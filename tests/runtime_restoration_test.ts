import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventSession } from '../electron/runtime/session';
import { ToolRegistry } from '../electron/runtime/tools';
import { registerCodingTools } from '../electron/runtime/agent_files';
import { runAgent } from '../electron/runtime/agent';
import { captureSnapshot } from '../electron/runtime/desktop_perception';
import { SurfaceAdapterRegistry } from '../electron/runtime/desktop_adapters';
import { runRuntime } from '../electron/runtime/index';
import { bootPlugins, PluginContext } from '../electron/runtime/agent_plugins';
import { extensionsInventory, registerToolResultReader } from '../electron/runtime/agent_services';
import { handleFabric } from '../electron/runtime/fabric_api';
import { describeDeliveryFailure } from '../electron/runtime/actions_delivery';
import { runBackgroundAgent, readAgentStatus } from '../electron/runtime/agent_background';
import { settingsStore } from '../electron/runtime/model_admin';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-restoration-'));
  const workspace = path.join(root, 'workspace'), userData = path.join(root, 'user');
  await mkdir(workspace, { recursive: true });
  const session = await EventSession.open(userData, 'restoration');
  const registry = new ToolRegistry(); registerCodingTools(registry, workspace, session);
  return { root, workspace, userData, session, registry };
}

test('large tool results remain in the session and can be read by call id', async () => {
  const f = await fixture(); let step = 0;
  registerToolResultReader(f.registry, f.session);
  const content = 'retained-start\n' + 'x'.repeat(70000);
  f.registry.register({ name: 'LargeEvidence', description: 'Evidence fixture', effect: 'read',
    input_schema: { type: 'object', properties: {}, required: [] }, execute: () => content });
  const result = await runAgent({ root: f.root, userDataDir: f.userData, workspace: f.workspace,
    session: f.session, registry: f.registry, instruction: 'Read the complete evidence', system: 'Test',
    model: async request => {
      if (++step === 1) return { text: '', tool_calls: [{ id: 'large', name: 'LargeEvidence', arguments: {} }] };
      if (step === 2) {
        assert.match(request.messages.at(-1)!.content!, /ToolResult\.read/);
        return { text: '', tool_calls: [{ id: 'read', name: 'ToolResult.read', arguments: { tool_call_id: 'large', offset: 0, limit: 200 } }] };
      }
      return { text: 'Read back', tool_calls: [] };
    } });
  assert.equal(result.results[1].is_error, false, result.results[1].error_message);
  assert.match(String(result.results[1].value), /retained-start/);
  const message = f.session.events.find(event => event.type === 'operation/settled')?.data.message as { content: string };
  assert.equal(message.content, content);
});

test('production Runtime honors a disabled user plugin in harness.patch.json', async () => {
  const f = await fixture(), folder = path.join(f.userData, 'data', 'plugins', 'example');
  const marker = path.join(f.root, 'executed');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'plugin.json'), '{}');
  await writeFile(path.join(folder, 'plugin.js'), `module.exports={name:'example',apply(){require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')}}`);
  await writeFile(path.join(f.userData, 'data', 'harness.patch.json'), JSON.stringify({ schemaVersion: 1, patch: { 'user:example': { disabled: true } } }));
  await runRuntime({ question: '/help', workspaceRoot: f.workspace }, { root: f.root, userDataDir: f.userData });
  assert.equal(await stat(marker).then(() => true, () => false), false);
});

test('an explicitly projectless task does not inherit the last coding workspace', async () => {
  const f = await fixture();
  await writeFile(path.join(f.userData, 'workspace.txt'), f.workspace);
  const projectless = await runRuntime({ question: '/cwd', workspaceRoot: '' }, { root: f.root, userDataDir: f.userData });
  assert.equal(projectless.answer, '未绑定工作区。');
  const defaulted = await runRuntime({ question: '/cwd' }, { root: f.root, userDataDir: f.userData });
  assert.equal(defaulted.answer, f.workspace);
});

