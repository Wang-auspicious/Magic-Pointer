import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {ensureNativeTool, type DesktopRecord} from './desktop';

export interface NativeCaptureSession {
  arm(params: DesktopRecord): Promise<DesktopRecord>;
  commit(epochId: string): Promise<DesktopRecord>;
  cancel(epochId: string): Promise<void>;
  close(): void;
}

export class WgcCaptureSession implements NativeCaptureSession {
  constructor(
    private readonly resolveExecutable = () =>
      ensureNativeTool('wgc_capture_tool'),
  ) {}
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private generation = 0;
  private sequence = 0;
  private idleTimer?: NodeJS.Timeout;
  private pending = new Map<
    string,
    {
      resolve(value: DesktopRecord): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();

  private start(): Promise<void> {
    if (this.child && !this.child.killed) {
      return Promise.resolve();
    }
    if (this.starting) {
      return this.starting;
    }
    const generation = this.generation;
    const startup = (async () => {
      const executable = await this.resolveExecutable();
      if (generation !== this.generation) {
        throw new Error('wgc_closed');
      }
      const child = spawn(executable, [], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      let buffer = '';
      let diagnostic = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) {
            break;
          }
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const response = JSON.parse(line);
            const pending = this.pending.get(String(response.id));
            if (!pending) {
              continue;
            }
            this.pending.delete(String(response.id));
            clearTimeout(pending.timer);
            if (response.error) {
              pending.reject(new Error(String(response.error.code)));
            } else {
              pending.resolve(response.result);
            }
          } catch {
            this.fail(new Error('wgc_invalid_response'));
          }
        }
      });
      child.stderr.on('data', chunk => {
        diagnostic = (diagnostic + String(chunk)).slice(-2000);
      });
      child.stdin.on('error', error => {
        if (this.child === child) {
          this.fail(error);
        }
      });
      child.on('error', error => {
        if (this.child === child) {
          this.fail(error);
        }
      });
      child.on('exit', code => {
        if (this.child === child) {
          this.fail(new Error(`wgc_exited:${code}:${diagnostic}`));
        }
      });
    })().finally(() => {
      if (this.starting === startup) {
        this.starting = undefined;
      }
    });
    this.starting = startup;
    return startup;
  }

  private fail(error: Error): void {
    const child = this.child;
    this.child = undefined;
    child?.kill();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private async request(
    method: string,
    params: DesktopRecord = {},
  ): Promise<DesktopRecord> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const generation = this.generation;
    await this.start();
    const child = this.child;
    if (generation !== this.generation || !child || child.killed) {
      throw new Error('wgc_closed');
    }
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error(`wgc_${method}_timeout`)),
        8000,
      );
      this.pending.set(id, {resolve, reject, timer});
      child.stdin.write(`${JSON.stringify({id, method, params})}\n`);
    });
  }

  arm(params: DesktopRecord): Promise<DesktopRecord> {
    return this.request('arm', params);
  }

  status(): Promise<DesktopRecord> {
    return this.request('status');
  }

  async commit(epochId: string): Promise<DesktopRecord> {
    try {
      return await this.request('commit', {epochId});
    } finally {
      this.idleTimer = setTimeout(() => this.close(), 15000);
      this.idleTimer.unref();
    }
  }

  async cancel(epochId: string): Promise<void> {
    if (!this.child && !this.starting) {
      return;
    }
    await this.request('cancel', {epochId});
    this.idleTimer = setTimeout(() => this.close(), 15000);
    this.idleTimer.unref();
  }

  close(): void {
    this.generation++;
    this.starting = undefined;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = undefined;
    this.fail(new Error('wgc_closed'));
  }
}
