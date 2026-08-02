const assert = require('assert');
const { SelectionSessionStore } = require('../electron/selection_session');

const ids = ['session-1', 'request-1', 'request-2'];
const store = new SelectionSessionStore({
  ttlMs: 1000,
  idFactory: () => ids.shift(),
});

const session = store.create({ reason: 'hotkey', cursor: { x: 10, y: 20 } }, 100);
assert.strictEqual(session.token, 'session-1');
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
const request2 = store.startRequest('session-1', 350);
assert.strictEqual(request1, 'request-1');
assert.strictEqual(request2, 'request-2');
assert.strictEqual(store.isCurrentRequest('session-1', request1, 400), false);
assert.strictEqual(store.isCurrentRequest('session-1', request2, 400), true);
assert.strictEqual(store.finishRequest('session-1', request1, 400), null);
assert.strictEqual(store.finishRequest('session-1', request2, 400).state, 'ready');
assert.strictEqual(store.clearAgentPromptDraft('session-1', 410), true);
assert.strictEqual(store.getAgentPromptDraft('session-1', 420), null);

assert.strictEqual(store.get('session-1', 1100), null);
console.log('selection session test ok');
