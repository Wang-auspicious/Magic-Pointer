import { createHash, randomUUID } from 'node:crypto';
import { stat, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runAgent, registerAgentTools, compactSession, buildSystemPrompt, HookManager, type AgentEvent, type AgentOptions, type PermissionMode } from './agent';
import { registerCodingTools } from './agent_files';
import { registerSubagentTools } from './agent_background';
import { contextWindowFor, registerMemoryTools, registerSkillTools, registerWebTools, registerWaitTool, registerToolResultReader, initialToolNames, directoryPayload, expandSkillCommand, suggestNextPrompt } from './agent_services';
import { bootPlugins, extensionPaths, loadHarnessPatch, PromptSections, modelPlugins, type RuntimePlugin } from './agent_plugins';
import { RuntimeActivitySink } from './agent_activity';
import { EventSession } from './session';
import { ToolRegistry } from './tools';
import { resolveModelConfig, streamModel, requestVision } from './model';
import { prepareTaskContext } from './context_prepare';
import { configureDesktop, closeDesktop, registerDesktopTools, desktopSession, listWindows, listElements } from './desktop';
import { registerPerceptionTools, registerLookTool, createSnapshotPerceptionBackend, closeOcr, type PerceptionBackend, type VisionBackend } from './desktop_perception';
import { registerSelectionQuickTools } from './selection_quick_tools';
import { readMcpConfigs, registerMcpDiscovery } from './mcp';
import { settingsStore } from './model_admin';
import { Fabric, registerRecipeTools } from './fabric';
import { ScreenMemory } from './context_memory';

export type Data = Record<string, any>;
export interface RuntimeOptions { root: string; userDataDir: string; signal?: AbortSignal; onEvent?: (event: AgentEvent) => void; onProgress?: (phase: string, fields: Data) => void }
const presets: Record<string, PermissionMode> = { auto: 'accept_reversible', plan: 'plan', 'read-only': 'safe', 'workspace-write': 'default', 'danger-full-access': 'bypass' };

export function resolveSessionId(payload: Data): string {
  const explicit = String(payload.agentSessionId || payload.sessionId || '').trim();
  if (/^agent-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(explicit) || /^(agent-studio-conv-|agent-studio-new-)[A-Za-z0-9._-]+$/.test(explicit) && explicit.length <= 128) return explicit;
  if (payload.conversationId) return `agent-studio-conv-${createHash('sha256').update(String(payload.conversationId).trim()).digest('hex').slice(0, 32)}`;
  return `agent-studio-new-${randomUUID().replaceAll('-', '')}`;
}

function learningReview(payload: Data, options: RuntimeOptions): void {
  const child = spawn(process.execPath, [path.join(__dirname, 'worker.js'), 'learning_review'], { windowsHide: true, detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MAGIC_POINTER_USER_DATA_DIR: options.userDataDir } });
  child.on('error', () => {}); child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ ...payload, root: options.root })); child.unref();
}

