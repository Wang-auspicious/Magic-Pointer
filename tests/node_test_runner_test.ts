'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

// The selected-test probe launches the runner from inside the normal suite.
// The marker prevents that child from launching another child if an old runner
// incorrectly ignores argv and executes every test file.
if (process.env.MP_NODE_RUNNER_PROBE_CHILD !== '1') {
  const root = path.resolve(__dirname, '..');
  const runner = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const env = { ...process.env, MP_NODE_RUNNER_PROBE_CHILD: '1' };

  const selected = spawnSync(
    process.execPath,
    [runner, 'scripts/run-node-tests.ts', 'tests/stage_turn_stream_test.ts'],
    { cwd: root, env, encoding: 'utf8' },
  );
  assert.strictEqual(selected.status, 0, selected.stderr || selected.stdout);
  assert.match(selected.stdout, /node suite passed: 1 test files/);
  assert.doesNotMatch(selected.stdout, /typography .* test ok/);

  const invalid = spawnSync(
    process.execPath,
    [runner, 'scripts/run-node-tests.ts', 'electron/main.ts'],
    { cwd: root, env, encoding: 'utf8' },
  );
  assert.notStrictEqual(invalid.status, 0, 'a source file outside tests must fail');
  assert.match(`${invalid.stdout}\n${invalid.stderr}`, /invalid test path/i);

  const missing = spawnSync(
    process.execPath,
    [runner, 'scripts/run-node-tests.ts', 'tests/not_present_test.ts'],
    { cwd: root, env, encoding: 'utf8' },
  );
  assert.notStrictEqual(missing.status, 0, 'a missing selected test must fail');
  assert.match(`${missing.stdout}\n${missing.stderr}`, /test file not found/i);
}

console.log('node test runner test ok');
