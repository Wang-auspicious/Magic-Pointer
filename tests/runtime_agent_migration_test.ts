import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { EventSession } from '../electron/runtime/session';
import { compactSession, HookManager, registerAgentTools, runAgent, type ModelReply } from '../electron/runtime/agent';
import { scheduleToolCalls, ToolRegistry, type ToolEvent } from '../electron/runtime/tools';
import { WorkspaceFiles } from '../electron/runtime/agent_files';
import { readAgentStatus } from '../electron/runtime/agent_background';

const schema = { type: 'object', properties: {}, required: [] };
const call = (id: string, name: string, args = {}) => ({ id, name, arguments: args });
const reply = (calls: ReturnType<typeof call>[] = [], text = 'Done'): ModelReply => ({ text, tool_calls: calls });
const fixture = async (id: string) => {
  const root = await mkdtemp(join(tmpdir(), 'mp-runtime-'));
  return { root, userDataDir: root, session: await EventSession.open(root, id) };
};

test('permission suspension survives reopening and executes the exact approved action once', async () => {
  const context = await fixture('permission');
  let executions = 0;
  const registry = () => {
    const tools = new ToolRegistry();
    tools.register({ name: 'Deliver', description: 'Fixture delivery', effect: 'external_send', input_schema: schema,
      execute: () => { executions++; return { verification: { matched: true } }; } });
    return tools;
  };
  const waiting = await runAgent({ ...context, registry: registry(), instruction: 'Deliver once', model: async () => reply([call('send', 'Deliver')]) });
  assert.equal(waiting.reason, 'awaiting_user');
  assert.equal(executions, 0);
  const reopened = await EventSession.open(context.root, 'permission', false);
  assert.equal(reopened.pendingInput()?.requestId, 'send');
  await reopened.answer('send', { decision: 'once' });
  const resumed = await runAgent({ ...context, session: reopened, registry: registry(), model: async () => reply() });
  assert.equal(resumed.reason, 'completed');
  assert.equal(executions, 1);
  assert.equal(reopened.approvedCalls().length, 0);
  await runAgent({ ...context, session: await EventSession.open(context.root, 'permission', false), registry: registry(), model: async () => reply() });
  assert.equal(executions, 1);
});

test('interrupted writes remain blocked until a later read and explicit recovery confirmation', async () => {
  const context = await fixture('recovery');
  await context.session.append('turn/start', { turn: 1 });
  await context.session.appendMessage({ role: 'assistant', content: '', tool_calls: [call('original', 'Deliver')] });
  await context.session.append('operation/prepared', { turn: 1, operationId: 'unknown-send', callId: 'original', name: 'Deliver', arguments: {}, effect: 'external_send', dispatched: true });
  let executions = 0, round = 0;
  const registry = new ToolRegistry();
  registry.register({ name: 'Deliver', description: 'Fixture delivery', effect: 'external_send', input_schema: schema, execute: () => { executions++; return 'sent'; } });
  registry.register({ name: 'Inspect', description: 'Fixture readback', effect: 'read', input_schema: schema, execute: () => ({ alreadyDelivered: true }) });
  const resumed = await runAgent({ ...context, session: await EventSession.open(context.root, 'recovery', false), registry, permissionMode: 'bypass',
    model: async () => ++round === 1 ? reply([call('retry', 'Deliver'), call('verify', 'Inspect')]) : reply() });
  assert.equal(resumed.reason, 'completed');
  assert.equal(executions, 0);
  assert.match(String(resumed.results[0].value), /RECOVERY_RETRY_BLOCKED/);
  const reopened = await EventSession.open(context.root, 'recovery', false);
  assert.equal(reopened.pendingRecovery().length, 1);
  await assert.rejects(reopened.append('operation/recovery_resolved', { operationId: 'unknown-send', verificationCallId: 'retry', confirmed: true }), /successful_post_recovery_read_required/);
  await reopened.append('operation/recovery_resolved', { operationId: 'unknown-send', verificationCallId: 'verify', confirmed: true });
  assert.equal(reopened.pendingRecovery().length, 0);
});

