'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'verify_n20_resident_desktop.py'),
  'utf8',
);

assert.match(
  source,
  /"wake_mode":\s*"hotkey"[\s\S]*"wiggle_enabled":\s*False/,
  'N20 desktop evidence must isolate its activation hotkey instead of allowing cursor setup to trigger wiggle',
);
assert.match(
  source,
  /def primary_button\(down: bool\)[\s\S]*def draw_selection\(/,
  'N20 desktop evidence must drive a real Windows primary-button selection gesture',
);
assert.match(
  source,
  /press_hotkey\(\)[\s\S]*wait_log\([^)]*"selection gesture ready"[\s\S]*draw_selection\(point\)[\s\S]*wait_log\([^)]*"selection gesture completed"/,
  'each N20 voice round must wake, draw, and release before waiting for voice output',
);
assert.match(
  source,
  /wait_log\([^)]*"stage renderer state=capsule-voice"[\s\S]*wait_log\([^)]*"selection session capture done"[\s\S]*wait_stage_text/,
  'N20 evidence must observe the visible voice surface and completed capture before asserting final text',
);

console.log('N20 resident desktop verifier static test ok');
