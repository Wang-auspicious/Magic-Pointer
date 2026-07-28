const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PreflightRunner, validateManifest } = require('../electron/bootstrap_runner');

const manifestPath = path.join(__dirname, '..', 'data', 'preflight_manifest.v1.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.deepStrictEqual(manifest.stages.map((stage) => stage.id), [
  'runtime', 'os_permissions', 'pointer_host', 'voice', 'grounding',
  'agents', 'model_profile', 'privacy', 'e2e_smoke',
]);
assert.deepStrictEqual(validateManifest(manifest).stages.map((stage) => stage.id), manifest.stages.map((stage) => stage.id));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-pointer-preflight-'));
const events = [];
const runner = new PreflightRunner({
  manifest,
  markerPath: path.join(root, 'onboarding.json'),
  emit: (event) => events.push(event),
  checks: Object.fromEntries(manifest.stages.map((stage) => [stage.id, () => ({ state: 'pass', evidence: `checked=${stage.id}` })])),
});
const result = runner.run();
assert.strictEqual(result.ready, true);
assert.strictEqual(result.stages.every((stage) => stage.state === 'pass'), true);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'onboarding.json'), 'utf8')).status, 'ready');
assert(events.some((event) => event.type === 'manifest'));
assert(events.filter((event) => event.type === 'stage' && event.state === 'running').length === 9);

const blockedMarker = path.join(root, 'blocked-onboarding.json');
const blocked = new PreflightRunner({
  manifest,
  markerPath: blockedMarker,
  checks: { runtime: () => ({ state: 'needs_user', evidence: 'microphone permission not granted' }) },
}).run();
assert.strictEqual(blocked.ready, false);
assert.strictEqual(blocked.stages[0].state, 'needs_user');
assert.strictEqual(fs.existsSync(blockedMarker), false);

const retry = new PreflightRunner({
  manifest,
  markerPath: path.join(root, 'retry-onboarding.json'),
  checks: { privacy: () => ({ state: 'warn', evidence: 'screenshot upload disabled' }) },
}).run({ stageIds: ['privacy'] });
assert.deepStrictEqual(retry.stages.map((stage) => stage.state), ['warn']);
assert.strictEqual(retry.ready, false);

console.log('bootstrap runner test ok');
