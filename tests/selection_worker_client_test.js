'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const path = require('path');
const { SelectionWorkerClient } = require('../electron/selection_worker_client');

function fakeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.commands = [];
  child.stdin = {
    writable: true,
    write: value => { child.commands.push(JSON.parse(value)); return true; },
  };
  child.kill = () => { child.killed = true; };
  return child;
}

(function reusesOneWorkerAcrossCompletedRequests() {
  const children = [];
  const client = new SelectionWorkerClient({
    root: path.resolve('.'),
    spawnProcess: () => { const child = fakeChild(); children.push(child); return child; },
  });
  const results = [];
  client.run({ requestId: 'one', payload: { command: 'a' }, onComplete: value => results.push(value) });
  children[0].stdout.emit('data', '{"id":"one","result":{"ok":true,"answer":"a"}}\n');
  client.run({ requestId: 'two', payload: { command: 'b' }, onComplete: value => results.push(value) });
  children[0].stdout.emit('data', '{"id":"two","result":{"ok":true,"answer":"b"}}\n');

  assert.strictEqual(children.length, 1);
  assert.deepStrictEqual(results.map(item => item.answer), ['a', 'b']);
  client.shutdown({ force: true });
})();

(function rejectsConcurrentRequestWithoutCorruptingActiveOne() {
  const child = fakeChild();
  const client = new SelectionWorkerClient({ root: path.resolve('.'), spawnProcess: () => child });
  const results = [];
  client.run({ requestId: 'one', payload: {}, onComplete: value => results.push(value) });
  client.run({ requestId: 'two', payload: {}, onComplete: value => results.push(value) });
  assert.strictEqual(results.at(-1).error, 'selection_worker_busy');
  child.stdout.emit('data', '{"id":"one","result":{"ok":true}}\n');
  assert.strictEqual(results.at(-1).ok, true);
  client.shutdown({ force: true });
})();

(function cancellationKillsWorkerAndNextRequestRespawns() {
  const children = [];
  const client = new SelectionWorkerClient({
    root: path.resolve('.'),
    spawnProcess: () => { const child = fakeChild(); children.push(child); return child; },
  });
  const results = [];
  const handle = client.run({ requestId: 'one', payload: {}, onComplete: value => results.push(value) });
  handle.cancel();
  assert.strictEqual(children[0].killed, true);
  assert.strictEqual(results.at(-1).error, 'bridge_cancelled');
  client.run({ requestId: 'two', payload: {}, onComplete: value => results.push(value) });
  assert.strictEqual(children.length, 2);
  client.shutdown({ force: true });
})();

console.log('selection_worker_client_test: all assertions passed');

// ── 8·29 真机：60s 墙钟把还在正常生成的长答案杀了 ─────────────────────
// 计时器必须是"沉默"语义：stderr 每来一行就续期，流式生成（answer_chunk
// 120ms 一条）永远不会撞墙；真正的挂死（60s 一行输出都没有）才会超时。
{
  const child = fakeChild();
  const client = new SelectionWorkerClient({ root: path.resolve('.'), spawnProcess: () => child });
  const results = [];
  client.run({
    requestId: 'long-answer',
    payload: {},
    timeoutMs: 200,
    onComplete: value => results.push(value),
  });
  // 200ms 期限，但每 50ms 来一行进度——持续 1s（5 倍于期限）都不许超时。
  const stream = setInterval(() => child.stderr.emit('data', '@@mp phase=answer_chunk b64=x\n'), 50);
  setTimeout(() => {
    clearInterval(stream);
    child.stdout.emit('data', '{"id":"long-answer","result":{"ok":true,"answer":"完整答案"}}\n');
    assert.strictEqual(results.at(-1).ok, true,
      'a steadily streaming answer must never hit the idle timeout');
    assert.strictEqual(results.at(-1).answer, '完整答案');
    client.shutdown({ force: true });
    console.log('selection_worker_client idle-timeout test ok');
  }, 1000);
}
