'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createPythonBridgeRunner } = require('../electron/python_bridge_runner');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

{
  const child = fakeChild();
  let timeout = null;
  const delivered = [];
  const runner = createPythonBridgeRunner({
    spawnImpl: () => child,
    setTimeoutImpl: (fn) => { timeout = fn; return 7; },
    clearTimeoutImpl: () => {},
  });
  runner.run({ executable: 'python', args: [], input: {}, timeoutMs: 25, onComplete: value => delivered.push(value) });
  timeout();
  child.emit('close', 1);
  assert.equal(child.killed, true);
  assert.deepStrictEqual(delivered, [{ ok: false, error: 'bridge_timeout' }]);
}

{
  const child = fakeChild();
  const delivered = [];
  const runner = createPythonBridgeRunner({ spawnImpl: () => child });
  runner.run({
    executable: 'python', args: [], input: {}, timeoutMs: 1000,
    maxStdoutBytes: 8, onComplete: value => delivered.push(value),
  });
  child.stdout.write('12345678');
  child.stdout.write('9');
  child.emit('close', 1);
  assert.equal(child.killed, true);
  assert.deepStrictEqual(delivered, [{ ok: false, error: 'bridge_output_limit', stream: 'stdout' }]);
}

{
  const child = fakeChild();
  const delivered = [];
  const runner = createPythonBridgeRunner({ spawnImpl: () => child });
  runner.run({ executable: 'python', args: [], input: {}, timeoutMs: 1000, onComplete: value => delivered.push(value) });
  child.stdout.end('not-json-secret-content');
  child.emit('close', 0);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].ok, false);
  assert.equal(delivered[0].error, 'bridge_invalid_json');
  assert.match(delivered[0].stdout_sha256, /^[a-f0-9]{64}$/);
  assert(!JSON.stringify(delivered[0]).includes('not-json-secret-content'));
}

{
  const child = fakeChild();
  const controller = new AbortController();
  const delivered = [];
  const runner = createPythonBridgeRunner({ spawnImpl: () => child });
  runner.run({ executable: 'python', args: [], input: {}, timeoutMs: 1000, signal: controller.signal, onComplete: value => delivered.push(value) });
  controller.abort();
  child.emit('error', new Error('late error'));
  assert.deepStrictEqual(delivered, [{ ok: false, error: 'bridge_cancelled' }]);
}

{
  // The deadline is inactivity, not wall clock. A bridge that keeps producing
  // output is working, and a long job must be allowed to keep working: the old
  // wall-clock kill made any task past 60s impossible regardless of progress.
  // Only silence means hung.
  const child = fakeChild();
  const delivered = [];
  let fire = null;
  let armed = 0;
  let cleared = 0;
  const runner = createPythonBridgeRunner({
    spawnImpl: () => child,
    setTimeoutImpl: (fn) => { fire = fn; armed += 1; return armed; },
    clearTimeoutImpl: () => { cleared += 1; },
  });
  runner.run({
    executable: 'python', args: [], input: {}, timeoutMs: 25,
    onProgress: () => {},
    onComplete: value => delivered.push(value),
  });
  assert.equal(armed, 1);

  child.stderr.write('@@mp phase=model_request ms=10\n');
  assert.equal(armed, 2, 'stderr activity must re-arm the idle deadline');
  child.stdout.write('partial');
  assert.equal(armed, 3, 'stdout activity must re-arm the idle deadline');
  assert.ok(cleared >= 2, 'each re-arm clears the previous timer');
  assert.deepStrictEqual(delivered, [], 'an active bridge is never killed');

  fire();
  assert.equal(child.killed, true);
  assert.deepStrictEqual(delivered, [{ ok: false, error: 'bridge_timeout' }]);
}

console.log('python bridge runner test ok');
