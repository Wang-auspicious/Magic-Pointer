const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildPreflightChecks } = require('../electron/preflight_checks');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-pointer-preflight-checks-'));
const commands = [];
const runtimeExecutable = path.join(root, 'runtime', 'node.exe');
const checks = buildPreflightChecks({
  root,
  projectRoot: path.join(__dirname, '..'),
  platform: 'win32',
  settings: {
    activation: { wiggle_enabled: true, fallback_hotkey_enabled: true },
    privacy: { default_capture_mode: 'structured_only', sensitive_apps: ['1password'] },
    models: { profiles: [{ id: 'local', apiMode: 'local', credentialRef: '' }] },
  },
  credentialStore: { status: () => ({ present: false, available: true }) },
  wiggleDetector: {},
  runtimeExecutable,
  environment: {
    PATH: 'C:\\Windows',
    PYTHONHOME: 'C:\\host-python',
    PYTHONPATH: 'C:\\injected',
    VIRTUAL_ENV: 'C:\\venv',
  },
  commandRunner: (command, args, options) => {
    commands.push({ command, args, options });
    if (args.includes('registerDesktopTools')) return { status: 0, stdout: '{"ok": true}' };
    return { status: 0, stdout: '{"ok": true, "providers": [{"available": true}]}' };
  },
});

assert.strictEqual(checks.runtime().state, 'pass');
assert.strictEqual(checks.os_permissions().state, 'pass');
assert.strictEqual(checks.pointer_host().state, 'pass');
assert.strictEqual(checks.grounding().state, 'pass');
assert.strictEqual(checks.agents().state, 'pass');
assert.strictEqual(checks.model_profile().state, 'pass');
assert.strictEqual(checks.privacy().state, 'pass');
assert.strictEqual(checks.e2e_smoke().state, 'pass');
assert(commands.some(({ args }) => args.join(' ').includes('discoverProviders')));
assert(commands.some(({ args }) => args.join(' ').includes('registerDesktopTools')));
assert(commands.every(({ command }) => command === runtimeExecutable), 'every preflight must use the requested runtime executable');
assert(commands.every(({ args }) => args[0] === '-e'));
assert(commands.every(({ options }) => options.env.ELECTRON_RUN_AS_NODE === '1'));

const missing = buildPreflightChecks({
  root,
  projectRoot: path.join(__dirname, '..'),
  platform: 'darwin',
  settings: { activation: {}, interaction: {}, privacy: {}, models: { profiles: [] } },
  credentialStore: null,
  wiggleDetector: null,
  commandRunner: () => ({ status: 1, stdout: '' }),
});
assert.strictEqual(missing.os_permissions().state, 'needs_user');
assert.strictEqual(missing.pointer_host().state, 'fail');
assert.strictEqual(missing.model_profile().state, 'skipped');

const bundledMissing = buildPreflightChecks({
  root,
  projectRoot: path.join(__dirname, '..'),
  platform: 'win32',
  settings: { activation: {}, interaction: {}, privacy: {}, models: { profiles: [] } },
  runtimeExecutable: 'D:\\missing\\node.exe',
  commandRunner: () => ({ status: 1, stdout: '' }),
});
assert.deepStrictEqual(bundledMissing.runtime(), {
  state: 'fail', evidence: 'node_runtime_unavailable', fixAction: 'repair_runtime',
});

console.log('preflight checks test ok');
