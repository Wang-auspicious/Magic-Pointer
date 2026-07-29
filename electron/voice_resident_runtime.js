'use strict';

const { VoiceWorkerClient } = require('./voice_worker_client');

function sameConfig(left, right) {
  return left
    && right
    && left.enabled === right.enabled
    && left.memoryLimitMb === right.memoryLimitMb
    && left.idleUnloadMs === right.idleUnloadMs
    && left.settingsPath === right.settingsPath
    && left.pythonExecutable === right.pythonExecutable
    && left.pythonIsolated === right.pythonIsolated
    && left.modelName === right.modelName;
}

class VoiceResidentRuntime {
  constructor({
    createClient = options => new VoiceWorkerClient(options),
    startLegacy = null,
    stopLegacy = null,
    onDeliver = null,
    onStatus = null,
  } = {}) {
    this.createClient = createClient;
    this.startLegacy = startLegacy;
    this.stopLegacy = stopLegacy;
    this.onDeliver = onDeliver || (() => {});
    this.onStatus = onStatus || (() => {});
    this.config = null;
    this.client = null;
    this.active = null;
  }

  configure(next) {
    const config = normalizeConfig(next);
    if (sameConfig(this.config, config)) return { ok: true, rebuilt: false, changed: false };
    if (this.active) return { ok: false, error: 'voice_session_active' };
    const hadClient = Boolean(this.client);
    this._disposeClient();
    this.config = config;
    this._publishStatus(config.enabled ? 'unloaded' : 'disabled');
    return { ok: true, rebuilt: hadClient, changed: true };
  }

  warmUp() {
    if (!this.config?.enabled) return false;
    try {
      const client = this._ensureClient();
      this._publishStatus('warming');
      client.ensureStarted({ preload: true });
      return true;
    } catch (_) {
      this._disposeClient();
      this._publishStatus('error', 'voice_worker_start_failed');
      return false;
    }
  }

  start({ requestId, surface, contextPath, silenceMs = 1600, inputWav = '' } = {}) {
    if (!this.config) return { ok: false, error: 'voice_runtime_unconfigured' };
    if (this.active) return { ok: false, error: 'voice_session_active' };
    if (
      !validSessionValue(requestId)
      || !validSurface(surface)
      || typeof contextPath !== 'string'
      || typeof inputWav !== 'string'
      || inputWav.length > 4096
    ) {
      return { ok: false, error: 'invalid_voice_session' };
    }
    this.active = { requestId, surface, cancelled: false, resident: this.config.enabled, startedAt: Date.now() };
    if (!this.config.enabled) {
      if (typeof this.startLegacy !== 'function') {
        this.active = null;
        return { ok: false, error: 'legacy_voice_unavailable' };
      }
      const result = this.startLegacy({ requestId, surface, contextPath, silenceMs });
      if (!result?.ok) this.active = null;
      return result || { ok: false, error: 'legacy_voice_start_failed' };
    }
    let result;
    try {
      result = this._ensureClient().startDictation({
        requestId,
        contextPath,
        silenceMs,
        inputWav,
      });
    } catch (_) {
      this._disposeClient();
      result = { ok: false, error: 'voice_worker_start_failed' };
    }
    if (!result?.ok) {
      this.active = null;
      this._publishStatus('error', result?.error || 'voice_worker_start_failed');
      return result;
    }
    this.active.mode = result.mode === 'wav' ? 'wav' : 'microphone';
    this._publishStatus('warming');
    return result;
  }

  stop(requestId, { graceful = false, cancel = false } = {}) {
    if (!this.active || this.active.requestId !== requestId) return false;
    this.active.cancelled = cancel || !graceful;
    if (!this.active.resident) {
      if (typeof this.stopLegacy !== 'function') return false;
      return this.stopLegacy({
        requestId,
        surface: this.active.surface,
        graceful: graceful === true,
        cancel: this.active.cancelled,
      }) === true;
    }
    const stopped = this.client?.stopDictation(requestId, { cancel: this.active.cancelled });
    if (stopped) {
      this._publishStatus('releasing');
    } else {
      this.active = null;
      this._disposeClient();
      this._publishStatus('error', 'voice_worker_transport_failed');
    }
    return Boolean(stopped);
  }

  legacyFinished(requestId) {
    if (this.active?.resident === false && this.active.requestId === requestId) this.active = null;
  }

  shutdown() {
    this.active = null;
    this._disposeClient();
    this._publishStatus('unloaded');
  }

