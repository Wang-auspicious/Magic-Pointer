const assert = require('assert');
const { InteractionEpisodeStore, inferReferenceMode } = require('../electron/interaction_episode');

const ids = ['episode-1', 'episode-2'];
const store = new InteractionEpisodeStore({
  ttlMs: 30 * 60 * 1000,
  idFactory: () => ids.shift(),
});

const episode = store.start(100);
assert.strictEqual(episode.id, 'episode-1');

const sourceA = store.bindPointedObject({
  snapshotId: 'snap-a', selectionSessionToken: 'session-a', app: 'browser',
  windowTitle: 'Research A', label: 'Paragraph A',
  bbox: [10, 20, 300, 80],
  source: { app: 'browser', url: 'https://example.com/a', page: 2 },
}, 200);
assert.strictEqual(sourceA.slots.this.objectId, 'selection:snap-a');
assert.strictEqual(sourceA.slots.that, null);
assert.deepStrictEqual(sourceA.slots.this.bbox, [10, 20, 300, 80]);
assert.strictEqual(sourceA.slots.this.source.url, 'https://example.com/a');

const sourceB = store.bindPointedObject({
  snapshotId: 'snap-b', selectionSessionToken: 'session-b', app: 'pdf',
  windowTitle: 'Paper B', label: 'Paragraph B',
}, 300);
assert.strictEqual(sourceB.slots.this.objectId, 'selection:snap-b');
assert.strictEqual(sourceB.slots.that.objectId, 'selection:snap-a');

const grouped = store.bindThese(['selection:snap-a', 'selection:snap-b'], 400);
assert.deepStrictEqual(grouped.slots.these.map((item) => item.objectId), [
  'selection:snap-a', 'selection:snap-b',
]);

const destination = store.bindHere({
  snapshotId: 'snap-destination', selectionSessionToken: 'session-destination', app: 'word',
  windowTitle: 'Draft.docx', label: 'Insertion point',
}, 500);
assert.strictEqual(destination.slots.here.objectId, 'selection:snap-destination');
assert.strictEqual(destination.slots.this.objectId, 'selection:snap-b', 'binding HERE must not replace THIS');

const payload = store.contextPayload(600);
assert.strictEqual(payload.episodeId, 'episode-1');
assert.strictEqual(payload.slots.this.objectId, 'selection:snap-b');
assert.strictEqual(payload.slots.that.objectId, 'selection:snap-a');
assert.strictEqual(payload.slots.these.length, 2);
assert.strictEqual(payload.slots.here.windowTitle, 'Draft.docx');
assert.strictEqual(payload.objects.length, 3);
assert.ok(!JSON.stringify(payload).includes('selectedText'), 'episode payload must not duplicate selected content');

assert.strictEqual(store.contextPayload(30 * 60 * 1000 + 501), null, 'expired episode must fail closed');
const next = store.ensureActive(30 * 60 * 1000 + 502);
assert.strictEqual(next.id, 'episode-2');
assert.strictEqual(next.slots.this, null);

assert.strictEqual(inferReferenceMode('compare this with that'), 'this');
assert.strictEqual(inferReferenceMode('merge these'), 'these');
assert.strictEqual(inferReferenceMode('put these here'), 'here');
assert.strictEqual(inferReferenceMode('把这些写到这里'), 'here');

console.log('interaction episode test ok');
