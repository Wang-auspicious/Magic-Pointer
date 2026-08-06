'use strict';

const assert = require('assert');
const { nativeShapeRegions } = require('../electron/stage_hit_regions');

const doubleDensityScreen = {
  dipToScreenPoint(point) {
    return { x: point.x * 2, y: point.y * 2 };
  },
};

assert.deepStrictEqual(
  nativeShapeRegions({
    platform: 'win32',
    screenApi: doubleDensityScreen,
    stageBounds: { x: 0, y: 0, width: 1560, height: 1040 },
    regions: [{ x: 982, y: 111, width: 116, height: 36 }],
  }),
  [{ x: 982, y: 111, width: 116, height: 36 }],
  'Electron renderer rectangles and BrowserWindow.setShape share window pixels on Windows',
);

assert.deepStrictEqual(
  nativeShapeRegions({
    platform: 'linux',
    screenApi: doubleDensityScreen,
    stageBounds: { x: 0, y: 0, width: 1560, height: 1040 },
    regions: [{ x: 982, y: 111, width: 116, height: 36 }],
  }),
  [{ x: 982, y: 111, width: 116, height: 36 }],
  'non-Windows shapes use the same renderer/window coordinate contract',
);

console.log('stage_shape_scaling_test: all assertions passed');
