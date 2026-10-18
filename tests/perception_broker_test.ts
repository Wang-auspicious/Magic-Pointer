import assert from 'node:assert/strict';
import test from 'node:test';
import {runPerceptionProviders} from '../electron/runtime/perception_broker';

test('a slow reader cannot erase or indefinitely delay another reader', async () => {
  const events: Array<{provider: string; state: string}> = [];
  let slowAborted = false;
  const started = performance.now();
  const result = await runPerceptionProviders([
    {id: 'uia', softDeadlineMs: 10, hardDeadlineMs: 100, read: async () => 'Selected text'},
    {id: 'office', softDeadlineMs: 10, hardDeadlineMs: 50, read: signal => new Promise<string>(() => {
      signal.addEventListener('abort', () => { slowAborted = true; }, {once: true});
    })},
  ], {onProgress: event => events.push(event)});
  assert.equal(result[0].status, 'fulfilled');
  assert.equal(result[0].value, 'Selected text');
  assert.equal(result[1].status, 'timeout');
  assert.equal(slowAborted, true);
  assert.ok(performance.now() - started < 800);
  assert.deepEqual(events.filter(event => event.provider === 'office').map(event => event.state), ['reading', 'slow', 'timeout']);
});

test('all readers start concurrently, complete in their own order and keep identity', async () => {
  const starts: string[] = [];
  let release!: (value: string) => void;
  const pending = runPerceptionProviders([
    {id: 'first', softDeadlineMs: 100, hardDeadlineMs: 200, read: () => {
      starts.push('first'); return new Promise<string>(resolve => { release = resolve; });
    }},
    {id: 'second', softDeadlineMs: 100, hardDeadlineMs: 200, read: async () => { starts.push('second'); return 'B'; }},
  ]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts, ['first', 'second']);
  release('A');
  const result = await pending;
  assert.deepEqual(result.map(item => [item.id, item.status, item.value]), [['first', 'fulfilled', 'A'], ['second', 'fulfilled', 'B']]);
});

test('caller cancellation is not converted to empty or successful perception', async () => {
  const abort = new AbortController();
  const pending = runPerceptionProviders([
    {id: 'uia', softDeadlineMs: 100, hardDeadlineMs: 300, read: () => new Promise<never>(() => {})},
  ], {signal: abort.signal});
  abort.abort(new Error('user_cancelled'));
  await assert.rejects(pending, /user_cancelled/);
});

test('provider failure reports the provider and elapsed time; late results stay retired', async () => {
  const events: Array<{provider: string; state: string}> = [];
  let release!: (value: string) => void;
  const result = await runPerceptionProviders([
    {id: 'broken', softDeadlineMs: 10, hardDeadlineMs: 30, read: async () => { throw new Error('native_busy'); }},
    {id: 'late', softDeadlineMs: 10, hardDeadlineMs: 30, read: () => new Promise<string>(resolve => { release = resolve; })},
  ], {onProgress: event => events.push(event)});
  assert.equal(result[0].status, 'rejected');
  assert.match(result[0].error!, /native_busy/);
  assert.ok(result[0].latencyMs >= 0);
  const count = events.length;
  release('too late');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, count);
  assert.equal(result[1].status, 'timeout');
});
