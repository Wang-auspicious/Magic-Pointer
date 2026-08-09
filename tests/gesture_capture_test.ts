'use strict';

const assert = require('assert');
const {
  CHAIN_IDLE_FINALIZE_MS,
  QUICK_POINT_MAX_DISTANCE,
  QUICK_POINT_MAX_DURATION_MS,
  chainFinalizeDelay,
  pointerContinuesGestureChain,
  summarizeGesture,
} = require('../electron/gesture_capture');

assert.strictEqual(CHAIN_IDLE_FINALIZE_MS, 520);
assert.strictEqual(chainFinalizeDelay({ now: 1000, deadlineAt: 3500 }), 520,
  'an idle pointer finalizes quickly instead of paying the full multi-stroke gap');
assert.strictEqual(chainFinalizeDelay({ now: 3400, deadlineAt: 3500 }), 100,
  'active movement may extend only to the bounded chain deadline');
assert.strictEqual(pointerContinuesGestureChain(
  { x: 100, y: 100 }, { x: 104, y: 103 },
), true, 'deliberate travel toward another target keeps the chain open');
assert.strictEqual(pointerContinuesGestureChain(
  { x: 100, y: 100 }, { x: 101, y: 101 },
), false, 'sub-pixel pointer jitter must not postpone completion');

const line = summarizeGesture([
  { x: 100, y: 200, t: 0 },
  { x: 150, y: 204, t: 45 },
  { x: 215, y: 211, t: 110 },
]);
assert.strictEqual(line.valid, true);
assert.strictEqual(line.schemaVersion, 2);
assert.strictEqual(line.kind, 'line');
assert(line.semanticPoint && typeof line.semanticPoint.x === 'number',
  'semanticPoint must be present for proximity scoring');
assert.deepStrictEqual(line.releasePoint, { x: 215, y: 211 });
assert.strictEqual(line.strokes.length, 1);
assert.deepStrictEqual(line.strokes[0].points, line.points);
assert.deepStrictEqual(line.anchorPoint, { x: 215, y: 211 }, 'single stroke keeps the release anchor');
assert(line.pathLength > 110);
assert.strictEqual(line.geometry[0].type, 'band_corridor', 'line must become a bandwidth corridor');
assert.strictEqual(line.geometry[0].corridor.length, line.points.length * 2, 
  'corridor is a closed polygon: left edge forward + right edge backward');
assert(line.geometry[0].widthPx >= 10 && line.geometry[0].widthPx <= 36,
  'corridor width must scale with the stroke length');
assert.strictEqual(line.geometry[0].coordinateSpace, 'logical_dips');
const lineDirection = line.direction;
assert(Math.abs(Math.hypot(lineDirection.x, lineDirection.y) - 1) < 1e-9,
  'direction must be a unit vector');
assert(lineDirection.x > 0.99, 
  'a left-to-right line points in the +x direction');

const circle = summarizeGesture([
  { x: 200, y: 160, t: 0 },
  { x: 240, y: 175, t: 40 },
  { x: 250, y: 215, t: 80 },
  { x: 220, y: 245, t: 120 },
  { x: 180, y: 235, t: 160 },
  { x: 160, y: 195, t: 200 },
  { x: 190, y: 163, t: 240 },
]);
assert.strictEqual(circle.valid, true);
assert.strictEqual(circle.kind, 'circle');
assert(circle.semanticPoint && typeof circle.semanticPoint.x === 'number',
  'circle center must be present for proximity scoring');
assert.deepStrictEqual(circle.strokes[0].points, circle.points);
assert.strictEqual(circle.geometry[0].type, 'polygon_region', 'circle must become a polygon region');
assert.strictEqual(circle.geometry[0].ring.length, 33, 
  'the ring is a fixed 32-point sampling of the fitted ellipse');
assert(Math.abs(circle.geometry[0].ring[0].x - circle.geometry[0].ring.at(-1).x) < 1e-9,
  'ring must be closed (first and last points coincide)');

const lightning = summarizeGesture([
  { x: 100, y: 100, t: 0 },
  { x: 180, y: 160, t: 60 },
  { x: 125, y: 220, t: 120 },
  { x: 230, y: 290, t: 190 },
]);
assert.strictEqual(lightning.valid, true);
assert.strictEqual(lightning.kind, 'freeform');
assert(lightning.semanticPoint && typeof lightning.semanticPoint.x === 'number');
assert.deepStrictEqual(lightning.releasePoint, { x: 230, y: 290 });
assert.strictEqual(lightning.geometry[0].type, 'band_corridor');
assert.deepStrictEqual(lightning.semanticPoint, { x: 159, y: 193 }, 'freeform uses the stroke centroid');

