'use strict';


const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  COORDINATE_SPACES,
  isPhysicalScreenPixels,
  normalizeCoordinateSpace,
} = require('../electron/coordinate_space');
const {
  GEOMETRY_COORDINATE_SPACE,
  STROKE_CLASSIFIER_THRESHOLDS,
  summarizeGesture,
} = require('../electron/gesture_capture');


assert.deepStrictEqual(
  Object.keys(COORDINATE_SPACES).sort(),
  ['DIP_SCREEN', 'DIP_WINDOW', 'PHYSICAL_SCREEN_PIXELS'],
  'the enum names every space the contract defines',
);
assert.strictEqual(COORDINATE_SPACES.PHYSICAL_SCREEN_PIXELS, 'physical_screen_pixels');
assert.strictEqual(COORDINATE_SPACES.DIP_WINDOW, 'dip_window');
assert(Object.isFrozen(COORDINATE_SPACES), 'the enum is a constant, not a mutable table');


assert.strictEqual(
  normalizeCoordinateSpace('physical-screen-pixels'),
  COORDINATE_SPACES.PHYSICAL_SCREEN_PIXELS,
  'the legacy hyphenated spelling still reads as physical screen pixels',
);
assert.strictEqual(isPhysicalScreenPixels('physical-screen-pixels'), true);
assert.strictEqual(isPhysicalScreenPixels('physical_screen_pixels'), true);
assert.strictEqual(
  normalizeCoordinateSpace('logical_dips'),
  COORDINATE_SPACES.DIP_WINDOW,
  'the old geometry space resolves to the window-DIP space it always meant',
);
assert.strictEqual(isPhysicalScreenPixels('logical_dips'), false);
assert.strictEqual(normalizeCoordinateSpace('physical_screen_pixel'), null);
assert.strictEqual(normalizeCoordinateSpace(''), null);
assert.strictEqual(normalizeCoordinateSpace(undefined), null);
assert.strictEqual(normalizeCoordinateSpace(7), null);
assert.strictEqual(isPhysicalScreenPixels('nonsense'), false, 'unknown spaces fail closed');


assert.strictEqual(
  GEOMETRY_COORDINATE_SPACE,
  COORDINATE_SPACES.DIP_WINDOW,
  'gesture geometry must declare the canonical window-DIP space, not "logical_dips"',
);

{
  const circle = summarizeGesture([
    { x: 200, y: 160, t: 0 },
    { x: 240, y: 175, t: 40 },
    { x: 250, y: 215, t: 80 },
    { x: 220, y: 245, t: 120 },
    { x: 180, y: 235, t: 160 },
    { x: 160, y: 195, t: 200 },
    { x: 190, y: 163, t: 240 },
  ]);
  assert.strictEqual(circle.strokes[0].kind, 'circle');
  assert.strictEqual(
    circle.strokes[0].geometry.coordinateSpace,
    COORDINATE_SPACES.DIP_WINDOW,
  );
}


const PYTHON_AND_CONSUMER_GUARDS = [
  'app/grounding/evidence_binding.py',
  'app/actions/draft_delivery.py',
  'app/actions/executor.py',
  'app/adapters/browser_devtools_adapter.py',
  'scripts/selection_snapshot_bridge.py',
  'electron/internal_action_policy.ts',
];
for (const relative of PYTHON_AND_CONSUMER_GUARDS) {
  const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  assert(
    source.includes(COORDINATE_SPACES.PHYSICAL_SCREEN_PIXELS),
    `${relative} must require the canonical physical-screen-pixels spelling`,
  );
  assert(
    !source.includes('physical-screen-pixels'),
    `${relative} must not contain the legacy hyphenated spelling`,
  );
}


const PIPELINE_FILES = [
  'electron/coordinate_space.ts',
  'electron/gesture_capture.ts',
  'electron/interaction_episode.ts',
  'electron/selection_session.ts',
  'electron/stage_hit_policy.ts',
  'electron/stage_pick_policy.ts',
  'electron/gesture_runtime_settings.ts',
];
const RETIRED_SPELLINGS = ['physical-screen-pixels', 'logical_dips', 'electron_dip_screen'];
for (const relative of PIPELINE_FILES) {
  const absolute = path.join(__dirname, '..', relative);
  if (!fs.existsSync(absolute)) continue;
  const source = fs.readFileSync(absolute, 'utf8');
  for (const retired of RETIRED_SPELLINGS) {
    if (relative === 'electron/coordinate_space.ts') {
      assert.strictEqual(
        source.split(retired).length - 1,
        1,
        `coordinate_space.ts may reference the retired spelling ${retired} only as a legacy alias`,
      );
      continue;
    }
    assert(
      !source.includes(retired),
      `${relative} still writes the retired coordinate-space spelling ${retired}`,
    );
  }
  const literalPhysical = source.match(/'physical_screen_pixels'/g) || [];
  if (relative !== 'electron/coordinate_space.ts') {
    assert.strictEqual(
      literalPhysical.length,
      0,
      `${relative} must use COORDINATE_SPACES.PHYSICAL_SCREEN_PIXELS, not the literal`,
    );
  }
}

const episode = fs.readFileSync(path.join(__dirname, '..', 'electron/interaction_episode.ts'), 'utf8');
assert(
  episode.includes('COORDINATE_SPACES.PHYSICAL_SCREEN_PIXELS'),
  'the visual-region locator must take its discriminant from the one enum',
);


{
  const circle = summarizeGesture([
    { x: 200, y: 160, t: 0 },
    { x: 240, y: 175, t: 40 },
    { x: 250, y: 215, t: 80 },
    { x: 220, y: 245, t: 120 },
    { x: 180, y: 235, t: 160 },
    { x: 160, y: 195, t: 200 },
    { x: 190, y: 163, t: 240 },
  ]);
  const stroke = circle.strokes[0];
  assert(stroke.shapeVerdict, 'a stroke carries its classified shape');
  assert.strictEqual(stroke.shapeVerdict.kind, stroke.kind);
  assert.strictEqual(stroke.shapeVerdict.closed, true, 'a circle is closed');
  assert.strictEqual(stroke.shapeVerdict.closed, stroke.kind === 'circle');
  assert.strictEqual(
    stroke.shapeVerdict.thresholds,
    STROKE_CLASSIFIER_THRESHOLDS,
    'the verdict carries the thresholds it was reached with',
  );
  assert.deepStrictEqual(STROKE_CLASSIFIER_THRESHOLDS, {
    minPoints: 6,
    minEdgeDip: 16,
    closureRatio: 0.36,
    circuitRatio: 1.65,
    straightness: 0.8,
  }, 'every classifier threshold is a ratio or a DIP value, never an absolute pixel count');

  const line = summarizeGesture([
    { x: 100, y: 100, t: 0 },
    { x: 300, y: 104, t: 90 },
    { x: 500, y: 100, t: 180 },
  ]);
  assert.strictEqual(line.strokes[0].shapeVerdict.closed, false, 'a line is not closed');
  assert.strictEqual(line.strokes[0].shapeVerdict.kind, 'line');
}

console.log('coordinate space canonical test ok');
