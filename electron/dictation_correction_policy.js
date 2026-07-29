'use strict';

const STATES = Object.freeze({
  IDLE: 'idle',
  FINAL_PENDING: 'final_pending',
  CORRECTING: 'correcting',
  REPEATING: 'repeating',
  SUBMITTED: 'submitted',
  CANCELLED: 'cancelled',
});

const STRATEGIES = Object.freeze({
  VERBATIM: 'verbatim',
  CLEANUP: 'cleanup',
  PROMPT: 'prompt',
});

const CAPSULE_SEMANTIC = 'dictation-final';

class DictationCorrectionPolicy {
  constructor({ capsuleId, strategy = STRATEGIES.VERBATIM } = {}) {
    if (typeof capsuleId !== 'string' || capsuleId.length === 0 || capsuleId.length > 128) {
      throw new TypeError('capsuleId must be a non-empty string of at most 128 characters');
    }
    if (!Object.values(STRATEGIES).includes(strategy)) {
      throw new TypeError('strategy must be verbatim, cleanup, or prompt');
    }

    this.capsuleId = capsuleId;
    this.strategy = strategy;
    this.state = STATES.IDLE;
    this._text = '';
  }

  dispatch(event = {}) {
    const type = event && typeof event.type === 'string' ? event.type : '';

    if (this.state === STATES.SUBMITTED || this.state === STATES.CANCELLED) {
      return this._result();
    }
    if (type === 'final') {
      return this._acceptFinal(event.text);
    }
    if (type === 'correct' && this.state === STATES.FINAL_PENDING) {
      this.state = STATES.CORRECTING;
      return this._result(['open-correction']);
    }
    if (type === 'replace' && this.state === STATES.CORRECTING) {
      this._text = validateText(event.text);
      this.state = STATES.FINAL_PENDING;
      return this._result(['update-capsule']);
    }
    if (type === 'repeat' && this.state === STATES.FINAL_PENDING) {
      this.state = STATES.REPEATING;
      return this._result(['restart-dictation']);
    }
    if (type === 'cancel') {
      return this._cancel();
    }
    if (type === 'submit' && this.state === STATES.FINAL_PENDING) {
      this.state = STATES.SUBMITTED;
      return this._result([{ type: 'submit', strategy: this.strategy, text: this._text }]);
    }
    return this._result();
  }

  _acceptFinal(text) {
    if (this.state !== STATES.IDLE && this.state !== STATES.REPEATING) {
      return this._result();
    }
    const wasRepeating = this.state === STATES.REPEATING;
    this._text = validateText(text);
    this.state = STATES.FINAL_PENDING;
    return this._result([wasRepeating ? 'update-capsule' : 'show-capsule']);
  }

  _cancel() {
    if (![STATES.FINAL_PENDING, STATES.CORRECTING, STATES.REPEATING].includes(this.state)) {
      return this._result();
    }

    const effects = this.state === STATES.REPEATING
      ? ['stop-dictation', 'dismiss-capsule']
      : ['dismiss-capsule'];
    this.state = STATES.CANCELLED;
    return this._result(effects);
  }

  _result(effects = []) {
    const capsuleIsActive = [STATES.FINAL_PENDING, STATES.CORRECTING, STATES.REPEATING].includes(this.state);
    return {
      state: this.state,
      capsule: capsuleIsActive ? { id: this.capsuleId, semantic: CAPSULE_SEMANTIC } : null,
      text: this._text,
      strategy: this.strategy,
      effects: effects.map((effect) => (typeof effect === 'object' ? { ...effect } : effect)),
    };
  }
}

function validateText(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 10000) {
    throw new TypeError('final text must be a non-empty string of at most 10000 characters');
  }
  return text;
}

module.exports = { DictationCorrectionPolicy, STATES, STRATEGIES };
