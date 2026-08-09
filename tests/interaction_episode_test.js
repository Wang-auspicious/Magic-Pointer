const assert = require('assert');
const fs = require('fs');
const { InteractionEpisodeStore, inferReferenceLabel, inferReferenceMode, normalizeObject } = require('../electron/interaction_episode');

{
  const object = normalizeObject({
    objectId: 'terminal-1',
    source: {
      app: 'terminal',
      terminalEvidence: {
        schemaVersion: 1,
        state: 'resolved',
        method: 'uia:terminal-text-pattern',
        command: 'python verify.py',
        exitCode: 7,
        anchor: { line: 3, text: 'Error: broken', private: 'drop' },
        window: { startLine: 1, endLine: 4, lineCount: 4, before: 'working', error: 'Error: broken', after: '', text: 'working\nError: broken' },
        private: 'drop',
      },
    },
  });
  assert.equal(object.source.terminalEvidence.schemaVersion, 1);
  assert.equal(object.source.terminalEvidence.exitCode, 7);
  assert.equal(object.source.terminalEvidence.anchor.private, undefined);
  assert.equal(object.source.terminalEvidence.private, undefined);
}

{
  const object = normalizeObject({
    objectId: 'browser-1',
    source: {
      app: 'browser',
      browserContext: {
        schemaVersion: 1,
        state: 'resolved',
        method: 'cdp:dom-point',
        page: { title: 'Checkout', url: 'https://example.test/checkout' },
        node: { tag: 'button', role: 'button', accessibleName: 'Retry', text: 'Retry', attributes: { 'data-testid': 'retry' }, private: 'drop' },
        selector: 'button[data-testid="retry"]',
        coordinates: { pointerScreenPhysical: { x: 640, y: 520 }, pointerViewportCss: { x: 500, y: 240 } },
        networkFailures: [{ url: 'https://api.example.test/pay', errorText: 'net::ERR_FAILED', source: 'devtools_log', private: 'drop' }],
        provenance: { endpoint: 'http://127.0.0.1:9222', targetId: 'page-1', structural: true },
        private: 'drop',
      },
    },
  });
  assert.equal(object.source.browserContext.selector, 'button[data-testid="retry"]');
  assert.equal(object.source.browserContext.node.accessibleName, 'Retry');
  assert.equal(object.source.browserContext.networkFailures[0].private, undefined);
  assert.equal(object.source.browserContext.private, undefined);
}

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
  source: {
    app: 'browser',
    url: 'https://example.com/a',
    page: 2,
    annotatedPath: 'D:\\captures\\a.pointer.png',
    captureAttestation: {
      status: 'verified',
      phase: 'complete',
      expected: { hwnd: 42, processId: 314, title: 'Research A', desktopId: 'desktop-1' },
    },
    perceptionTrace: {
      schemaVersion: 1,
      selectedLayer: 'uia',
      selectedAdapter: 'uia_text_selection',
      selectedMethod: 'uia:element-from-point',
      pixelFallbackUsed: false,
      fallbackReason: null,
      policyMode: 'structured_only',
      attempts: [{
        layer: 'uia', adapter: 'uia_text_selection', method: 'uia:element-from-point',
        status: 'succeeded', reason: 'structured_context_available', secret: 'drop-me',
      }],
      privateWindowTitle: 'drop-me',
    },
  },
}, 200);
store.labelCurrent('A', 210);
assert.strictEqual(sourceA.slots.this.objectId, 'selection:snap-a');
assert.strictEqual(sourceA.slots.that, null);
assert.deepStrictEqual(sourceA.slots.this.bbox, [10, 20, 300, 80]);
assert.strictEqual(sourceA.slots.this.source.url, 'https://example.com/a');
assert.strictEqual(sourceA.slots.this.source.annotatedPath, 'D:\\captures\\a.pointer.png');
assert.strictEqual(sourceA.slots.this.source.captureAttestation.status, 'verified');
assert.strictEqual(sourceA.slots.this.source.captureAttestation.expected.desktopId, 'desktop-1');
assert.strictEqual(sourceA.slots.this.source.perceptionTrace.selectedLayer, 'uia');
assert.strictEqual(sourceA.slots.this.source.perceptionTrace.attempts[0].status, 'succeeded');
assert.ok(!JSON.stringify(sourceA.slots.this.source.perceptionTrace).includes('drop-me'));

const sourceB = store.bindPointedObject({
  snapshotId: 'snap-b', selectionSessionToken: 'session-b', app: 'pdf',
  windowTitle: 'Paper B', label: 'Paragraph B', bbox: [400, 20, 700, 80],
}, 300);
store.labelCurrent('B', 310);
assert.strictEqual(sourceB.slots.this.objectId, 'selection:snap-b');
assert.strictEqual(sourceB.slots.that.objectId, 'selection:snap-a');

