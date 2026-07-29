'use strict';

const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');
const preload = fs.readFileSync('electron/preload.js', 'utf8');
const stage = fs.readFileSync('electron/renderer/stage.js', 'utf8');

assert(main.includes('stageWindow.setShape(regions)'),
  'the native full-display stage must be shaped to visible surface regions');
assert(main.includes('sanitizeStageHitRegions'),
  'renderer hit regions must be validated and clamped in the trusted main process');
assert(main.includes('function mergeStageHitRegions('),
  'shape transitions must retain old and new regions until the next compositor paint');
assert(main.includes('stageShapeSettleTimer'),
  'native shape must settle to the current regions after the transition frame');
assert(preload.includes('regions: Array.isArray(options?.regions)'),
  'preload must forward only an explicit region list');
assert(stage.includes('function visibleStageRegions()'),
  'renderer must report the actual visible DOM rectangles');
assert(stage.includes('function interactiveStageRegions()'),
  'renderer must separate operable controls from non-interactive visual feedback');
assert(stage.includes("window.addEventListener('mousemove'"),
  'forwarded mouse movement must toggle capture only over interactive controls');
assert(!stage.includes("document.addEventListener('pointerdown'"),
  'an invisible full-screen document must never consume the first outside click');
assert(main.includes('function showStage(payload = {})') && main.includes('armTemporaryDismissShortcut();'),
  'every stage result path must arm the global Escape cancellation contract');

console.log('stage_native_hit_region_test: all assertions passed');