const noisy = summarizeGesture([
  { x: 100, y: 300, t: 0 },
  { x: 125, y: 294, t: 19 },
  { x: 118, y: 307, t: 37 },
  { x: 170, y: 299, t: 58 },
  { x: 158, y: 311, t: 79 },
  { x: 230, y: 302, t: 111 },
]);
assert.strictEqual(noisy.valid, true);
assert.deepStrictEqual(noisy.strokes[0].points, [
  { x: 100, y: 300, t: 0 },
  { x: 125, y: 294, t: 19 },
  { x: 118, y: 307, t: 37 },
  { x: 170, y: 299, t: 58 },
  { x: 158, y: 311, t: 79 },
  { x: 230, y: 302, t: 111 },
], 'noise, reversals, ordering, and timestamps are grounding evidence');

const click = summarizeGesture([
  { x: 10, y: 10, t: 0 },
  { x: 13, y: 12, t: QUICK_POINT_MAX_DURATION_MS },
]);
assert.strictEqual(click.valid, true, 'a prompt press-release is a point target');
assert.strictEqual(click.kind, 'point');
assert.deepStrictEqual(click.semanticPoint, { x: 13, y: 12 });
assert.deepStrictEqual(click.releasePoint, { x: 13, y: 12 });
assert.strictEqual(click.geometry[0].type, 'point_target');
assert.strictEqual(click.geometry[0].radiusPx, QUICK_POINT_MAX_DISTANCE);

const slowClick = summarizeGesture([
  { x: 10, y: 10, t: 0 },
  { x: 13, y: 12, t: QUICK_POINT_MAX_DURATION_MS + 1 },
]);
assert.strictEqual(slowClick.valid, false, 'a stationary hold beyond the threshold is not a click');
assert.strictEqual(slowClick.reason, 'gesture_too_short');

// Unified multi-stroke chain: several circles committed before finalize.
const multi = summarizeGesture(
  [
    { x: 400, y: 100, t: 0 },
    { x: 410, y: 120, t: 30 },
  ],
  [
    { points: [
      { x: 200, y: 160, t: 0 },
      { x: 240, y: 175, t: 40 },
      { x: 250, y: 215, t: 80 },
      { x: 220, y: 245, t: 120 },
      { x: 180, y: 235, t: 160 },
      { x: 160, y: 195, t: 200 },
      { x: 190, y: 163, t: 240 },
    ] },
    { points: [
      { x: 700, y: 300, t: 300 },
      { x: 730, y: 320, t: 340 },
      { x: 735, y: 360, t: 380 },
      { x: 705, y: 385, t: 420 },
      { x: 675, y: 370, t: 460 },
      { x: 660, y: 330, t: 500 },
      { x: 690, y: 302, t: 540 },
    ] },
  ],
);
assert.strictEqual(multi.valid, true);
assert.strictEqual(multi.kind, 'multi', 'a multi-stroke chain is one unified gesture');
assert.strictEqual(multi.strokes.length, 2);
assert.strictEqual(multi.strokes[0].kind, 'circle');
assert.strictEqual(multi.strokes[1].kind, 'circle');
assert.strictEqual(multi.strokes[0].semanticPoint.x, 205, 'first circle center');
assert.strictEqual(multi.strokes[1].semanticPoint.x, 698, 'second circle center');
assert.deepStrictEqual(multi.anchorPoint, { x: 190, y: 163 }, 'capsule anchors at FIRST stroke release');
assert.deepStrictEqual(multi.releasePoint, { x: 690, y: 302 }, 'gesture release tracks the LAST stroke');
assert.strictEqual(multi.bbox.x, 160);
assert.strictEqual(multi.bbox.y, 160);
assert.strictEqual(multi.bbox.width, 575, 'aggregate bbox covers both strokes');
assert.strictEqual(multi.bbox.height, 225);
assert.strictEqual(multi.geometry.length, 2, 'per-stroke geometry is preserved');

// A deliberate quick click is now a point target and may participate in a chain.
const chainWithJunk = summarizeGesture(
  [],
  [
    { points: [
      { x: 300, y: 300, t: 0 },
      { x: 305, y: 303, t: 30 },
    ] },
    { points: [
      { x: 500, y: 500, t: 100 },
      { x: 540, y: 505, t: 140 },
      { x: 545, y: 545, t: 180 },
      { x: 505, y: 548, t: 220 },
    ] },
  ],
);
assert.strictEqual(chainWithJunk.valid, true, 'a quick point and a drawn stroke form one valid chain');
assert.strictEqual(chainWithJunk.kind, 'multi');
assert.strictEqual(chainWithJunk.strokes.length, 2);
assert.strictEqual(chainWithJunk.strokes[0].kind, 'point');

console.log('gesture capture test ok');
