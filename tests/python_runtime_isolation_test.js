'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  pythonInvocationArgs,
  pythonSpawnEnvironment,
} = require('../electron/python_runtime');

const injectedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-pointer-python-injection-'));
try {
  fs.writeFileSync(path.join(injectedRoot, 'mp_host_injected.py'), 'VALUE = 1\n', 'utf8');
  const executable = process.env.MAGIC_POINTER_PYTHON || process.env.PYTHON_EXECUTABLE || 'python';
  const env = pythonSpawnEnvironment({
    isolated: true,
    env: {
      ...process.env,
      PYTHONHOME: injectedRoot,
      PYTHONPATH: injectedRoot,
      PYTHONUSERBASE: injectedRoot,
      VIRTUAL_ENV: injectedRoot,
    },
  });
  const probe = spawnSync(
    executable,
    pythonInvocationArgs([
      '-c',
      'import importlib.util; print(importlib.util.find_spec("mp_host_injected") is None)',
    ], { isolated: true }),
    { cwd: injectedRoot, env, encoding: 'utf8', windowsHide: true },
  );
  assert.strictEqual(probe.status, 0, probe.stderr || 'isolated Python probe failed');
  assert.strictEqual(probe.stdout.trim(), 'True',
    'host PYTHONPATH and current working directory must not inject modules into isolated Python');
} finally {
  fs.rmSync(injectedRoot, { recursive: true, force: true });
}

console.log('python_runtime_isolation_test: host injection rejected');
