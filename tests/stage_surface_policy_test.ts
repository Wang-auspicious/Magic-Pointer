const assert = require('assert');

const {
  COMPOSER_SIZE,
  WORK_PANEL_SIZE,
  surfaceSize,
  stableSurfacePlacement,
} = require('../electron/stage_surface_policy');

assert.deepStrictEqual(COMPOSER_SIZE, { width: 480, height: 132 });
assert.deepStrictEqual(WORK_PANEL_SIZE, { width: 440, height: 300 });

assert.deepStrictEqual(
  surfaceSize('composer', { width: 1920, height: 1080 }),
  COMPOSER_SIZE,
  'the composer must not grow with transcript length',
);
assert.deepStrictEqual(
  surfaceSize('work-panel', { width: 1920, height: 1080 }),
  WORK_PANEL_SIZE,
  'the work panel must not grow with answer length',
);
assert.deepStrictEqual(
  surfaceSize('work-panel', { width: 420, height: 360 }),
  { width: 404, height: 300 },
  'small screens may clamp a surface once, but content must not resize it',
);

let placements = 0;
const first = stableSurfacePlacement({
  previous: null,
  sessionToken: 'session-a',
  role: 'work-panel',
  viewport: { width: 1920, height: 1080 },
  place: (size: { width: number; height: number }) => {
    placements += 1;
    return { x: 1200, y: 80, side: 'right', mode: 'outside', ...size };
  },
});
const streamed = stableSurfacePlacement({
  previous: first,
  sessionToken: 'session-a',
  role: 'work-panel',
  viewport: { width: 1920, height: 1080 },
  place: () => {
    placements += 1;
    return { x: 10, y: 10 };
  },
});
assert.strictEqual(streamed, first, 'streaming content must reuse the exact placement object');
assert.strictEqual(placements, 1, 'the anchor policy must run only once per surface session');

const next = stableSurfacePlacement({
  previous: first,
  sessionToken: 'session-b',
  role: 'work-panel',
  viewport: { width: 1920, height: 1080 },
  place: () => {
    placements += 1;
    return { x: 16, y: 16 };
  },
});
assert.notStrictEqual(next, first, 'a new session must choose a fresh anchor');
assert.strictEqual(placements, 2);

console.log('stage surface policy test ok');
