const assert = require('assert');
const { initialState, transition, STATES } = require('../electron/stage_state');

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

assert.deepStrictEqual(JSON.parse(JSON.stringify(initialState())), frozenSnapshot);

let text = transition(initialState(), { type: 'WAKE' });
text = transition(text, { type: 'FREEZE', target: { x: 1, y: 2, width: 3, height: 4 } });
text = transition(text, { type: 'OPEN_CAPSULE', mode: 'text' });
assert.strictEqual(text.name, 'capsule-text');
assert.strictEqual(text.inputMode, 'text');

const switched = transition(text, { type: 'OPEN_CAPSULE', mode: 'voice' });
assert.strictEqual(switched.name, 'capsule-voice');

text = transition(text, { type: 'TRANSCRIPT', transcript: 'summarize this' });
text = transition(text, { type: 'SUBMIT', command: 'summarize this politely' });
assert.strictEqual(text.name, 'processing');
assert.strictEqual(text.command, 'summarize this politely', 'explicit command wins over transcript');

let bad = transition(text, { type: 'ERROR', error: { message: 'whisper timeout' } });
assert.strictEqual(bad.name, 'error');
assert.deepStrictEqual(bad.error, { message: 'whisper timeout' });
bad = transition(bad, { type: 'DISMISS' });
assert.strictEqual(bad.name, 'dismissing');
bad = transition(bad, { type: 'HIDDEN' });
assert.strictEqual(bad.name, 'hidden');
assert.strictEqual(bad.error, null, 'hidden clears error payload');

const cancelled = transition(text, { type: 'DISMISS' });
assert.strictEqual(cancelled.name, 'dismissing');

const completedSilently = transition(text, { type: 'COMPLETE' });
const completedWithAnswer = transition(text, { type: 'COMPLETE', result: {
  kind: 'inline', answer: '修改已经写入并回读确认。', trajectory: [{ kind: 'tool', name: 'Write' }],
} });
assert.strictEqual(completedWithAnswer.name, 'result', 'a real completed turn stays readable on both surfaces');
assert.strictEqual(completedWithAnswer.turns.at(-1).result.answer, '修改已经写入并回读确认。');
assert.strictEqual(completedWithAnswer.turns.at(-1).status, 'done');
assert.strictEqual(completedSilently.name, 'dismissing',
  'verified execution collapses the capsule without entering result state');

const hidden = initialState();
assert.strictEqual(transition(hidden, { type: 'SUBMIT' }), hidden);
assert.strictEqual(transition(hidden, { type: 'RESULT', result: {} }), hidden);
assert.strictEqual(transition(hidden, { type: 'HIDDEN' }), hidden);
assert.strictEqual(transition(hidden, { type: 'NO_SUCH_EVENT' }), hidden);
assert.strictEqual(transition(hidden, null), hidden);
assert.strictEqual(transition(hidden, {}), hidden);

const targeting = transition(initialState(), { type: 'WAKE' });
assert.strictEqual(transition(targeting, { type: 'OPEN_CAPSULE', mode: 'voice' }), targeting, 'capsule requires frozen target first');

const directResult = transition(targeting, { type: 'RESULT', result: { kind: 'inline', answer: 'ok' } });
assert.strictEqual(directResult.name, 'result');
assert.deepStrictEqual(directResult.result, { kind: 'inline', answer: 'ok' });
const frozenEarly = transition(targeting, { type: 'FREEZE', target: { x: 0, y: 0, width: 5, height: 5 } });
const earlyError = transition(frozenEarly, { type: 'ERROR', error: { message: '选区不可用' } });
assert.strictEqual(earlyError.name, 'error');
assert.deepStrictEqual(earlyError.error, { message: '选区不可用' });
const capsuleEarly = transition(frozenEarly, { type: 'OPEN_CAPSULE', mode: 'voice' });
const capsuleError = transition(capsuleEarly, { type: 'ERROR', error: { message: 'whisper missing' } });
assert.strictEqual(capsuleError.name, 'error');

const resultState = transition(text, { type: 'RESULT', result: { kind: 'text' } });
assert.strictEqual(transition(resultState, { type: 'FREEZE', target: { x: 0, y: 0, width: 1, height: 1 } }), resultState);
assert.strictEqual(transition(resultState, { type: 'WAKE' }), resultState);

const dismissing = transition(resultState, { type: 'DISMISS' });
assert.strictEqual(transition(dismissing, { type: 'SUBMIT' }), dismissing);

let rm = initialState({ reducedMotion: true });
rm = transition(rm, { type: 'WAKE' });
rm = transition(rm, { type: 'FREEZE', target: { x: 0, y: 0, width: 10, height: 10 } });
rm = transition(rm, { type: 'OPEN_CAPSULE', mode: 'voice' });
rm = transition(rm, { type: 'SUBMIT' });
assert.strictEqual(rm.config.reducedMotion, true, 'config survives the whole path');

const toggled = transition(rm, { type: 'SET_REDUCED_MOTION', value: false });
assert.strictEqual(toggled.name, rm.name);
assert.strictEqual(toggled.config.reducedMotion, false);
const toggledHidden = transition(initialState(), { type: 'SET_REDUCED_MOTION', value: true });
assert.strictEqual(toggledHidden.name, 'hidden');
assert.strictEqual(toggledHidden.config.reducedMotion, true);


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

