const assert = require('assert');
const { initialState, transition, STATES } = require('../electron/stage_state');

// --- initial state + config -------------------------------------------------
const start = initialState();
assert.strictEqual(start.name, 'hidden');
assert.strictEqual(start.target, null);
assert.strictEqual(start.transcript, '');
assert.strictEqual(start.result, null);
assert.strictEqual(start.error, null);
assert.strictEqual(start.config.reducedMotion, false);

const reduced = initialState({ reducedMotion: true });
assert.strictEqual(reduced.config.reducedMotion, true);

assert.deepStrictEqual(STATES, [
  'hidden', 'targeting', 'frozen', 'capsule-voice', 'capsule-text',
  'processing', 'result', 'error', 'dismissing',
]);

// --- happy path: voice branch ----------------------------------------------
let state = initialState();
const frozenSnapshot = JSON.parse(JSON.stringify(state));

state = transition(state, { type: 'WAKE', target: { x: 10, y: 20, width: 300, height: 40 } });
assert.strictEqual(state.name, 'targeting');
assert.deepStrictEqual(state.target, { x: 10, y: 20, width: 300, height: 40 });

state = transition(state, { type: 'TARGET_MOVE', target: { x: 50, y: 60, width: 120, height: 30 } });
assert.strictEqual(state.name, 'targeting');
assert.deepStrictEqual(state.target, { x: 50, y: 60, width: 120, height: 30 });

state = transition(state, { type: 'FREEZE', target: { x: 55, y: 62, width: 118, height: 28 } });
assert.strictEqual(state.name, 'frozen');
assert.deepStrictEqual(state.target, { x: 55, y: 62, width: 118, height: 28 });

state = transition(state, { type: 'OPEN_CAPSULE', mode: 'voice' });
assert.strictEqual(state.name, 'capsule-voice');
assert.strictEqual(state.inputMode, 'voice');
assert.deepStrictEqual(state.target, { x: 55, y: 62, width: 118, height: 28 }, 'capsule keeps frozen target');

state = transition(state, { type: 'TRANSCRIPT', transcript: '翻译这段话' });
assert.strictEqual(state.name, 'capsule-voice');
assert.strictEqual(state.transcript, '翻译这段话');

state = transition(state, { type: 'SUBMIT' });
assert.strictEqual(state.name, 'processing');
assert.strictEqual(state.command, '翻译这段话', 'submit defaults command to transcript');

state = transition(state, { type: 'RESULT', result: { kind: 'text', answer: 'done' } });
assert.strictEqual(state.name, 'result');
assert.deepStrictEqual(state.result, { kind: 'text', answer: 'done' });

state = transition(state, { type: 'ACTION_START', command: 'confirm result action' });
assert.strictEqual(state.name, 'processing');
assert.strictEqual(state.command, 'confirm result action');
assert.strictEqual(state.result, null);

state = transition(state, { type: 'RESULT', result: { kind: 'text', answer: 'confirmed' } });
assert.strictEqual(state.name, 'result');

state = transition(state, { type: 'DISMISS' });
assert.strictEqual(state.name, 'dismissing');

state = transition(state, { type: 'HIDDEN' });
assert.strictEqual(state.name, 'hidden');
assert.strictEqual(state.target, null, 'hidden clears target payload');
assert.strictEqual(state.transcript, '', 'hidden clears transcript');
assert.strictEqual(state.result, null, 'hidden clears result');

// transition must not mutate its input
assert.deepStrictEqual(JSON.parse(JSON.stringify(initialState())), frozenSnapshot);

// --- text branch -------------------------------------------------------------
let text = transition(initialState(), { type: 'WAKE' });
text = transition(text, { type: 'FREEZE', target: { x: 1, y: 2, width: 3, height: 4 } });
text = transition(text, { type: 'OPEN_CAPSULE', mode: 'text' });
assert.strictEqual(text.name, 'capsule-text');
assert.strictEqual(text.inputMode, 'text');

// mode switch voice <-> text is legal while capsule is open
const switched = transition(text, { type: 'OPEN_CAPSULE', mode: 'voice' });
assert.strictEqual(switched.name, 'capsule-voice');

text = transition(text, { type: 'TRANSCRIPT', transcript: 'summarize this' });
text = transition(text, { type: 'SUBMIT', command: 'summarize this politely' });
assert.strictEqual(text.name, 'processing');
assert.strictEqual(text.command, 'summarize this politely', 'explicit command wins over transcript');