test('Glob and Grep respect nested ignore files and explicit reinclusion', async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace, '.gitignore'), 'ignored/\n*.log\n!keep.log\n');
  await mkdir(path.join(f.workspace, 'ignored')); await mkdir(path.join(f.workspace, 'nested'));
  await writeFile(path.join(f.workspace, 'nested', '.gitignore'), 'local.txt\n');
  for (const file of ['ignored/a.txt', 'nested/local.txt', 'visible.txt', 'keep.log', 'hidden.log'])
    await writeFile(path.join(f.workspace, file), 'needle');
  const glob = await f.registry.execute({ id: 'glob', name: 'Glob', arguments: { pattern: '**/*.txt' } });
  assert.deepEqual((glob.value as { files: string[] }).files, ['visible.txt']);
  const grep = await f.registry.execute({ id: 'grep', name: 'Grep', arguments: { pattern: 'needle', output_mode: 'files_with_matches' } });
  assert.deepEqual((grep.value as { matches: string[] }).matches.sort(), ['keep.log', 'visible.txt']);
});

async function plugin(f: Awaited<ReturnType<typeof fixture>>, source: string, patch: object = {}) {
  const folder = path.join(f.userData, 'data', 'plugins', 'fixture');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'plugin.json'), JSON.stringify({ main: 'entry.cjs' }));
  await writeFile(path.join(folder, 'entry.cjs'), source);
  await writeFile(path.join(f.userData, 'data', 'harness.patch.json'), JSON.stringify({ schemaVersion: 1, patch }));
}

test('selection Runtime records screen memory only when the setting is enabled', async () => {
  const f = await fixture();
  await plugin(f, `module.exports={name:'provider',async apply(ctx){await ctx.provideUp('llm',async()=>({text:'handled',tool_calls:[]}))}}`, { 'llm-provider': { disabled: true } });
  const store = settingsStore(f.userData), settings = store.load();
  settings.privacy.screen_memory_enabled = true; store.save(settings);
  const snapshot = { snapshot_id: 'selection-memory', context: { app: 'notepad', content: 'Selected text' }, source_window: { title: 'Notes' } };
  const options = { root: f.root, userDataDir: f.userData };
  await runRuntime({ question: 'Remember this selection', selectionSnapshot: snapshot }, options);
  const memoryPath = path.join(f.userData, 'screen-memory.json');
  const first = JSON.parse(await readFile(memoryPath, 'utf8'));
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].excerpt, 'Remember this selection');
  settings.privacy.screen_memory_enabled = false; store.save(settings);
  await runRuntime({ question: 'Do not retain this', selectionSnapshot: snapshot }, options);
  assert.equal(JSON.parse(await readFile(memoryPath, 'utf8')).entries.length, 1);
  settings.privacy.screen_memory_enabled = true; store.save(settings);
  await runRuntime({ question: 'My password is 123', selectionSnapshot: snapshot }, options);
  assert.equal(JSON.parse(await readFile(memoryPath, 'utf8')).entries.length, 1);
});

test('Runtime compacts a long task at the active model window', async () => {
  const f = await fixture();
  await plugin(f, `module.exports={name:'provider',async apply(ctx){await ctx.provideUp('llm',async request=>({text:request.system.includes('为下个上下文窗口写交接摘要')?'Retain the task':'Task complete',tool_calls:[]}))}}`, { 'llm-provider': { disabled: true } });
  const sessionId = 'agent-studio-new-context-budget', session = await EventSession.open(f.userData, sessionId);
  for (let index = 0; index < 4; index++) await session.appendMessage({ role: index % 2 ? 'assistant' : 'user', content: `Historical evidence ${index}: ` + 'x'.repeat(55000) });
  const events: string[] = [];
  const result = await runRuntime({ question: 'Finish the ongoing task', agentSessionId: sessionId, modelRuntime: { model: 'fixture-unknown', credential: 'fixture' } },
    { root: f.root, userDataDir: f.userData, onEvent: event => events.push(event.kind) });
  assert.equal(result.ok, true, result.error);
  assert(events.includes('context_compacted'));
  const previous = process.env.MAGIC_POINTER_CONTEXT_TOKENS;
  process.env.MAGIC_POINTER_CONTEXT_TOKENS = '2048';
  try {
    const overrideId = 'agent-studio-new-context-override', override = await EventSession.open(f.userData, overrideId);
    for (let index = 0; index < 4; index++) await override.appendMessage({ role: index % 2 ? 'assistant' : 'user', content: `Previous step ${index}: ` + 'y'.repeat(4000) });
    const overrideEvents: string[] = [];
    const overrideResult = await runRuntime({ question: 'Continue', agentSessionId: overrideId, modelRuntime: { model: 'fixture-unknown', credential: 'fixture' } },
      { root: f.root, userDataDir: f.userData, onEvent: event => overrideEvents.push(event.kind) });
    assert.equal(overrideResult.ok, true, overrideResult.error);
    assert(overrideEvents.includes('context_compacted'));
  } finally {
    if (previous === undefined) delete process.env.MAGIC_POINTER_CONTEXT_TOKENS;
    else process.env.MAGIC_POINTER_CONTEXT_TOKENS = previous;
  }
});

