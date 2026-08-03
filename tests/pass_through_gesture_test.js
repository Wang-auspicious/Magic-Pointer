'use strict';

const assert = require('assert');
const { PassThroughGestureCapture } = require('../electron/pass_through_gesture');

function sample(t, x, y, buttons) {
  return { t, x, y, buttons };
}

const capture = new PassThroughGestureCapture({ minimumPointDistance: 2 });
capture.arm({
  token: 'first',
  displayBounds: { x: 100, y: 50, width: 800, height: 600 },
  initialButtons: 0,
});

assert.deepStrictEqual(
  capture.push(sample(10, 140, 90, 1)).map((event) => event.type),
  ['started', 'point'],
  'a real global left-button edge starts a click-through stroke',
);
assert.deepStrictEqual(
  capture.push(sample(20, 180, 110, 1)).map((event) => event.type),
  ['point'],
);
const completed = capture.push(sample(30, 200, 120, 0));
assert.deepStrictEqual(completed.map((event) => event.type), ['point', 'completed']);
assert.strictEqual(completed.at(-1).token, 'first');
assert.deepStrictEqual(completed.at(-1).points.at(0), { x: 40, y: 40, t: 10 });
assert.deepStrictEqual(completed.at(-1).releasePoint, { x: 100, y: 70 });
assert.strictEqual(capture.active, false, 'release must fully retire the arm');

capture.arm({
  token: 'second',
  displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
  initialButtons: 0,
});
assert.deepStrictEqual(
  capture.push(sample(40, 300, 200, 2)).map((event) => event.type),
  ['dismissed'],
  'right click exits without leaving a stale drawing owner',
);
assert.strictEqual(capture.active, false);

capture.arm({
  token: 'third',
  displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
  initialButtons: 0,
});
assert.deepStrictEqual(
  capture.push(sample(50, 320, 220, 1)).map((event) => event.type),
  ['started', 'point'],
  'a new arm must work immediately after right-click dismissal',
);
assert.deepStrictEqual(
  capture.push(sample(60, 350, 240, 0)).map((event) => event.type),
  ['point', 'completed'],
);

capture.arm({
  token: 'held',
  displayBounds: { x: 0, y: 0, width: 500, height: 500 },
  initialButtons: 1,
});
assert.deepStrictEqual(
  capture.push(sample(70, 30, 30, 1)),
  [],
  'arming while the left button is already held must not synthesize a stroke',
);
assert.deepStrictEqual(capture.push(sample(80, 30, 30, 0)), []);
assert.deepStrictEqual(
  capture.push(sample(90, 40, 40, 1)).map((event) => event.type),
  ['started', 'point'],
  'the next genuine down edge remains available',
);

const quickClick = new PassThroughGestureCapture({ minimumPointDistance: 2 });
quickClick.arm({
  token: 'quick-click',
  displayBounds: { x: 0, y: 0, width: 500, height: 500 },
  initialButtons: 0,
});
quickClick.push(sample(100, 120, 130, 1));
const quickCompleted = quickClick.push(sample(220, 121, 131, 0));
assert.deepStrictEqual(quickCompleted.map((event) => event.type), ['completed']);
assert.deepStrictEqual(quickCompleted[0].points, [
  { x: 120, y: 130, t: 100 },
  { x: 121, y: 131, t: 220 },
], 'release must be retained even when it is inside the movement sampling threshold');

const chained = new PassThroughGestureCapture({ minimumPointDistance: 2 });
chained.arm({
  token: 'chained',
  displayBounds: { x: 0, y: 0, width: 800, height: 600 },
  initialButtons: 0,
  multiStroke: true,
});
chained.push(sample(300, 100, 100, 1));
const firstStroke = chained.push(sample(340, 180, 130, 0));
assert.deepStrictEqual(firstStroke.map((event) => event.type), ['point', 'stroke-completed']);
assert.strictEqual(firstStroke.at(-1).index, 1);
assert.strictEqual(chained.active, true, 'multi-stroke capture stays armed during the grace period');
chained.push(sample(500, 400, 300, 1));
const secondStroke = chained.push(sample(560, 480, 340, 0));
assert.strictEqual(secondStroke.at(-1).type, 'stroke-completed');
assert.strictEqual(secondStroke.at(-1).index, 2);
const chainedDone = chained.finish();
assert.strictEqual(chainedDone.type, 'completed');
assert.strictEqual(chainedDone.strokes.length, 2);
assert.deepStrictEqual(chainedDone.releasePoint, { x: 480, y: 340 });
assert.strictEqual(chained.active, false);

console.log('pass_through_gesture_test: all assertions passed');
