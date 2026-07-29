'use strict';

const assert = require('assert');
const { VoiceTriggerPolicy, STATES, STRATEGIES } = require('../electron/voice_trigger_policy');

function transition(machine, event) {
  return machine.dispatch(event);
}

(function autoStartsOnlyWhenCapsuleIsReady() {
  const machine = new VoiceTriggerPolicy({ strategy: STRATEGIES.AUTO });
  assert.strictEqual(machine.state, STATES.IDLE);
  assert.deepStrictEqual(transition(machine, { type: 'capsule-ready', t: 1 }), {
    state: STATES.LISTENING,
    effects: ['start'],
  });
  assert.deepStrictEqual(transition(machine, { type: 'capsule-ready', t: 2 }), {
    state: STATES.LISTENING,
    effects: [],
  });
  assert.deepStrictEqual(transition(machine, { type: 'cancel', t: 3 }), {
    state: STATES.CANCELLED,
    effects: ['stop'],
  });
}());

(function pushToTalkStartsOnPressAndSubmitsImmediatelyOnRelease() {
  const machine = new VoiceTriggerPolicy({ strategy: STRATEGIES.PUSH_TO_TALK });
  assert.deepStrictEqual(transition(machine, { type: 'press', t: 10 }), {
    state: STATES.LISTENING,
    effects: ['start'],
  });
  assert.deepStrictEqual(transition(machine, { type: 'release', t: 11 }), {
    state: STATES.SUBMITTED,
    effects: ['stop', 'submit'],
  });
  assert.deepStrictEqual(transition(machine, { type: 'release', t: 12 }), {
    state: STATES.SUBMITTED,
    effects: [],
  });
}());

(function hoverStartsAtTheConfiguredThresholdWhileStillOverTarget() {
  const machine = new VoiceTriggerPolicy({ strategy: STRATEGIES.HOVER, hoverThresholdMs: 400 });
  assert.deepStrictEqual(transition(machine, { type: 'enter', t: 100 }), {
    state: STATES.IDLE,
    effects: [],
  });
  assert.deepStrictEqual(transition(machine, { type: 'tick', t: 499 }), {
    state: STATES.IDLE,
    effects: [],
  });
  assert.deepStrictEqual(transition(machine, { type: 'tick', t: 500 }), {
    state: STATES.LISTENING,
    effects: ['start'],
  });
}());

(function hoverQuickPassNeverStartsAndLeaveNeverSubmits() {
  const machine = new VoiceTriggerPolicy({ strategy: STRATEGIES.HOVER, hoverThresholdMs: 400 });
  transition(machine, { type: 'enter', t: 0 });
  assert.deepStrictEqual(transition(machine, { type: 'leave', t: 399 }), {
    state: STATES.CANCELLED,
    effects: [],
  });
  assert.deepStrictEqual(transition(machine, { type: 'tick', t: 500 }), {
    state: STATES.CANCELLED,
    effects: [],
  });
}());

(function hoverLeaveAndCancelStopWithoutSubmitting() {
  const leaving = new VoiceTriggerPolicy({ strategy: STRATEGIES.HOVER, hoverThresholdMs: 1 });
  transition(leaving, { type: 'enter', t: 0 });
  transition(leaving, { type: 'tick', t: 1 });
  assert.deepStrictEqual(transition(leaving, { type: 'leave', t: 2 }), {
    state: STATES.CANCELLED,
    effects: ['stop'],
  });

  const cancelling = new VoiceTriggerPolicy({ strategy: STRATEGIES.PUSH_TO_TALK });
  transition(cancelling, { type: 'press', t: 0 });
  assert.deepStrictEqual(transition(cancelling, { type: 'cancel', t: 1 }), {
    state: STATES.CANCELLED,
    effects: ['stop'],
  });
}());

(function illegalSequencesFailClosedAndEventsDoNotCarryContent() {
  const machine = new VoiceTriggerPolicy({ strategy: STRATEGIES.PUSH_TO_TALK });
  assert.deepStrictEqual(transition(machine, { type: 'release', t: 0, transcript: 'must not be retained' }), {
    state: STATES.IDLE,
    effects: [],
  });
  assert.deepStrictEqual(transition(machine, { type: 'capsule-ready', t: 1 }), {
    state: STATES.IDLE,
    effects: [],
  });
  assert.deepStrictEqual(Object.keys(machine).sort(), ['_hoverEnteredAt', '_pointerOverTarget', 'state', 'strategy']);
  const hover = new VoiceTriggerPolicy({ strategy: STRATEGIES.HOVER });
  assert.throws(() => transition(hover, { type: 'enter' }), /timestamp/);
}());

console.log('voice_trigger_policy_test: PASS');