store.bindPointedObject({
  snapshotId: 'snap-c', selectionSessionToken: 'session-c', app: 'canvas',
  windowTitle: 'Board C', label: 'Card C', bbox: [400, 200, 700, 300],
}, 320);
store.labelCurrent('C', 330);
const grouped = store.bindThese(null, 400);
assert.deepStrictEqual(grouped.slots.these.map((item) => item.objectId), [
  'selection:snap-a', 'selection:snap-b', 'selection:snap-c',
]);
assert.deepStrictEqual(grouped.slots.these.map((item) => item.referenceLabel), ['A', 'B', 'C']);
assert(grouped.spatialRelations.some(item => item.from === 'A' && item.to === 'B' && item.horizontal === 'left_of'));
assert(grouped.spatialRelations.some(item => item.from === 'B' && item.to === 'C' && item.vertical === 'above'));

const destination = store.bindHere({
  snapshotId: 'snap-destination', selectionSessionToken: 'session-destination', app: 'word',
  windowTitle: 'Draft.docx', label: 'Insertion point',
}, 500);
assert.strictEqual(destination.slots.here.objectId, 'selection:snap-destination');
assert.strictEqual(destination.slots.this.objectId, 'selection:snap-c', 'binding HERE must not replace THIS');

const payload = store.contextPayload(600);
assert.strictEqual(payload.episodeId, 'episode-1');
assert.strictEqual(payload.slots.this.objectId, 'selection:snap-c');
assert.strictEqual(payload.slots.that.objectId, 'selection:snap-b');
assert.strictEqual(payload.slots.these.length, 3);
assert.strictEqual(payload.slots.here.windowTitle, 'Draft.docx');
assert.strictEqual(payload.objects.length, 4);
assert.deepStrictEqual(payload.labels, { A: 'selection:snap-a', B: 'selection:snap-b', C: 'selection:snap-c' });
assert.strictEqual(payload.spatialRelations.length, 3);
assert.ok(!JSON.stringify(payload).includes('selectedText'), 'episode payload must not duplicate selected content');

assert.strictEqual(store.contextPayload(30 * 60 * 1000 + 501), null, 'expired episode must fail closed');
const next = store.ensureActive(30 * 60 * 1000 + 502);
assert.strictEqual(next.id, 'episode-2');
assert.strictEqual(next.slots.this, null);

assert.strictEqual(inferReferenceMode('compare this with that'), 'this');
assert.strictEqual(inferReferenceMode('merge these'), 'these');
assert.strictEqual(inferReferenceMode('比较这些'), 'these');
assert.strictEqual(inferReferenceMode('put these here'), 'here');
assert.strictEqual(inferReferenceMode('and this'), 'append');
assert.strictEqual(inferReferenceMode('also this'), 'append');
assert.strictEqual(inferReferenceLabel('这是 A'), 'A');
assert.strictEqual(inferReferenceLabel('mark this as C'), 'C');

const main = fs.readFileSync('electron/main.ts', 'utf8');
assert(main.includes('const referenceLabel = inferReferenceLabel(command)'));
assert(main.includes('interactionEpisodes.labelCurrent(referenceLabel)'));
assert(main.includes('referenceLabel: item.referenceLabel || null'));
assert(main.includes('labels: episode.labels'));
assert(main.includes('spatialRelations: episode.spatialRelations'));
assert(main.includes('captureAttestation: snapshot.capture_attestation || null'));
assert(main.includes('perceptionTrace: snapshot.perception_trace || null'));
assert.strictEqual(inferReferenceMode('把这些写到这里'), 'here');

{
  const continuous = new InteractionEpisodeStore({
    ttlMs: 60_000,
    idFactory: () => 'episode-continuous',
  });
  const first = continuous.bindCommandTarget({ snapshotId: 'source-a', label: '1 lb Spaghetti' }, 'Add this', 1_000);
  assert.strictEqual(first.id, 'episode-continuous');
  assert.strictEqual(first.pendingIntent, 'add');
  assert.deepStrictEqual(first.slots.these.map((item) => item.objectId), ['selection:source-a']);

  const second = continuous.bindCommandTarget({ snapshotId: 'source-b', label: '2 oz Parmesan' }, 'and this', 2_000);
  assert.strictEqual(second.id, first.id, 'a follow-up stroke stays in the same episode');
  assert.strictEqual(second.pendingIntent, 'add');
  assert.deepStrictEqual(second.slots.these.map((item) => item.objectId), [
    'selection:source-a', 'selection:source-b',
  ]);

  const destination = continuous.bindCommandTarget({ snapshotId: 'destination', label: 'Shopping list' }, 'here', 3_000);
  assert.strictEqual(destination.id, first.id);
  assert.strictEqual(destination.slots.here.objectId, 'selection:destination');
  assert.deepStrictEqual(destination.slots.these.map((item) => item.objectId), [
    'selection:source-a', 'selection:source-b',
  ], 'binding HERE must not discard the ordered source set');
  assert.strictEqual(destination.pendingIntent, 'add');
}

console.log('interaction episode test ok');
