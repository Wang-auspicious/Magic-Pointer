'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const { spawn } = require('child_process');
const { pythonInvocationArgs, pythonSpawnEnvironment } = require('./python_runtime');

type ChildProcess = ReturnType<typeof spawn>;
type VoiceEngine = 'auto' | 'sense_voice' | 'whisper';
type VoiceMode = 'microphone' | 'wav';
type UnknownRecord = Record<string, unknown>;

interface ActiveDictation {
  cancelled: boolean;
  captureStarted?: boolean;
  mode: VoiceMode;
  requestId: string;
}

interface VoiceWorkerOptions {
  baseEnv?: NodeJS.ProcessEnv;
  engine?: unknown;
  idleUnloadMs?: unknown;
  memoryLimitMb?: unknown;
  modelName?: string;
  pythonExecutable?: string;
  pythonIsolated?: boolean;
  root?: unknown;
  settingsPath?: string;
  spawnProcess?: typeof spawn;
}

interface StartDictationOptions {
  contextPath?: string;
  inputWav?: string;
  requestId?: unknown;
  silenceMs?: number;
}

function recordOf(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' ? (value as UnknownRecord) : null;
}

class VoiceWorkerClient extends EventEmitter {
  root: string;
  pythonExecutable: string;
  modelName: string;
  settingsPath: string;
  memoryLimitMb: number;
  idleUnloadMs: number;
  pythonIsolated: boolean;
  engine: VoiceEngine;
  spawnProcess: typeof spawn;
  baseEnv: NodeJS.ProcessEnv;
  child: ChildProcess | null;
  active: ActiveDictation | null;
  stdoutBuffer: string;
  stderrBuffer: string;
  closing: boolean;

  constructor({
    root,
    pythonExecutable = 'python',
    modelName = 'tiny',
    settingsPath = '',
    memoryLimitMb = 1024,
    idleUnloadMs = 0,
    engine = 'auto',
    pythonIsolated = false,
    spawnProcess = spawn,
    baseEnv = process.env,
  }: VoiceWorkerOptions = {}) {
    super();
    const rootPath = String(root || '');
    if (!path.isAbsolute(rootPath)) throw new TypeError('root must be absolute');
    if (typeof memoryLimitMb !== 'number'
      || !Number.isInteger(memoryLimitMb)
      || memoryLimitMb < 128
      || memoryLimitMb > 16384) {
      throw new TypeError('memoryLimitMb must be an integer from 128 to 16384');
    }
    if (typeof idleUnloadMs !== 'number'
      || !Number.isInteger(idleUnloadMs)
      || idleUnloadMs < 0
      || idleUnloadMs > 3600000) {
      throw new TypeError('idleUnloadMs must be an integer from 0 (resident) to 3600000');
    }
    const engineName = String(engine || 'auto').trim().toLowerCase() || 'auto';
    if (!['auto', 'whisper', 'sense_voice'].includes(engineName)) {
      throw new TypeError('engine must be auto, whisper, or sense_voice');
    }
    this.root = rootPath;
    this.pythonExecutable = pythonExecutable;
    this.modelName = modelName;
    this.settingsPath = settingsPath;
    this.memoryLimitMb = memoryLimitMb;
    this.idleUnloadMs = idleUnloadMs;
    this.pythonIsolated = pythonIsolated === true;
    this.engine = engineName as VoiceEngine;
    this.spawnProcess = spawnProcess;
    this.baseEnv = baseEnv;
    this.child = null;
    this.active = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.closing = false;
  }

