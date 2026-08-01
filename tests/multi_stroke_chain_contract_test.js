'use strict';

// Contract for the unified multi-stroke chain:
// - one activation path, no "modes": a chain of strokes is collected on the
//   overlay and finalized into ONE gesture (this/these regions together);
// - the capsule anchors at the FIRST stroke and never jumps;
// - the arm stays alive between strokes (overlay:gesture-stroke);
// - the stage capsule reports how many regions were selected.

const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');
const overlay = fs.readFileSync('electron/renderer/overlay.js', 'utf8');
const stage = fs.readFileSync('electron/renderer/stage.js', 'utf8');
const stageHtml = fs.readFileSync('electron/renderer/stage.html', 'utf8');
const stageCss = fs.readFileSync('electron/renderer/stage.css', 'utf8');
const preload = fs.readFileSync('electron/preload.js', 'utf8');
const capture = fs.readFileSync('electron/gesture_capture.js', 'utf8');
const { summarizeGesture } = require('../electron/gesture_capture');

// ── summarizeGesture contract ────────────────────────────────────────────
const multi = summarizeGesture(
  [],
  [
    { points: [
      { x: 200, y: 160, t: 0 }, { x: 240, y: 175, t: 40 },
      { x: 250, y: 215, t: 80 }, { x: 220, y: 245, t: 120 },
      { x: 180, y: 235, t: 160 }, { x: 160, y: 195, t: 200 },
      { x: 190, y: 163, t: 240 },
    ] },
    { points: [
      { x: 700, y: 300, t: 300 }, { x: 730, y: 320, t: 340 },
      { x: 735, y: 360, t: 380 }, { x: 705, y: 385, t: 420 },
      { x: 675, y: 370, t: 460 }, { x: 660, y: 330, t: 500 },
      { x: 690, y: 302, t: 540 },
    ] },
  ],
);
assert.strictEqual(multi.valid, true);
assert.strictEqual(multi.kind, 'multi');
assert.strictEqual(multi.strokes.length, 2);
assert.deepStrictEqual(multi.anchorPoint, { x: 190, y: 163 });
assert.deepStrictEqual(multi.releasePoint, { x: 690, y: 302 });

// ── overlay chaining ─────────────────────────────────────────────────────
assert(overlay.includes('let strokes = [];'), 'chain state must exist');
assert(overlay.includes('CHAIN_GAP_MS'), 'rolling finalize window must exist');
assert(overlay.includes('strokes.push({'), 'pointerup must commit the stroke to the chain');
assert(overlay.includes('points: [...points],'), 'the committed stroke keeps its points');
assert(overlay.includes("window.magicPointer?.gestureStroke(gestureToken, strokes.length)"),
  'committed stroke must refresh the arm timeout');
assert(overlay.includes('scheduleChainFinalize'), 'chain must finalize after the gap window');
assert(overlay.includes("if (e.key === 'Enter')"), 'Enter finalizes the chain');
assert(overlay.includes('drawStrokeMarker'), 'committed strokes must be visible while chaining');
assert(overlay.includes('drawPointTarget'), 'committed point targets must remain visibly marked');
assert(overlay.includes('strokes: strokes.map((s) => ({ points: [...s.points] }))'),
  'the done() payload must carry every stroke');
assert(overlay.includes('finalizeGesture'), 'finalize helper must exist');

// ── main keeps the arm alive between strokes ─────────────────────────────
assert(main.includes("ipcMain.on('overlay:gesture-stroke'"),
  'main must handle committed strokes');
const strokeHandler = main.slice(
  main.indexOf("ipcMain.on('overlay:gesture-stroke'"),
  main.indexOf('ipcMain.on(\'stage:submit-selection-command\''),
);
assert(strokeHandler.includes('markSelectionGestureDrawing(arm.token)'),
  'a committed stroke must refresh the gesture expiry');
assert(strokeHandler.includes('String(payload?.token || \'\') !== arm.token'),
  'stroke handler must validate the arm token');

// ── completeSelectionGesture consumes multi-stroke summaries ─────────────
const complete = main.slice(
  main.indexOf('function completeSelectionGesture('),
  main.indexOf('function processPassThroughGestureSample('),
);
assert(complete.includes('summarizeGesture(payload?.points, payload?.strokes)'),
  'gesture completion must accept committed strokes');
assert(complete.includes('anchorPoint'), 'gesture must carry the first-stroke anchor');

// ── capsule anchors at the first stroke, count chip present ──────────────
const begin = main.slice(
  main.indexOf('function beginSelectionSession('),
  main.indexOf('app.whenReady().then('),
);
assert(begin.includes('gesture?.anchorPoint || gesture?.releasePoint'),
  'beginSelectionSession must prefer the first-stroke anchor');
assert(begin.includes('selectionCount'), 'session payload must expose the selection count');
assert(stage.includes('session.selectionCount'), 'stage must track the selection count');
assert(stageHtml.includes('id="capsule-count"'), 'stage must render the count chip');
assert(stageCss.includes('.capsule-count'), 'count chip styling must exist');
assert(preload.includes('gestureStroke'), 'preload must expose gestureStroke');
assert(main.includes('overlay:gesture-stroke'), 'IPC wiring must exist');

console.log('multi stroke chain contract test ok');