export async function runRuntime(payload: Data, options: RuntimeOptions): Promise<Data> {
  const started = performance.now(), { root, userDataDir, signal } = options;
  const preset = String(payload.permissionPreset || 'workspace-write'), permissionMode = presets[preset];
  if (!permissionMode) throw new Error(`Unknown permission preset: ${preset}`);
  const config = resolveModelConfig({ ...payload.modelRuntime, effort: payload.effort || payload.modelRuntime?.effort || 'high' }, root, userDataDir);
  const envContextTokens = Number(process.env.MAGIC_POINTER_CONTEXT_TOKENS);
  const contextTokens = Number.isFinite(envContextTokens) && envContextTokens > 0 ? Math.trunc(envContextTokens) : config.defaultContextWindow || contextWindowFor(config.model);
  if (payload.operation === 'suggest_next') return { ok: true, suggestion: await suggestNextPrompt(streamModel, { root, userDataDir, config, signal }, JSON.stringify({ turns: payload.turns || [], object: payload.object || {} })) };
  let instruction = String(payload.question || payload.instruction || '').trim();
  if (!instruction && !payload.inputResponse && !payload.resume) throw new Error('问题不能为空。');
  if ([...instruction].length > 12000) throw new Error('问题最多 12000 字。');
  const workspaceState = path.join(userDataDir, 'workspace.txt');
  const savedWorkspace = (await readFile(workspaceState, 'utf8').catch(() => '')).trim();
  const validSavedWorkspace = savedWorkspace && await stat(savedWorkspace).then(info => info.isDirectory(), () => false) ? savedWorkspace : undefined;
  const selectedWorkspace = String(payload.workspaceRoot ?? '').trim();
  const workspace = Object.hasOwn(payload, 'workspaceRoot')
    ? (selectedWorkspace ? path.resolve(selectedWorkspace) : undefined)
    : validSavedWorkspace;
  if (workspace && !(await stat(workspace)).isDirectory()) throw new Error('Workspace must be an existing directory');
  const session = await EventSession.open(userDataDir, resolveSessionId(payload));
  const sink = new RuntimeActivitySink((phase, fields) => options.onProgress?.(phase, fields), { model: config.model, apiMode: config.apiMode });
  const onEvent = (event: AgentEvent) => { sink.onEvent(event); options.onEvent?.(event); };
  const registry = new ToolRegistry(), hooks = new HookManager();
  configureDesktop(root);
  let files: ReturnType<typeof registerCodingTools> | undefined;
  const contextTools = new ToolRegistry();
  const prepared = await prepareTaskContext(session, { ...payload, workspacePath: workspace || '' }, { root, userDataDir, registry: contextTools });
  const settings = settingsStore(userDataDir).load();
  const extensions = extensionPaths(userDataDir);
  const prompt = new PromptSections();
  const selectionSnapshot = payload.selectionSnapshot || payload.object?.selectionSnapshot || {};
  const perception = createSnapshotPerceptionBackend(selectionSnapshot);
  const vision: VisionBackend = (images, prompt, signal) => requestVision(config, { images, prompt, signal, timeoutMs: 30000 });
  const perceptionOptions = { snapshot: selectionSnapshot, uploadScreenshots: settings.privacy.upload_screenshots !== false,
    sources: (id: string) => prepared.taskContext.sources?.find((source: Data) => source.sourceId === id),
    windowReadScope: (hwnd: number) => prepared.authorizeAccess({ action: 'read', windowIds: [`w-${hwnd}`] }).allowed };
  const builtins: RuntimePlugin[] = [
    { name: 'harness-tools', apply: ctx => registerAgentTools(ctx.get('tools'), session, onEvent) },
    { name: 'tool-result-reader', apply: ctx => registerToolResultReader(ctx.get('tools'), session) },
    { name: 'coding-tools', apply: ctx => { if (workspace) files = registerCodingTools(ctx.get('tools'), workspace, session); } },
    { name: 'memory-tools', apply: ctx => registerMemoryTools(ctx.get('tools'), userDataDir, session) },
    { name: 'context-tools', apply: ctx => { const tools = ctx.get<ToolRegistry>('tools'); for (const tool of contextTools.list()) if (!tools.list().some(existing => existing.name === tool.name)) tools.register(tool); } },
    { name: 'skill-writer', apply: ctx => { if (workspace) registerSkillTools(ctx.get('tools'), userDataDir); } },
    { name: 'web-tools', apply: ctx => registerWebTools(ctx.get('tools')) },
    { name: 'wait-tools', apply: ctx => registerWaitTool(ctx.get('tools'), { workspace,
      windows: async () => (await listWindows(signal)).filter(window => perceptionOptions.windowReadScope(window.hwnd)),
      elements: async hwnd => perceptionOptions.windowReadScope(hwnd) ? listElements(hwnd, signal) : [] }) },
    { name: 'desktop-action-tools', apply: ctx => registerDesktopTools(ctx.get('tools'), desktopSession(session.id, Number(payload.object?.hwnd || payload.object?.windowHwnd || 0) || undefined), prepared.authorizeAccess) },
    { name: 'local-action-tools', apply: ctx => registerRecipeTools(ctx.get('tools'), new Fabric(options, config), session) },
    { name: 'selection-quick-tools', apply: ctx => { const snapshot = payload.selectionSnapshot || payload.object?.selectionSnapshot; if (snapshot) registerSelectionQuickTools(ctx.get('tools'), snapshot); } },
    { name: 'perception-provider', apply: ctx => ctx.provideUp('perception', perception) },
    { name: 'vision-provider', apply: ctx => ctx.provideUp('vision', vision) },
    { name: 'perception-tools', inject: ['tools', 'perception'], apply: ctx => registerPerceptionTools(ctx.get('tools'), { ...perceptionOptions, backend: ctx.get<PerceptionBackend>('perception'),
      vision: (images, prompt, signal) => ctx.has('vision') ? ctx.get<VisionBackend>('vision')(images, prompt, signal) : Promise.resolve({ text: '', usedBackend: 'vision_unavailable' }) }) },
    { name: 'look-tool', inject: ['tools', 'vision'], apply: ctx => registerLookTool(ctx.get('tools'), { ...perceptionOptions, vision: ctx.get<VisionBackend>('vision') }) },
    { name: 'mcp-provider', defaults: { config_path: extensions.mcp }, apply: (ctx, cfg) => { ctx.effect(registerMcpDiscovery(ctx.get('tools'), readMcpConfigs(String(cfg.config_path)))); } },
    { name: 'system-prompt', apply: ctx => { ctx.get<PromptSections>('prompt').add({ id: 'default', order: 0, render: buildSystemPrompt }); } },
    { name: 'delegate-tool', apply: ctx => { if (workspace) registerSubagentTools(ctx.get('tools'), { root, userDataDir, workspace, session, config, permissionMode, onEvent,
      allowedTools: payload.permissionGrants || [], deniedTools: payload.permissionDenials || [], maxTokens: config.defaultMaxTokens || 32768, contextTokens }); } },
    ...modelPlugins(streamModel),
  ];
  const plugins = await bootPlugins({ directory: extensions.plugins, patch: await loadHarnessPatch(extensions.patch), scope: 'agent', builtins, rows: builtins.map(plugin => ({ id: plugin.name, plugin: plugin.name })), core: { tools: registry, session, hooks, prompt, runtime: options } });
  registry.setInitialTools(initialToolNames({ workspace, taskContext: prepared.taskContext, selectionSnapshot: payload.selectionSnapshot || payload.snapshot || payload.object?.selectionSnapshot,
    object: payload.object, permissionMode }));
  let accepted: Data | null = null;
  try {
    if (payload.inputResponse) {
      const response = payload.inputResponse, requestId = String(response.requestId || response.request_id || '');
      const answered = await session.answer(requestId, response.response || response);
      accepted = answered.data; instruction = '';
      options.onProgress?.('user_input_accepted', { b64: Buffer.from(JSON.stringify(accepted)).toString('base64') });
    }
    const common: AgentOptions = { root, userDataDir, session, registry, instruction, evidence: prepared.evidence,
      hasSelection: Boolean(selectionSnapshot.frameLease || selectionSnapshot.frameLeaseId || prepared.taskContext.references?.some((reference: Data) => reference.active && reference.frameLeaseId)),
      model: request => plugins.context.get<AgentOptions['model']>('model_client')(request), config, workspace, permissionMode, signal, onEvent, hooks,
      allowedTools: payload.permissionGrants || [], deniedTools: payload.permissionDenials || [], onceTools: Array.isArray(payload.permissionGrantOnce) ? payload.permissionGrantOnce.map(String).map((rule: string) => rule.trim()).filter(Boolean) : [], contextTokens,
      maxTokens: config.defaultMaxTokens || 32768, authorizeAccess: prepared.authorizeAccess, metadata: { conversationId: payload.conversationId || '', object: payload.object || {} } };
    common.system = await prompt.build(common);
    const command = /^\/(help|compact|permission|model|cwd|rewind)(?:\s+([\s\S]*))?$/.exec(instruction);
    if (command) {
      const name = command[1], rest = (command[2] || '').trim();
      if (name === 'help') return { ok: true, answer: JSON.stringify({ ...await directoryPayload(workspace, userDataDir), plugins: plugins.dumpConfig(), warnings: plugins.warnings }, null, 2), command: { type: name }, agentSessionId: session.id, usedBackend: 'runtime.slash_help' };
      if (name === 'compact') { const compacted = await compactSession(common, common.system, signal || new AbortController().signal, true); return { ok: compacted, answer: compacted ? '已压缩任务上下文。' : '当前上下文未压缩。', command: { type: name }, agentSessionId: session.id, usedBackend: 'runtime.compaction' }; }
      if (name === 'permission') { if (rest && !presets[rest]) throw new Error('Unknown permission preset'); return { ok: true, command: { type: name, preset: rest || preset }, permissionPreset: rest || preset, answer: rest ? `权限预设：${rest}` : Object.keys(presets).join(' · ') }; }
      if (name === 'model') return { ok: true, command: { type: name, value: rest }, answer: config.model };
      if (name === 'cwd') {
        if (!rest) return { ok: true, command: { type: name }, answer: workspace || '未绑定工作区。' };
        const raw = rest.replace(/^"(.*)"$/, '$1'), target = path.resolve(raw === '~' ? os.homedir() : raw.startsWith('~/') || raw.startsWith('~\\') ? path.join(os.homedir(), raw.slice(2)) : raw);
        if (!(await stat(target)).isDirectory()) throw new Error('Workspace must be an existing directory');
        await mkdir(path.dirname(workspaceState), { recursive: true }); await writeFile(workspaceState, target, 'utf8');
        return { ok: true, command: { type: name, path: target }, answer: `工作区已切换为 ${target}，下一次发送即生效。` };
      }
      if (name === 'rewind') { if (!files) throw new Error('未绑定工作区。'); const result = await files.rewind(rest ? Number(rest) : 0); return { ok: true, command: { type: name }, answer: JSON.stringify(result), result }; }
    }
    instruction = await expandSkillCommand(instruction, workspace, userDataDir);
    if (session.deriveMessages().length === 0 && payload.turns?.length) await session.appendMessage({ role: 'user', origin: 'data', injected: true, content: `[旧对话首次迁移]\n${JSON.stringify(payload.turns)}` });
    await session.append('runtime/effort', { effort: config.effort });
    const terminal = await runAgent({ ...common, instruction, evidence: prepared.evidence });
    sink.flush();
    const successful = ['completed', 'awaiting_user'].includes(terminal.reason);
    const plan = [...session.events].reverse().find(event => event.type === 'plan/updated')?.data || null;
    const result = { ok: successful, answer: terminal.message, error: successful ? undefined : terminal.message, loopTerminated: !successful, loopTerminatedReason: successful ? undefined : terminal.reason,
      usedBackend: terminal.usedBackend, permissionPreset: preset, receipts: [terminal.receipt], events: terminal.results, activities: sink.activities, trajectory: sink.trajectory,
      modelUsage: terminal.model_usage, timingMs: performance.now() - started, agentSessionId: session.id, hasPendingWork: terminal.reason !== 'completed' || terminal.receipt.status !== 'succeeded', pluginReport: { rows: plugins.dumpConfig(), warnings: plugins.warnings },
      interactionLedger: session.events.filter(event => event.type.startsWith('interaction/') || event.type === 'receipt/issued').map(event => event.data),
      awaitingUserInput: terminal.reason === 'awaiting_user', pendingInput: terminal.pending_input, taskContext: prepared.taskContext, artifacts: prepared.artifacts,
      runtimeTurn: [...session.events].reverse().find(event => event.type === 'turn/end')?.data.turn ?? null, plan,
      thinking: sink.trajectory.filter(item => item.kind === 'message').map(item => item.reasoning || '').join(''), ...(accepted ? { accepted: true, inputAnswer: accepted } : {}) };
    if (settings.privacy.screen_memory_enabled === true && terminal.reason === 'completed' && (payload.selectionSnapshot || payload.snapshot)) {
      const snapshot = payload.selectionSnapshot || payload.snapshot;
      const context = snapshot.context || {};
      const window = snapshot.source_window || context.window || {};
      const originalCommand = String(payload.command || payload.question || payload.instruction || '');
      const reference = (prepared.inputArtifact.references as Data[] || []).find(item => item?.sourceId && item?.locator);
      const sensitive = /密码|口令|验证码|密钥|secret|password|token|sk-[A-Za-z0-9]/i.test(`${originalCommand}\n${terminal.message}`);
      try {
        await new ScreenMemory(path.join(userDataDir, 'screen-memory.json'), true).record({
          app: String(context.app || ''), windowTitle: String(window.title || ''), excerpt: originalCommand,
          sourceId: reference?.sourceId || null, locator: reference?.locator || null, sensitive,
        });
      } catch (error) {
        options.onProgress?.('screen_memory_error', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (settings.privacy.background_learning_enabled === true && ['completed', 'stalled', 'invariant_failed', 'budget_exhausted'].includes(terminal.reason)) learningReview({ sessionId: session.id, terminalReason: terminal.reason, modelRuntime: config }, options);
    return result;
  } finally { sink.flush(); try { await registry.close(); } finally { try { await plugins.close(); } finally { closeOcr(); closeDesktop(); } } }
}
