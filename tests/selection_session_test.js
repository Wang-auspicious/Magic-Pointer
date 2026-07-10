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

const request1 = store.startRequest('session-1', 300);
const request2 = store.startRequest('session-1', 350);
assert.strictEqual(request1, 'request-1');
assert.strictEqual(request2, 'request-2');
assert.strictEqual(store.isCurrentRequest('session-1', request1, 400), false);
assert.strictEqual(store.isCurrentRequest('session-1', request2, 400), true);
assert.strictEqual(store.finishRequest('session-1', request1, 400), null);
assert.strictEqual(store.finishRequest('session-1', request2, 400).state, 'ready');

assert.strictEqual(store.get('session-1', 1100), null);
console.log('selection session test ok');
