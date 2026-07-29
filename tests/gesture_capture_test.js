'use strict';

const assert = require('assert');
const { summarizeGesture } = require('../electron/gesture_capture');

const line = summarizeGesture([
  { x: 100, y: 200, t: 0 },
  { x: 150, y: 204, t: 45 },
  { x: 215, y: 211, t: 110 },
]);
assert.strictEqual(line.valid, true);
assert.strictEqual(line.kind, 'line');
assert.deepStrictEqual(line.releasePoint, { x: 215, y: 211 });
assert(line.pathLength > 110);

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
assert(circle.semanticPoint.x >= 195 && circle.semanticPoint.x <= 205);
assert(circle.semanticPoint.y >= 198 && circle.semanticPoint.y <= 208);

const lightning = summarizeGesture([
  { x: 100, y: 100, t: 0 },
  { x: 180, y: 160, t: 60 },
  { x: 125, y: 220, t: 120 },
  { x: 230, y: 290, t: 190 },
]);
assert.strictEqual(lightning.valid, true);
assert.strictEqual(lightning.kind, 'freeform');
assert.deepStrictEqual(lightning.releasePoint, { x: 230, y: 290 });

const click = summarizeGesture([
  { x: 10, y: 10, t: 0 },
  { x: 13, y: 12, t: 35 },
]);
assert.strictEqual(click.valid, false);
assert.strictEqual(click.reason, 'gesture_too_short');

console.log('gesture capture test ok');
