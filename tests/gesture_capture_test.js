'use strict';

const assert = require('assert');
const { summarizeGesture } = require('../electron/gesture_capture');

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
assert.deepStrictEqual(line.strokes, [{ points: line.points }]);
assert(line.pathLength > 110);
assert.strictEqual(line.geometry.type, 'band_corridor', 'line must become a bandwidth corridor');
assert.strictEqual(line.geometry.corridor.length, line.points.length * 2, 
  'corridor is a closed polygon: left edge forward + right edge backward');
assert(line.geometry.widthPx >= 10 && line.geometry.widthPx <= 36,
  'corridor width must scale with the stroke length');
assert.strictEqual(line.geometry.coordinateSpace, 'logical_dips');
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
assert.strictEqual(circle.geometry.type, 'polygon_region', 'circle must become a polygon region');
assert.strictEqual(circle.geometry.ring.length, 33, 
  'the ring is a fixed 32-point sampling of the fitted ellipse');
assert(Math.abs(circle.geometry.ring[0].x - circle.geometry.ring.at(-1).x) < 1e-9,
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
assert.strictEqual(lightning.geometry.type, 'band_corridor');
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
  { x: 13, y: 12, t: 35 },
]);
assert.strictEqual(click.valid, false);
assert.strictEqual(click.reason, 'gesture_too_short');

console.log('gesture capture test ok');
