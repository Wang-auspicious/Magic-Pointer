const assert = require('assert');
const fs = require('fs');
const {
  physicalDisplayBounds,
  physicalGestureBoundingBox,
  physicalScreenPoint,
  physicalGestureTraceResult,
  normalizeGroundingGeometry,
} = require('../electron/coordinate_space');

assert.deepStrictEqual(
  physicalGestureBoundingBox([
    { x: 625, y: 846 },
    { x: 1370, y: 846 },
  ], 16),
  { x: 625, y: 838, width: 745, height: 16 },
  'a perfectly horizontal stroke is a physical corridor, not a zero-area box',
);
assert.deepStrictEqual(
  physicalGestureBoundingBox([
    { x: 900, y: 200 },
    { x: 900, y: 500 },
  ], 16),
  { x: 892, y: 200, width: 16, height: 300 },
  'a perfectly vertical stroke receives the same centered thickness',
);

const mixedDpiScreen = {
  dipToScreenPoint(point: { x: number; y: number }) {
    return { x: point.x * 1.5 - 120, y: point.y * 1.5 };
  },
  screenToDipPoint(point: { x: number; y: number }) {
    return { x: (point.x + 120) / 1.5, y: point.y / 1.5 };
  },
  screenToDipRect(_window: null, rect: { height: number; width: number; x: number; y: number }) {
    return {
      x: Math.round((rect.x + 120) / 1.5),
      y: Math.round(rect.y / 1.5),
      width: Math.round(rect.width / 1.5),
      height: Math.round(rect.height / 1.5),
    };
  },
};

const ring = [{ x: 10, y: 10 }, { x: 180, y: 10 }, { x: 180, y: 160 }, { x: 10, y: 160 }, { x: 10, y: 10 }];
for (const coordinateSpace of ['electron_dip', 'physical_screen_pixels']) {
  const physical = coordinateSpace === 'physical_screen_pixels';
  const trace = physicalGestureTraceResult(mixedDpiScreen, {
    coordinateSpace,
    strokes: [{ points: ring.slice(0, -1), kind: 'circle',
      shapeVerdict: { kind: 'circle', closedness: 0.18 },
      geometry: { type: 'polygon_region', ring, coordinateSpace },
    }],
  });
  assert.strictEqual(trace.ok, true);
  assert.strictEqual(trace.trace.strokes[0].geometry?.type, 'polygon_region');
  assert.deepStrictEqual(trace.trace.strokes[0].geometry.ring,
    physical ? ring : ring.map((point) => mixedDpiScreen.dipToScreenPoint(point)));
  assert.strictEqual(trace.trace.strokes[0].geometry.coordinateSpace, 'physical_screen_pixels');
  assert.strictEqual(trace.trace.strokes[0].kind, 'circle');
}

assert.deepStrictEqual(
  physicalScreenPoint(mixedDpiScreen, { x: -800, y: 200 }),
  { x: -1320, y: 300 },
);
assert.deepStrictEqual(
  physicalScreenPoint({ dipToScreenPoint: () => ({ x: 100.4, y: 200.6 }) }, { x: 1, y: 2 }),
  { x: 100, y: 201 },
);
assert.strictEqual(physicalScreenPoint({}, { x: 1, y: 2 }), null);
assert.strictEqual(physicalScreenPoint(mixedDpiScreen, { x: NaN, y: 2 }), null);
assert.strictEqual(physicalScreenPoint({ dipToScreenPoint: () => { throw new Error('no display'); } }, { x: 1, y: 2 }), null);

const geometry = normalizeGroundingGeometry({
  pointer: { x: -1320, y: 300 },
  pointerSpace: 'physical_screen_pixels',
  targetRects: [{ x: -1330, y: 286, width: 160, height: 28 }],
  targetSpace: 'physical_screen_pixels',
  targetFormat: 'xywh',
  captureRect: { x: -1500, y: 120, width: 640, height: 420 },
  captureSpace: 'physical_screen_pixels',
  captureFormat: 'xywh',
  stageBounds: { x: -880, y: 0, width: 880, height: 1440 },
  screenApi: mixedDpiScreen,
});

assert.strictEqual(geometry.state, 'resolved');
assert.deepStrictEqual(
  geometry.capturePhysicalRect,
  { x: -1500, y: 120, width: 640, height: 420 },
);
assert.notDeepStrictEqual(geometry.stageTarget, geometry.capturePhysicalRect);
assert.deepStrictEqual(geometry.stageTarget, { x: 73, y: 191, width: 107, height: 19 });

assert.strictEqual(normalizeGroundingGeometry({
  pointer: { x: 10, y: 20 },
  pointerSpace: 'electron_dip',
  stageBounds: { x: 0, y: 0, width: 800, height: 600 },
  screenApi: mixedDpiScreen,
}).state, 'invalid');

assert.strictEqual(normalizeGroundingGeometry({
  pointer: { x: 10, y: 20 },
  pointerSpace: 'physical_screen_pixels',
  targetRects: [{ x: 1, y: 2, width: Infinity, height: 10 }],
  targetSpace: 'physical_screen_pixels',
  targetFormat: 'xywh',
  stageBounds: { x: 0, y: 0, width: 800, height: 600 },
  screenApi: mixedDpiScreen,
}).state, 'invalid');

