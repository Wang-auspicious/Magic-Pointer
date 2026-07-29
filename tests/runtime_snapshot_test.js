'use strict';

const assert = require('assert');
const { RuntimeSnapshot } = require('../electron/runtime_snapshot');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

(async () => {
  let now = 1000;
  let probeCalls = 0;
  const runtime = new RuntimeSnapshot({
    clock: () => now,
    ttlMs: 5000,
    probe: async ({ generation }) => {
      probeCalls += 1;
      return { generation, readiness: { state: 'ready' } };
    },
  });

  const [left, right] = await Promise.all([runtime.get(), runtime.get()]);
  assert.strictEqual(probeCalls, 1);
  assert.strictEqual(left, right, 'same-generation callers share one completed object');
  assert.strictEqual(left.schemaVersion, 1);
  assert.strictEqual(left.readiness.state, 'ready');
  for (const key of ['workers', 'models', 'permissions', 'capabilities', 'repairs', 'diagnostics']) {
    assert(Object.hasOwn(left, key), `snapshot must include ${key}`);
  }

  now += 4999;
  assert.strictEqual(await runtime.get(), left, 'fresh completed snapshot is cached');
  assert.strictEqual(probeCalls, 1);

  runtime.invalidate('settings_changed');
  const generationTwo = await runtime.get();
  assert.strictEqual(probeCalls, 2);
  assert.strictEqual(generationTwo.generation, 1);
  assert.strictEqual(generationTwo.invalidationReason, 'settings_changed');

  const slowFirst = deferred();
  const slowSecond = deferred();
  let generationCalls = 0;
  const ordered = new RuntimeSnapshot({
    clock: () => now,
    probe: ({ generation }) => {
      generationCalls += 1;
      return generation === 0 ? slowFirst.promise : slowSecond.promise;
    },
  });
  const oldRequest = ordered.get();
  ordered.invalidate('worker_restarted');
  const newRequest = ordered.get();
  slowSecond.resolve({ readiness: { state: 'ready' }, diagnostics: { source: 'new' } });
  const newSnapshot = await newRequest;
  slowFirst.resolve({ readiness: { state: 'ready' }, diagnostics: { source: 'old' } });
  await oldRequest;
  assert.strictEqual(generationCalls, 2);
  assert.strictEqual((await ordered.get()).generation, newSnapshot.generation);
  assert.strictEqual((await ordered.get()).diagnostics.source, 'new');

  const degraded = new RuntimeSnapshot({
    clock: () => now,
    probe: async () => { throw new Error('probe exploded'); },
  });
  const failed = await degraded.get();
  assert.strictEqual(failed.readiness.state, 'degraded');
  assert.strictEqual(failed.diagnostics.error.code, 'runtime_probe_failed');
  assert.match(failed.diagnostics.error.message, /probe exploded/);

  console.log('runtime snapshot test ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