test('text delivery distinguishes refusal before writing from an unverified write', () => {
  const refused = describeDeliveryFailure('Target is not an editable input surface');
  assert.equal(refused.reasonCode, 'not_an_input_surface');
  assert.equal(refused.writeAttempted, false);
  const uncertain = describeDeliveryFailure('Write could not be verified');
  assert.equal(uncertain.reasonCode, 'write_not_verifiable');
  assert.equal(uncertain.writeAttempted, true);
  assert.notEqual(refused.message, uncertain.message);
});

test('workspace Runtime exposes skill saving and disabling builtin web tools reaches the real registry', async () => {
  const f = await fixture(), marker = path.join(f.root, 'tools.json');
  await plugin(f, `module.exports={name:'inspect',inject:['tools','prompt'],apply(ctx){ctx.get('prompt').add({id:'inspect',render(){require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify(ctx.get('tools').list().map(t=>t.name)));return ''}})}}`, { 'web-tools': { disabled: true }, 'context-tools': { disabled: true }, 'delegate-tool': { disabled: true } });
  await runRuntime({ question: '/help', workspaceRoot: f.workspace }, { root: f.root, userDataDir: f.userData });
  const names = JSON.parse(await readFile(marker, 'utf8')) as string[];
  assert.ok(names.includes('SaveSkill'), 'SaveSkill must be reachable in a workspace');
  assert.ok(!names.includes('Search'), 'disabled web tools must not be registered');
  assert.ok(!names.includes('Context.read'), 'disabled context tools must not be registered');
  assert.ok(!names.includes('Agent'), 'disabled delegation must not be registered');
  await runRuntime({ question: '/help' }, { root: f.root, userDataDir: f.userData });
  assert.ok(!JSON.parse(await readFile(marker, 'utf8')).includes('SaveSkill'), 'desktop-only scope must not expose skill writes');
});

test('plugin provider and prompt sections reach a real Runtime turn', async () => {
  const f = await fixture();
  await plugin(f, `module.exports={name:'provider',inject:['prompt'],async apply(ctx){ctx.get('prompt').add({id:'fixture',render:options=> options.evidence.includes('source evidence')?'RESTORED_PROMPT':'missing-evidence'});await ctx.provideUp('llm',async request=>({text:request.system.includes('RESTORED_PROMPT')?'provider-and-prompt-restored':'missing-prompt',tool_calls:[]}))}}`, { 'llm-provider': { disabled: true } });
  const result = await runRuntime({ question: 'Answer the fixture', workspaceRoot: f.workspace, modelRuntime: { model: 'fixture', baseUrl: 'http://127.0.0.1:1', credential: 'fixture' } }, { root: f.root, userDataDir: f.userData, signal: AbortSignal.timeout(10000) });
  assert.equal(result.answer, 'provider-and-prompt-restored');
  assert.equal(result.loopTerminated, false, 'normal completion must not be rendered as failure');
  assert.ok(!result.loopTerminatedReason);
  const inventory = await extensionsInventory(f.userData);
  assert.equal((inventory.plugins as { items: { status: string }[] }).items[0].status, 'configured');
  const apiInventory = await handleFabric({ operation: 'extensions.inventory' }, { root: f.root, userDataDir: f.userData });
  assert.equal(apiInventory.plugins.items[0].status, 'configured');
});

