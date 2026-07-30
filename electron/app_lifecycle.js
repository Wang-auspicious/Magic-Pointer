'use strict';

const fs = require('fs');

function shouldStartHidden({ argv = [], wasOpenedAtLogin = false, captureMode = false } = {}) {
  const switches = new Set((Array.isArray(argv) ? argv : []).map((value) => String(value).toLowerCase()));
  return captureMode === true
    || wasOpenedAtLogin === true
    || switches.has('--background')
    || switches.has('--hidden');
}

function onboardingIsReady(markerPath, options = {}) {
  return inspectOnboardingReadiness({ markerPath, ...options }).ready;
}

function inspectOnboardingReadiness({
  markerPath,
  bootstrapVersion = 1,
  requiredPaths = [],
} = {}) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (marker?.schemaVersion !== 2) return { ready: false, reason: 'marker_schema_outdated' };
    if (marker?.status !== 'ready') return { ready: false, reason: 'marker_not_ready' };
    if (Number(marker.bootstrapVersion) !== Number(bootstrapVersion)) {
      return { ready: false, reason: 'bootstrap_version_changed' };
    }
    if (!Array.isArray(requiredPaths) || requiredPaths.some((requiredPath) => {
      try {
        return !fs.statSync(requiredPath).isFile();
      } catch (_) {
        return true;
      }
    })) {
      return { ready: false, reason: 'runtime_probe_failed' };
    }
    return { ready: true, reason: 'ready' };
  } catch (error) {
    return {
      ready: false,
      reason: error?.code === 'ENOENT' ? 'marker_missing' : 'marker_invalid',
    };
  }
}

module.exports = { inspectOnboardingReadiness, onboardingIsReady, shouldStartHidden };
