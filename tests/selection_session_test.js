const assert = require('assert');
const { SelectionSessionStore, continuationTaskForSelection } = require('../electron/selection_session');

const ids = ['session-1', 'request-1', 'request-2', 'request-3'];
const store = new SelectionSessionStore({
  ttlMs: 1000,
  idFactory: () => ids.shift(),
});

const session = store.create({ reason: 'hotkey', cursor: { x: 10, y: 20 } }, 100);
assert.strictEqual(session.token, 'session-1');
assert.strictEqual(session.taskId, 'agent-session-1', 'the selection owns its durable Runtime task identity before submit');

const continuationStore = new SelectionSessionStore({ idFactory: () => 'continuation-session' });
const continuing = continuationStore.create({
  reason: 'gesture',
  cursor: { x: 30, y: 40 },
  taskId: 'agent-existing-task',
}, 110);
assert.strictEqual(
  continuing.taskId,
  'agent-existing-task',
  'a later gesture can join the durable task that is already running',
);

assert.deepStrictEqual(
  continuationTaskForSelection({
    episodeTaskId: 'agent-existing-task',
    taskOwners: [
      { token: 'old-token', taskId: 'agent-existing-task', running: true },
      { token: 'other-token', taskId: 'agent-other-task', running: true },
    ],
  }),
  { token: 'old-token', taskId: 'agent-existing-task' },
  'a new pointing session joins only the matching live task',
);
assert.strictEqual(
  continuationTaskForSelection({
    episodeTaskId: 'agent-existing-task',
    taskOwners: [{ token: 'old-token', taskId: 'agent-existing-task', running: false }],
  }),
  null,
  'finished tasks are not mistaken for a live mid-run steer',
);
assert.deepStrictEqual(
  continuationTaskForSelection({
    episodeTaskId: '',
    taskOwners: [{ token: 'conversation-request', taskId: 'agent-studio-conv-1', running: true }],
  }),
  { token: 'conversation-request', taskId: 'agent-studio-conv-1' },
  'the sole live Studio task owns a point made while its answer is running',
);
assert.strictEqual(session.state, 'capturing');
assert.strictEqual(store.get('session-1', 200).cursor.x, 10);

const attached = store.attachSnapshot('session-1', {
  selectionSnapshot: { snapshot_id: 'snapshot-1', status: 'ready' },
  captureSummary: { label: 'THIS', hasContent: true },
  suggestedCommands: [
    { label: 'Explain', command: 'explain this' },
    { label: 'Rewrite', command: 'rewrite this' },
  ],
}, 250);
assert.strictEqual(attached.state, 'ready');
assert.strictEqual(attached.snapshot.snapshot_id, 'snapshot-1');
assert.strictEqual(attached.suggestedCommands.length, 2);

const laidOut = store.setPanelLayout('session-1', {
  nonce: 'layout-1',
  geometry: {
    anchorCursor: { x: 10, y: 20 },
    selectionRects: [{ x: 30, y: 40, width: 50, height: 20 }],
  },
}, 275);
assert.strictEqual(laidOut.panelLayoutNonce, 'layout-1');
assert.strictEqual(laidOut.panelGeometry.selectionRects.length, 1);
assert.strictEqual(store.setPanelPlacement('session-1', { mode: 'right-anchor' }, 280).panelPlacement.mode, 'right-anchor');

const promptDraft = store.setAgentPromptDraft('session-1', {
  prompt: 'editable prompt',
  contextPacket: { schemaVersion: 2, packetId: 'packet-1' },
  generatedBy: 'model',
}, 290);
assert.strictEqual(promptDraft.prompt, 'editable prompt');
assert.strictEqual(store.getAgentPromptDraft('session-1', 295).contextPacket.packetId, 'packet-1');

const request1 = store.startRequest('session-1', 300);
const blocked = store.startRequest('session-1', 350);
assert.strictEqual(blocked, null, 'a second gesture does not orphan the request in flight');
assert.strictEqual(store.isCurrentRequest('session-1', request1, 400), true);
assert.strictEqual(store.finishRequest('session-1', request1, 400).state, 'ready');
const request2 = store.startRequest('session-1', 405);
assert.strictEqual(request2, 'request-2');
assert.strictEqual(store.finishRequest('session-1', request2, 410).state, 'ready');
assert.strictEqual(store.clearAgentPromptDraft('session-1', 410), true);
assert.strictEqual(store.getAgentPromptDraft('session-1', 420), null);

assert.strictEqual(store.get('session-1', 1400).state, 'ready');
assert.strictEqual(store.get('session-1', 100_000_000).state, 'ready');
assert.strictEqual(store.get('session-1', 100_000_000).snapshot.snapshot_id, 'snapshot-1');

const emptyIds = ['session-empty'];
const emptyStore = new SelectionSessionStore({ ttlMs: 1000, idFactory: () => emptyIds.shift() });
emptyStore.create({ reason: 'hotkey' }, 0);
assert.strictEqual(emptyStore.get('session-empty', 999).state, 'capturing');
assert.strictEqual(emptyStore.get('session-empty', 1000), null);

const blankIds = ['session-blank'];
const blankStore = new SelectionSessionStore({ ttlMs: 1000, idFactory: () => blankIds.shift() });
blankStore.create({ reason: 'hotkey' }, 0);
blankStore.attachSnapshot('session-blank', { selectionSnapshot: null }, 10);
assert.strictEqual(blankStore.get('session-blank', 10).state, 'unavailable');
assert.strictEqual(blankStore.get('session-blank', 500_000).state, 'unavailable');

let seq = 0;
const cappedStore = new SelectionSessionStore({
  ttlMs: 1000,
  maxFrozen: 2,
  idFactory: () => `frozen-${(seq += 1)}`,
});
for (let index = 1; index <= 3; index += 1) {
  cappedStore.create({ reason: 'hotkey' }, index * 10);
  cappedStore.attachSnapshot(`frozen-${index}`, {
    selectionSnapshot: { snapshot_id: `snapshot-${index}` },
  }, index * 10);
}
assert.strictEqual(cappedStore.get('frozen-1', 40), null);
assert.strictEqual(cappedStore.get('frozen-2', 40).state, 'ready');
assert.strictEqual(cappedStore.get('frozen-3', 40).state, 'ready');

const requestIds = ['session-running', 'request-running'];
const runningStore = new SelectionSessionStore({
  ttlMs: 1000,
  idFactory: () => requestIds.shift(),
});
runningStore.create({ reason: 'hotkey' }, 0);
runningStore.attachSnapshot('session-running', {
  selectionSnapshot: { snapshot_id: 'snapshot-running', status: 'ready' },
}, 100);
const runningRequest = runningStore.startRequest('session-running', 900);
assert.strictEqual(runningRequest, 'request-running');
assert.strictEqual(runningStore.isCurrentRequest('session-running', runningRequest, 2500), true);
assert.strictEqual(runningStore.finishRequest('session-running', runningRequest, 2500).state, 'ready');
assert.strictEqual(runningStore.get('session-running', 3500).state, 'ready');

assert.strictEqual(runningStore.cancel('session-running'), true);
assert.strictEqual(runningStore.get('session-running', 3600), null);
console.log('selection session test ok');
