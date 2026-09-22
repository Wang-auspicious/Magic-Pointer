import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionFailure, ToolRegistry, scheduleToolCalls, type ToolCall, type ToolEvent } from '../electron/runtime/tools';

const schema = { type: 'object', properties: { resource: { type: 'string' } }, required: [] };
const call = (id: string, name = 'Read', resource = id): ToolCall => ({ id, name, arguments: { resource } });
function gate() {
  let release!: (value?: unknown) => void;
  const promise = new Promise<unknown>(resolve => { release = resolve; });
  return { promise, release };
}
async function collect(source: AsyncIterable<ToolEvent>, events: ToolEvent[] = []) {
  for await (const event of source) events.push(event);
  return events;
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('registry validates nested arguments, discovers deferred tools and preserves execution failures', async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({ name: 'Read', description: 'Read document', input_schema: schema, execute: args => args });
  registry.register({ name: 'Edit', description: '编辑文档', deferred: true, effect: 'reversible_write',
    input_schema: { type: 'object', properties: { rows: { type: 'array', minItems: 1, items: { $ref: '#/$defs/row' } } }, required: ['rows'],
      $defs: { row: { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'], additionalProperties: false } } },
    execute: () => { executions++; throw new ActionFailure('content_changed', 'Document changed', 'Read again', { revision: 2 }); } });
  assert.deepEqual(registry.schemas().map(item => item.name), ['Read']);
  assert.deepEqual(registry.discover({ keyword: '编辑' }).map(item => item.name), ['Edit']);
  assert.deepEqual(registry.schemas().map(item => item.name), ['Read', 'Edit']);
  const invalid = await registry.execute({ id: 'bad', name: 'Edit', arguments: { rows: [{ count: true }] } });
  assert.equal(invalid.is_error, true);
  assert.equal(executions, 0);
  const failure = await registry.execute({ id: 'edit', name: 'Edit', arguments: { rows: [{ count: 1 }] } });
  assert.equal(failure.failure_type, 'content_changed');
  assert.deepEqual(failure.value, { revision: 2 });
  assert.match(failure.error_message!, /Read again/);
  assert.equal(failure.outcome_known, true);
  assert.equal(failure.used_backend, 'local');
  assert.ok(failure.latency_ms! >= 0);
  assert.throws(() => registry.discover({ names: ['Read', 'Missing'] }), /Missing/);
  registry.registerDiscovery();
  assert.deepEqual((await registry.execute({ id: 'discover', name: 'Tools', arguments: { names: ['Edit'] } })).value, { tools: [{ name: 'Edit' }] });
});

test('bounded pool replenishes on completion while results commit in model order', async () => {
  const registry = new ToolRegistry();
  const gates = [gate(), gate(), gate()];
  const starts: string[] = [], settled: string[] = [];
  registry.register({ name: 'Read', description: 'Read', input_schema: schema, is_concurrency_safe: true,
    execute: async (_args, context) => { starts.push(context.tool_call_id); return gates[Number(context.tool_call_id)]!.promise; } });
  const events: ToolEvent[] = [];
  const task = collect(scheduleToolCalls([call('0'), call('1'), call('2')], registry,
    { max_parallel_tool_calls: 2, onSettled: event => { settled.push(event.call.id); } }), events);
  await tick();
  assert.deepEqual(starts, ['0', '1']);
  gates[1]!.release('second');
  await tick();
  assert.deepEqual(starts, ['0', '1', '2']);
  assert.deepEqual(settled, ['1']);
  assert.deepEqual(events.filter(event => event.type === 'committed'), []);
  gates[2]!.release('third');
  gates[0]!.release('first');
  await task;
  assert.deepEqual(events.filter(event => event.type === 'committed').map(event => event.call.id), ['0', '1', '2']);
  assert.deepEqual(settled, ['1', '2', '0']);
});

test('shared resource keys serialize and exclusive actions form a barrier', async () => {
  const registry = new ToolRegistry();
  const gates = [gate(), gate(), gate(), gate(), gate()];
  const starts: string[] = [];
  const execute = async (_args: Record<string, unknown>, context: { tool_call_id: string }) => {
    starts.push(context.tool_call_id);
    return gates[Number(context.tool_call_id)]!.promise;
  };
  registry.register({ name: 'Read', description: 'Read', input_schema: schema, is_concurrency_safe: true,
    resource_keys: args => [String(args.resource)], execute });
  registry.register({ name: 'Write', description: 'Write', input_schema: schema, effect: 'reversible_write', execute });
  const task = collect(scheduleToolCalls([call('0'), call('1'),
    call('2', 'Read', 'network'), call('3', 'Write'), call('4')], registry, {
    before_dispatch: call => {
      if (['0', '1'].includes(call.id)) call.arguments = { resource: 'document' };
      return undefined;
    },
  }));
  await tick(); assert.deepEqual(starts, ['0']);
  gates[0]!.release(); await tick(); assert.deepEqual(starts, ['0', '1', '2']);
  gates[2]!.release(); await tick(); assert.deepEqual(starts, ['0', '1', '2']);
  gates[1]!.release(); await tick(); assert.deepEqual(starts, ['0', '1', '2', '3']);
  gates[3]!.release(); await tick(); assert.deepEqual(starts, ['0', '1', '2', '3', '4']);
  gates[4]!.release(); await task;
});

test('abort drains started work and explicitly settles undispatched calls', async () => {
  const registry = new ToolRegistry(), controller = new AbortController();
  const pending = gate(), events: ToolEvent[] = [], starts: string[] = [];
  registry.register({ name: 'Read', description: 'Read', input_schema: schema, is_concurrency_safe: true,
    execute: async (_args, context) => { starts.push(context.tool_call_id); return pending.promise; } });
  const task = collect(scheduleToolCalls([call('0'), call('1')], registry,
    { max_parallel_tool_calls: 1, signal: controller.signal }), events);
  const aborted = assert.rejects(task, { name: 'AbortError' });
  await tick(); controller.abort(); await tick();
  assert.equal(events.filter(event => event.type === 'committed').length, 0);
  pending.release('already finished'); await aborted;
  assert.deepEqual(starts, ['0']);
  const results = events.filter(event => event.type === 'committed');
  assert.equal(results[0]!.result.value, 'already finished');
  assert.equal(results[0]!.result.outcome_known, true);
  assert.equal(results[1]!.dispatched, false);
  assert.match(String(results[1]!.result.value), /before dispatch/);
});

test('abort during dispatched execution records unknown outcome and blocks remaining work', async () => {
  const registry = new ToolRegistry(), controller = new AbortController();
  registry.register({ name: 'Read', description: 'Read', input_schema: schema,
    execute: (_args, context) => new Promise((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
    }) });
  const events: ToolEvent[] = [];
  const task = collect(scheduleToolCalls([call('0'), call('1')], registry, { signal: controller.signal }), events);
  const aborted = assert.rejects(task, { name: 'AbortError' });
  await tick(); controller.abort(); await aborted;
  const results = events.filter(event => event.type === 'committed');
  assert.equal(results[0]!.dispatched, true);
  assert.equal(results[0]!.result.outcome_known, false);
  assert.equal(results[1]!.dispatched, false);
});

test('dispatch guard and action preconditions prevent effects; timeout reports unknown dispatched outcome', async () => {
  const registry = new ToolRegistry();
  let effects = 0;
  registry.register({ name: 'Read', description: 'Read or write document', input_schema: schema,
    effect_for: args => args.resource === 'write' ? 'reversible_write' : 'read',
    preconditions: [() => { throw new ActionFailure('stale_anchor', 'Target moved'); }],
    execute: () => { effects++; } });
  assert.equal(registry.effect('Read', { resource: 'write' }), 'reversible_write');
  assert.equal(registry.effect('Read', {}), 'read');
  const denied = await registry.execute(call('denied'));
  assert.equal(denied.failure_type, 'stale_anchor');
  assert.equal(denied.outcome_known, true);
  const events = await collect(scheduleToolCalls([call('blocked')], registry, { before_dispatch: () => denied }));
  assert.equal(events[0]!.dispatched, false);
  assert.equal(effects, 0);
  registry.register({ name: 'Wait', description: 'Wait for I/O', input_schema: schema, timeout_ms: 5,
    execute: (_args, context) => new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })) });
  const timed = await registry.execute(call('timed', 'Wait'));
  assert.equal(timed.failure_type, 'timeout');
  assert.equal(timed.outcome_known, false);
});
