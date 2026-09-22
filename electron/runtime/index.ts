import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runAgent, registerAgentTools, compactSession, buildSystemPrompt, HookManager, type AgentEvent, type AgentOptions, type PermissionMode } from './agent';
import { registerCodingTools } from './agent_files';
import { registerSubagentTools } from './agent_background';
import { registerMemoryTools, registerWebTools, directoryPayload, expandSkillCommand, suggestNextPrompt } from './agent_services';
import { bootPlugins } from './agent_plugins';
import { RuntimeActivitySink } from './agent_activity';
import { EventSession } from './session';
import { ToolRegistry } from './tools';
import { resolveModelConfig, streamModel } from './model';
import { prepareTaskContext } from './context_prepare';
import { configureDesktop, closeDesktop, registerDesktopTools, desktopSession } from './desktop';
import { registerPerceptionTools, closeOcr } from './desktop_perception';
import { readMcpConfigs, registerMcpDiscovery } from './mcp';
import { settingsStore } from './model_admin';
import { Fabric, registerRecipeTools } from './fabric';

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
  if (payload.operation === 'suggest_next') return { ok: true, suggestion: await suggestNextPrompt(streamModel, { root, userDataDir, config, signal }, JSON.stringify({ turns: payload.turns || [], object: payload.object || {} })) };
  let instruction = String(payload.question || payload.instruction || '').trim();
  if (!instruction && !payload.inputResponse && !payload.resume) throw new Error('问题不能为空。');
  if ([...instruction].length > 12000) throw new Error('问题最多 12000 字。');
  const workspace = payload.workspaceRoot ? path.resolve(String(payload.workspaceRoot)) : undefined;
  if (workspace && !(await stat(workspace)).isDirectory()) throw new Error('Workspace must be an existing directory');
  const session = await EventSession.open(userDataDir, resolveSessionId(payload));
  const sink = new RuntimeActivitySink((phase, fields) => options.onProgress?.(phase, fields), { model: config.model, apiMode: config.apiMode });
  const onEvent = (event: AgentEvent) => { sink.onEvent(event); options.onEvent?.(event); };
  const registry = new ToolRegistry(), hooks = new HookManager();
  configureDesktop(root); registerAgentTools(registry, session, onEvent);
  const files = workspace ? registerCodingTools(registry, workspace, session) : undefined;
  registerMemoryTools(registry, userDataDir); registerWebTools(registry);
  registerDesktopTools(registry, desktopSession(session.id, Number(payload.object?.hwnd || payload.object?.windowHwnd || 0) || undefined));
  const prepared = await prepareTaskContext(session, payload, { root, userDataDir, registry });
  const settings = settingsStore(userDataDir).load();
  registerRecipeTools(registry, new Fabric(options, config));
  registerPerceptionTools(registry, { snapshot: payload.selectionSnapshot || payload.object?.selectionSnapshot || {}, model: config, uploadScreenshots: settings.privacy.upload_screenshots !== false,
    sources: (id: string) => prepared.taskContext.sources?.find((source: Data) => source.sourceId === id) });
  const closeMcp = registerMcpDiscovery(registry, readMcpConfigs(path.join(userDataDir, 'data', 'mcp.json')));
  const plugins = await bootPlugins({ directory: path.join(userDataDir, 'data', 'plugins'), scope: 'agent', core: { tools: registry, session, hooks, model_client: streamModel, runtime: options } });
  let accepted: Data | null = null;
  try {
    if (payload.inputResponse) {
      const response = payload.inputResponse, requestId = String(response.requestId || response.request_id || '');
      const answered = await session.answer(requestId, response.response || response);
      accepted = answered.data; instruction = '';
      options.onProgress?.('user_input_accepted', { blob: Buffer.from(JSON.stringify(accepted)).toString('base64') });
    }
    const common: AgentOptions = { root, userDataDir, session, registry, model: streamModel, config, workspace, permissionMode, signal, onEvent, hooks,
      allowedTools: payload.permissionGrants || [], deniedTools: payload.permissionDenials || [], contextTokens: config.defaultContextWindow || 128000,
      maxTokens: config.defaultMaxTokens || 32768, authorizeAccess: prepared.authorizeAccess, metadata: { conversationId: payload.conversationId || '', object: payload.object || {} } };
    registerSubagentTools(registry, common);
    const command = /^\/(help|compact|permission|model|cwd|rewind)(?:\s+([\s\S]*))?$/.exec(instruction);
    if (command) {
      const name = command[1], rest = (command[2] || '').trim();
      if (name === 'help') return { ok: true, answer: JSON.stringify(await directoryPayload(workspace, userDataDir), null, 2), command: { type: name }, agentSessionId: session.id, usedBackend: 'runtime.slash_help' };
      if (name === 'compact') { const compacted = await compactSession(common, await buildSystemPrompt(common), signal || new AbortController().signal, true); return { ok: compacted, answer: compacted ? '已压缩任务上下文。' : '当前上下文未压缩。', command: { type: name }, agentSessionId: session.id, usedBackend: 'runtime.compaction' }; }
      if (name === 'permission') { if (rest && !presets[rest]) throw new Error('Unknown permission preset'); return { ok: true, command: { type: name, value: rest }, permissionPreset: rest || preset, answer: rest ? `权限预设：${rest}` : Object.keys(presets).join(' · ') }; }
      if (name === 'model' || name === 'cwd') return { ok: true, command: { type: name, value: rest }, answer: name === 'cwd' ? workspace || '未绑定工作区。' : config.model };
      if (name === 'rewind') { if (!files) throw new Error('未绑定工作区。'); const result = await files.rewind(rest ? Number(rest) : 0); return { ok: true, command: { type: name }, answer: JSON.stringify(result), result }; }
    }
    instruction = await expandSkillCommand(instruction, workspace, userDataDir);
    if (session.deriveMessages().length === 0 && payload.turns?.length) await session.appendMessage({ role: 'user', origin: 'data', injected: true, content: `[旧对话首次迁移]\n${JSON.stringify(payload.turns)}` });
    await session.append('runtime/effort', { effort: config.effort });
    const terminal = await runAgent({ ...common, instruction, evidence: prepared.evidence });
    sink.flush();
    const successful = ['completed', 'awaiting_user'].includes(terminal.reason);
    const plan = [...session.events].reverse().find(event => event.type === 'plan/updated')?.data || null;
    const result = { ok: successful, answer: terminal.message, error: successful ? undefined : terminal.message, loopTerminated: true, loopTerminatedReason: terminal.reason,
      usedBackend: terminal.usedBackend, permissionPreset: preset, receipts: [terminal.receipt], events: terminal.results, activities: sink.activities, trajectory: sink.trajectory,
      modelUsage: terminal.model_usage, timingMs: performance.now() - started, agentSessionId: session.id, hasPendingWork: terminal.reason !== 'completed',
      interactionLedger: session.events.filter(event => event.type.startsWith('interaction/') || event.type === 'receipt/issued').map(event => event.data),
      awaitingUserInput: terminal.reason === 'awaiting_user', pendingInput: terminal.pending_input, taskContext: prepared.taskContext, artifacts: prepared.artifacts,
      runtimeTurn: [...session.events].reverse().find(event => event.type === 'turn/end')?.data.turn ?? null, plan,
      thinking: sink.trajectory.filter(item => item.kind === 'message').map(item => item.reasoning || '').join(''), ...(accepted ? { accepted: true, inputAnswer: accepted } : {}) };
    if (settings.privacy.background_learning_enabled === true && ['completed', 'stalled', 'invariant_failed', 'budget_exhausted'].includes(terminal.reason)) learningReview({ sessionId: session.id, terminalReason: terminal.reason, modelRuntime: config }, options);
    return result;
  } finally { sink.flush(); closeMcp(); await plugins.close(); closeOcr(); closeDesktop(); }
}