  ensureStarted({ preload = false }: { preload?: boolean } = {}): ChildProcess {
    if (this.child && !this.child.killed) {
      if (preload && !this._write({ command: 'load' })) {
        throw new Error('voice_worker_unavailable');
      }
      return this.child;
    }
    const scriptPath = path.join(this.root, 'scripts', 'local_voice_worker.py');
    const args = pythonInvocationArgs([
      '-u', scriptPath,
      '--model', this.modelName,
      '--engine', this.engine,
      '--memory-limit-mb', String(this.memoryLimitMb),
      '--idle-unload-ms', String(this.idleUnloadMs),
    ], { isolated: this.pythonIsolated });
    const child = this.spawnProcess(this.pythonExecutable, args, {
      cwd: this.root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: pythonSpawnEnvironment({ env: {
        ...this.baseEnv,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        MAGIC_POINTER_VOICE_SETTINGS_FILE: this.settingsPath,
      }, isolated: this.pythonIsolated }),
    });
    this.child = child;
    this.closing = false;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) throw new Error('voice_worker_stdio_unavailable');
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string | Buffer) => {
      if (this.child === child) this._consumeStdout(String(chunk));
    });
    stderr.setEncoding('utf8');
    stderr.on('data', (chunk: string | Buffer) => {
      if (this.child === child) this.stderrBuffer = `${this.stderrBuffer}${String(chunk)}`.slice(-4000);
    });
    child.on('error', (error: Error) => {
      this._detachFailedChild(child, `Local voice worker failed to start: ${error.message}`);
    });
    child.on('close', (code: number | null) => {
      if (this.child !== child) return;
      const expected = this.closing;
      this.child = null;
      if (!expected) this._workerFailed(`Local voice worker exited: ${this.stderrBuffer.trim().slice(0, 500) || `exit ${code}`}`);
      this.emit('worker-close', { code, expected });
    });
    if (preload && !this._write({ command: 'load' })) {
      throw new Error('voice_worker_unavailable');
    }
    return child;
  }

  startDictation({
    requestId,
    contextPath = '',
    silenceMs = 1600,
    inputWav = '',
  }: StartDictationOptions = {}) {
    if (!validRequestId(requestId)) return { ok: false, error: 'invalid_request_id' };
    if (this.active) return { ok: false, error: 'voice_worker_busy' };
    this.ensureStarted();
    const mode = inputWav ? 'wav' : 'microphone';
    this.active = { requestId, mode, cancelled: false };
    let written = false;
    if (mode === 'wav') {
      written = this._write({ command: 'transcribe_wav', requestId, path: path.resolve(inputWav), contextPath });
    } else {
      written = this._write({ command: 'start_microphone', requestId, contextPath, silenceMs });
    }
    if (!written) {
      this._failTransport('Local voice worker command channel is unavailable.');
      return { ok: false, error: 'voice_worker_unavailable' };
    }
    return { ok: true, requestId, mode };
  }

  stopDictation(requestId: unknown, { cancel = false }: { cancel?: boolean } = {}): boolean {
    if (!this.active || this.active.requestId !== requestId) return false;
    if (cancel) this.active.cancelled = true;
    if (this.active.mode === 'microphone') {
      if (!this._write({ command: 'stop_microphone', requestId })) {
        this._failTransport('Local voice worker command channel failed while stopping capture.');
        return false;
      }
    } else if (cancel) {
      this.shutdown({ force: true });
    }
    return true;
  }

  shutdown({ force = false }: { force?: boolean } = {}): void {
    const child = this.child;
    this.closing = true;
    this.active = null;
    if (!child) return;
    if (!force && !this._write({ command: 'shutdown' })) force = true;
    try {
      if (force && !child.killed) child.kill();
    } catch (_) {
      // The worker may already have exited between the state check and kill.
    }
    if (force && this.child === child) this.child = null;
  }

  _write(command: UnknownRecord): boolean {
    if (!this.child || this.child.killed || !this.child.stdin?.writable) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(command)}\n`, 'utf8');
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
      try {
        this._handleEvent(JSON.parse(line));
      } catch (_) {
        this.emit('protocol-error', { error: 'invalid_jsonl' });
      }
    }
  }

  _handleEvent(rawEvent: unknown): void {
    const candidate = recordOf(rawEvent);
    if (candidate === null || Array.isArray(rawEvent)) {
      this.emit('protocol-error', { error: 'invalid_event' });
      return;
    }
    const active = this.active;
    const event: UnknownRecord = { ...candidate };
    const eventType = typeof event.type === 'string' ? event.type : '';
    if (eventType === 'status' && !event.requestId) {
      this.emit('worker-status', event);
      return;
    }
    if (!active) {
      const preloadState = eventType === 'loading'
        ? 'warming'
        : eventType === 'ready'
          ? 'ready'
          : eventType === 'error'
            ? 'error'
            : null;
      if (preloadState && !event.requestId) {
        this.emit('worker-status', {
          type: event.type,
          state: preloadState,
          engine: event.engine,
          memory_mb: event.memory_mb,
          reused: event.reused === true,
          code: event.code,
        });
      }
      return;
    }
    if (!event.requestId) event.requestId = active.requestId;
    if (event.requestId !== active.requestId) return;
    if (eventType === 'microphone_started' && active.mode === 'microphone') {
      active.captureStarted = true;
    }
    if (active.cancelled && ['partial', 'final'].includes(eventType)) return;
    if (!['loading', 'ready', 'microphone_started', 'partial', 'final', 'error', 'microphone_stopped'].includes(eventType)) return;
    this.emit('voice-event', event);
    if (active.mode === 'wav' && ['final', 'error'].includes(eventType)) {
      this.active = null;
    } else if (active.mode === 'microphone' && eventType === 'error' && !active.captureStarted) {
      this.active = null;
    } else if (active.mode === 'microphone' && eventType === 'microphone_stopped') {
      this.active = null;
    }
  }

  _workerFailed(message: string): void {
    const requestId = this.active?.requestId || null;
    this.active = null;
    this.emit('voice-event', { type: 'error', requestId, error: message, engine: this.engine });
  }

  _failTransport(message: string): void {
    const child = this.child;
    if (!child) {
      this._workerFailed(message);
      return;
    }
    this._detachFailedChild(child, message);
  }

  _detachFailedChild(child: ChildProcess, message: string): void {
    if (!child || this.child !== child) return;
    const expected = this.closing;
    this.child = null;
    try {
      if (!child.killed) child.kill();
    } catch (_) {
      // Detaching the failed transport is still valid if the process already exited.
    }
    if (!expected) this._workerFailed(message);
    this.emit('worker-close', { code: null, expected, error: true });
  }
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && value === value.trim();
}

module.exports = { VoiceWorkerClient, validRequestId };
