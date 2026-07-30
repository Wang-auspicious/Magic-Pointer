'use strict';

const assert = require('assert');
const path = require('path');
const {
  resolvePythonRuntime,
  resolvePythonExecutable,
  bundledPythonPath,
} = require('../electron/python_runtime');

(function packagedWindowsAlwaysUsesBundledRuntime() {
  const resourcesPath = path.join('D:', 'Installed', 'Magic Pointer', 'resources');
  const expected = path.join(resourcesPath, 'python-runtime', 'python.exe');
  const runtime = resolvePythonRuntime({
    isPackaged: true,
    platform: 'win32',
    resourcesPath,
    env: { MAGIC_POINTER_PYTHON: 'C:\\host-python\\python.exe' },
  });
  assert.deepStrictEqual(runtime, { executable: expected, source: 'bundled', required: true });
  assert.strictEqual(bundledPythonPath(resourcesPath), expected);
  assert.strictEqual(resolvePythonExecutable({
    isPackaged: true,
    platform: 'win32',
    resourcesPath,
    env: { MAGIC_POINTER_PYTHON: 'python-from-path' },
  }), expected);
})();

(function developmentCanUseExplicitOrPathPython() {
  assert.deepStrictEqual(resolvePythonRuntime({
    isPackaged: false,
    platform: 'win32',
    env: { MAGIC_POINTER_PYTHON: 'D:\\tools\\python.exe' },
  }), { executable: 'D:\\tools\\python.exe', source: 'environment', required: false });
  assert.deepStrictEqual(resolvePythonRuntime({
    isPackaged: false,
    platform: 'win32',
    env: { PYTHON_EXECUTABLE: 'C:\\portable\\python.exe' },
  }), { executable: 'C:\\portable\\python.exe', source: 'environment', required: false });
  assert.deepStrictEqual(resolvePythonRuntime({
    isPackaged: false,
    platform: 'win32',
    env: {},
  }), { executable: 'python', source: 'path', required: false });
})();

(function packagedEnvironmentDropsHostPythonInjection() {
  const { pythonInvocationArgs, pythonSpawnEnvironment } = require('../electron/python_runtime');
  const sanitized = pythonSpawnEnvironment({
    isolated: true,
    env: {
      Path: 'C:\\Windows',
      PYTHONHOME: 'C:\\host-python',
      PythonPath: 'C:\\injected',
      PYTHONUSERBASE: 'C:\\user-site',
      VIRTUAL_ENV: 'C:\\venv',
      CONDA_PREFIX: 'C:\\conda',
      KEEP_ME: 'yes',
    },
  });
  assert.strictEqual(sanitized.Path, 'C:\\Windows');
  assert.strictEqual(sanitized.KEEP_ME, 'yes');
  for (const key of ['PYTHONHOME', 'PythonPath', 'PYTHONUSERBASE', 'VIRTUAL_ENV', 'CONDA_PREFIX']) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(sanitized, key), false, `${key} must be removed`);
  }
  assert.strictEqual(sanitized.PYTHONNOUSERSITE, '1');
  assert.strictEqual(sanitized.PYTHONDONTWRITEBYTECODE, '1');
  assert.strictEqual(sanitized.PYTHONUTF8, '1');
  assert.deepStrictEqual(
    pythonInvocationArgs(['scripts/electron_bridge.py'], { isolated: true }),
    ['-I', '-X', 'utf8', 'scripts/electron_bridge.py'],
  );
  assert.deepStrictEqual(
    pythonInvocationArgs(['scripts/electron_bridge.py'], { isolated: false }),
    ['scripts/electron_bridge.py'],
  );
})();

(function packagedMacUsesRelocatableBundledRuntime() {
  const resourcesPath = path.join('/', 'Applications', 'Magic Pointer.app', 'Contents', 'Resources');
  const runtime = resolvePythonRuntime({
    isPackaged: true,
    platform: 'darwin',
    resourcesPath,
    env: { MAGIC_POINTER_PYTHON: '/opt/python/bin/python3' },
  });
  assert.deepStrictEqual(runtime, {
    executable: path.join(resourcesPath, 'python-runtime', 'bin', 'python3'),
    source: 'bundled',
    required: true,
  });
})();

console.log('python runtime resolver test ok');
