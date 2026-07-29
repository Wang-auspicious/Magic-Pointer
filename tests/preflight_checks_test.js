const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildPreflightChecks } = require('../electron/preflight_checks');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-pointer-preflight-checks-'));
const commands = [];
const bundledPython = path.join(root, 'bundled-python', 'python.exe');
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
  pythonRuntime: { executable: bundledPython, source: 'bundled', required: true },
  environment: {
    PATH: 'C:\\Windows',
    PYTHONHOME: 'C:\\host-python',
    PYTHONPATH: 'C:\\injected',
    VIRTUAL_ENV: 'C:\\venv',
  },
  commandRunner: (command, args, options) => {
    commands.push({ command, args, options });
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
assert.strictEqual(checks.e2e_smoke().state, 'pass');
assert(commands.some(({ args }) => args.join(' ').includes('fabric_bridge.py')));
assert(commands.some(({ args }) => args.join(' ').includes('smoke_fabric.py')));
assert(commands.every(({ command }) => command === bundledPython), 'every preflight Python command must use resolved bundled executable');
assert(commands.every(({ args }) => args.slice(0, 3).join(' ') === '-I -X utf8'),
  'every bundled preflight command must use isolated UTF-8 Python mode');
assert(commands.every(({ options }) => !('PYTHONHOME' in options.env) && !('PYTHONPATH' in options.env) && !('VIRTUAL_ENV' in options.env)),
  'bundled preflight commands must not inherit host Python injection variables');

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

const bundledMissing = buildPreflightChecks({
  root,
  projectRoot: path.join(__dirname, '..'),
  platform: 'win32',
  settings: { activation: {}, interaction: {}, privacy: {}, models: { profiles: [] } },
  pythonRuntime: { executable: 'D:\\missing\\python.exe', source: 'bundled', required: true },
  commandRunner: () => ({ status: 1, stdout: '' }),
});
assert.deepStrictEqual(bundledMissing.runtime(), {
  state: 'fail', evidence: 'bundled_python_runtime_unavailable', fixAction: 'repair_runtime',
});

console.log('preflight checks test ok');
