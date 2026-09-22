'use strict';


const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.ts', 'utf8');

assert(main.includes('MAGIC_POINTER_N18_WIGGLE_EVIDENCE_PATH'), 'N18 evidence hook must remain available in dev');
assert(main.includes('MAGIC_POINTER_DASHBOARD_CAPTURE'), 'dashboard capture hook must remain available in dev');

assert(main.includes('if (!app.isPackaged && wiggleEvidencePath) {'),
  'N18 wiggle evidence hook must be dev/test-only');
assert(main.includes('if (!app.isPackaged && dashboardCapturePath) {'),
  'dashboard capture hook must be dev/test-only');
assert(/const captureMode = Boolean\(\s*!app\.isPackaged/.test(main),
  'captureMode must only engage in dev/test builds');
assert(main.includes('packaged builds never run test hooks'),
  'packaged builds must log that evidence hooks are ignored');

console.log('test hooks isolation static test ok');
