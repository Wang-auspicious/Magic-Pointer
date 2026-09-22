'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildAsyncPreflightChecks } = require('../electron/preflight_checks');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-pointer-preflight-async-checks-'));
  const runtimeExecutable = path.join(root, 'node.exe');
  fs.writeFileSync(runtimeExecutable, 'fixture', 'utf8');
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
    runtimeExecutable,
    environment: { PATH: 'C:\\Windows', PYTHONPATH: 'C:\\injected' },
    asyncCommandRunner: async (command, args, options) => {
      commands.push({ command, args, options });
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (args.join(' ').includes('registerDesktopTools')) return { status: 0, stdout: '{"ok":true}', stderr: '' };
      if (args.join(' ').includes('discoverProviders')) {
        return { status: 0, stdout: '{"ok":true,"providers":[{"id":"pi","available":true}]}', stderr: '' };
      }
      return { status: 0, stdout: '{"ok":true,"node":"24"}', stderr: '' };
    },
  });

  assert.strictEqual((await checks.runtime()).state, 'pass');
  assert.strictEqual((await checks.agents()).state, 'pass');
  assert.strictEqual((await checks.e2e_smoke()).state, 'pass');
  assert.strictEqual(commands.length, 3);
  assert(commands.every(({ args }) => args[0] === '-e'));
  assert(commands.every(({ options }) => options.env.ELECTRON_RUN_AS_NODE === '1'));
  console.log('preflight checks async test ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