test('independent child Runtime uses the same installed provider and prompt extensions', async () => {
  const f = await fixture(), child = await EventSession.open(f.userData, 'child', true, f.session.id);
  await plugin(f, `module.exports={name:'child-provider',inject:['prompt'],async apply(ctx){ctx.get('prompt').add({id:'child-marker',render:()=> 'CHILD_EXTENSION'});await ctx.provideUp('llm',async request=>({text:request.system.includes('CHILD_EXTENSION')?'child-restored':'missing-child-prompt',tool_calls:[]}))}}`, { 'llm-provider': { disabled: true } });
  await writeFile(path.join(f.userData, 'agent-sessions', 'child.agent.json'), JSON.stringify({ id: child.id, status: 'starting', startedAt: Date.now() }));
  await runBackgroundAgent({ root: f.root, userDataDir: f.userData, workspace: f.workspace, sessionId: child.id, parentId: f.session.id, instruction: 'Answer', readonly: true, permissionMode: 'safe', parentCallId: 'delegate', config: { model: 'fixture', baseUrl: 'http://127.0.0.1:1' } });
  assert.equal((await readAgentStatus(f.userData, child.id))!.summary, 'child-restored');
  await f.session.refresh();
  assert.ok(f.session.pendingInbox('next-step').some(item => String(item.text).includes('child-restored')));
});

test('direct plugin tool registration is removed on unload', async () => {
  const context = new PluginContext(), registry = new ToolRegistry();
  const report = await bootPlugins({ context, directory: '', core: { tools: registry }, builtins: [{ name: 'owned', apply(ctx) { ctx.get<ToolRegistry>('tools').register({ name: 'Owned', description: 'Owned tool', input_schema: { type: 'object', properties: {}, required: [] }, execute: () => 'owned' }); } }], rows: [{ id: 'owned', plugin: 'owned' }] });
  assert.equal((await registry.execute({ id: 'owned', name: 'Owned', arguments: {} })).value, 'owned');
  await report.unmount('owned');
  assert.throws(() => registry.get('Owned'), /Unknown tool/);
  await report.close();
});

test('slash permission returns the preset consumed by the composer', async () => {
  const f = await fixture();
  const result = await runRuntime({ question: '/permission plan' }, { root: f.root, userDataDir: f.userData });
  assert.equal(result.command.preset, 'plan');
});

test('cwd persists the selected directory for the next task', async () => {
  const f = await fixture();
  const result = await runRuntime({ question: `/cwd ${f.workspace}` }, { root: f.root, userDataDir: f.userData });
  assert.equal(result.command.path, f.workspace);
  const nextInstallRoot = path.join(f.root, 'next-install');
  await mkdir(nextInstallRoot);
  const next = await runRuntime({ question: '/cwd' }, { root: nextInstallRoot, userDataDir: f.userData });
  assert.equal(next.answer, f.workspace);
});

test('surface scope excludes agent plugins, rejects invalid config, and unloads registered adapters', async () => {
  const f = await fixture(); let called = false;
  const adapters = new SurfaceAdapterRegistry();
  await plugin(f, `module.exports={name:'agent-only',apply(){throw Error('must not activate in surface scope')}}`);
  const report = await bootPlugins({ directory: path.join(f.userData, 'data', 'plugins'), scope: 'surface', core: { surface_adapters: adapters },
    builtins: [
      { name: 'surface', scopes: ['surface'], apply(ctx) { ctx.get<typeof adapters>('surface_adapters').register({ id: 'custom', matches: () => true, resolve: async () => ({ content: 'restored' }) }); } },
      { name: 'configured', scopes: ['surface'], config_schema: { type: 'object', properties: { count: { type: 'integer' } }, required: [] }, apply() { called = true; } },
    ], rows: [{ id: 'surface', plugin: 'surface' }, { id: 'configured', plugin: 'configured', config: { count: 'invalid' } }] });
  assert.ok(!report.rows.some(row => row.id === 'user:agent-only'));
  assert.equal(called, false);
  assert.equal(report.rows.find(row => row.id === 'configured')!.status, 'error');
  assert.equal((await adapters.resolve({}))[0].content, 'restored');
  await report.close(); assert.equal(adapters.matching({}).length, 0);
});

test('truncated model output gets bounded additional headroom without executing partial calls', async () => {
  const f = await fixture(), ceilings: number[] = []; let executed = 0;
  f.registry.register({ name: 'Partial', description: 'Must not execute', input_schema: { type: 'object', properties: {}, required: [] }, execute: () => { executed++; } });
  const result = await runAgent({ root: f.root, userDataDir: f.userData, session: f.session, registry: f.registry, instruction: 'Complete', maxTokens: 4096,
    model: async request => { ceilings.push(request.maxTokens!); return ceilings.length <= 3
      ? { text: '', tool_calls: [{ id: 'partial', name: 'Partial', arguments: {} }], stop_reason: 'max_output_tokens' }
      : { text: 'complete', tool_calls: [] }; } });
  assert.equal(result.reason, 'completed'); assert.equal(executed, 0);
  assert.deepEqual(ceilings, [4096, 16384, 64000, 64000]);
});