  _ensureClient() {
    if (this.client) return this.client;
    this.client = this.createClient({
      root: this.config.root,
      pythonExecutable: this.config.pythonExecutable,
      pythonIsolated: this.config.pythonIsolated,
      modelName: this.config.modelName,
      settingsPath: this.config.settingsPath,
      memoryLimitMb: this.config.memoryLimitMb,
      idleUnloadMs: this.config.idleUnloadMs,
    });
    this.client.on('voice-event', event => this._handleEvent(event));
    this.client.on('worker-status', event => {
      const workerState = String(event?.state || '');
      if (workerState === 'unloaded') this._publishStatus('unloaded', event.reason || null, event);
      else if (workerState === 'warming' || workerState === 'loading') this._publishStatus('warming', null, event);
      else if (workerState === 'ready') this._publishStatus('ready', null, event);
      else if (workerState === 'error') this._publishStatus('error', event.code || 'voice_worker_preload_failed', event);
    });
    this.client.on('worker-close', details => {
      if (!details.expected) {
        this.active = null;
        this._publishStatus('error', 'voice_worker_crashed');
      }
    });
    return this.client;
  }

  _disposeClient() {
    if (!this.client) return;
    try { this.client.shutdown({ force: true }); } catch (_) {}
    try { this.client.removeAllListeners(); } catch (_) {}
    this.client = null;
  }

  _handleEvent(event) {
    if (!event || typeof event !== 'object') return;
    const active = this.active;
    if (!active || active.resident !== true || event.requestId !== active.requestId) return;
    const type = String(event.type || '');
    if (active.cancelled && (type === 'partial' || type === 'final')) return;
    if (!['loading', 'ready', 'microphone_started', 'partial', 'final', 'error', 'microphone_stopped'].includes(type)) return;
    if (type === 'loading') this._publishStatus('warming');
    if (type === 'ready') this._publishStatus(active.mode === 'wav' ? 'warming' : 'recording');
    if (type === 'microphone_started') {
      active.captureStarted = true;
      this._publishStatus('recording');
      return;
    }
    if (type === 'final' && active.mode !== 'wav') this._publishStatus('releasing');
    if (type === 'error') {
      this._publishStatus('error', String(event.code || 'voice_error'));
      if (active.mode === 'microphone' && active.captureStarted) {
        active.faulted = true;
        active.cancelled = true;
      }
    }
    this.onDeliver({ ...event, surface: active.surface, reused: event.reused === true });
    if (
      type === 'microphone_stopped'
      || (type === 'error' && (active.mode === 'wav' || !active.captureStarted))
      || (type === 'final' && active.mode === 'wav')
    ) {
      this.active = null;
      if (type === 'microphone_stopped' || type === 'final') this._publishStatus('ready');
    }
  }

  _publishStatus(state, errorCode = null, workerEvent = null) {
    this.onStatus({
      state,
      errorCode: safeToken(errorCode),
      residentEnabled: this.config?.enabled === true,
      workerEvent: projectWorkerEvent(workerEvent),
    });
  }
}

function safeToken(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const token = String(value);
  return /^[a-z0-9._-]{1,120}$/i.test(token) ? token : fallback;
}

function projectWorkerEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const projected = {
    type: safeToken(event.type),
    state: safeToken(event.state),
    reason: safeToken(event.reason),
    engine: safeToken(event.engine),
    reused: event.reused === true,
  };
  const memoryMb = Number(event.memory_mb);
  if (Number.isFinite(memoryMb) && memoryMb >= 0) projected.memory_mb = memoryMb;
  return projected;
}

function normalizeConfig(value = {}) {
  if (!Number.isInteger(value.memoryLimitMb) || value.memoryLimitMb < 128 || value.memoryLimitMb > 16384) {
    throw new TypeError('memoryLimitMb must be an integer from 128 to 16384');
  }
  if (!Number.isInteger(value.idleUnloadMs) || value.idleUnloadMs < 10000 || value.idleUnloadMs > 3600000) {
    throw new TypeError('idleUnloadMs must be an integer from 10000 to 3600000');
  }
  return {
    enabled: value.enabled !== false,
    memoryLimitMb: value.memoryLimitMb,
    idleUnloadMs: value.idleUnloadMs,
    root: String(value.root || ''),
    settingsPath: String(value.settingsPath || ''),
    pythonExecutable: String(value.pythonExecutable || ''),
    pythonIsolated: value.pythonIsolated === true,
    modelName: String(value.modelName || 'tiny'),
  };
}

function validSessionValue(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && value === value.trim();
}

function validSurface(value) {
  return value === 'stage' || value === 'overlay';
}

module.exports = { VoiceResidentRuntime, normalizeConfig };
