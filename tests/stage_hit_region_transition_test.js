'use strict';

const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('electron/renderer/stage.ts', 'utf8');

assert(source.includes('function syncHitRegions()'),
  'native shape updates must be isolated from state side effects');
assert(source.includes('function scheduleHitRegionRefresh()'),
  'surface visibility changes must schedule native shape refreshes');
assert(!source.includes('function capsuleVisualRegion('),
  'a fixed composer must not maintain a second animated-width hit region');
assert.doesNotMatch(source, /getPropertyValue\('--capsule-width'\)/,
  'native hit geometry must use the already-final DOM rectangle');
assert.match(
  source,
  /capsule\.addEventListener\('transitionend',\s*syncHitRegions\)/,
  'the final opacity transition still refreshes native hit geometry',
);
assert.match(
  source,
  /setTimeout\(syncHitRegions,\s*2(?:2|4)0\)/,
  'a bounded fallback refresh must cover missed transition events',
);

assert.match(
  source,
  /function visibleStageRegions\(\)[\s\S]*selectionStretch/,
  'visibleStageRegions must include selectionStretch so stretch handles receive clicks',
);
assert.match(
  source,
  /capsuleDrag \|\| surfaceDrag \|\| selectionStretchDrag/,
  'syncHitRegions must treat selectionStretchDrag as an active drag',
);
console.log('stage_hit_region_transition_test: all assertions passed');
