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

// Pointer capture: a drag owns the mouse from press to release. Without this
// the cursor flickered between the stage and the app below, and dragging the
// bubble selected text in whatever was underneath it.
assert.strictEqual(shouldCaptureMouse({
  hasInteractiveSurface: true,
  pointer: { x: 4000, y: 4000 },
  interactiveRegions: [capsule],
  dragging: true,
}), true, 'a drag keeps the mouse even when the pointer has left every region');
assert.strictEqual(shouldCaptureMouse({
  hasInteractiveSurface: false,
  pointer: null,
  interactiveRegions: [],
  dragging: true,
}), true, 'a drag outranks the surface and region checks entirely');
assert.strictEqual(shouldCaptureMouse({
  hasInteractiveSurface: true,
  pointer: { x: 4000, y: 4000 },
  interactiveRegions: [capsule],
  dragging: false,
}), false, 'releasing the drag restores normal region-based capture');

console.log('stage_hit_policy_test: all assertions passed');
