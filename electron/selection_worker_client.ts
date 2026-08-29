'use strict';

import path from 'node:path';
import { spawn } from 'node:child_process';

const { createProgressLineSplitter } = require('./bridge_progress_lines');
const { pythonInvocationArgs, pythonSpawnEnvironment } = require('./python_runtime');

type ChildProcess = ReturnType<typeof spawn>;
type Result = Record<string, unknown>;

interface ActiveRequest {
  id: string;
  onComplete: (result: Result) => void;
  onProgress: ((record: unknown) => void) | null;
  timer: NodeJS.Timeout | null;
  timeoutMs: number;
}

interface ClientOptions {
  root?: unknown;
  pythonExecutable?: string;
  pythonIsolated?: boolean;
  baseEnv?: NodeJS.ProcessEnv;
  userDataDir?: string;
  spawnProcess?: typeof spawn;
}

interface RunOptions {
  requestId: string;
  payload: unknown;
  timeoutMs?: number;
  signal?: AbortSignal | null;
  onComplete?: (result: Result) => void;
  onProgress?: ((record: unknown) => void) | null;
}

class SelectionWorkerClient {
  root: string;
  pythonExecutable: string;
  pythonIsolated: boolean;
  baseEnv: NodeJS.ProcessEnv;
  userDataDir: string;
  spawnProcess: typeof spawn;
  child: ChildProcess | null = null;
  active: ActiveRequest | null = null;
  stdoutBuffer = '';
  closing = false;

  constructor({
    root,
    pythonExecutable = 'python',
    pythonIsolated = false,
    baseEnv = process.env,
    userDataDir = '',
    spawnProcess = spawn,
  }: ClientOptions = {}) {
    const resolvedRoot = String(root || '');
    if (!path.isAbsolute(resolvedRoot)) throw new TypeError('root must be absolute');
    this.root = resolvedRoot;
    this.pythonExecutable = pythonExecutable;
    this.pythonIsolated = pythonIsolated === true;
    this.baseEnv = baseEnv;
    this.userDataDir = userDataDir;
    this.spawnProcess = spawnProcess;
  }

  ensureStarted(): ChildProcess {
    if (this.child && !this.child.killed) return this.child;
    const script = path.join(this.root, 'scripts', 'selection_worker.py');
    const args = pythonInvocationArgs(['-u', script], { isolated: this.pythonIsolated });
    const child = this.spawnProcess(this.pythonExecutable, args, {
      cwd: this.root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: pythonSpawnEnvironment({
        env: {
          ...this.baseEnv,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          MAGIC_POINTER_USER_DATA_DIR: this.userDataDir,
        },
        isolated: this.pythonIsolated,
      }),
    });
    this.child = child;
    this.closing = false;
    this.stdoutBuffer = '';
    if (!child.stdout || !child.stderr) throw new Error('selection_worker_stdio_unavailable');
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string | Buffer) => {
      if (this.child === child) this._consumeStdout(String(chunk));
    });
    const feedProgress = createProgressLineSplitter((record: unknown) => {
      this.active?.onProgress?.(record);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string | Buffer) => {
      if (this.child !== child) return;
      // 桥 runner 同款语义：任何输出都是活着的证明。60s 计的是沉默，
      // 不是总时长——长答案（大上下文的模型调用可以跑 1-2 分钟）必须
      // 靠持续到来的 @@mp 进度行续期，否则好答案被墙钟误杀（真机 8·29）。
      this._rearm(this.active);
      feedProgress(String(chunk));
    });
    child.on('error', (error: Error) => {
      if (this.child !== child) return;
      this.child = null;
      this._finish({ ok: false, error: 'bridge_spawn_error', detail: error.message.slice(0, 500) });
    });
    child.on('close', (code: number | null) => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.closing) {
        this._finish({ ok: false, error: 'selection_worker_exited', code });
      }
    });
    return child;
  }

  run({
    requestId,
    payload,
    timeoutMs = 60_000,
    signal = null,
    onComplete = () => {},
    onProgress = null,
  }: RunOptions) {
    if (this.active) {
      onComplete({ ok: false, error: 'selection_worker_busy' });
      return { cancel() {}, kill() {} };
    }
    const child = this.ensureStarted();
    const active: ActiveRequest = {
      id: requestId,
      onComplete,
      onProgress,
      timer: null,
      timeoutMs: 0,
    };
    this.active = active;
    const cancel = (): void => {
      if (this.active !== active) return;
      this._stopWorker({ ok: false, error: 'bridge_cancelled' });
    };
    if (signal) {
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    }
    active.timeoutMs = Math.max(1000, Number(timeoutMs) || 60_000);
    this._rearm(active);
    try {
      if (!child.stdin) throw new Error('selection_worker_stdin_unavailable');
      child.stdin.write(`${JSON.stringify({ id: requestId, op: 'run', payload })}\n`, 'utf8');
    } catch (error) {
      this._stopWorker({
        ok: false,
        error: 'bridge_stdin_error',
        detail: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
    }
    return { cancel, kill: cancel };
  }

  shutdown({ force = false }: { force?: boolean } = {}): void {
    const child = this.child;
    this.closing = true;
    this._finish({ ok: false, error: 'bridge_cancelled' });
    if (!child) return;
    try {
      if (!force && child.stdin?.writable) {
        child.stdin.write(`${JSON.stringify({ id: 'shutdown', op: 'shutdown' })}\n`, 'utf8');
      } else if (!child.killed) {
        child.kill();
      }
    } catch {
      try { if (!child.killed) child.kill(); } catch {}
    }
    if (force && this.child === child) this.child = null;
  }

  _consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > 1024 * 1024) {
      this._stopWorker({ ok: false, error: 'bridge_output_limit', stream: 'stdout' });
      return;
    }
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        this._stopWorker({ ok: false, error: 'bridge_invalid_json' });
        return;
      }
      const active = this.active;
      if (!active || message?.id !== active.id) continue;
      const result = message?.result;
      this._finish(result && typeof result === 'object'
        ? result
        : { ok: false, error: 'bridge_invalid_json' });
    }
  }

  private _rearm(active: ActiveRequest | null): void {
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    active.timer = setTimeout(() => {
      active.timer = null;
      this._stopWorker({ ok: false, error: 'bridge_timeout' });
    }, active.timeoutMs);
  }

  _finish(result: Result): void {
    if (this.active?.timer) clearTimeout(this.active.timer);
    if (this.active) this.active.timer = null;
    const active = this.active;
    if (!active) return;
    this.active = null;
    if (active.timer) clearTimeout(active.timer);
    active.timer = null;
    active.onComplete(result);
  }

  _stopWorker(result: Result): void {
    const child = this.child;
    this.child = null;
    try { if (child && !child.killed) child.kill(); } catch {}
    this._finish(result);
  }
}

module.exports = { SelectionWorkerClient };