// --- error path --------------------------------------------------------------
let bad = transition(text, { type: 'ERROR', error: { message: 'whisper timeout' } });
assert.strictEqual(bad.name, 'error');
assert.deepStrictEqual(bad.error, { message: 'whisper timeout' });
bad = transition(bad, { type: 'DISMISS' });
assert.strictEqual(bad.name, 'dismissing');
bad = transition(bad, { type: 'HIDDEN' });
assert.strictEqual(bad.name, 'hidden');
assert.strictEqual(bad.error, null, 'hidden clears error payload');

// processing can be cancelled
const cancelled = transition(text, { type: 'DISMISS' });
assert.strictEqual(cancelled.name, 'dismissing');

const completedSilently = transition(text, { type: 'COMPLETE' });
assert.strictEqual(completedSilently.name, 'dismissing',
  'verified execution collapses the capsule without entering result state');

// --- illegal transitions are no-ops (same reference) -------------------------
const hidden = initialState();
assert.strictEqual(transition(hidden, { type: 'SUBMIT' }), hidden);
assert.strictEqual(transition(hidden, { type: 'RESULT', result: {} }), hidden);
assert.strictEqual(transition(hidden, { type: 'HIDDEN' }), hidden);
assert.strictEqual(transition(hidden, { type: 'NO_SUCH_EVENT' }), hidden);
assert.strictEqual(transition(hidden, null), hidden);
assert.strictEqual(transition(hidden, {}), hidden);

const targeting = transition(initialState(), { type: 'WAKE' });
assert.strictEqual(transition(targeting, { type: 'OPEN_CAPSULE', mode: 'voice' }), targeting, 'capsule requires frozen target first');

// --- direct RESULT/ERROR shortcuts (runtime-issue capture, early failures) ---
// A runtime-issue circle capture delivers a result with no capsule round-trip.
const directResult = transition(targeting, { type: 'RESULT', result: { kind: 'inline', answer: 'ok' } });
assert.strictEqual(directResult.name, 'result');
assert.deepStrictEqual(directResult.result, { kind: 'inline', answer: 'ok' });
// An ineligible selection errors straight from frozen.
const frozenEarly = transition(targeting, { type: 'FREEZE', target: { x: 0, y: 0, width: 5, height: 5 } });
const earlyError = transition(frozenEarly, { type: 'ERROR', error: { message: '选区不可用' } });
assert.strictEqual(earlyError.name, 'error');
assert.deepStrictEqual(earlyError.error, { message: '选区不可用' });
// Dictation failure surfaces from the open capsule without a SUBMIT.
const capsuleEarly = transition(frozenEarly, { type: 'OPEN_CAPSULE', mode: 'voice' });
const capsuleError = transition(capsuleEarly, { type: 'ERROR', error: { message: 'whisper missing' } });
assert.strictEqual(capsuleError.name, 'error');

const resultState = transition(text, { type: 'RESULT', result: { kind: 'text' } });
assert.strictEqual(transition(resultState, { type: 'FREEZE', target: { x: 0, y: 0, width: 1, height: 1 } }), resultState);
assert.strictEqual(transition(resultState, { type: 'WAKE' }), resultState);

const dismissing = transition(resultState, { type: 'DISMISS' });
assert.strictEqual(transition(dismissing, { type: 'SUBMIT' }), dismissing);

// --- reduced motion flag flows through every transition ----------------------
let rm = initialState({ reducedMotion: true });
rm = transition(rm, { type: 'WAKE' });
rm = transition(rm, { type: 'FREEZE', target: { x: 0, y: 0, width: 10, height: 10 } });
rm = transition(rm, { type: 'OPEN_CAPSULE', mode: 'voice' });
rm = transition(rm, { type: 'SUBMIT' });
assert.strictEqual(rm.config.reducedMotion, true, 'config survives the whole path');

// SET_REDUCED_MOTION is legal from any state and never changes the state name
const toggled = transition(rm, { type: 'SET_REDUCED_MOTION', value: false });
assert.strictEqual(toggled.name, rm.name);
assert.strictEqual(toggled.config.reducedMotion, false);
const toggledHidden = transition(initialState(), { type: 'SET_REDUCED_MOTION', value: true });
assert.strictEqual(toggledHidden.name, 'hidden');
assert.strictEqual(toggledHidden.config.reducedMotion, true);

