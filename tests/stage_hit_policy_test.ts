'use strict';

const assert = require('assert');
const {
  DRAG_LEASE_MAX_MS,
  dragLeaseExpired,
  pointInRegions,
  shouldCaptureMouse,
} = require('../electron/stage_hit_policy');

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

assert.strictEqual(shouldCaptureMouse({
  hasInteractiveSurface: true,
  pointer: { x: 4000, y: 4000 },
  interactiveRegions: [capsule],
  dragging: true,
  dragStartedAt: 1000,
  now: 1000 + DRAG_LEASE_MAX_MS,
}), true, 'a drag inside its lease still holds the mouse');
assert.strictEqual(shouldCaptureMouse({
  hasInteractiveSurface: true,
  pointer: { x: 4000, y: 4000 },
  interactiveRegions: [capsule],
  dragging: true,
  dragStartedAt: 1000,
  now: 1000 + DRAG_LEASE_MAX_MS + 1,
}), false, 'a drag that outlived its lease releases the mouse even if the flag is stuck');
assert.strictEqual(shouldCaptureMouse({
  hasInteractiveSurface: false,
  pointer: { x: 4000, y: 4000 },
  interactiveRegions: [capsule],
  dragging: true,
  dragStartedAt: 1000,
  now: 1000 + DRAG_LEASE_MAX_MS + 1,
}), false, 'an expired lease falls back to the region test, not to unconditional capture');
assert.strictEqual(shouldCaptureMouse({
  hasInteractiveSurface: true,
  pointer: { x: 430, y: 90 },
  interactiveRegions: [capsule],
  dragging: true,
  dragStartedAt: 1000,
  now: 1000 + DRAG_LEASE_MAX_MS + 1,
}), true, 'an expired lease over a real region is ordinary region capture');
assert.strictEqual(dragLeaseExpired({ dragStartedAt: 0, now: DRAG_LEASE_MAX_MS }), false);
assert.strictEqual(dragLeaseExpired({ dragStartedAt: 0, now: DRAG_LEASE_MAX_MS + 1 }), true);
assert.strictEqual(dragLeaseExpired({ now: 9001 }), false, 'an unknown start cannot expire');
assert.strictEqual(dragLeaseExpired({ dragStartedAt: NaN, now: 9001 }), false);
assert.strictEqual(
  shouldCaptureMouse({
    hasInteractiveSurface: false,
    pointer: null,
    interactiveRegions: [],
    dragging: true,
  }),
  true,
  'a caller that does not report a start time keeps unbounded capture',
);

console.log('stage_hit_policy_test: all assertions passed');
