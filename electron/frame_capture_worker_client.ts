'use strict';

// Persistent JSONL RPC client for scripts/frame_capture_worker.py.
// One child process is reused across arm/commit for every gesture; the worker
// stays idle between gestures. Frame contents (artifact paths, hashes, pixel
// data) never appear in logs or emitted events.

const { EventEmitter } = require('events');
const path = require('path');
const { spawn } = require('child_process');
const { validateFrameLease } = require('./frame_lease');
const { pythonInvocationArgs, pythonSpawnEnvironment } = require('./python_runtime');

type ChildProcessWithoutNullStreams = ReturnType<typeof spawn>;
type UnknownRecord = Record<string, unknown>;

interface CaptureArmRequest {
  epochId: string;
  displayId: string;
  scaleFactor: number;
  surfaceBoundsPx: [number, number, number, number];
  targetWindow: { hwnd: number; processId: number; processName: string; title: string };
  overlayExcluded?: boolean;
}

interface CaptureCommitRequest {
  epochId: string;
  gesture: UnknownRecord;
}

interface FrameCaptureWorkerClientOptions {
  spawnWorker?: () => ChildProcessWithoutNullStreams;
  requestTimeoutMs?: number;
  root?: string;
  pythonExecutable?: string;
  pythonIsolated?: boolean;
  baseEnv?: NodeJS.ProcessEnv;
  logger?: { log(message: string): void };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  label: string;
  timer: NodeJS.Timeout;
}

