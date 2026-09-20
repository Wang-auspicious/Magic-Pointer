import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPythonBridgeRunner } from '../electron/python_bridge_runner';
const { SelectionWorkerClient } = require('../electron/selection_worker_client');
function childProcess(): any {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdout.setEncoding = child.stderr.setEncoding = () => {};
  child.stdin = { writable: true, on() {}, write() {}, end() {} }; child.kill = () => {};
  return child;
}
const trajectory = Array.from({ length: 40 }, () => ({ kind: 'tool_result', text: 'x'.repeat(32000) }));
const child = childProcess(); let result: any;
createPythonBridgeRunner({ spawnImpl: () => child, setTimeoutImpl: () => 0, clearTimeoutImpl: () => {} }).run({ onComplete: (value) => { result = value; } });
child.stdout.emit('data', JSON.stringify({ ok: true, trajectory })); child.emit('close', 0);
assert.equal(result.ok, true, 'a legitimate final trajectory can exceed one MiB');
assert.equal(result.trajectory.length, 40);
const worker = childProcess(); let workerResult: any;
const client = new SelectionWorkerClient({ root: process.cwd(), spawnProcess: () => worker });
try {
  client.run({ requestId: 'long', payload: {}, onComplete: (value: any) => { workerResult = value; } });
  worker.stdout.emit('data', JSON.stringify({ id: 'long', result: { ok: true, trajectory } }) + '\n');
  assert.equal(workerResult.ok, true, 'the selection worker uses the same full-result contract');
  assert.equal(workerResult.trajectory.length, 40);
} finally { client.shutdown({ force: true }); }
console.log('bridge_large_result_test: passed');
