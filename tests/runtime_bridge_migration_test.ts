import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { streamModel, modelPayload, requestVision, resolveModelConfig, type ModelConfig } from '../electron/runtime/model';
import { handleModels } from '../electron/runtime/model_admin';
import { MagicPointerMcpServer, buildHookResponse } from '../electron/runtime/connectors';
import { Fabric, registerRecipeTools } from '../electron/runtime/fabric';
import { handleFabric } from '../electron/runtime/fabric_api';
import { Workflows } from '../electron/runtime/workflow';
import { runAgent } from '../electron/runtime/agent';
import { ToolRegistry } from '../electron/runtime/tools';
import { ensureFolderReadScope, fileSource, registerSource, updateContext } from '../electron/runtime/context';
import { EventSession } from '../electron/runtime/session';
import { registerMcpDiscovery } from '../electron/runtime/mcp';
import { ReviewSessionStore } from '../electron/runtime/review';
import { recordSnapshot, loadTrace, tracePayload } from '../electron/runtime/replay';

const root = path.resolve(__dirname, '..');
const sse = (events: object[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
test('model selection updates the configuration used by subsequent runtime tasks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mp-model-select-')), userData = path.join(directory, 'user-data');
  await mkdir(path.join(directory, 'secrets'), { recursive: true });
  await writeFile(path.join(directory, 'secrets', 'model.txt'), 'old-model');
  const previous = process.env.MAGIC_POINTER_MODEL; delete process.env.MAGIC_POINTER_MODEL;
  try {
    await handleModels({ operation: 'model.select', model: 'selected-model', modelRuntime: { model: 'old-model', baseUrl: '' } }, directory, userData);
    assert.equal(resolveModelConfig(null, directory, userData).model, 'selected-model');
    process.env.MAGIC_POINTER_MODEL = 'environment-model';
    await assert.rejects(handleModels({ operation: 'model.select', model: 'another-model' }, directory, userData), /environment/i);
  } finally { if (previous === undefined) delete process.env.MAGIC_POINTER_MODEL; else process.env.MAGIC_POINTER_MODEL = previous; }
});
test('provider tool names satisfy wire syntax and resolve back to canonical dotted names', async () => {
  const config: ModelConfig = { model: 'fixture', credential: 'fixture' }, tools = [{ name: 'Context.list' }, { name: 'Context_list' }];
  let wire = '';
  const reply = await streamModel({ root, config, system: '', messages: [], tools, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.ok(body.tools.every((tool: any) => /^[A-Za-z0-9_-]+$/.test(tool.function.name)));
    assert.notEqual(body.tools[0].function.name, body.tools[1].function.name); wire = body.tools[0].function.name;
    return Response.json({ choices: [{ message: { tool_calls: [{ id: 'id', function: { name: wire, arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
  } });
  assert.equal(reply.tool_calls[0]?.name, 'Context.list');
  const replay = modelPayload(config, { system: '', tools, messages: [{ role: 'assistant', content: '', tool_calls: reply.tool_calls }] });
  assert.equal(replay.messages[0].tool_calls[0].function.name, wire);
});
test('vision retries unsupported optional controls while retaining image bytes', async () => {
  const bodies: Record<string, any>[] = [];
  const result = await requestVision({ model: 'fixture', apiMode: 'messages', credential: 'fixture' }, { prompt: 'Describe', images: [{ dataUrl: 'data:image/png;base64,aW1hZ2U=' }], fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    return bodies.length === 1 ? new Response('unsupported thinking field', { status: 400 }) : Response.json({ content: [{ type: 'text', text: 'image' }], stop_reason: 'end_turn' });
  } });
  assert.equal(result.text, 'image'); assert.equal(bodies.length, 2); assert.equal(bodies[1].thinking, undefined); assert.equal(bodies[1].messages[0].content.at(-1).source.data, 'aW1hZ2U=');
});
test('three streaming protocols preserve tools, usage and provider reasoning across replay', async () => {
  const cases: { mode: ModelConfig['apiMode']; events: object[] }[] = [
    { mode: 'chat-completions', events: [
      { choices: [{ delta: { reasoning_content: 'reason', tool_calls: [{ index: 0, id: 'call1', function: { name: 'Read', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { content: '中文', tool_calls: [{ index: 0, function: { arguments: '"file"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 9 } },
    ] },
    { mode: 'messages', events: [
      { type: 'message_start', message: { usage: { input_tokens: 7 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call1', name: 'Read', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"file"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
    ] },
    { mode: 'responses', events: [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'reason1', encrypted_content: 'opaque' } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'item1', call_id: 'call1', name: 'Read', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"file"}' },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 7, output_tokens: 9 } } },
    ] },
  ];
  for (const item of cases) {
    const config: ModelConfig = { model: 'fixture', credential: 'fixture', baseUrl: 'http://localhost:1/v1', apiMode: item.mode };
    const reply = await streamModel({ root, config, system: '', messages: [], tools: [], fetch: async () => sse(item.events) });
    assert.equal(reply.stop_reason, 'completed'); assert.deepEqual(reply.tool_calls, [{ id: 'call1', name: 'Read', arguments: { path: 'file' } }]);
    assert.equal(reply.usage.input_tokens ?? reply.usage.prompt_tokens, 7);
    assert.ok(reply.provider_items.length);
    const body = modelPayload(config, { system: '', tools: [], messages: [{ role: 'assistant', content: reply.text, tool_calls: reply.tool_calls, provider_items: reply.provider_items }, { role: 'tool', tool_call_id: 'call1', content: 'content' }] });
    assert.ok(JSON.stringify(body).includes(item.mode === 'responses' ? 'opaque' : item.mode === 'messages' ? 'signed' : 'reason'));
  }
});

test('an interrupted committed stream is not replayed and empty input tools remain valid', async () => {
  let attempts = 0;
  const request = { root, config: { model: 'fixture', apiMode: 'messages' as const, credential: 'fixture' }, system: '', messages: [], tools: [] };
  const empty = await streamModel({ ...request, fetch: async () => sse([{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'empty', name: 'ListApps', input: {} } }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }]) });
  assert.deepEqual(empty.tool_calls[0].arguments, {}); assert.equal(empty.tool_calls[0].argument_error, undefined);
  const reply = await streamModel({ ...request, fetch: async () => { attempts++; let step = 0; return new Response(new ReadableStream({ pull(controller) { if (step++ === 0) controller.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n')); else controller.error(new Error('disconnected')); } }), { headers: { 'content-type': 'text/event-stream' } }); } });
  assert.equal(attempts, 1); assert.match(reply.stop_reason, /disconnected/);
});

test('MCP confirmation, immutable plans and idempotent file artifacts work through the public interface', async () => {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'mp-bridge-')), options = { root, userDataDir }, fabric = new Fabric(options);
  const plan = (await fabric.plan({ recipeId: 'table.to_spreadsheet', command: 'export', objects: [{ id: 'table', kind: 'table', content: 'name,value\na,1' }] })).plan;
  const server = await MagicPointerMcpServer.open(options);
  assert.equal((await server.call('execute_recipe', { plan })).status, 'confirmation_required');
  const token = server.issueConfirmation('execute_recipe', `${plan.id}:${plan.integrityToken}`);
  const result = await server.call('execute_recipe', { plan, confirmationToken: token });
  assert.equal(result.status, 'succeeded'); assert.equal(result.verified, true); assert.match(await readFile(result.output.artifact, 'utf8'), /"a","1"/);
  assert.deepEqual(await fabric.execute(plan, true), result);
  await assert.rejects(fabric.execute({ ...plan, command: 'changed' }, true), /plan_changed/);
  const hook = await buildHookResponse('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'this table' }, options); assert.deepEqual(hook, {});
});

test('Fabric history reads need per-plan approval and clipboard restore is a write', async () => {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'mp-history-scope-'));
  const options = { root, userDataDir }, fabric = new Fabric(options), server = await MagicPointerMcpServer.open(options);
  await writeFile(path.join(userDataDir, 'screen-memory.json'), JSON.stringify({ entries: [{
    at: Date.now() / 1000, excerpt: 'Earlier private screen text', windowTitle: 'Private window',
    sourceId: 'old-screen', locator: { kind: 'text', value: {} },
  }] }));
  await writeFile(path.join(userDataDir, 'clipboard-history.json'), JSON.stringify({ entries: [{
    digest: 'old-copy', text: 'Earlier private copied text', at: Date.now() / 1000, app: 'Editor',
  }] }));

  const memory = (await fabric.plan({ recipeId: 'memory.recall', command: 'Earlier private', objects: [] })).plan;
  assert.equal(memory.requiresConfirmation, true);
  assert.equal((await server.call('execute_recipe', { plan: memory })).status, 'confirmation_required');
  const memoryToken = server.issueConfirmation('execute_recipe', `${memory.id}:${memory.integrityToken}`);
  assert.equal((await server.call('execute_recipe', { plan: memory, confirmationToken: memoryToken })).output.entries[0].excerpt, 'Earlier private screen text');
  const legacyMemory = { ...memory, requiresConfirmation: false };
  await writeFile(path.join(userDataDir, 'plans', `${memory.id}.json`), JSON.stringify(legacyMemory));
  assert.equal((await server.call('execute_recipe', { plan: legacyMemory })).status, 'confirmation_required');
  const legacyTask = await new Workflows(userDataDir).create(legacyMemory);
  const legacyPending = await handleFabric({ operation: 'workflow.execute', taskId: legacyTask.taskId }, options);
  assert.equal(legacyPending.state, 'confirmation_required');
  assert.equal(legacyPending.workflowTask.approvalState, 'pending');
  await handleFabric({ operation: 'workflow.approve', taskId: legacyTask.taskId, confirmed: true }, options);
  assert.equal((await handleFabric({ operation: 'workflow.execute', taskId: legacyTask.taskId }, options)).receipt.output.entries[0].excerpt, 'Earlier private screen text');
  const oldResult = await handleFabric({ operation: 'workflow.execute', taskId: legacyTask.taskId }, options);
  assert.equal(oldResult.reused, true);
  assert.doesNotMatch(JSON.stringify(oldResult), /Earlier private screen text/);

  const clipboard = (await fabric.plan({ recipeId: 'clipboard.history', command: 'copied text', objects: [] })).plan;
  assert.equal(clipboard.requiresConfirmation, true);
  assert.equal((await server.call('execute_recipe', { plan: clipboard })).status, 'confirmation_required');
  const workflow = await handleFabric({ operation: 'plan', recipeId: 'clipboard.history', command: 'copied text', objects: [] }, options);
  assert.equal((await handleFabric({ operation: 'workflow.execute', taskId: workflow.workflowTask.taskId }, options)).state, 'confirmation_required');
  await handleFabric({ operation: 'workflow.approve', taskId: workflow.workflowTask.taskId, confirmed: true }, options);
  assert.equal((await handleFabric({ operation: 'workflow.execute', taskId: workflow.workflowTask.taskId }, options)).receipt.output.entries[0].excerpt, 'Earlier private copied text');

  const restore = (await fabric.plan({ recipeId: 'clipboard.history', command: 'restore copied text', objects: [], parameters: { digest: 'old-copy' } })).plan;
  assert.equal(restore.risk, 'local_write');
  assert.equal(restore.parameters.permissionDecision.decision, 'confirm');
  assert.equal((await server.call('execute_recipe', { plan: restore })).status, 'confirmation_required');
  const legacyRestore = { ...restore, risk: 'read', requiresConfirmation: false };
  await writeFile(path.join(userDataDir, 'plans', `${restore.id}.json`), JSON.stringify(legacyRestore));
  await assert.rejects(fabric.execute(legacyRestore, true), /plan_risk_mismatch/);
});

test('Agent Recipe respects task material scope at plan and execution, and keeps plan confirmation', async () => {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'mp-recipe-scope-'));
  const materialDir = path.join(userDataDir, 'materials');
  await mkdir(materialDir);
  const selectedPath = path.join(userDataDir, 'selected.png');
  const privatePath = path.join(userDataDir, 'private.png');
  const folderPath = path.join(materialDir, 'page.png');
  await Promise.all([selectedPath, privatePath, folderPath].map(file => writeFile(file, 'image fixture')));
  const session = await EventSession.open(userDataDir, 'recipe-scope');
  await registerSource(session, fileSource(session.id, selectedPath));
  await ensureFolderReadScope(session, materialDir);
  const registry = new ToolRegistry();
  registerRecipeTools(registry, new Fabric({ root, userDataDir }), session);
  const plan = async (id: string, imagePath: string) => registry.execute({ id, name: 'Recipe', arguments: {
    operation: 'plan', recipeId: 'text.ocr_copy', command: 'OCR this image',
    objects: [{ id, kind: 'image', source: { path: imagePath } }],
  } });
  const privatePlan = await plan('private', privatePath);
  assert.equal(privatePlan.failure_type, 'permission_denied');
  const privateAttachment = await registry.execute({ id: 'private-attachment', name: 'Recipe', arguments: {
    operation: 'plan', recipeId: 'image.to_prompt', command: 'Describe this image',
    objects: [{ id: 'image', kind: 'image', content: 'image' }], parameters: { attachments: [privatePath] },
  } });
  assert.equal(privateAttachment.failure_type, 'permission_denied');
  const selectedPlan = await plan('selected', selectedPath);
  assert.equal(selectedPlan.is_error, false, selectedPlan.error_message);
  const folderPlan = await plan('folder', folderPath);
  assert.equal(folderPlan.is_error, false, folderPlan.error_message);
  await updateContext(session, { scopeRevocations: ['workspace-materials'] });
  const revokedExecution = await registry.execute({ id: 'revoked', name: 'Recipe', arguments: { operation: 'execute', plan: (folderPlan.value as any).plan } });
  assert.equal(revokedExecution.failure_type, 'permission_denied');
  const unconfirmedExecution = await registry.execute({ id: 'unconfirmed', name: 'Recipe', arguments: { operation: 'execute', plan: (selectedPlan.value as any).plan } });
  assert.equal((unconfirmedExecution.value as any).status, 'confirmation_required');
  const tablePlan = (await registry.execute({ id: 'table-plan', name: 'Recipe', arguments: {
    operation: 'plan', recipeId: 'table.to_spreadsheet', command: 'Export the selected table',
    objects: [{ id: 'table', kind: 'table', content: 'name,value\na,1' }],
  } })).value as { plan: Record<string, unknown> };
  const otherPlan = (await registry.execute({ id: 'other-plan', name: 'Recipe', arguments: {
    operation: 'plan', recipeId: 'table.to_spreadsheet', command: 'Export another table',
    objects: [{ id: 'other', kind: 'table', content: 'name,value\nb,2' }],
  } })).value as { plan: Record<string, unknown> };
  const approvedArgs = { operation: 'execute', plan: tablePlan.plan };
  assert.equal(tablePlan.plan.requiresConfirmation, true);
  assert.equal(registry.effect('Recipe', approvedArgs), 'local_irreversible');
  assert.equal(registry.effect('Recipe', { operation: 'execute', plan: { risk: 'read', requiresConfirmation: true } }), 'read');
  const requestId = 'recipe-approval';
  await session.append('permission/requested', { requestId, pendingInput: {
    requestId, kind: 'permission', tool: 'Recipe', question: 'Allow Recipe?', options: ['仅这一次允许', '本会话总是允许 Recipe', '拒绝'],
    harnessPermission: true, action: { tool: 'Recipe', arguments: approvedArgs },
  } });
  await session.answer(requestId, { decision: 'grant' });
  const mismatched = await registry.execute({ id: `approval-${requestId}`, name: 'Recipe', arguments: { operation: 'execute', plan: otherPlan.plan } });
  assert.equal((mismatched.value as any).status, 'confirmation_required');
  await session.append('operation/prepared', { operationId: 'recipe-approved', callId: `approval-${requestId}`, name: 'Recipe', arguments: approvedArgs, effect: 'local_irreversible', dispatched: true });
  const approved = await registry.execute({ id: `approval-${requestId}`, name: 'Recipe', arguments: approvedArgs });
  assert.equal((approved.value as any).status, 'succeeded');
  assert.match(await readFile((approved.value as any).output.artifact, 'utf8'), /"a","1"/);
  await session.append('operation/settled', { operationId: 'recipe-approved', outcome: 'succeeded', message: {
    role: 'tool', tool_call_id: `approval-${requestId}`, name: 'Recipe', content: JSON.stringify(approved.value), origin: 'data',
  } });
  const staleRequestId = 'recipe-stale';
  const staleArgs = { operation: 'execute', plan: otherPlan.plan };
  await session.append('permission/requested', { requestId: staleRequestId, pendingInput: {
    requestId: staleRequestId, kind: 'permission', tool: 'Recipe', question: 'Allow Recipe?', options: ['仅这一次允许', '本会话总是允许 Recipe', '拒绝'],
    harnessPermission: true, action: { tool: 'Recipe', arguments: staleArgs },
  } });
  await session.answer(staleRequestId, { decision: 'once' });
  await session.append('permission/cancelled', { requestIds: [staleRequestId] });
  const stale = await registry.execute({ id: `approval-${staleRequestId}`, name: 'Recipe', arguments: staleArgs });
  assert.equal((stale.value as any).status, 'confirmation_required');
  const waiting = await runAgent({ root, userDataDir, session, registry, instruction: 'Export another table', emergencyFuse: 2,
    model: async () => ({ text: '', tool_calls: [{ id: 'another-execution', name: 'Recipe', arguments: staleArgs }] }) });
  assert.equal(waiting.reason, 'awaiting_user');
  assert.equal(session.pendingInput()?.requestId, 'another-execution');
});

test('MCP lazy discovery invokes an actual JSONL server and keeps colliding tool names distinct', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mp-mcp-')), file = path.join(directory, 'server.cjs');
  await writeFile(file, `require('readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(!r.id)return;const result=r.method==='initialize'?{}:r.method==='tools/list'?{tools:[{name:'a-b',inputSchema:{type:'object',properties:{}}},{name:'a_b',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:'actual child'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')});`);
  const registry = new ToolRegistry(), close = registerMcpDiscovery(registry, [{ name: 'fixture', command: process.execPath, args: [file] }]);
  try { const context = { signal: new AbortController().signal, tool_call_id: 'discover' }; const result = await registry.get('mcp_search').execute({ query: 'fixture' }, context) as { tools: { name: string }[] };
    assert.equal(result.tools.length, 2); assert.notEqual(result.tools[0].name, result.tools[1].name);
    assert.equal((await registry.get(result.tools[0].name).execute({}, context) as { text: string }).text, 'actual child');
  } finally { close(); }
});

test('review completion and historical trace replay preserve the intended session and recorded evidence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mp-review-')), store = new ReviewSessionStore(directory);
  const snapshot = { snapshot_id: 'frozen', context: { content: 'historical selection', artifacts: {} }, source_window: { hwnd: 1 } };
  const first = await store.record(snapshot, 'first'); await store.finish(first.session_id); const second = await store.record(snapshot, 'second');
  await store.finish(first.session_id); assert.equal((await store.active())!.session_id, second.session_id);
  const traceDirectory = path.join(directory, 'trace'); await recordSnapshot(traceDirectory, snapshot); const trace = await loadTrace(traceDirectory), payload = await tracePayload(traceDirectory, trace);
  assert.equal(payload.selectionSnapshot.context.content, 'historical selection'); assert.equal(payload.selectionSnapshot.capture_attestation.status, 'replay');
});
