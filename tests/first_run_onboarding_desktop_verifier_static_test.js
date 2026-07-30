'use strict';

const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('scripts/verify_first_run_onboarding.py', 'utf8');
for (const token of [
  'onboarding.html',
  'onboarding-start',
  'onboarding-progress',
  'onboarding-cancel',
  'onboarding-continue',
  'dashboard.html',
  'onboarding readiness ready=true reason=ready',
  'preflight_repeated_on_second_launch',
  'onboarding_marker_rewritten_on_second_launch',
  'Page.captureScreenshot',
]) assert(source.includes(token), token);
assert(!source.includes('ipcRenderer'));
assert(!source.includes('webContents.send'));

console.log('first-run onboarding desktop verifier static test ok');