function recordOf(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

class FrameCaptureWorkerClient extends EventEmitter {
  root: string;
  pythonExecutable: string;
  pythonIsolated: boolean;
  baseEnv: NodeJS.ProcessEnv;
  requestTimeoutMs: number;
  logger: { log(message: string): void };
  spawnWorker: () => ChildProcessWithoutNullStreams;
  child: ChildProcessWithoutNullStreams | null;
  stdoutBuffer: string;
  requestSeq: number;
  pending: Map<string, PendingRequest>;
  closing: boolean;

  constructor({
    spawnWorker,
    requestTimeoutMs = 10000,
    root = path.join(__dirname, '..'),
    pythonExecutable = 'python',
    pythonIsolated = false,
    baseEnv = process.env,
    logger = console,
  }: FrameCaptureWorkerClientOptions = {}) {
    super();
    this.root = root;
    this.pythonExecutable = pythonExecutable;
    this.pythonIsolated = pythonIsolated === true;
    this.baseEnv = baseEnv;
    this.requestTimeoutMs = Math.max(1, Number(requestTimeoutMs) || 10000);
    this.logger = logger;
    this.spawnWorker = spawnWorker || (() => this._defaultSpawn());
    this.child = null;
    this.stdoutBuffer = '';
    this.requestSeq = 0;
    this.pending = new Map();
    this.closing = false;
  }

  start(): Promise<void> {
    const child = this._ensureStarted();
    if (!child) return Promise.reject(new Error('frame_capture_worker_unavailable'));
    this.logger.log('[frame-capture-worker] start, ping for readiness');
    return this._rpc('ping', {}, 'ping').then(() => undefined);
  }

  arm(request: CaptureArmRequest): Promise<void> {
    return this._rpc('arm', request as unknown as UnknownRecord, 'arm').then(() => undefined);
  }

  commit(request: CaptureCommitRequest): Promise<ReturnType<typeof validateFrameLease>> {
    return this._rpc('commit', request as unknown as UnknownRecord, 'commit').then((result) => {
      this.logger.log('[frame-capture-worker] commit ok, lease validated');
      return validateFrameLease(result);
    });
  }

  cancel(epochId: string): Promise<void> {
    return this._rpc('cancel', { epochId }, 'cancel').then(() => undefined);
  }

  shutdown(): Promise<void> {
    if (!this.child || this.child.killed) return Promise.resolve();
    this.closing = true;
    return this._rpc('shutdown', {}, 'shutdown').catch((error: Error) => {
      this.logger.log(
        `[frame-capture-worker] shutdown failed: ${error?.message || 'unknown'}`,
      );
    }).then(() => undefined);
  }

  _defaultSpawn(): ChildProcessWithoutNullStreams {
    const scriptPath = path.join(this.root, 'scripts', 'frame_capture_worker.py');
    const args = pythonInvocationArgs(['-u', scriptPath], { isolated: this.pythonIsolated });
    return spawn(this.pythonExecutable, args, {
      cwd: this.root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: pythonSpawnEnvironment({
        env: {
          ...this.baseEnv,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
        },
        isolated: this.pythonIsolated,
      }),
    });
  }

  _ensureStarted(): ChildProcessWithoutNullStreams | null {
    if (this.child && !this.child.killed) return this.child;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnWorker();
    } catch (error) {
      this.logger.log(
        `[frame-capture-worker] spawn failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return null;
    }
    this.child = child;
    this.stdoutBuffer = '';
    this.closing = false;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      this.child = null;
      return null;
    }
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string | Buffer) => {
      if (this.child === child) this._consumeStdout(String(chunk));
    });
    stderr.setEncoding('utf8');
    stderr.on('data', () => {
      // Diagnostics only; responses are JSONL on stdout and nothing else.
    });
    child.on('error', (error: Error) => {
      this._detachFailedChild(child, `frame capture worker failed to start: ${error.message}`);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.child !== child) return;
      const expected = this.closing;
      this.child = null;
      if (!expected) {
        this._rejectAllPending(new Error(
          `frame_capture_worker_exited:${code ?? signal ?? 'closed'}`,
        ));
      }
      this.emit('worker-close', { code, expected });
    });
    return child;
  }

  _rpc(method: string, params: UnknownRecord, label: string): Promise<unknown> {
    const child = this._ensureStarted();
    if (!child) return Promise.reject(new Error('frame_capture_worker_unavailable'));
    const requestId = `rpc-${++this.requestSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.logger.log(
          `[frame-capture-worker] request ${requestId} method=${label} timed out, sending cancel`,
        );
        const epochId = String(recordOf(params)?.epochId || '');
        if (epochId) {
          this._write({
            id: `rpc-${++this.requestSeq}`,
            method: 'cancel',
            params: { epochId },
          });
        }
        reject(new Error(`frame_capture_worker_timeout:${label}`));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, label, timer });
      if (!this._write({ id: requestId, method, params })) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('frame_capture_worker_transport_failed'));
      }
    });
  }

  _write(payload: UnknownRecord): boolean {
    const child = this.child;
    if (!child || child.killed || !child.stdin?.writable) return false;
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8');
      return true;
    } catch (_) {
      return false;
    }
  }

  _consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      this._handleLine(line);
    }
  }

  _handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (_) {
      this.emit('protocol-error', { error: 'invalid_jsonl' });
      return;
    }
    const candidate = recordOf(parsed);
    if (candidate === null) {
      this.emit('protocol-error', { error: 'invalid_response' });
      return;
    }
    const requestId = typeof candidate.id === 'string' ? candidate.id : '';
    const pending = requestId ? this.pending.get(requestId) : undefined;
    if (!pending) {
      this.emit('protocol-error', { error: 'unknown_request_id', id: requestId });
      return;
    }
    if ('error' in candidate) {
      const errorCode = String(recordOf(candidate.error)?.code || 'unknown');
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(new Error(`frame_capture_worker_error:${errorCode}`));
      return;
    }
    if (!('result' in candidate)) {
      // Malformed for this request only: the rest of the pending queue stays alive.
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      this.emit('protocol-error', { error: 'malformed_response', id: requestId });
      pending.reject(new Error('frame_capture_worker_malformed_response'));
      return;
    }
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(candidate.result);
  }

  _rejectAllPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }

  _detachFailedChild(child: ChildProcessWithoutNullStreams, message: string): void {
    if (!child || this.child !== child) return;
    const expected = this.closing;
    this.child = null;
    this._rejectAllPending(new Error('frame_capture_worker_exited:spawn_error'));
    this.emit('worker-close', { code: null, expected, error: true });
    this.logger.log(`[frame-capture-worker] ${message}`);
  }
}

module.exports = { FrameCaptureWorkerClient };
