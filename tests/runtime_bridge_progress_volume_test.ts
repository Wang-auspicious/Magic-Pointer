import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRuntimeBridgeRunner } from '../electron/runtime_bridge_runner';
const child: any = new EventEmitter();
child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
child.stdin.write = () => {}; child.stdin.end = () => {}; child.kill = () => {};
let result: any;
let progress = 0;
createRuntimeBridgeRunner({ spawnImpl: () => child, setTimeoutImpl: () => 0, clearTimeoutImpl: () => {} }).run({
  onComplete: (value) => { result = value; }, onProgress: () => { progress += 1; },
});
const line = '@@mp phase=tool_result ms=1 b64=' + Buffer.from(JSON.stringify({ id: 'read', name: 'Read', state: 'done', result: '文'.repeat(32000) })).toString('base64') + '\n';
for (let index = 0; index < 12; index++) {
  child.stderr.emit('data', line.slice(0, 50000));
  child.stderr.emit('data', line.slice(50000));
}
child.stdout.emit('data', JSON.stringify({ ok: true, answer: 'done' }));
child.emit('close', 0);
assert.equal(result.ok, true, 'consumed progress is not accumulated against a lifetime stderr ceiling');
assert.equal(progress, 12);
console.log('runtime_bridge_progress_volume_test: passed');