test('large desktop-only results retain head and tail without offering an inaccessible file', async () => {
  const f = await fixture(), registry = new ToolRegistry();
  registry.register({ name: 'Evidence', description: 'Large desktop evidence', input_schema: { type: 'object', properties: {}, required: [] }, execute: () => 'start-marker' + 'x'.repeat(70000) + 'end-marker' });
  let step = 0;
  const result = await runAgent({ root: f.root, userDataDir: f.userData, session: f.session, registry, instruction: 'Inspect', model: async () => ++step === 1 ? { text: '', tool_calls: [{ id: 'evidence', name: 'Evidence', arguments: {} }] } : { text: 'done', tool_calls: [] } });
  assert.match(String(result.results[0].value), /end-marker/);
  assert.doesNotMatch(String(result.results[0].value), /complete result saved at/);
});

test('multi-file patch preserves Windows newlines when moving a file', async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace, 'source.txt'), 'first\r\nsecond\r\n');
  await f.registry.execute({ id: 'read', name: 'Read', arguments: { path: 'source.txt' } });
  const result = await f.registry.execute({ id: 'patch', name: 'Patch', arguments: { patch: '*** Begin Patch\n*** Update File: source.txt\n*** Move to: moved.txt\n@@\n first\n-second\n+updated\n*** End Patch' } });
  assert.equal(result.is_error, false, result.error_message);
  assert.equal(await readFile(path.join(f.workspace, 'moved.txt'), 'utf8'), 'first\r\nupdated\r\n');
});

test('snapshot entry loads and cleans surface extensions even when capture evidence is invalid', async () => {
  const f = await fixture(), marker = path.join(f.root, 'surface-marker');
  await plugin(f, `module.exports={name:'surface-entry',scopes:['surface'],inject:['surface_adapters'],apply(ctx){require('node:fs').writeFileSync(${JSON.stringify(marker)},'opened');ctx.effect(()=>require('node:fs').appendFileSync(${JSON.stringify(marker)},':closed'))}}`);
  const previous = process.env.MAGIC_POINTER_USER_DATA_DIR; process.env.MAGIC_POINTER_USER_DATA_DIR = f.userData;
  try {
    const result = await captureSnapshot({ frameLease: { localArtifact: { path: path.join(f.root, 'missing.png') } } });
    assert.equal(result.ok, false);
    assert.equal(await readFile(marker, 'utf8'), 'opened:closed');
  } finally { if (previous === undefined) delete process.env.MAGIC_POINTER_USER_DATA_DIR; else process.env.MAGIC_POINTER_USER_DATA_DIR = previous; }
});

test('question pause and answered continuation preserve successful UI state and stream acceptance', async () => {
  const f = await fixture();
  await plugin(f, `module.exports={name:'question-provider',async apply(ctx){await ctx.provideUp('llm',async request=>request.messages.some(m=>(m.content||'').includes('chosen-fixture'))?{text:'continued',tool_calls:[]}:{text:'',tool_calls:[{id:'question',name:'AskUser',arguments:{question:'Choose',options:['A','B']}}]})}}`, { 'llm-provider': { disabled: true } });
  const options = { root: f.root, userDataDir: f.userData }, conversationId = 'question-flow';
  const first = await runRuntime({ question: 'Ask me', conversationId }, options);
  assert.equal(first.awaitingUserInput, true); assert.equal(first.ok, true); assert.equal(first.loopTerminated, false);
  let accepted: Record<string, unknown> | undefined;
  const resumed = await runRuntime({ conversationId, inputResponse: { requestId: first.pendingInput.requestId, response: { answer: 'chosen-fixture' } } }, {
    ...options, onProgress: (phase, fields) => { if (phase === 'user_input_accepted') accepted = JSON.parse(Buffer.from(fields.b64, 'base64').toString('utf8')); },
  });
  assert.equal(accepted?.requestId, 'question'); assert.equal(resumed.answer, 'continued'); assert.equal(resumed.loopTerminated, false);
  const session = await EventSession.open(f.userData, resumed.agentSessionId, false);
  assert.equal(session.pendingInput(), null);
  assert.equal(session.events.filter(event => event.type === 'user_input/answered').length, 1);
});
