'use strict';

const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('electron/renderer/stage.ts', 'utf8');

assert(source.includes('function syncHitRegions()'),
  'native shape updates must be isolated from dictation/state side effects');
assert(source.includes('function scheduleHitRegionRefresh()'),
  'animated surfaces must schedule native shape refreshes');
assert(source.includes('function capsuleVisualRegion('),
  'capsule native shape must reserve the final animated width before first paint');
assert.match(
  source,
  /getPropertyValue\('--capsule-width'\)/,
  'capsule region must read the committed final CSS width instead of the current animated width',
);
assert.match(
  source,
  /capsule\.addEventListener\('transitionend',\s*syncHitRegions\)/,
  'the final expanded capsule bounds must be sent after its width transition',
);
assert.match(
  source,
  /setTimeout\(syncHitRegions,\s*2(?:2|4)0\)/,
  'a bounded fallback refresh must cover missed transition events',
);

console.log('stage_hit_region_transition_test: all assertions passed');
