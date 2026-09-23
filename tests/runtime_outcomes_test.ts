import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventSession } from '../electron/runtime/session';
import { runAgent, type ModelReply } from '../electron/runtime/agent';
import { ToolRegistry } from '../electron/runtime/tools';
import { operationOutcomes, taskOutcomes } from '../electron/runtime/agent_outcomes';

const schema = { type: 'object', properties: {}, required: [], additionalProperties: true };
const call = (id: string, name: string, args = {}) => ({ id, name, arguments: args });
const reply = (tool_calls: ReturnType<typeof call>[] = []): ModelReply => ({ text: tool_calls.length ? '' : 'Done', tool_calls });
async function fixture(id: string) {
  const root = await mkdtemp(join(tmpdir(), 'mp-outcomes-'));
  return { root, userDataDir: root, session: await EventSession.open(root, id) };
}

test('verification belongs to each written target and survives a resumed turn', async () => {
  const options = await fixture('targets'), registry = new ToolRegistry();
  registry.register({ name: 'Edit', description: 'edit exact target', input_schema: schema, effect: 'reversible_write',
    execute: args => ({ path: args.path, verification: { matched: args.path === 'a.txt', method: 'readback' } }) });
  registry.register({ name: 'Inspect', description: 'read unrelated target', input_schema: schema,
    execute: () => ({ path: 'other.txt', verification: { matched: true } }) });
  let round = 0;
  const result = await runAgent({ ...options, registry, model: async () => ++round === 1
    ? reply([call('a', 'Edit', { path: 'a.txt' }), call('b', 'Edit', { path: 'b.txt' }), call('other', 'Inspect')]) : reply() });
  assert.equal(result.receipt.status, 'unverified');
  const targets = result.receipt.targets as Array<Record<string, unknown>>;
  assert.equal(targets.find(row => row.target === 'file:a.txt')?.status, 'verified');
  assert.equal(targets.find(row => row.target === 'file:b.txt')?.status, 'unverified');
  const resumed = await runAgent({ ...options, instruction: 'Continue verifying b.txt', session: await EventSession.open(options.root, 'targets', false), registry: new ToolRegistry(), model: async () => reply() });
  assert.equal(resumed.receipt.status, 'unverified');
});

test('pending plan deliverables cannot be projected as a succeeded task', async () => {
  const options = await fixture('plan');
  await options.session.append('plan/updated', { plan: [{ content: 'Deliver the second document', status: 'pending' }] });
  const result = await runAgent({ ...options, registry: new ToolRegistry(), model: async () => reply() });
  assert.equal(result.receipt.status, 'partial');
  assert.deepEqual(result.receipt.unfinished, ['Deliver the second document']);
});

test('a normal continuation retains unverified writes and unfinished plan items', async () => {
  const options = await fixture('continue-obligations'), registry = new ToolRegistry();
  registry.register({ name: 'Edit', description: 'edit', input_schema: schema, effect: 'reversible_write',
    execute: () => ({ path: 'order.txt', verification: { matched: false } }) });
  let round = 0;
  const first = await runAgent({ ...options, registry, instruction: 'Finish both edits', model: async () => ++round === 1
    ? reply([call('edit', 'Edit', { path: 'order.txt' })]) : reply() });
  assert.equal(first.receipt.status, 'unverified');
  await options.session.append('plan/updated', { plan: [{ content: 'Finish second edit', status: 'pending' }] });
  const next = await runAgent({ ...options, registry, instruction: 'Continue the same task', model: async () => reply() });
  assert.equal(next.receipt.status, 'unverified');
  assert.equal((next.receipt.targets as Array<Record<string, unknown>>)[0]?.target, 'file:order.txt');
  assert.deepEqual(next.receipt.unfinished, ['Finish second edit']);
});

test('cancelled plan items still count as undelivered work', async () => {
  const options = await fixture('cancelled-item');
  await options.session.append('plan/updated', { plan: [{ content: 'Deliver second document', status: 'cancelled' }] });
  const result = await runAgent({ ...options, registry: new ToolRegistry(), model: async () => reply() });
  assert.equal(result.receipt.status, 'partial');
  assert.deepEqual(result.receipt.unfinished, ['Deliver second document']);
});