// --- Conversation thread -----------------------------------------------------
// A follow-up must never cost the user the question they already asked. These
// assertions pin the thread: the ask is recorded when it is submitted (so it is
// on screen while the answer is still coming), the answer settles that same
// turn, and reopening the composer leaves the finished turns alone.

function threadAtCapsule() {
  let s = transition(initialState(), { type: 'WAKE', target: { x: 0, y: 0, width: 10, height: 10 } });
  s = transition(s, { type: 'FREEZE', target: { x: 0, y: 0, width: 10, height: 10 } });
  return transition(s, { type: 'OPEN_CAPSULE', mode: 'text' });
}

let thread = threadAtCapsule();
assert.deepStrictEqual(thread.turns, [], 'a fresh session starts with no turns');

thread = transition(thread, { type: 'SUBMIT', command: '翻译这段' });
assert.strictEqual(thread.turns.length, 1, 'submitting opens a turn immediately');
assert.strictEqual(thread.turns[0].ask, '翻译这段', 'the question is recorded before the answer exists');
assert.strictEqual(thread.turns[0].status, 'pending');

thread = transition(thread, { type: 'RESULT', result: { text: 'translate this' } });
assert.strictEqual(thread.turns.length, 1, 'the answer settles the open turn instead of adding one');
assert.strictEqual(thread.turns[0].status, 'done');
assert.deepStrictEqual(thread.turns[0].result, { text: 'translate this' });
assert.strictEqual(thread.turns[0].ask, '翻译这段', 'settling must not erase the ask');

// The follow-up: this is the regression that mattered — reopening the composer
// used to null the result, so the previous exchange vanished from the screen.
thread = transition(thread, { type: 'OPEN_CAPSULE', mode: 'text' });
assert.strictEqual(thread.name, 'capsule-text');
assert.strictEqual(thread.turns.length, 1, 'a follow-up must not discard the finished turn');
assert.strictEqual(thread.turns[0].ask, '翻译这段');
assert.deepStrictEqual(thread.turns[0].result, { text: 'translate this' });

thread = transition(thread, { type: 'SUBMIT', command: '第二句什么意思' });
assert.strictEqual(thread.turns.length, 2, 'the follow-up appends');
assert.strictEqual(thread.turns[1].ask, '第二句什么意思');
assert.notStrictEqual(thread.turns[0].id, thread.turns[1].id, 'turn ids must be distinct');

thread = transition(thread, { type: 'ERROR', error: { message: 'nope' } });
assert.strictEqual(thread.turns.length, 2);
assert.strictEqual(thread.turns[1].status, 'failed', 'a failed follow-up settles as failed');
assert.deepStrictEqual(thread.turns[1].error, { message: 'nope' });
assert.strictEqual(thread.turns[0].status, 'done', 'an earlier success is untouched by a later failure');

// Chip actions run against the same thread.
let chipThread = threadAtCapsule();
chipThread = transition(chipThread, { type: 'SUBMIT', command: '总结' });
chipThread = transition(chipThread, { type: 'RESULT', result: { text: 'a' } });
chipThread = transition(chipThread, { type: 'ACTION_START', command: '发到日历' });
assert.strictEqual(chipThread.name, 'processing');
assert.strictEqual(chipThread.turns.length, 2, 'a suggested action opens its own turn');
assert.strictEqual(chipThread.turns[1].ask, '发到日历');
assert.strictEqual(chipThread.turns[1].status, 'pending');

// A result with no preceding ask still lands in the thread (runtime-issue
// capture, ineligible selection) so the surface never renders an orphan card.
let direct = transition(initialState(), { type: 'WAKE', target: { x: 0, y: 0, width: 4, height: 4 } });
direct = transition(direct, { type: 'RESULT', result: { text: 'captured' } });
assert.strictEqual(direct.turns.length, 1, 'an unsolicited result opens and closes its own turn');
assert.strictEqual(direct.turns[0].ask, '');
assert.strictEqual(direct.turns[0].status, 'done');

// Dismissing ends the session; the next wake starts an empty thread.
let ended = transition(thread, { type: 'DISMISS' });
ended = transition(ended, { type: 'HIDDEN' });
assert.deepStrictEqual(ended.turns, [], 'a new session must not inherit the previous thread');
assert.strictEqual(ended.nextTurnId, 1);

console.log('stage state test ok');
