'use strict';

const MAX_PHASE_SAMPLES = 32;
let nextSessionNumber = 1;
type FocusOptions = { expectedHwnd: number; sessionId?: string; startedAt?: number };
type PhaseSample = { phase: string; hwnd: number; timestamp: number };
type Violation = { phase: string; expectedHwnd: number; observedHwnd: number; timestamp: number };

class VoiceFocusGuard {
  static MAX_PHASE_SAMPLES = MAX_PHASE_SAMPLES;

  _sessionId: string;
  _expectedHwnd: number;
  _startedAt: number;
  _phases: PhaseSample[];
  _phaseNames: Set<string>;
  _violationCount: number;
  _violations: Violation[];
  _failed: boolean;
  _finished: boolean;
  _finishedAt: number | null;

  constructor(options: FocusOptions | number) {
    const normalized = normalizeOptions(options);
    this._sessionId = normalized.sessionId;
    this._expectedHwnd = normalized.expectedHwnd;
    this._startedAt = normalized.startedAt;
    this._phases = [];
    this._phaseNames = new Set();
    this._violationCount = 0;
    this._violations = [];
    this._failed = false;
    this._finished = false;
    this._finishedAt = null;
  }

  observe(phase: string, hwnd: number, timestamp = Date.now()): boolean {
    if (this._finished) {
      throw new TypeError('VoiceFocusGuard has already finished');
    }

    validatePhase(phase);
    validateTimestamp(timestamp, 'timestamp');
    validateObservedHwnd(hwnd);

    if (this._failed) {
      return false;
    }

    if (hwnd === 0 || hwnd !== this._expectedHwnd) {
      this._violationCount += 1;
      this._violations.push({
        phase,
        expectedHwnd: this._expectedHwnd,
        observedHwnd: hwnd,
        timestamp,
      });
      this._failed = true;
      return false;
    }

    if (!this._phaseNames.has(phase) && this._phases.length < MAX_PHASE_SAMPLES) {
      this._phaseNames.add(phase);
      this._phases.push({ phase, hwnd, timestamp });
    }

    return true;
  }

  finish(timestamp = Date.now()) {
    validateTimestamp(timestamp, 'timestamp');

    if (!this._finished) {
      this._finished = true;
      this._finishedAt = timestamp;
    }

    return this._evidence();
  }

  _evidence() {
    return {
      sessionId: this._sessionId,
      expectedHwnd: this._expectedHwnd,
      contract: 'foreground-hwnd-stable',
      invariant: this._violationCount === 0,
      violationCount: this._violationCount,
      violations: this._violations.map((item) => ({ ...item })),
      phases: this._phases.map(({ phase, hwnd, timestamp }) => ({ phase, hwnd, timestamp })),
      startedAt: this._startedAt,
      finishedAt: this._finishedAt,
    };
  }
}

function normalizeOptions(options: FocusOptions | number): Required<FocusOptions> {
  const input = Number.isSafeInteger(options) ? { expectedHwnd: options } : options;

  if (!isPlainObject(input)) {
    throw new TypeError('options must be an object or a positive HWND');
  }

  const {
    expectedHwnd,
    sessionId = `voice-focus-${nextSessionNumber++}`,
    startedAt = Date.now(),
  } = input;
  validateExpectedHwnd(expectedHwnd);
  validateSessionId(sessionId);
  validateTimestamp(startedAt, 'startedAt');

  return { expectedHwnd, sessionId, startedAt };
}

function validateExpectedHwnd(hwnd: unknown): asserts hwnd is number {
  if (typeof hwnd !== 'number' || !Number.isSafeInteger(hwnd) || hwnd <= 0) {
    throw new TypeError('expectedHwnd must be a non-zero safe integer');
  }
}

function validateObservedHwnd(hwnd: unknown): asserts hwnd is number {
  if (typeof hwnd !== 'number' || !Number.isSafeInteger(hwnd) || hwnd < 0) {
    throw new TypeError('hwnd must be a non-negative safe integer');
  }
}

function validateTimestamp(timestamp: unknown, name: string): asserts timestamp is number {
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function validateSessionId(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) {
    throw new TypeError('sessionId must be a non-empty string of at most 128 characters');
  }
}

function validatePhase(phase: unknown): asserts phase is string {
  if (typeof phase !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(phase)) {
    throw new TypeError('phase must be a lowercase semantic identifier');
  }
}

function isPlainObject(value: unknown): value is FocusOptions {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

module.exports = { VoiceFocusGuard };
