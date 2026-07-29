'use strict';

const assert = require('assert');
const {
  DictationCorrectionPolicy,
  STATES,
  STRATEGIES,
} = require('../electron/dictation_correction_policy');

(function defaultVerbatimPolicyKeepsTheFinalTextUntouchedUntilSubmission() {
  const machine = new DictationCorrectionPolicy({ capsuleId: 'voice-24' });
  const rawFinal = 'um send the draft to Maira';

  const final = machine.dispatch({ type: 'final', text: rawFinal });
  assert.deepStrictEqual(final, {
    state: STATES.FINAL_PENDING,
    capsule: { id: 'voice-24', semantic: 'dictation-final' },
    text: rawFinal,
    strategy: STRATEGIES.VERBATIM,
    effects: ['show-capsule'],
  });

  const submitted = machine.dispatch({ type: 'submit' });
  assert.deepStrictEqual(submitted, {
    state: STATES.SUBMITTED,
    capsule: null,
    text: rawFinal,
    strategy: STRATEGIES.VERBATIM,
    effects: [{ type: 'submit', strategy: STRATEGIES.VERBATIM, text: rawFinal }],
  });
}());

(function correctionIsAvailableBeforeSubmissionAndKeepsTheSameCapsule() {
  const machine = new DictationCorrectionPolicy({ capsuleId: 'voice-24' });
  machine.dispatch({ type: 'final', text: 'send it to Maira' });

  assert.deepStrictEqual(machine.dispatch({ type: 'correct' }), {
    state: STATES.CORRECTING,
    capsule: { id: 'voice-24', semantic: 'dictation-final' },
    text: 'send it to Maira',
    strategy: STRATEGIES.VERBATIM,
    effects: ['open-correction'],
  });
  assert.deepStrictEqual(machine.dispatch({ type: 'replace', text: 'send it to Mara' }), {
    state: STATES.FINAL_PENDING,
    capsule: { id: 'voice-24', semantic: 'dictation-final' },
    text: 'send it to Mara',
    strategy: STRATEGIES.VERBATIM,
    effects: ['update-capsule'],
  });
}());

(function repeatReusesTheCapsuleAndMayBeCancelledBeforeAnySubmission() {
  const machine = new DictationCorrectionPolicy({ capsuleId: 'voice-24' });
  machine.dispatch({ type: 'final', text: 'first attempt' });

  assert.deepStrictEqual(machine.dispatch({ type: 'repeat' }), {
    state: STATES.REPEATING,
    capsule: { id: 'voice-24', semantic: 'dictation-final' },
    text: 'first attempt',
    strategy: STRATEGIES.VERBATIM,
    effects: ['restart-dictation'],
  });
  assert.deepStrictEqual(machine.dispatch({ type: 'cancel' }), {
    state: STATES.CANCELLED,
    capsule: null,
    text: 'first attempt',
    strategy: STRATEGIES.VERBATIM,
    effects: ['stop-dictation', 'dismiss-capsule'],
  });
}());

(function finalAfterRepeatUpdatesTheExistingCapsuleInsteadOfCreatingAnotherSemanticSurface() {
  const machine = new DictationCorrectionPolicy({ capsuleId: 'voice-24' });
  machine.dispatch({ type: 'final', text: 'first attempt' });
  machine.dispatch({ type: 'repeat' });

  assert.deepStrictEqual(machine.dispatch({ type: 'final', text: 'second attempt' }), {
    state: STATES.FINAL_PENDING,
    capsule: { id: 'voice-24', semantic: 'dictation-final' },
    text: 'second attempt',
    strategy: STRATEGIES.VERBATIM,
    effects: ['update-capsule'],
  });
}());

(function cancellationAndEditsFailClosedAfterSubmission() {
  const machine = new DictationCorrectionPolicy({ capsuleId: 'voice-24' });
  machine.dispatch({ type: 'final', text: 'keep this' });
  machine.dispatch({ type: 'submit' });

  assert.deepStrictEqual(machine.dispatch({ type: 'correct' }), {
    state: STATES.SUBMITTED,
    capsule: null,
    text: 'keep this',
    strategy: STRATEGIES.VERBATIM,
    effects: [],
  });
  assert.deepStrictEqual(machine.dispatch({ type: 'cancel' }), {
    state: STATES.SUBMITTED,
    capsule: null,
    text: 'keep this',
    strategy: STRATEGIES.VERBATIM,
    effects: [],
  });
}());

(function cleanupAndPromptAreExplicitPoliciesRatherThanImplicitRewrites() {
  const cleanup = new DictationCorrectionPolicy({
    capsuleId: 'cleanup',
    strategy: STRATEGIES.CLEANUP,
  });
  cleanup.dispatch({ type: 'final', text: 'hello  world' });
  assert.deepStrictEqual(cleanup.dispatch({ type: 'submit' }).effects, [
    { type: 'submit', strategy: STRATEGIES.CLEANUP, text: 'hello  world' },
  ]);

  const prompt = new DictationCorrectionPolicy({
    capsuleId: 'prompt',
    strategy: STRATEGIES.PROMPT,
  });
  prompt.dispatch({ type: 'final', text: 'make it friendly' });
  assert.deepStrictEqual(prompt.dispatch({ type: 'submit' }).effects, [
    { type: 'submit', strategy: STRATEGIES.PROMPT, text: 'make it friendly' },
  ]);
}());

console.log('dictation_correction_policy_test: PASS');
