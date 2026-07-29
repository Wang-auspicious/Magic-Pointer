'use strict';

const fs = require('fs');

function shouldStartHidden({ argv = [], wasOpenedAtLogin = false, captureMode = false } = {}) {
  const switches = new Set((Array.isArray(argv) ? argv : []).map((value) => String(value).toLowerCase()));
  return captureMode === true
    || wasOpenedAtLogin === true
    || switches.has('--background')
    || switches.has('--hidden');
}

function onboardingIsReady(markerPath) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return marker?.schemaVersion === 1 && marker?.status === 'ready';
  } catch (_) {
    return false;
  }
}

module.exports = { onboardingIsReady, shouldStartHidden };
