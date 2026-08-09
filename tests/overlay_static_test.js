const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('electron/renderer/overlay.ts', 'utf8');
const html = fs.readFileSync('electron/renderer/index.html', 'utf8');
const styles = fs.readFileSync('electron/renderer/styles.css', 'utf8');

// Kept contract: 光标是 CSS armed-cursor，不在 canvas 画鼠标。
// 之前 canvas 画蓝圈（drawPointer/drawObserverAura）是用户点名不要的。
assert(!source.includes('function drawObserverAura'),
  'observer 模式必须用 CSS 光标，不画 canvas aura');
assert(!source.includes('function drawPointer'),
  'capture 模式必须用 CSS 光标，不画 canvas 鼠标');
assert(source.includes('window.magicPointer?.onCursor('));
assert(!source.includes("document.getElementById('armed-cursor')"),
  'gesture mode must not render a lagging software cursor');
assert(!source.includes('function updateArmedCursor('),
  'gesture mode must let the OS move the native cursor without renderer IPC');
assert(source.includes('observerMode = payload?.observerMode === true'));
assert(!source.includes('if (observerMode) drawObserverAura(lastPointer);'));

// Clicky 式引导小三角：默认不出现，收到 [POINT] 指点才浮现并贝塞尔飞行
assert(source.includes('window.magicPointer?.onGuidePoint?.('),
  'overlay 必须监听主进程的 overlay:guide-point');
assert(html.includes('id="guide-triangle"'),
  'guidance must move one persistent DOM triangle');
assert(source.includes("document.getElementById('guide-triangle')"),
  'guidance must bind the persistent DOM triangle');
assert(source.includes('function updateGuideTriangle('),
  'guidance must have one DOM transform synchronization path');
assert(styles.includes('#guide-triangle'),
  'the persistent guide triangle must have an explicit compositor style');
assert(!source.includes('function drawGuideTriangle'),
  'guidance must not repaint a blurred triangle into the transparent canvas');
assert(!source.includes('guideFrames'),
  'guidance must not retain raster frames that can ghost on Windows');
assert(!source.includes('g.shadowBlur'),
  'guidance must not use canvas blur on a transparent Windows surface');
assert(source.includes('function guideFlightPoint'),
  '贝塞尔飞行必须是纯函数，可单测');
assert(source.includes('guideTarget = null;'),
  'overlay 隐藏时必须清理引导状态');
assert(!source.includes('guideFollow'),
  'Clicky guidance must not start or follow the pointer merely because the overlay woke');
assert(source.includes('window.magicPointer?.guideFinished()'),
  'the guide overlay must retire itself after the requested point has been shown');

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
assert(!html.includes('id="armed-cursor"'));
assert(styles.includes("url('./assets/armed-cursor.cur') 3 3"),
  'Windows must use a native cursor resource for zero-lag gesture tracking');
const nativeCursor = fs.readFileSync('electron/renderer/assets/armed-cursor.cur');
assert.strictEqual(nativeCursor.readUInt16LE(0), 0, 'CUR reserved field must be zero');
assert.strictEqual(nativeCursor.readUInt16LE(2), 2, 'asset must be a Windows CUR file');
assert.strictEqual(nativeCursor.readUInt16LE(4), 1, 'CUR asset must contain exactly one image');
assert.strictEqual(nativeCursor.readUInt8(6), 32, 'native cursor width must match the SVG');
assert.strictEqual(nativeCursor.readUInt8(7), 32, 'native cursor height must match the SVG');
assert.strictEqual(nativeCursor.readUInt16LE(10), 3, 'native cursor X hotspot must match CSS');
assert.strictEqual(nativeCursor.readUInt16LE(12), 3, 'native cursor Y hotspot must match CSS');
assert(html.includes('id="sweep-layer"'),
  'gesture mode must have a dedicated transparent sweep compositor');
assert(html.includes('src="sweep_visual.js"'),
  'the procedural sweep renderer must load before overlay.js');
assert(html.includes('id="hint"'));

// Demo 7 visual contract: gesture bands are GPU-composited and the old
// three-stroke Canvas brush is not used for the default gesture style.
assert(source.includes('new globalThis.MagicSweepVisual.SweepRenderer'));
assert(source.includes("gestureLineStyle === 'demo6_band'"));
assert(source.includes('sweepRenderer.render('));

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

// A committed quick click keeps its point identity so the renderer can show
// the actual target instead of covering it with the sequence badge.
assert(source.includes('kind: strokeSummary.kind,'),
  'committed strokes must retain the summarized gesture kind');
assert(source.includes("if (stroke.kind === 'point')"),
  'point strokes must have a dedicated rendering path');
assert(source.includes('drawPointTarget(stroke.semanticPoint)'),
  'the dedicated point rendering path must draw the clicked coordinate');
assert.match(source, /function drawPointTarget[\s\S]*?const radius = 38;/,
  'a quick click needs a visible cursor-sized glow, not a tiny hidden dot');

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
