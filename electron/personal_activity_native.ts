import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {desktopRuntimeRoot, ensureNativeTool} from './runtime/desktop';
import type {ActivityWindowInterval} from './personal_activity';

export interface PersonalActivityForeground {
  hwnd: number;
  pid: number;
  appId: string;
  label: string;
  title: string;
  bounds: [number, number, number, number];
}

export interface PersonalActivityBatch {
  type: 'batch';
  runId: string;
  sequence: number;
  at: string;
  from: string;
  to: string;
  keyboard: Record<string, number>;
  injectedKeyboard: Record<string, number>;
  applications: Array<{
    appId: string;
    label: string;
    activeMs: number;
    activations: number;
  }>;
  coverage: {
    activeMs: number;
    idleMs: number;
    lockedMs: number;
    unavailableMs: number;
  };
  foreground: PersonalActivityForeground | null;
  state: 'active' | 'idle' | 'locked' | 'unavailable';
  usedBackend: 'windows.wh-keyboard-ll+winevent';
  intervals?: ActivityWindowInterval[];
}

export type PersonalActivityNativeStatus =
  'stopped' | 'starting' | 'running' | 'error';

export interface PersonalActivityNativeOptions {
  onBatch(batch: PersonalActivityBatch): void;
  onStatus?(status: PersonalActivityNativeStatus): void;
  onError?(error: Error): void;
  batchMs?: number;
  idleMs?: number;
  launch?(args: string[]): Promise<ChildProcessWithoutNullStreams>;
}

/** Local aggregate feed. Pausing uses stop(), which flushes and removes the native hooks. */
export class PersonalActivityNative {
  status: PersonalActivityNativeStatus = 'stopped';
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private wanted = false;
  private pending = new Map<
    string,
    {resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout}
  >();
  private exited?: Promise<void>;

  constructor(private readonly options: PersonalActivityNativeOptions) {}

  async start(): Promise<void> {
    if (this.stopping) {
      await this.stopping;
    }
    this.wanted = true;
    if (this.status === 'running') {
      return;
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.startProcess().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private setStatus(status: PersonalActivityNativeStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.options.onStatus?.(status);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private async startProcess(): Promise<void> {
    this.setStatus('starting');
    const args = [
      '--batch-ms',
      String(this.options.batchMs ?? 5000),
      '--idle-ms',
      String(this.options.idleMs ?? 60000),
    ];
    let child: ChildProcessWithoutNullStreams;
    try {
      if (this.options.launch) {
        child = await this.options.launch(args);
      } else {
        const executable = await ensureNativeTool('personal_activity_host');
        if (!this.wanted) {
          this.setStatus('stopped');
          return;
        }
        child = spawn(executable, args, {
          cwd: desktopRuntimeRoot(),
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.setStatus('error');
      this.options.onError?.(error);
      throw error;
    }
    this.child = child;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let failed = false;
    let buffer = '';
    let stderr = '';
    const fail = (error: Error) => {
      if (failed) {
        return;
      }
      failed = true;
      clearTimeout(startupTimer);
      this.setStatus('error');
      this.rejectPending(error);
      rejectReady(error);
      this.options.onError?.(error);
      child.kill();
    };
    const startupTimer = setTimeout(
      () => fail(new Error('personal_activity_start_timeout')),
      15000,
    );
    this.exited = new Promise<void>(resolve => {
      child.once('close', (code, signal) => {
        clearTimeout(startupTimer);
        if (this.child === child) {
          this.child = undefined;
        }
        if (this.wanted && !failed) {
          fail(
            new Error(
              `personal_activity_exited:${code ?? signal ?? 'unknown'}${stderr ? `:${stderr.trim()}` : ''}`,
            ),
          );
        } else if (!failed) {
          this.setStatus('stopped');
          resolveReady();
        }
        this.rejectPending(new Error('personal_activity_stopped'));
        resolve();
      });
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) {
          continue;
        }
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === 'ready') {
            clearTimeout(startupTimer);
            if (this.wanted) {
              this.setStatus('running');
            }
            resolveReady();
          } else if (event.type === 'batch') {
            this.options.onBatch(event as unknown as PersonalActivityBatch);
          } else if (event.type === 'flushed') {
            const id = String(event.id);
            const request = this.pending.get(id);
            if (request) {
              this.pending.delete(id);
              clearTimeout(request.timer);
              request.resolve();
            }
          } else if (event.type === 'error') {
            fail(
              new Error(
                `${String(event.code || 'personal_activity_native_error')}:${String(event.message || '')}`,
              ),
            );
          } else if (event.type !== 'stopped') {
            fail(
              new Error(
                `personal_activity_unknown_event:${String(event.type)}`,
              ),
            );
          }
        } catch (cause) {
          fail(cause instanceof Error ? cause : new Error(String(cause)));
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.once('error', fail);
    child.stdin.on('error', error => {
      if (this.wanted) {
        fail(error);
      }
    });
    if (!this.wanted) {
      child.stdin.write(`${JSON.stringify({command: 'stop'})}\n`);
    }
    await ready;
  }

  async flush(): Promise<void> {
    if (this.starting) {
      await this.starting;
    }
    if (!this.child || this.status !== 'running') {
      return;
    }
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('personal_activity_flush_timeout'));
      }, 5000);
      this.pending.set(id, {resolve, reject, timer});
      this.child!.stdin.write(
        `${JSON.stringify({command: 'flush', id})}\n`,
        error => {
          if (error) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(error);
          }
        },
      );
    });
  }

  async stop(): Promise<void> {
    this.wanted = false;
    if (this.stopping) {
      return this.stopping;
    }
    this.stopping = (async () => {
      if (this.starting) {
        await this.starting.catch(() => {});
      }
      const child = this.child;
      if (!child) {
        this.setStatus('stopped');
        return;
      }
      child.stdin.end(`${JSON.stringify({command: 'stop'})}\n`);
      const timer = setTimeout(() => {
        this.options.onError?.(
          new Error(
            'personal_activity_stop_timeout:final_batch_may_be_incomplete',
          ),
        );
        child.kill();
      }, 5000);
      try {
        await this.exited;
      } finally {
        clearTimeout(timer);
        this.setStatus('stopped');
      }
    })().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
}
