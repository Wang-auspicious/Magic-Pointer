'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildAsyncPreflightChecks } = require('../electron/preflight_checks');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-pointer-preflight-async-checks-'));
  const bundledPython = path.join(root, 'python.exe');
  fs.writeFileSync(bundledPython, 'fixture', 'utf8');
  const commands = [];
  const checks = buildAsyncPreflightChecks({
    root,
    projectRoot: path.join(__dirname, '..'),
    platform: 'win32',
    settings: {
      activation: { wiggle_enabled: true, fallback_hotkey_enabled: true },
      privacy: { default_capture_mode: 'structured_only', sensitive_apps: [] },
      models: { profiles: [] },
    },
    wiggleDetector: {},
    pythonRuntime: { executable: bundledPython, source: 'bundled', required: true },
    environment: { PATH: 'C:\\Windows', PYTHONPATH: 'C:\\injected' },
    asyncCommandRunner: async (command, args, options) => {
      commands.push({ command, args, options });
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (args.join(' ').includes('smoke_fabric.py')) return { status: 0, stdout: '{"ok":true}', stderr: '' };
      if (args.join(' ').includes('fabric_bridge.py')) {
        return { status: 0, stdout: '{"ok":true,"providers":[{"id":"pi","available":true}]}', stderr: '' };
      }
      return { status: 0, stdout: 'Python 3.11', stderr: '' };
    },
  });

  assert.strictEqual((await checks.runtime()).state, 'pass');
  assert.strictEqual((await checks.agents()).state, 'pass');
  assert.strictEqual((await checks.e2e_smoke()).state, 'pass');
  assert.strictEqual(commands.length, 3);
  assert(commands.every(({ args }) => args.slice(0, 3).join(' ') === '-I -X utf8'));
  assert(commands.every(({ options }) => !('PYTHONPATH' in options.env)));
  console.log('preflight checks async test ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
