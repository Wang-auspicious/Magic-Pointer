'use strict';

const assert = require('assert');
const { pointInRegions, shouldCaptureMouse } = require('../electron/stage_hit_policy');

const sweep = { x: 100, y: 100, width: 420, height: 70 };
const capsule = { x: 390, y: 70, width: 180, height: 52 };

assert.strictEqual(pointInRegions({ x: 170, y: 130 }, [capsule]), false);
assert.strictEqual(pointInRegions({ x: 430, y: 90 }, [capsule]), true);
assert.strictEqual(pointInRegions(null, [capsule]), false);
assert.strictEqual(pointInRegions({ x: NaN, y: 90 }, [capsule]), false);
assert.strictEqual(shouldCaptureMouse({
  hasInteractiveSurface: true,
  pointer: { x: 170, y: 130 },
  interactiveRegions: [capsule],
  visualRegions: [sweep, capsule],
}), false, 'a visual sweep region must remain click-through');
assert.strictEqual(shouldCaptureMouse({
  hasInteractiveSurface: true,
  pointer: { x: 430, y: 90 },
  interactiveRegions: [capsule],
  visualRegions: [sweep, capsule],
}), true, 'the text capsule must capture its own mouse interactions');
assert.strictEqual(shouldCaptureMouse({
  hasInteractiveSurface: false,
  pointer: { x: 430, y: 90 },
  interactiveRegions: [capsule],
}), false);

console.log('stage_hit_policy_test: all assertions passed');
