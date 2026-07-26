const assert = require('assert');
const fs = require('fs');
const { physicalScreenPoint } = require('../electron/coordinate_space');

const mixedDpiScreen = {
  dipToScreenPoint(point) {
    return { x: point.x * 1.5 - 120, y: point.y * 1.5 };
  },
};

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

const main = fs.readFileSync('electron/main.js', 'utf8');
assert(main.includes("const { physicalScreenPoint } = require('./coordinate_space');"));
assert(main.includes('const physicalCursor = physicalScreenPoint(screen, cursor);'));
assert(main.includes("cursorSpace: physicalCursor ? 'physical_screen_pixels' : null"));
assert(main.includes('targetPoint: safeClone(session.snapshot?.target_point || null)'));

console.log('coordinate space test ok');
