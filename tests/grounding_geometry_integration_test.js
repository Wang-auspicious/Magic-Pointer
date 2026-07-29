const assert = require('assert');
const { normalizeGroundingGeometry } = require('../electron/coordinate_space');

const identityScreen = {
  screenToDipPoint(point) {
    return { ...point };
  },
  screenToDipRect(_window, rect) {
    return { ...rect };
  },
};

const structured = normalizeGroundingGeometry({
  pointer: { x: 640, y: 520 },
  pointerSpace: 'physical_screen_pixels',
  targetRects: [[610, 500, 80, 24]],
  targetSpace: 'physical_screen_pixels',
  targetFormat: 'xywh',
  stageBounds: { x: 0, y: 0, width: 1920, height: 1080 },
  screenApi: identityScreen,
});

const pointerOnly = normalizeGroundingGeometry({
  pointer: { x: 600, y: 500 },
  pointerSpace: 'physical_screen_pixels',
  targetRects: [],
  targetSpace: 'physical_screen_pixels',
  targetFormat: 'xywh',
  targetKind: 'pointer_anchor',
  captureRect: [280, 290, 920, 710],
  captureSpace: 'physical_screen_pixels',
  captureFormat: 'ltrb',
  stageBounds: { x: 0, y: 0, width: 1920, height: 1080 },
  screenApi: identityScreen,
});

assert.strictEqual(structured.state, 'resolved');
assert.deepStrictEqual(structured.stageTarget, { x: 610, y: 500, width: 80, height: 24 });
assert.strictEqual(pointerOnly.state, 'pointer_only');
assert.strictEqual(pointerOnly.capturePhysicalRect.width, 640);
assert.strictEqual(pointerOnly.capturePhysicalRect.height, 420);
assert(pointerOnly.capturePhysicalRect.width > pointerOnly.stageTarget.width);
assert(pointerOnly.capturePhysicalRect.height > pointerOnly.stageTarget.height);
assert.deepStrictEqual(pointerOnly.stageTarget, { x: 592, y: 492, width: 16, height: 16 });

console.log('grounding geometry integration test ok');
