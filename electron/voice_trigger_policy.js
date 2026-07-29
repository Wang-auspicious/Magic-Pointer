'use strict';

(() => {
const STATES = Object.freeze({
  IDLE: 'idle',
  LISTENING: 'listening',
  SUBMITTED: 'submitted',
  CANCELLED: 'cancelled',
});

const STRATEGIES = Object.freeze({
  AUTO: 'auto',
  PUSH_TO_TALK: 'push_to_talk',
  HOVER: 'hover',
});

const configurations = new WeakMap();

class VoiceTriggerPolicy {
  constructor({ strategy = STRATEGIES.AUTO, hoverThresholdMs = 500 } = {}) {
    if (!Object.values(STRATEGIES).includes(strategy)) {
      throw new TypeError('strategy must be auto, push_to_talk, or hover');
    }
    if (!Number.isSafeInteger(hoverThresholdMs) || hoverThresholdMs < 0) {
      throw new TypeError('hoverThresholdMs must be a non-negative safe integer');
    }

    this.strategy = strategy;
    this.state = STATES.IDLE;
    this._hoverEnteredAt = null;
    this._pointerOverTarget = false;
    configurations.set(this, { hoverThresholdMs });
  }

  dispatch(event = {}) {
    if (this.state === STATES.SUBMITTED || this.state === STATES.CANCELLED) {
      return this._result();
    }

    const type = event && typeof event.type === 'string' ? event.type : '';
    if (type === 'cancel') {
      return this._cancel();
    }

    if (this.strategy === STRATEGIES.AUTO) {
      return type === 'capsule-ready' ? this._start() : this._result();
    }
    if (this.strategy === STRATEGIES.PUSH_TO_TALK) {
      return this._dispatchPushToTalk(type);
    }
    return this._dispatchHover(type, event);
  }

  _dispatchPushToTalk(type) {
    if (type === 'press' && this.state === STATES.IDLE) {
      return this._start();
    }
    if (type === 'release' && this.state === STATES.LISTENING) {
      this.state = STATES.SUBMITTED;
      return this._result(['stop', 'submit']);
    }
    return this._result();
  }

  _dispatchHover(type, event) {
    if (type === 'enter' && this.state === STATES.IDLE) {
      this._pointerOverTarget = true;
      this._hoverEnteredAt = timestampOf(event);
      return this._result();
    }
    if (type === 'tick' && this.state === STATES.IDLE && this._pointerOverTarget) {
      if (event.overTarget === false) {
        return this._cancel();
      }
      const elapsed = timestampOf(event) - this._hoverEnteredAt;
      return elapsed >= configurations.get(this).hoverThresholdMs ? this._start() : this._result();
    }
    if (type === 'leave') {
      return this._cancel();
    }
    return this._result();
  }

  _start() {
    if (this.state !== STATES.IDLE) {
      return this._result();
    }
    this.state = STATES.LISTENING;
    return this._result(['start']);
  }

  _cancel() {
    const wasListening = this.state === STATES.LISTENING;
    this.state = STATES.CANCELLED;
    this._pointerOverTarget = false;
    this._hoverEnteredAt = null;
    return this._result(wasListening ? ['stop'] : []);
  }

  _result(effects = []) {
    return { state: this.state, effects };
  }
}

function timestampOf(event) {
  if (!Number.isSafeInteger(event.t) || event.t < 0) {
    throw new TypeError('hover events require a non-negative safe timestamp');
  }
  return event.t;
}

const voiceTriggerPolicyApi = { STATES, STRATEGIES, VoiceTriggerPolicy };
if (typeof module !== 'undefined' && module.exports) module.exports = voiceTriggerPolicyApi;
if (typeof globalThis !== 'undefined') globalThis.MagicPointerVoiceTrigger = voiceTriggerPolicyApi;
})();