let awaitingThread = threadAtCapsule();
awaitingThread = transition(awaitingThread, { type: 'SUBMIT', command: 'choose' });
awaitingThread = transition(awaitingThread, {
  type: 'RESULT',
  result: {
    awaitingUserInput: true,
    pendingInput: { question: 'Which one?', options: ['A', 'B'] },
  },
});
assert.strictEqual(awaitingThread.name, 'result');
assert.strictEqual(awaitingThread.turns[0].status, 'awaiting');

const waitingResult = { awaitingUserInput: true, pendingInput: { requestId: 'ask-1', question: 'Which one?', options: ['A', 'B'] } };
let resumedInput = transition(threadAtCapsule(), { type: 'SUBMIT', command: '处理原任务' });
resumedInput = transition(resumedInput, { type: 'RESULT', result: waitingResult });
assert.strictEqual(transition(resumedInput, { type: 'RESUME_INPUT', turnId: 99, requestId: 'ask-1' }), resumedInput);
assert.strictEqual(transition(resumedInput, { type: 'RESUME_INPUT', turnId: 1, requestId: 'stale' }), resumedInput);
resumedInput = transition(resumedInput, { type: 'RESUME_INPUT', turnId: 1, requestId: 'ask-1' });
assert.strictEqual(resumedInput.name, 'processing', 'an answer resumes the original waiting turn');
assert.strictEqual(resumedInput.turns.length, 1);
assert.strictEqual(resumedInput.turns[0].id, 1);
assert.strictEqual(resumedInput.turns[0].ask, '处理原任务');
assert.strictEqual(resumedInput.turns[0].status, 'pending');
resumedInput = transition(resumedInput, { type: 'RESULT', result: waitingResult });
assert.strictEqual(resumedInput.turns[0].status, 'awaiting', 'unaccepted transport failure can restore the same request');
resumedInput = transition(resumedInput, { type: 'RESUME_INPUT', turnId: 1, requestId: 'ask-1' });
resumedInput = transition(resumedInput, { type: 'ERROR', error: { message: 'provider failed after accepting input' } });
assert.strictEqual(resumedInput.turns.length, 1);
assert.strictEqual(resumedInput.turns[0].status, 'failed');
assert.strictEqual(resumedInput.turns[0].result, null);

thread = transition(thread, { type: 'OPEN_CAPSULE', mode: 'text' });
assert.strictEqual(thread.name, 'capsule-text');
assert.strictEqual(thread.turns.length, 1, 'a follow-up must not discard the finished turn');
assert.strictEqual(thread.turns[0].ask, '翻译这段');
assert.deepStrictEqual(thread.turns[0].result, { text: 'translate this' });

thread = transition(thread, { type: 'SUBMIT', command: '第二句什么意思' });
assert.strictEqual(thread.turns.length, 2, 'the follow-up appends');
assert.strictEqual(thread.turns[1].ask, '第二句什么意思');
assert.notStrictEqual(thread.turns[0].id, thread.turns[1].id, 'turn ids must be distinct');

thread = transition(thread, { type: 'ERROR', error: { message: 'nope' },
  result: { answer: '已检查选区，但后续读取失败。', trajectory: [{ kind: 'tool', name: 'Look', state: 'error' }] } });
assert.strictEqual(thread.turns.length, 2);
assert.strictEqual(thread.turns[1].status, 'failed', 'a failed follow-up settles as failed');
assert.deepStrictEqual(thread.turns[1].error, { message: 'nope' });
assert.strictEqual(thread.turns[1].result.answer, '已检查选区，但后续读取失败。');
assert.strictEqual(thread.turns[1].result.trajectory[0].name, 'Look');
assert.strictEqual(thread.turns[0].status, 'done', 'an earlier success is untouched by a later failure');

let chipThread = threadAtCapsule();
chipThread = transition(chipThread, { type: 'SUBMIT', command: '总结' });
chipThread = transition(chipThread, { type: 'RESULT', result: { text: 'a' } });
chipThread = transition(chipThread, { type: 'ACTION_START', command: '发到日历' });
assert.strictEqual(chipThread.name, 'processing');
assert.strictEqual(chipThread.turns.length, 2, 'a suggested action opens its own turn');
assert.strictEqual(chipThread.turns[1].ask, '发到日历');
assert.strictEqual(chipThread.turns[1].status, 'pending');

let direct = transition(initialState(), { type: 'WAKE', target: { x: 0, y: 0, width: 4, height: 4 } });
direct = transition(direct, { type: 'RESULT', result: { text: 'captured' } });
assert.strictEqual(direct.turns.length, 1, 'an unsolicited result opens and closes its own turn');
assert.strictEqual(direct.turns[0].ask, '');
assert.strictEqual(direct.turns[0].status, 'done');

let ended = transition(thread, { type: 'DISMISS' });
ended = transition(ended, { type: 'HIDDEN' });
assert.deepStrictEqual(ended.turns, [], 'a new session must not inherit the previous thread');
assert.strictEqual(ended.nextTurnId, 1);

console.log('stage state test ok');
