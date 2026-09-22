'use strict';

const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.ts', 'utf8');

assert(main.includes('function placeStageOnDisplay(display:'), 'stage needs an explicit display placement helper');
assert(main.includes("} = require('./coordinate_space');")
  && main.includes('physicalScreenPoint,')
  && main.includes('normalizeGroundingGeometry,'),
  'main must use the shared GroundingGeometry module');
assert(main.includes('const grounding = normalizeGroundingGeometry({'),
  'frozen targets must pass through GroundingGeometry');
assert(main.includes('stageTarget: grounding.stageTarget || null'),
  'panel geometry must expose only the normalized Stage target');
assert(main.includes('targetGeometryKind: grounding.state'),
  'Stage must receive resolved versus pointer-only geometry truth');
assert(
  /const cursor = [^;]*getCursorScreenPoint\(\);[\s\S]{0,200}?getDisplayNearestPoint\(cursor\);[\s\S]{0,200}?placeStageOnDisplay\(display\);[\s\S]{0,200}?const stageBounds = (?:stageWindow\.getBounds\(\)|liveStageBounds\(\));/
    .test(main),
  'initial pointer anchor must use the cursor display rather than the primary display',
);
assert(main.includes('targetGeometryKind: frozenTarget.targetGeometryKind'),
  'freeze update must carry target geometry kind to renderer');

console.log('stage_display_static_test: all assertions passed');
