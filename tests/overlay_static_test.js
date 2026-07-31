const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('electron/renderer/overlay.js', 'utf8');
const html = fs.readFileSync('electron/renderer/index.html', 'utf8');

// Kept contract: observer aura follows the main-process cursor feed.
assert(source.includes('function drawObserverAura'));
assert(source.includes('window.magicPointer?.onCursor('));
assert(source.includes('observerMode = payload?.observerMode === true'));
assert(source.includes('if (observerMode) drawObserverAura(lastPointer);'));

// Kept contract: runtime-issue circle capture submits the drawn region via done().
assert(source.includes("let currentWorkflow = 'generic';"));
assert(source.includes("currentWorkflow = String(payload?.workflow || 'generic')"));
assert(source.includes('workflow: currentWorkflow'));
assert(source.includes('window.magicPointer?.done(payload)'));
assert(source.includes('圈出运行中的问题，然后说你期望什么'));
assert(source.includes('function hideVisualsForCapture'));
assert(source.includes('window.magicPointer?.onShow('));
assert(source.includes('window.magicPointer?.onHide('));
assert(source.includes('window.magicPointer?.hide()'));
assert(html.includes('id="trail"'));
assert(html.includes('id="hint"'));

// The circle payload keeps points + bbox + viewport for the capture bridge.
const payloadStart = source.indexOf('function computeSelectionPayload');
const payloadEnd = source.indexOf('function hideVisualsForCapture');
assert(payloadStart >= 0, 'computeSelectionPayload not found');
assert(payloadEnd > payloadStart, 'computeSelectionPayload block end not found');

const context = { window: { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 2 } };
vm.runInNewContext([
  'let points = [{ x: 10, y: 20 }, { x: 40, y: 5 }, { x: 25, y: 60 }];',
  'let strokes = [];',
  'let gestureToken = null;',
  source.slice(payloadStart, payloadEnd),
  'globalThis.testPayload = computeSelectionPayload();',
].join('\n'), context, { filename: 'overlay_static_test.vm.js' });

assert.strictEqual(context.testPayload.bbox.x1, 10);
assert.strictEqual(context.testPayload.bbox.y1, 5);
assert.strictEqual(context.testPayload.bbox.x2, 40);
assert.strictEqual(context.testPayload.bbox.y2, 60);
assert.strictEqual(context.testPayload.viewport.width, 1280);
assert.strictEqual(context.testPayload.viewport.height, 800);
assert.strictEqual(context.testPayload.viewport.dpr, 2);
assert.strictEqual(context.testPayload.points.length, 3);

// Unified multi-stroke chain: the payload carries every committed stroke.
const chainStart = source.indexOf('let strokes = [];');
const chainEnd = source.indexOf('let renderRaf = null;');
assert(chainStart >= 0, 'multi-stroke chain state must exist');
assert(chainEnd > chainStart, 'chain state must live before the render loop');
assert(source.includes('CHAIN_GAP_MS'));
assert(source.includes('window.magicPointer?.gestureStroke(gestureToken, strokes.length)'),
  'every committed stroke keeps the arm alive via overlay:gesture-stroke');
assert(source.includes('scheduleChainFinalize'));
assert(source.includes("if (e.key === 'Enter')"), 'Enter must finalize the chain');
assert(source.includes('finalizeGesture'));
assert(source.includes('strokes: strokes.map((s) => ({ points: [...s.points] }))'),
  'the unified payload must include all strokes');

// Legacy retirement: the overlay no longer renders results or actions.
// Everything below now lives on the PointerStage surface.
assert(!source.includes('pill'));
assert(!source.includes('showPill'));
assert(!source.includes('showResult'));
assert(!source.includes('onResult'));
assert(!source.includes('executeAction'));
assert(!source.includes('renderActionProposals'));
assert(!source.includes('renderSafeMarkdown'));
assert(!source.includes('innerHTML'));
assert(!source.includes('actionProposals'));
assert(!source.includes('intentKind'));
assert(!source.includes('autoDismiss'));
assert(!source.includes('startDictation'));
assert(!source.includes('onDictationResult'));
assert(!source.includes('runSelectedCommand'));
assert(!source.includes('commandInput'));
assert(!html.includes('id="pill"'));
assert(!html.includes('id="result"'));
assert(!html.includes('id="command"'));
assert(!html.includes('id="run"'));
assert(!html.includes('id="dictation"'));

console.log('overlay static test ok');
