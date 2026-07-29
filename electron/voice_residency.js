'use strict';

const STATES = Object.freeze({
  UNLOADED: 'unloaded',
  LOADING: 'loading',
  READY: 'ready',
  BUSY: 'busy',
  IDLE: 'idle',
  UNLOADING: 'unloading',
  ERROR: 'error',
});

class VoiceResidencyController {
  constructor({ memoryLimitMb, idleUnloadMs, clock = Date.now } = {}) {
    if (!isNonNegativeFinite(memoryLimitMb) || !isNonNegativeFinite(idleUnloadMs)) {
      throw new TypeError('memoryLimitMb and idleUnloadMs must be non-negative finite numbers');
    }
    if (typeof clock !== 'function') {
      throw new TypeError('clock must be a function');
    }

    this.memoryLimitMb = memoryLimitMb;
    this.idleUnloadMs = idleUnloadMs;
    this.clock = clock;
    this.state = STATES.UNLOADED;
    this.estimatedMb = null;
    this.actualMb = null;
    this.activeSessions = 0;
    this.idleSinceMs = null;
    this.lastTouchedMs = this._now();
    this.unloadRequested = false;
    this.errorCode = null;
  }

  requestLoad(estimatedMb) {
    if (!isNonNegativeFinite(estimatedMb)) {
      return this._fail('invalid_estimated_memory');
    }
    if (this.state === STATES.LOADING) {
      return this.estimatedMb === estimatedMb;
    }
    if ([STATES.READY, STATES.BUSY, STATES.IDLE].includes(this.state)) {
      return this.estimatedMb === estimatedMb;
    }
    if (this.state !== STATES.UNLOADED) {
      return false;
    }

    this.estimatedMb = estimatedMb;
    this.lastTouchedMs = this._now();
    if (estimatedMb > this.memoryLimitMb) {
      return this._fail('memory_limit_exceeded');
    }

    this.state = STATES.LOADING;
    return true;
  }

  loaded(actualMb) {
    if (!isNonNegativeFinite(actualMb)) {
      return this._fail('invalid_actual_memory');
    }
    if ([STATES.READY, STATES.BUSY, STATES.IDLE, STATES.UNLOADING].includes(this.state)) {
      return this.actualMb === actualMb;
    }
    if (this.state !== STATES.LOADING) {
      return this._fail('loaded_without_request');
    }

    this.actualMb = actualMb;
    this.lastTouchedMs = this._now();
    if (actualMb > this.memoryLimitMb) {
      this.state = STATES.UNLOADING;
      this.unloadRequested = true;
      return false;
    }

    this.state = STATES.READY;
    return true;
  }

  beginSession() {
    if (this.state === STATES.BUSY) {
      return true;
    }
    if (this.state !== STATES.READY && this.state !== STATES.IDLE) {
      return this._fail('session_before_ready');
    }

    this.state = STATES.BUSY;
    this.activeSessions = 1;
    this.idleSinceMs = null;
    this.lastTouchedMs = this._now();
    return true;
  }

  endSession() {
    if (this.state === STATES.IDLE) {
      return true;
    }
    if (this.state !== STATES.BUSY) {
      return this._fail('session_end_without_begin');
    }

    const now = this._now();
    this.state = STATES.IDLE;
    this.activeSessions = 0;
    this.idleSinceMs = now;
    this.lastTouchedMs = now;
    return true;
  }

  touch() {
    if (![STATES.READY, STATES.BUSY, STATES.IDLE].includes(this.state)) {
      return false;
    }

    const now = this._now();
    this.lastTouchedMs = now;
    if (this.state === STATES.IDLE) {
      this.idleSinceMs = now;
    }
    return true;
  }

  tick() {
    if (this.state !== STATES.IDLE) {
      return false;
    }

    const now = this._now();
    if (now - this.idleSinceMs < this.idleUnloadMs) {
      return false;
    }

    this.state = STATES.UNLOADING;
    this.unloadRequested = true;
    this.lastTouchedMs = now;
    return true;
  }

  unloaded() {
    if (this.state !== STATES.UNLOADING && this.state !== STATES.ERROR && this.state !== STATES.UNLOADED) {
      return false;
    }

    this.state = STATES.UNLOADED;
    this.estimatedMb = null;
    this.actualMb = null;
    this.activeSessions = 0;
    this.idleSinceMs = null;
    this.lastTouchedMs = this._now();
    this.unloadRequested = false;
    this.errorCode = null;
    return true;
  }

  snapshot() {
    return {
      state: this.state,
      memoryLimitMb: this.memoryLimitMb,
      idleUnloadMs: this.idleUnloadMs,
      estimatedMb: this.estimatedMb,
      actualMb: this.actualMb,
      activeSessions: this.activeSessions,
      idleSinceMs: this.idleSinceMs,
      lastTouchedMs: this.lastTouchedMs,
      unloadRequested: this.unloadRequested,
      errorCode: this.errorCode,
    };
  }

  _fail(errorCode) {
    if (this.state === STATES.ERROR) {
      return false;
    }
    this.state = STATES.ERROR;
    this.activeSessions = 0;
    this.idleSinceMs = null;
    this.unloadRequested = false;
    this.errorCode = errorCode;
    this.lastTouchedMs = this._now();
    return false;
  }

  _now() {
    const now = this.clock();
    if (!isNonNegativeFinite(now)) {
      throw new TypeError('clock must return a non-negative finite number');
    }
    return now;
  }
}

function isNonNegativeFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

module.exports = { STATES, VoiceResidencyController };