test('a later verified read resolves only its matching write, and another write invalidates it', async () => {
  const options = await fixture('readback'), registry = new ToolRegistry();
  registry.register({ name: 'Edit', description: 'edit', input_schema: schema, effect: 'reversible_write', execute: args => ({ path: args.path }) });
  registry.register({ name: 'Check', description: 'verified readback', input_schema: schema, execute: args => ({ path: args.path, verification: { matched: true, method: 'expected_value' } }) });
  let round = 0;
  const result = await runAgent({ ...options, registry, model: async () => ++round === 1
    ? reply([call('edit', 'Edit', { path: 'a.txt' }), call('check', 'Check', { path: 'a.txt' })]) : reply() });
  assert.equal(result.receipt.status, 'succeeded');
  assert.equal((result.receipt.targets as Array<Record<string, unknown>>)[0].verificationCallId, 'check');
  round = 0;
  const next = await runAgent({ ...options, registry, model: async () => ++round === 1 ? reply([call('again', 'Edit', { path: 'a.txt' })]) : reply() });
  assert.equal(next.receipt.status, 'unverified');
});

test('a generic matched read cannot certify a failed write or an unverified write without a method', async () => {
  for (const failure of [true, false]) {
    const options = await fixture(`weak-read-${failure}`), registry = new ToolRegistry();
    registry.register({ name: 'Edit', description: 'edit', input_schema: schema, effect: 'reversible_write',
      execute: () => { if (failure) throw new Error('Edit failed'); return { path: 'a.txt' }; } });
    registry.register({ name: 'Check', description: 'generic check', input_schema: schema,
      execute: () => ({ path: 'a.txt', verification: { matched: true } }) });
    let round = 0;
    const result = await runAgent({ ...options, registry, model: async () => ++round === 1
      ? reply([call('edit', 'Edit', { path: 'a.txt' }), call('check', 'Check', { path: 'a.txt' })]) : reply() });
    assert.equal(result.receipt.status, 'unverified');
    assert.equal((result.receipt.targets as Array<Record<string, unknown>>)[0]?.status, failure ? 'failed' : 'unverified');
  }
});

test('direct external effects require application-level evidence, while genuine delivery can verify', async () => {
  for (const [effect, scope, expected] of [
    ['external_send', 'input_only_not_delivery', 'unverified'], ['external_send', 'external_delivery', 'succeeded'],
    ['destructive', 'ui_postcondition', 'unverified'], ['destructive', 'application_state', 'succeeded'],
  ] as const) {
    const options = await fixture(`delivery-${scope}`), registry = new ToolRegistry();
    registry.register({ name: 'Deliver', description: 'deliver', input_schema: schema, effect,
      execute: () => ({ verification: { matched: true, method: 'recipient_message_readback', scope } }) });
    let round = 0;
    const result = await runAgent({ ...options, registry, permissionMode: 'bypass', model: async () => ++round === 1
      ? reply([call('delivery', 'Deliver', { recipient: 'approved@example.test' })]) : reply() });
    assert.equal(result.receipt.status, expected);
  }
  const options = await fixture('validator-only'), registry = new ToolRegistry();
  registry.register({ name: 'Deliver', description: 'submit', input_schema: schema, effect: 'external_send',
    verify_result: () => {}, execute: () => ({ submitted: true }) });
  let round = 0;
  const result = await runAgent({ ...options, registry, permissionMode: 'bypass', model: async () => ++round === 1
    ? reply([call('submitted', 'Deliver')]) : reply() });
  assert.equal(result.receipt.status, 'unverified');
  for (const [scope, expected] of [['input_only_not_delivery', 'unverified'], ['transaction_settlement', 'verified']] as const) {
    const outcome = operationOutcomes({ operationId: 'purchase-op', callId: 'purchase', name: 'Purchase', effect: 'purchase', dispatched: true, arguments: {} },
      { tool_call_id: 'purchase', value: { verification: { matched: true, method: 'merchant_receipt_readback', scope } }, is_error: false,
        failure_type: null, used_backend: 'fixture', latency_ms: 1, outcome_known: true }, false);
    assert.equal(outcome[0]?.status, expected);
  }
});

