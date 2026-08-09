const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.ts', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const runner = fs.readFileSync('scripts/run-node-tests.ts', 'utf8');

assert(main.includes("require('./bootstrap_runner')"));
assert(main.includes("require('./preflight_checks')"));
assert(main.includes('buildAsyncPreflightChecks'));
assert(main.includes("require('./python_runtime')"));
assert(main.includes('const PYTHON_RUNTIME = resolvePythonRuntime({'));
assert(main.includes('const PYTHON_EXECUTABLE = PYTHON_RUNTIME.executable;'));
assert(main.includes('pythonRuntime: PYTHON_RUNTIME'));
assert(main.includes('const pythonExecutable = PYTHON_EXECUTABLE;'));
assert(main.includes('const py = PYTHON_EXECUTABLE;'));
assert(
  !main.includes("process.env.MAGIC_POINTER_PYTHON || 'python'"),
  'main process must not bypass packaged bundled runtime with a PATH fallback',
);
assert(main.includes("path.join(ROOT, 'data', 'preflight_manifest.v1.json')"));
assert(main.includes("markerPath: path.join(FABRIC_DATA_DIR, 'onboarding.json')"));
assert(main.includes("if (operation === 'preflight.run')"));
assert(main.includes('runner.runAsync'));
assert(main.includes("'dashboard:preflight-event'"));
assert(main.includes('preflightRunPromise'));
assert(main.includes('manifestDigest'));
assert(main.includes('requiredPaths'));
assert(main.includes('microphonePermissionStatus'));
assert(pkg.scripts.test.includes('scripts/run-node-tests.ts'));
assert(runner.includes('/_test\\.[jt]s$/'));

console.log('preflight main static test ok');
