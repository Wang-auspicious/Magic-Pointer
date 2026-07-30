'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inspectOnboardingReadiness, onboardingIsReady } = require('../electron/app_lifecycle');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-pointer-readiness-'));
const markerPath = path.join(root, 'onboarding.json');
const requiredPath = path.join(root, 'runtime.bin');
fs.writeFileSync(requiredPath, 'runtime', 'utf8');

const expected = {
  markerPath,
  bootstrapVersion: 1,
  productVersion: '1.0.0',
  manifestDigest: 'manifest-sha256',
  requiredPaths: [requiredPath],
};

assert.deepStrictEqual(inspectOnboardingReadiness(expected), {
  ready: false,
  reason: 'marker_missing',
});

fs.writeFileSync(markerPath, JSON.stringify({
  schemaVersion: 2,
  status: 'ready',
  bootstrapVersion: 1,
  productVersion: '1.0.0',
  manifestDigest: 'manifest-sha256',
}), 'utf8');
assert.strictEqual(inspectOnboardingReadiness(expected).ready, true);
assert.strictEqual(onboardingIsReady(markerPath, expected), true);

assert.strictEqual(inspectOnboardingReadiness({ ...expected, productVersion: '2.0.0' }).ready, true);
assert.strictEqual(inspectOnboardingReadiness({ ...expected, manifestDigest: 'changed' }).ready, true);
assert.strictEqual(
  inspectOnboardingReadiness({ ...expected, bootstrapVersion: 2 }).reason,
  'bootstrap_version_changed',
);

fs.unlinkSync(requiredPath);
assert.strictEqual(inspectOnboardingReadiness(expected).reason, 'runtime_probe_failed');

fs.writeFileSync(markerPath, JSON.stringify({ schemaVersion: 1, status: 'ready' }), 'utf8');
assert.strictEqual(inspectOnboardingReadiness(expected).reason, 'marker_schema_outdated');

console.log('onboarding readiness test ok');