test('unknown writes need recovery resolution and an operation-bound readback', async () => {
  const options = await fixture('unknown-recovery'), session = options.session;
  await session.append('operation/prepared', { operationId: 'write-op', callId: 'write', name: 'Write', arguments: { path: 'a.txt' }, effect: 'reversible_write', dispatched: true });
  await session.append('operation/settled', { operationId: 'write-op', outcome: 'unknown', targetOutcomes: [{ operationId: 'write-op', callId: 'write', tool: 'Write', target: 'file:a.txt', status: 'unknown', method: 'not_verified', scope: 'tool_postcondition', usedBackend: 'fixture', effect: 'reversible_write' }],
    message: { role: 'tool', name: 'Write', tool_call_id: 'write', content: 'timed out', is_error: true } });
  await session.append('operation/prepared', { operationId: 'check-op', callId: 'check', name: 'Check', arguments: { path: 'a.txt' }, effect: 'read', dispatched: true });
  await session.append('operation/settled', { operationId: 'check-op', outcome: 'succeeded', message: { role: 'tool', name: 'Check', tool_call_id: 'check', content: JSON.stringify({ path: 'a.txt', verification: { matched: true, method: 'expected_value', operationId: 'write-op' } }) } });
  assert.equal(taskOutcomes(session.events).targets[0]?.status, 'unknown');
  await session.append('operation/recovery_resolved', { operationId: 'write-op', verificationCallId: 'check', confirmed: true });
  assert.equal(taskOutcomes(session.events).targets[0]?.status, 'verified');
});

test('changing arguments and error text does not renew a failing capability indefinitely', async () => {
  const options = await fixture('failures'), registry = new ToolRegistry();
  let round = 0;
  registry.register({ name: 'Fetch', description: 'unavailable reader', input_schema: schema,
    execute: args => { throw new Error(`Provider unavailable for attempt ${args.attempt}`); } });
  const result = await runAgent({ ...options, registry, emergencyFuse: 12,
    model: async () => reply([call(`r${++round}`, 'Fetch', { attempt: round })]) });
  assert.equal(result.reason, 'stalled');
  assert(round < 8);
});

test('switching read tools with identical evidence does not count as new progress', async () => {
  const options = await fixture('evidence'), registry = new ToolRegistry();
  for (const name of ['ReadOne', 'ReadTwo']) registry.register({ name, description: 'same source', input_schema: schema,
    execute: () => ({ sourceId: 'source', text: 'The original unchanged evidence', observedAt: Date.now() }) });
  let round = 0;
  const result = await runAgent({ ...options, registry, emergencyFuse: 12,
    model: async () => reply([call(`r${++round}`, round % 2 ? 'ReadOne' : 'ReadTwo', { page: round })]) });
  assert.equal(result.reason, 'stalled');
  assert(round < 8);
});

test('resuming older settled writes without target metadata does not invent verification', async () => {
  const options = await fixture('older-write');
  await options.session.append('operation/prepared', { operationId: 'old-op', callId: 'old-call', name: 'Edit', arguments: { path: 'a.txt' }, effect: 'reversible_write', dispatched: true });
  await options.session.append('operation/settled', { operationId: 'old-op', outcome: 'succeeded', message: { role: 'tool', name: 'Edit', tool_call_id: 'old-call', content: '{"path":"a.txt"}' } });
  const result = await runAgent({ ...options, registry: new ToolRegistry(), model: async () => reply() });
  assert.equal(result.receipt.status, 'unverified');
});

test('new writes and measured condition waits remain productive beyond the repetition limit', async () => {
  const options = await fixture('productive'), registry = new ToolRegistry();
  registry.register({ name: 'Edit', description: 'write current revision', input_schema: schema, effect: 'reversible_write',
    execute: args => ({ path: 'a.txt', revision: args.revision, verification: { matched: true } }) });
  registry.register({ name: 'wait', description: 'condition wait', input_schema: schema,
    execute: () => ({ satisfied: false, condition: 'file_exists', elapsed_s: 1 }) });
  let round = 0;
  const result = await runAgent({ ...options, registry, model: async () => ++round <= 8
    ? reply([call(`e${round}`, 'Edit', { path: 'a.txt', revision: round }), call(`w${round}`, 'wait', { file_exists: 'result.txt' })]) : reply() });
  assert.equal(result.reason, 'completed');
  assert.equal(result.receipt.status, 'succeeded');
});

test('native user takeover stops sibling actions and preserves the unknown outcome', async () => {
  const options = await fixture('takeover'), registry = new ToolRegistry();
  let siblingRan = false;
  registry.register({ name: 'Drag', description: 'long native action', input_schema: schema, effect: 'reversible_write',
    execute: () => { throw new DOMException('computer_use_interrupted', 'AbortError'); } });
  registry.register({ name: 'Click', description: 'next native action', input_schema: schema, effect: 'reversible_write', execute: () => { siblingRan = true; } });
  let turn = 0;
  const result = await runAgent({ ...options, registry, model: async () => ++turn === 1 ? reply([call('drag', 'Drag'), call('click', 'Click')]) : reply() });
  assert.equal(result.reason, 'user_interrupt');
  assert.equal(siblingRan, false);
  assert.equal(result.receipt.status, 'interrupted');
  assert.equal(options.session.pendingRecovery()[0]?.tool, 'Drag');
});

