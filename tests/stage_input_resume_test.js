'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const machine = require('../electron/stage_state');
const ConversationControl = require('../electron/conversation_control');
const source = fs.readFileSync('electron/renderer/stage.ts', 'utf8');
const html = fs.readFileSync('electron/renderer/stage.html', 'utf8');
const start = source.indexOf('  let pendingStageInput:');
const end = source.indexOf('  function clearChips(', start);
assert.ok(start >= 0 && end > start, 'Stage must implement the real tool-response continuation');
for (const dependency of ['decision_card.js', '../conversation_control.js']) assert.ok(html.includes(`src="${dependency}"`));
assert.ok(html.includes('href="decision_card.css"'));
assert.ok(!source.includes('clarify.clarificationChips(newest)'), 'questions use the shared form, never canned prompt chips');

function harness() {
  let state = machine.initialState();
  for (const event of [{ type: 'WAKE' }, { type: 'FREEZE' }, { type: 'OPEN_CAPSULE', mode: 'text' },
    { type: 'SUBMIT', command: '原任务' }, { type: 'RESULT', result: { awaitingUserInput: true,
      pendingInput: { requestId: 'ask-1', questions: [{ question: '选哪项?', options: [{ label: 'A' }, { label: 'B' }] }] } } }]) {
    state = machine.transition(state, event);
  }
  const pending = [], calls = [], paints = [];
  const host = { hidden: false };
  let card;
  const context = { state, session: { token: 'selection-1' }, stageDecision: host, taskInputSequence: 0,
    ConversationControl, runningCards: new Map(), Date,
    DecisionCard: {
      render(_host, request, submit) { card = { request, submit }; host.hidden = false; },
      pending(_host, busy, error) { host.busy = busy; host.error = error; },
      clear() { host.hidden = true; card = null; },
    },
    api: { respondInput(value) { calls.push(value); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
      openArtifact: async value => { calls.push(value); return { ok: true }; } },
    patchRunningCard: value => paints.push(value), scheduleHitRegionRefresh() {},
    dispatch(event) { context.state = machine.transition(context.state, event); context.renderStageDecision(); },
  };
  vm.runInNewContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  context.renderStageDecision();
  return { context, host, pending, calls, paints, card: () => card };
}

(async () => {
  const h = harness();
  assert.equal(h.card().request.questions.length, 1);
  const send = h.context.respondToStageInput(1, 'ask-1', { answers: { '选哪项?': 'A' } });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].selectionSessionToken, 'selection-1');
  assert.equal(h.calls[0].requestId, 'ask-1');
  assert.equal(h.context.state.turns.length, 1);
  assert.equal(h.context.state.turns[0].status, 'pending');
  h.pending[0].resolve({ ok: false, accepted: false, error: 'disk busy' });
  await send;
  assert.equal(h.context.state.turns[0].status, 'awaiting');
  assert.equal(h.host.hidden, false);
  assert.equal(h.host.error, 'disk busy');

  const retry = h.context.respondToStageInput(1, 'ask-1', { answers: { '选哪项?': 'A' } });
  const request = h.calls[1];
  h.context.onStageInputProgress({ requestId: 'other-request', record: { phase: 'user_input_accepted' } });
  assert.equal(h.host.hidden, false, 'foreign progress cannot consume the question');
  h.context.onStageInputProgress({ requestId: request.requestToken,
    record: { phase: 'user_input_accepted', fields: { inputRequestId: 'ask-1' } } });
  assert.equal(h.host.hidden, true, 'durable acceptance removes the question before provider completion');
  h.context.onStageInputProgress({ requestId: request.requestToken,
    record: { phase: 'answer_chunk', fields: { text: 'continuing' } } });
  h.pending[1].reject(new Error('provider disconnected'));
  await retry;
  assert.equal(h.context.state.turns.length, 1);
  assert.equal(h.context.state.turns[0].status, 'failed');
  assert.equal(h.host.hidden, true, 'accepted failure must not revive the question');

  const other = harness();
  const stale = other.context.respondToStageInput(1, 'ask-1', { answers: { '选哪项?': 'B' } });
  other.context.session.token = 'selection-2';
  const before = other.context.state;
  other.pending[0].resolve({ ok: true, accepted: true, answer: 'old session answer' });
  await stale;
  assert.equal(other.context.state, before, 'late completion cannot settle a different selection');
  await other.context.openStageArtifact('artifact-1');
  assert.deepEqual(JSON.parse(JSON.stringify(other.calls.at(-1))), { selectionSessionToken: 'selection-2', artifactId: 'artifact-1' });
  console.log('Stage input continuation tests ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
