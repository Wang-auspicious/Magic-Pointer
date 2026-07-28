const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildPreflightChecks } = require('../electron/preflight_checks');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-pointer-preflight-checks-'));
const commands = [];
const checks = buildPreflightChecks({
  root,
  projectRoot: path.join(__dirname, '..'),
  platform: 'win32',
  settings: {
    activation: { wiggle_enabled: true, fallback_hotkey_enabled: true },
    interaction: { default_input_mode: 'voice' },
    privacy: { default_capture_mode: 'structured_only', sensitive_apps: ['1password'] },
    models: { profiles: [{ id: 'local', apiMode: 'local', credentialRef: '' }] },
  },
  credentialStore: { status: () => ({ present: false, available: true }) },
  wiggleDetector: {},
  microphoneStatus: () => 'granted',
  commandRunner: (command, args) => {
    commands.push([command, ...args]);
    if (args.includes('smoke_fabric.py')) return { status: 0, stdout: '{"ok": true}' };
    return { status: 0, stdout: '{"ok": true, "providers": [{"available": true}]}' };
  },
});

assert.strictEqual(checks.runtime().state, 'pass');
assert.strictEqual(checks.os_permissions().state, 'pass');
assert.strictEqual(checks.pointer_host().state, 'pass');
assert.strictEqual(checks.voice().state, 'pass');
assert.strictEqual(checks.grounding().state, 'pass');
assert.strictEqual(checks.agents().state, 'pass');
assert.strictEqual(checks.model_profile().state, 'pass');
assert.strictEqual(checks.privacy().state, 'pass');
assert.strictEqual(checks.e2e_smoke().state, 'warn');
assert(commands.some((parts) => parts.join(' ').includes('fabric_bridge.py')));
assert(commands.some((parts) => parts.join(' ').includes('smoke_fabric.py')));

const missing = buildPreflightChecks({
  root,
  projectRoot: path.join(__dirname, '..'),
  platform: 'darwin',
  settings: { activation: {}, interaction: {}, privacy: {}, models: { profiles: [] } },
  credentialStore: null,
  wiggleDetector: null,
  microphoneStatus: () => 'denied',
  commandRunner: () => ({ status: 1, stdout: '' }),
});
assert.strictEqual(missing.os_permissions().state, 'needs_user');
assert.strictEqual(missing.pointer_host().state, 'fail');
assert.strictEqual(missing.voice().state, 'needs_user');
assert.strictEqual(missing.model_profile().state, 'skipped');

console.log('preflight checks test ok');