test('two edits in one file cannot share completion, while an exact retry can resolve failure', async () => {
  const options = await fixture('same-file'), registry = new ToolRegistry();
  let ready = false, turn = 0;
  registry.register({ name: 'Edit', description: 'edit exact fragment', input_schema: schema, effect: 'reversible_write', execute: args => {
    if (args.old_string === 'A' && !ready) throw new Error('A is not available');
    return { path: args.path, verification: { matched: true } };
  } });
  const a = { path: 'same.txt', old_string: 'A', new_string: 'updated A' }, b = { path: 'same.txt', old_string: 'B', new_string: 'updated B' };
  const first = await runAgent({ ...options, registry, instruction: 'Change both A and B', model: async () => ++turn === 1 ? reply([call('a', 'Edit', a), call('b', 'Edit', b)]) : reply() });
  assert.equal(first.receipt.status, 'unverified');
  ready = true; turn = 0;
  const retry = await runAgent({ ...options, registry, model: async () => ++turn === 1 ? reply([call('a-retry', 'Edit', a)]) : reply() });
  assert.equal(retry.receipt.status, 'succeeded');
});

test('a new user request starts fresh after the previous receipt succeeded', async () => {
  const options = await fixture('new-request'), registry = new ToolRegistry();
  registry.register({ name: 'Edit', description: 'edit', input_schema: schema, effect: 'reversible_write', execute: args => ({ path: args.path, verification: { matched: true } }) });
  let turn = 0;
  const first = await runAgent({ ...options, registry, instruction: 'First request', model: async () => ++turn === 1 ? reply([call('old', 'Edit', { path: 'old.txt' })]) : reply() });
  assert.equal(first.receipt.status, 'succeeded');
  turn = 0;
  const next = await runAgent({ ...options, registry, instruction: 'A new independent request', model: async () => ++turn === 1 ? reply([call('new', 'Edit', { path: 'new.txt' })]) : reply() });
  assert.equal(next.receipt.status, 'succeeded');
  assert.equal((next.receipt.targets as unknown[]).length, 1);
});

test('repeated non-idempotent keyboard input is not mistaken for a duplicate successful write', async () => {
  const options = await fixture('keys'), registry = new ToolRegistry();
  registry.register({ name: 'press_key', description: 'move one row', input_schema: schema, effect: 'reversible_write', execute: () => ({ ok: true, verification: { matched: false } }) });
  let turn = 0;
  const result = await runAgent({ ...options, registry, model: async () => ++turn <= 4 ? reply([call(`key-${turn}`, 'press_key', { state_id: 'state', keys: 'down' })]) : reply() });
  assert.equal(result.reason, 'completed');
  assert.equal(result.receipt.status, 'unverified');
});

test('desktop batch receipts use each action and explicit waits resolve only the bound non-send action', async () => {
  const options = await fixture('desktop-targets'), registry = new ToolRegistry();
  const actionTarget = { windowHwnd: 123, pid: 456, stateId: 'before', ref: '@e1' };
  registry.register({ name: 'act_ui', description: 'batch', input_schema: schema, effect: 'reversible_write', execute: () => ({
    verification: { matched: true }, actionResults: [
      { index: 0, name: 'set_value', effect: 'reversible_write', actionTarget, verification: { matched: false } },
      { index: 1, name: 'set_value', effect: 'reversible_write', actionTarget: { ...actionTarget, ref: '@e2' }, verification: { matched: true } },
      { index: 2, name: 'type_text', effect: 'external_send', submit: true, actionTarget, verification: { matched: true } },
    ] }) });
  registry.register({ name: 'wait_for', description: 'bound readback', input_schema: schema, execute: args => ({ verification: { matched: true,
    forCallId: 'batch', forActionIndex: args.index, windowHwnd: 123, pid: 456, stateId: 'before', method: 'uia_condition_wait' } }) });
  let turn = 0;
  const result = await runAgent({ ...options, registry, model: async () => ++turn === 1 ? reply([call('batch', 'act_ui', { actions: [{}, {}, { submit: true }] })])
    : turn === 2 ? reply([call('confirm-first', 'wait_for', { index: 0 }), call('cannot-confirm-send', 'wait_for', { index: 2 })]) : reply() });
  assert.equal(result.receipt.status, 'unverified');
  const targets = result.receipt.targets as Array<Record<string, unknown>>;
  assert.equal(targets.length, 3);
  assert.deepEqual(targets.map(row => row.status), ['verified', 'verified', 'unverified']);
});
