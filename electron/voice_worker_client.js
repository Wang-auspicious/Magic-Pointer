'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const { spawn } = require('child_process');
const { pythonInvocationArgs, pythonSpawnEnvironment } = require('./python_runtime');

class VoiceWorkerClient extends EventEmitter {
  constructor({
    root,
    pythonExecutable = 'python',
    modelName = 'tiny',
    settingsPath = '',
    memoryLimitMb = 1024,
    idleUnloadMs = 300000,
    pollIntervalMs = 80,
    pythonIsolated = false,
    spawnProcess = spawn,
    baseEnv = process.env,
  } = {}) {
    super();
    if (!path.isAbsolute(String(root || ''))) throw new TypeError('root must be absolute');
    if (!Number.isInteger(memoryLimitMb) || memoryLimitMb < 128 || memoryLimitMb > 16384) {
      throw new TypeError('memoryLimitMb must be an integer from 128 to 16384');
    }
    if (!Number.isInteger(idleUnloadMs) || idleUnloadMs < 10000 || idleUnloadMs > 3600000) {
      throw new TypeError('idleUnloadMs must be an integer from 10000 to 3600000');
    }
    this.root = root;
    this.pythonExecutable = pythonExecutable;
    this.modelName = modelName;
    this.settingsPath = settingsPath;
    this.memoryLimitMb = memoryLimitMb;
    this.idleUnloadMs = idleUnloadMs;
    this.pollIntervalMs = pollIntervalMs;
    this.pythonIsolated = pythonIsolated === true;
    this.spawnProcess = spawnProcess;
    this.baseEnv = baseEnv;
    this.child = null;
    this.active = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.pollTimer = null;
    this.closing = false;
  }

  ensureStarted({ preload = false } = {}) {
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
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child === child) this._consumeStdout(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      if (this.child === child) this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-4000);
    });
    child.on('error', error => {
      this._detachFailedChild(child, `Local voice worker failed to start: ${error.message}`);
    });
    child.on('close', code => {
      if (this.child !== child) return;
      const expected = this.closing;
      this.child = null;
      this._clearPoll();
      if (!expected) this._workerFailed(`Local voice worker exited: ${this.stderrBuffer.trim().slice(0, 500) || `exit ${code}`}`);
      this.emit('worker-close', { code, expected });
    });
    if (preload && !this._write({ command: 'load' })) {
      throw new Error('voice_worker_unavailable');
    }
    return child;
  }

  startDictation({ requestId, contextPath = '', silenceMs = 1600, inputWav = '' } = {}) {
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
    if (mode === 'microphone') {
      this.pollTimer = setInterval(() => {
        this._pollActiveMicrophone(requestId);
      }, this.pollIntervalMs);
    }
    return { ok: true, requestId, mode };
  }

  stopDictation(requestId, { cancel = false } = {}) {
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

  shutdown({ force = false } = {}) {
    const child = this.child;
    this.closing = true;
    this.active = null;
    this._clearPoll();
    if (!child) return;
    if (!force && !this._write({ command: 'shutdown' })) force = true;
    try { if (force && !child.killed) child.kill(); } catch (_) {}
    if (force && this.child === child) this.child = null;
  }

  _write(command) {
    if (!this.child || this.child.killed || !this.child.stdin?.writable) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(command)}\n`, 'utf8');
      return true;
    } catch (_) {
      return false;
    }
  }

  _consumeStdout(chunk) {
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

  _handleEvent(rawEvent) {
    if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) {
      this.emit('protocol-error', { error: 'invalid_event' });
      return;
    }
    const active = this.active;
    const event = { ...rawEvent };
    if (event.type === 'status' && !event.requestId) {
      this.emit('worker-status', event);
      return;
    }
    if (!active) {
      const preloadState = event.type === 'loading'
        ? 'warming'
        : event.type === 'ready'
          ? 'ready'
          : event.type === 'error'
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
    if (event.type === 'microphone_started' && active.mode === 'microphone') {
      active.captureStarted = true;
    }
    if (active.cancelled && ['partial', 'final'].includes(event.type)) return;
    if (!['loading', 'ready', 'microphone_started', 'partial', 'final', 'error', 'microphone_stopped'].includes(event.type)) return;
    this.emit('voice-event', event);
    if (active.mode === 'wav' && ['final', 'error'].includes(event.type)) {
      this.active = null;
      this._clearPoll();
    } else if (active.mode === 'microphone' && event.type === 'error' && !active.captureStarted) {
      this.active = null;
      this._clearPoll();
    } else if (active.mode === 'microphone' && event.type === 'microphone_stopped') {
      this.active = null;
      this._clearPoll();
    }
  }

  _workerFailed(message) {
    const requestId = this.active?.requestId || null;
    this.active = null;
    this._clearPoll();
    this.emit('voice-event', { type: 'error', requestId, error: message, engine: 'whisper-local' });
  }

  _pollActiveMicrophone(requestId) {
    if (this.active?.requestId !== requestId || this.active.mode !== 'microphone') return false;
    if (this._write({ command: 'poll_microphone', requestId })) return true;
    this._failTransport('Local voice worker command channel failed while polling capture.');
    return false;
  }

  _failTransport(message) {
    const child = this.child;
    if (!child) {
      this._workerFailed(message);
      return;
    }
    this._detachFailedChild(child, message);
  }

  _detachFailedChild(child, message) {
    if (!child || this.child !== child) return;
    const expected = this.closing;
    this.child = null;
    this._clearPoll();
    try { if (!child.killed) child.kill(); } catch (_) {}
    if (!expected) this._workerFailed(message);
    this.emit('worker-close', { code: null, expected, error: true });
  }

  _clearPoll() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}

function validRequestId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && value === value.trim();
}

module.exports = { VoiceWorkerClient, validRequestId };