assert.strictEqual(normalizeGroundingGeometry({
  pointer: { x: 10, y: 20 },
  pointerSpace: 'physical_screen_pixels',
  targetRects: [{ x: 1, y: 2, width: 0, height: 10 }],
  targetSpace: 'physical_screen_pixels',
  targetFormat: 'xywh',
  stageBounds: { x: 0, y: 0, width: 800, height: 600 },
  screenApi: mixedDpiScreen,
}).state, 'invalid');

const pointerOnly = normalizeGroundingGeometry({
  pointer: { x: 300, y: 150 },
  pointerSpace: 'physical_screen_pixels',
  stageBounds: { x: 0, y: 0, width: 800, height: 600 },
  screenApi: mixedDpiScreen,
});
assert.strictEqual(pointerOnly.state, 'pointer_only');
assert.deepStrictEqual(pointerOnly.stageTarget, { x: 272, y: 92, width: 16, height: 16 });

{
  assert.deepStrictEqual(
    physicalDisplayBounds({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
    [0, 0, 1920, 1080],
    'a 100% display keeps its own bounds',
  );
  assert.deepStrictEqual(
    physicalDisplayBounds({ bounds: { x: 1920, y: 0, width: 1707, height: 960 }, scaleFactor: 1.5 }),
    [2880, 0, 5441, 1440],
    'a secondary 150% display maps origin and size separately',
  );
  assert.deepStrictEqual(
    physicalDisplayBounds({ bounds: { x: -1920, y: 0, width: 1707, height: 960 }, scaleFactor: 1.5 }),
    [-2880, 0, -319, 1440],
    'negative-origin displays map below zero on the physical virtual screen',
  );
  assert.strictEqual(
    physicalDisplayBounds({ bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1.25 })[2]
      - physicalDisplayBounds({ bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1.25 })[0],
    125,
    'physical width is DIP width scaled, never the DIP width itself',
  );
  assert.throws(
    () => physicalDisplayBounds({ bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 0 }),
    /scaleFactor/,
  );
  assert.throws(
    () => physicalDisplayBounds({ bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: NaN }),
    /scaleFactor/,
  );
  assert.throws(
    () => physicalDisplayBounds({ bounds: { x: 0, y: 0, width: Infinity, height: 100 }, scaleFactor: 1 }),
    /bounds/,
  );
}

{
  const { normalizeCoordinateSpace, physicalGestureTraceResult } = require('../electron/coordinate_space');

  assert.deepStrictEqual(
    physicalGestureTraceResult(null, null),
    { ok: false, reason: 'gesture_absent', trace: null },
  );
  assert.deepStrictEqual(
    physicalGestureTraceResult(null, { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }),
    { ok: false, reason: 'screen_api_unavailable', trace: null },
    'no dipToScreenPoint is a stated failure, not an empty gesture',
  );
  assert.deepStrictEqual(
    physicalGestureTraceResult({}, { points: [{ x: 1, y: 2 }] }),
    { ok: false, reason: 'screen_api_unavailable', trace: null },
  );
  assert.deepStrictEqual(
    physicalGestureTraceResult(
      { dipToScreenPoint: () => { throw new Error('no display'); } },
      { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
    ),
    { ok: false, reason: 'gesture_unconvertible', trace: null },
  );

  const doubled = { dipToScreenPoint: (p: { x: number; y: number }) => ({ x: p.x * 2, y: p.y * 2 }) };
  const corruptRelease = physicalGestureTraceResult(doubled, {
    coordinateSpace: 'physical_screen_pixels',
    points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
    releasePoint: { x: 'nope', y: undefined },
  });
  assert.strictEqual(corruptRelease.ok, true);
  assert.deepStrictEqual(corruptRelease.trace.releasePoint, { x: 30, y: 40 });

  const zeroRelease = physicalGestureTraceResult(doubled, {
    coordinateSpace: 'physical_screen_pixels',
    points: [{ x: 0, y: 0 }, { x: 4, y: 4 }],
    releasePoint: { x: 0, y: 0 },
  });
  assert.deepStrictEqual(zeroRelease.trace.releasePoint, { x: 0, y: 0 });

  assert.strictEqual(normalizeCoordinateSpace('physical_screen_pixels'), 'physical_screen_pixels');
  assert.strictEqual(normalizeCoordinateSpace('physical-screen-pixels'), 'physical_screen_pixels');
}

const main = fs.readFileSync('electron/main.ts', 'utf8');
assert(main.includes('physicalGestureBoundingBox,'));
assert(main.includes('physicalScreenPoint,'));
assert(main.includes("} = require('./coordinate_space');"));
assert(main.includes('const physicalCursor = physicalScreenPoint(screen, targetPoint);'));
assert(main.includes("cursorSpace: physicalCursor ? 'physical_screen_pixels' : null"));
assert(main.includes('targetPoint: safeClone(session.snapshot?.target_point || null)'));

console.log('coordinate space test ok');
