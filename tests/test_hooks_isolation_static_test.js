'use strict';

// P0#4: production builds must never execute the env-gated evidence/capture
// hooks (N17 focus evidence, N18 wiggle evidence, dashboard capture). A
// leftover MAGIC_POINTER_* variable on a user machine would otherwise make
// the packaged app auto-quit at startup with no UI feedback.

const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');

// The dev/test hooks must still exist so unpackaged verification runs work.
assert(main.includes('MAGIC_POINTER_N17_FOCUS_EVIDENCE_PATH'), 'N17 evidence hook must remain available in dev');
assert(main.includes('MAGIC_POINTER_N18_WIGGLE_EVIDENCE_PATH'), 'N18 evidence hook must remain available in dev');
assert(main.includes('MAGIC_POINTER_DASHBOARD_CAPTURE'), 'dashboard capture hook must remain available in dev');

// But every one of them must be gated behind !app.isPackaged so packaged
// production runs are immune to stale env vars.
assert(main.includes('if (!app.isPackaged && focusEvidencePath) {'),
  'N17 focus evidence hook must be dev/test-only');
assert(main.includes('if (!app.isPackaged && wiggleEvidencePath) {'),
  'N18 wiggle evidence hook must be dev/test-only');
assert(main.includes('if (!app.isPackaged && dashboardCapturePath) {'),
  'dashboard capture hook must be dev/test-only');
assert(/const captureMode = Boolean\(\s*!app\.isPackaged/.test(main),
  'captureMode must only engage in dev/test builds');
assert(main.includes('packaged builds never run test hooks'),
  'packaged builds must log that evidence hooks are ignored');

console.log('test hooks isolation static test ok');
