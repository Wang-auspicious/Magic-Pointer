'use strict';

const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');

assert(main.includes('function placeStageOnDisplay(display)'), 'stage needs an explicit display placement helper');
assert(main.includes("const { physicalScreenPoint, normalizeGroundingGeometry } = require('./coordinate_space');"),
  'main must use the shared GroundingGeometry module');
assert(main.includes('const grounding = normalizeGroundingGeometry({'),
  'frozen targets must pass through GroundingGeometry');
assert(main.includes('stageTarget: grounding.stageTarget || null'),
  'panel geometry must expose only the normalized Stage target');
assert(main.includes('targetGeometryKind: grounding.state'),
  'Stage must receive resolved versus pointer-only geometry truth');
assert(main.includes('const stageBounds = placeStageOnDisplay(display).getBounds();'),
  'initial pointer anchor must use the cursor display rather than the primary display');
assert(main.includes('targetGeometryKind: frozenTarget.targetGeometryKind'),
  'freeze update must carry target geometry kind to renderer');

console.log('stage_display_static_test: all assertions passed');
