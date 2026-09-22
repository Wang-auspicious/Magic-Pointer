const { performance } = require('node:perf_hooks');

function bench(label, iterations, fn) {
  fn(); fn();  
  const t0 = performance.now();
  for (let i = 0; i < iterations; i += 1) fn(i);
  const t1 = performance.now();
  const totalMs = t1 - t0;
  const perCallUs = (totalMs * 1000) / iterations;
  console.log(
    `${label.padEnd(58)} n=${String(iterations).padStart(7)}  `
    + `total=${totalMs.toFixed(1).padStart(8)}ms  per_call=${perCallUs.toFixed(3).padStart(9)}us`,
  );
  return { totalMs, perCallUs };
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

section('1. stage_hit_policy.pointInRegions — runs on EVERY pointer tick');
const hitPolicy = require('../electron/stage_hit_policy.ts');
const regions16 = Array.from({ length: 16 }, (_, i) => ({
  x: 100 + i * 40, y: 200 + i * 10, width: 180, height: 48,
}));
const inside = { x: 500, y: 260 };
bench('pointInRegions(16 regions), hit', 200000, () => hitPolicy.pointInRegions(inside, regions16));

section('2. JSON.stringify(regions) — the change-detection key in syncHitRegions');
bench('JSON.stringify(16 regions)', 200000, () => JSON.stringify(regions16));

section('3. nativeShapeRegions — main-process side of every setMouseCapture IPC');
const hitRegions = require('../electron/stage_hit_regions.ts');
bench('nativeShapeRegions(16 regions)', 200000, () => hitRegions.nativeShapeRegions({
  platform: 'win32', screenApi: null, stageBounds: { x: 0, y: 0, width: 2560, height: 1440 }, regions: regions16,
}));

section('4. wiggle_detector.push — the body of the 20ms setInterval');
const { WiggleDetector } = require('../electron/wiggle_detector.ts');
{
  const detector = new WiggleDetector({ sensitivity: 0.5, disabledApps: [], cooldownMs: 1200 });
  let t = 0;
  let x = 400;
  const samples = [];
  for (let i = 0; i < 400; i += 1) {
    t += 20;
    x += Math.sin(i / 6) * 9 + 0.4;
    samples.push({ t, x, y: 300 + Math.sin(i / 9) * 4, buttons: 0, foregroundApp: 'Code.exe', isWindowMoving: false, scrollDelta: 0 });
  }
  let idx = 0;
  bench('WiggleDetector.push (steady), n=400 rolling', 2000, () => {
    const s = samples[idx % samples.length];
    idx += 1;
    detector.push(s);
  });
  const detector2 = new WiggleDetector({ sensitivity: 0.5, disabledApps: [], cooldownMs: 1200 });
  let t2 = 0;
  let x2 = 400;
  bench('WiggleDetector.push, monotonic clock (production shape)', 100000, () => {
    t2 += 20;
    x2 += Math.sin(t2 / 120) * 9 + 0.4;
    detector2.push({ t: t2, x: x2, y: 300, buttons: 0, foregroundApp: 'Code.exe', isWindowMoving: false, scrollDelta: 0 });
  });
  console.log('  window-bounded history length (windowMs=700 @ 20ms samples):', detector2.points.length);
}

section('5. mouse_activation.push — second detector on the same tick');
const { MouseActivationDetector } = require('../electron/mouse_activation.ts');
{
  const det = new MouseActivationDetector();
  bench('MouseActivationDetector.push', 200000, (i) => det.push({ t: i * 20, buttons: 0, mode: 'xbutton1' }));
}

section('6. completeSelectionGesture — the pointerup path (per-point work only)');
const GestureCapture = require('../electron/gesture_capture.ts');
function makeStroke(n) {
  const pts = [];
  for (let i = 0; i < n; i += 1) pts.push({ x: 300 + Math.sin(i / 20) * 250 + i * 0.3, y: 400 + Math.cos(i / 17) * 120, t: i * 8 });
  return pts;
}
for (const n of [256, 1024, 4096]) {
  const stroke = makeStroke(n);
  bench(`boundGestureInput(${n} points)`, 2000, () => GestureCapture.boundGestureInput(stroke, null, { maxPoints: 4096, maxStrokes: 32 }));
  const bounded = GestureCapture.boundGestureInput(stroke, null, { maxPoints: 4096, maxStrokes: 32 });
  const r = bench(`summarizeGesture(${n} points)`, 2000, () => GestureCapture.summarizeGesture(bounded.points, bounded.strokes));
  console.log(`    -> if getDisplayNearestPoint were ~1us native, ${n} points = ${(n * 1).toFixed(0)}us of pure native lookup`);
  void r;
}

section('7. sweep_visual.buildSdfPath — runs once per rAF frame while drawing');
const sweep = require('../electron/renderer/sweep_visual.ts');
for (const n of [64, 256, 1024, 4096]) {
  const pts = makeStroke(n);
  bench(`buildSdfPath(${n} raw points)  [per drawing frame]`, 2000, () => sweep.buildSdfPath(pts, 22));
}

section('8. bridge_progress_lines — per stderr chunk of every Python bridge');
const { createProgressLineSplitter } = require('../electron/bridge_progress_lines.ts');
{
  const lines = [];
  for (let i = 0; i < 200; i += 1) lines.push(`@@mp phase=answer_chunk ms=12 b64=${'A'.repeat(160)}`);
  const blob = lines.join('\n') + '\n';
  bench('splitter.feed(200 progress lines / ~33KB)', 2000, () => {
    const split = createProgressLineSplitter(() => {});
    split(blob);
  });
  bench('splitter.feed(1 line / ~190B) x200', 2000, () => {
    const split = createProgressLineSplitter(() => {});
    for (let i = 0; i < 200; i += 1) split(lines[i] + '\n');
  });
}

section('9. renderer-side per-tick rebuild proxies');
{
  const elCount = 9;  
  const btnCount = 12;  
  bench('region mapping arithmetic for 21 elements', 200000, () => {
    let acc = 0;
    for (let i = 0; i < elCount + btnCount; i += 1) {
      const rect = { left: i, top: i, right: i + 100, bottom: i + 40 };
      const padding = i % 2 ? 28 : 8;
      const x = Math.max(0, Math.floor(rect.left - padding));
      const y = Math.max(0, Math.floor(rect.top - padding));
      const right = Math.min(2560, Math.ceil(rect.right + padding));
      const bottom = Math.min(1440, Math.ceil(rect.bottom + padding));
      acc += right - x + bottom - y;
    }
    return acc;
  });
}

section('10. studio stream replay: replaceChildren + String growth');
{
  const n = 2000;
  bench(`String += of ${n} x 190-byte chunks (per answer)`, 200, () => {
    let s = '';
    for (let i = 0; i < n; i += 1) s += 'x'.repeat(190);
    return s.length;
  });
  bench(`Buffer.from(base64).toString(utf8) x ${n} chunks`, 200, () => {
    const b64 = Buffer.from('y'.repeat(190), 'utf8').toString('base64');
    let n2 = 0;
    for (let i = 0; i < n; i += 1) n2 += Buffer.from(b64, 'base64').toString('utf8').length;
    return n2;
  });
}

section('11. conversation_store / settings JSON round-trips');
const store = require('../electron/conversation_store.ts');
{
  const turns = Array.from({ length: 40 }, (_, i) => ({
    id: `t${i}`, question: 'q'.repeat(200), answer: 'a'.repeat(3000), at: Date.now(),
    events: [{ type: 'x', detail: 'd'.repeat(200) }],
    trajectory: Array.from({ length: 40 }, (_u, k) => ({ step: k, note: 'n'.repeat(80) })),
  }));
  bench('JSON.stringify(40 turns x ~5KB)', 200, () => JSON.stringify(turns).length);
  bench('JSON.parse(that same ~200KB blob)', 200, () => JSON.parse(JSON.stringify(turns)).length);
  void store;
}

console.log('\ndone');