test('concurrent session writers preserve every event and inbox claims are exclusive', async () => {
  const context = await fixture('concurrent');
  const other = await EventSession.open(context.root, 'concurrent', false);
  await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? other : context.session).append('fixture/item', { index })));
  await context.session.enqueue('Continue with the revised input');
  const claimed = await Promise.all([context.session.claimInbox('next-step'), other.claimInbox('next-step')]);
  assert.deepEqual(claimed.map(items => items.length).sort(), [0, 1]);
  const reopened = await EventSession.open(context.root, 'concurrent', false);
  assert.equal(reopened.events.filter(event => event.type === 'fixture/item').length, 12);
  assert.equal(reopened.deriveMessages().filter(message => message.content === 'Continue with the revised input').length, 1);
  await context.session.startTurn();
  await assert.rejects(other.startTurn(), /session_busy/);
  await context.session.endTurn('completed');
  const fork = await context.session.fork(context.root, 'child');
  assert.deepEqual(fork.deriveMessages(), context.session.deriveMessages());
});

test('scheduler runs independent reads together and serializes resource conflicts and writes', async () => {
  const registry = new ToolRegistry();
  let active = 0, peak = 0;
  const inUse = new Set<string>(), starts: string[] = [];
  registry.register({ name: 'Read', description: 'Fixture read', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }, is_concurrency_safe: true,
    resource_keys: args => [String(args.key)], execute: async args => {
      const key = String(args.key); assert(!inUse.has(key)); inUse.add(key); active++; peak = Math.max(peak, active); starts.push(key);
      await new Promise(resolve => setTimeout(resolve, key === 'a' ? 20 : 5)); active--; inUse.delete(key); return key;
    } });
  registry.register({ name: 'Write', description: 'Fixture write', effect: 'reversible_write', input_schema: schema, execute: () => { assert.equal(active, 0); starts.push('write'); return 'written'; } });
  const events: ToolEvent[] = [];
  for await (const event of scheduleToolCalls([call('1', 'Read', { key: 'a' }), call('2', 'Read', { key: 'b' }), call('3', 'Read', { key: 'a' }), call('4', 'Write')], registry)) events.push(event);
  assert.equal(peak, 2);
  assert.deepEqual(starts, ['a', 'b', 'a', 'write']);
  assert.deepEqual(events.filter(event => event.type === 'committed').map(event => event.call.id), ['1', '2', '3', '4']);
});

test('planning approval and pre-dispatch hooks gate writes while cleanup executes', async () => {
  const context = await fixture('planning'), registry = new ToolRegistry();
  registerAgentTools(registry, context.session);
  let round = 0, writes = 0, closed = 0;
  registry.register({ name: 'Write', description: 'Fixture write', effect: 'reversible_write', input_schema: schema, execute: () => { writes++; return 'written'; } });
  registry.onSessionEnd(() => { closed++; });
  const first = await runAgent({ ...context, registry, permissionMode: 'plan', model: async () => ++round === 1
    ? reply([call('write', 'Write')]) : reply([call('plan', 'ExitPlanMode', { plan: 'Inspect, edit, and verify.' })]) });
  assert.equal(first.reason, 'awaiting_user');
  assert.equal(writes, 0);
  assert.equal(closed, 1);
  await context.session.answer('plan', { decision: 'grant' });
  assert.equal(context.session.permissionMode('plan'), 'default');
  const hooks = new HookManager(); hooks.add('pre', () => ({ decision: 'block', reason: 'User changed scope' }));
  round = 0;
  const resumed = await runAgent({ ...context, registry, permissionMode: 'plan', hooks, model: async () => ++round === 1 ? reply([call('blocked', 'Write')]) : reply() });
  assert.equal(resumed.reason, 'completed');
  assert.equal(writes, 0);
});

