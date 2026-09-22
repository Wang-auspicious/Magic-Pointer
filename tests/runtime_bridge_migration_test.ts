import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { streamModel, modelPayload, requestVision, resolveModelConfig, type ModelConfig } from '../electron/runtime/model';
import { handleModels } from '../electron/runtime/model_admin';
import { MagicPointerMcpServer, buildHookResponse } from '../electron/runtime/connectors';
import { Fabric } from '../electron/runtime/fabric';
import { ToolRegistry } from '../electron/runtime/tools';
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
