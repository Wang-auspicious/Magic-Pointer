import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRuntimeBridgeRunner } from '../electron/runtime_bridge_runner';
function childProcess(): any {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdout.setEncoding = child.stderr.setEncoding = () => {};
  child.stdin = { writable: true, on() {}, write() {}, end() {} }; child.kill = () => {};
  return child;
}
const trajectory = Array.from({ length: 40 }, () => ({ kind: 'tool_result', text: 'x'.repeat(32000) }));
const child = childProcess(); let result: any;
createRuntimeBridgeRunner({ spawnImpl: () => child, setTimeoutImpl: () => 0, clearTimeoutImpl: () => {} }).run({ onComplete: (value) => { result = value; } });
child.stdout.emit('data', JSON.stringify({ ok: true, trajectory })); child.emit('close', 0);
assert.equal(result.ok, true, 'a legitimate final trajectory can exceed one MiB');
assert.equal(result.trajectory.length, 40);
console.log('bridge_large_result_test: passed');