test('filesystem edits require current reads and checkpoints restore actual content', async () => {
  const context = await fixture('files'), file = join(context.root, 'source.txt'), workspace = new WorkspaceFiles(context.root, context.session);
  await writeFile(file, 'before');
  await assert.rejects(workspace.write(file, 'after'), /Read .*before editing/);
  await workspace.read(file);
  await writeFile(file, 'outside edit');
  await assert.rejects(workspace.write(file, 'after'), /changed since/);
  await workspace.read(file);
  await workspace.write(file, 'after');
  assert.equal(await readFile(file, 'utf8'), 'after');
  await workspace.rewind(1);
  assert.equal(await readFile(file, 'utf8'), 'outside edit');
});

test('compaction keeps durable plan and permission state while replacing historical messages with evidence', async () => {
  const context = await fixture('compaction');
  await context.session.append('permission/mode', { mode: 'safe' });
  await context.session.append('plan/updated', { taskId: context.session.id, plan: [{ content: 'Verify saved output', status: 'in_progress' }] });
  await context.session.appendMessage({ role: 'user', content: 'Produce the report' });
  await context.session.appendMessage({ role: 'assistant', content: 'Historical evidence '.repeat(2000) });
  const compacted = await compactSession({ ...context, registry: new ToolRegistry(), model: async request => {
    assert.equal(request.messages[0].origin, 'data');
    return reply([], 'The report is saved; verify the output before delivery.');
  } }, '', new AbortController().signal, true);
  assert.equal(compacted, true);
  const reopened = await EventSession.open(context.root, context.session.id, false);
  assert.equal(reopened.permissionMode('default'), 'safe');
  assert.equal(reopened.deriveMessages().length, 1);
  assert.equal(reopened.deriveMessages()[0].origin, 'data');
  assert.match(reopened.deriveMessages()[0].content!, /Verify saved output/);
  assert.equal(reopened.events.filter(event => event.type === 'assistant/message').length, 1);
});

test('independent Agent worker finishes after its parent turn and delivers durable inbox completion', { timeout: 15000 }, async t => {
  const context = await fixture('parent');
  await context.session.startTurn(); await context.session.endTurn('completed');
  const child = await EventSession.open(context.root, 'background-child', true, context.session.id);
  await context.session.append('subagent/created', { childSessionId: child.id, task: 'Read the fixture', readonly: true });
  await writeFile(join(context.root, 'fixture.txt'), 'fixture content');
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume(); request.on('end', () => {
      requests++;
      const delta = requests === 1 ? { tool_calls: [{ index: 0, id: 'read-fixture', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ path: 'fixture.txt' }) } }] } : { content: 'Verified fixture content.' };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const worker = spawn(process.execPath, ['--import', 'tsx', join(process.cwd(), 'electron/runtime/agent_worker.ts'), 'agent'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (worker.exitCode === null) worker.kill(); });
  let errors = ''; worker.stderr.on('data', chunk => { errors += String(chunk); });
  const completed = new Promise<number | null>((resolve, reject) => { worker.once('error', reject); worker.once('exit', resolve); });
  await writeFile(join(context.root, 'agent-sessions', child.id + '.agent.json'), JSON.stringify({ id: child.id, status: 'starting', pid: worker.pid, startedAt: Date.now() }));
  worker.stdin.end(JSON.stringify({ root: context.root, userDataDir: context.root, workspace: context.root, sessionId: child.id, parentId: context.session.id,
    instruction: 'Read fixture.txt and report its contents.', readonly: true, permissionMode: 'safe', parentCallId: 'delegate',
    config: { model: 'fixture', apiMode: 'chat-completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, credential: 'fixture' } }));
  assert.equal(await completed, 0, errors);
  const status = await readAgentStatus(context.root, child.id);
  assert.equal(status?.status, 'completed');
  assert.equal(requests, 2);
  await context.session.refresh();
  assert(context.session.pendingInbox('next-step').some(item => String(item.text).includes('Verified fixture content.')));
  assert.equal(context.session.openTurn, null);
  const reopened = await EventSession.open(context.root, child.id, false);
  assert(reopened.events.some(event => event.type === 'operation/settled' && event.data.outcome === 'succeeded'));
});
