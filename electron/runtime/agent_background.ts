import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { asObject, runAgent, registerAgentTools, HookManager, type AgentOptions, type AgentEvent, type Data, type PermissionMode } from './agent';
import { bootPlugins, extensionPaths, loadHarnessPatch, PromptSections, modelPlugins } from './agent_plugins';
import { registerCodingTools } from './agent_files';
import { EventSession } from './session';
import { ToolRegistry } from './tools';
import { streamModel } from './model';
import { initialToolNames, registerToolResultReader } from './agent_services';

const active = new Set(['starting', 'running', 'awaiting_user']);
const str = (value: unknown) => String(value ?? '');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const filename = (userDataDir: string, id: string, suffix = '.agent.json') => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error('invalid_session_id');
  return path.join(userDataDir, 'agent-sessions', id + suffix);
};
async function persist(file: string, value: Data): Promise<void> {
  const temp = `${file}.${process.pid}.pending`;
  await writeFile(temp, JSON.stringify(value), 'utf8');
  for (let attempt = 0; ; attempt++) {
    try { await rename(temp, file); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 5) throw error;
      await pause(20 * (attempt + 1));
    }
  }
}
export async function readAgentStatus(userDataDir: string, id: string): Promise<Data | null> {
  let value: Data;
  try { value = asObject(JSON.parse(await readFile(filename(userDataDir, id), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (active.has(str(value.status)) && value.pid) {
    try { process.kill(Number(value.pid), 0); }
    catch {
      const child = await EventSession.open(userDataDir, id, false);
      return { ...value, status: 'stopped', phase: 'stopped', pendingInput: child.pendingInput(), resumeRequired: true,
        summary: 'Worker exited. Resume this Agent to continue from its journal.' };
    }
  }
  return value;
}
export async function listAgents(userDataDir: string, parent: EventSession): Promise<Data[]> {
  await parent.refresh();
  const ids = [...new Set(parent.events.filter(event => event.type === 'subagent/created').map(event => str(event.data.childSessionId)))];
  return (await Promise.all(ids.map(id => readAgentStatus(userDataDir, id)))).filter((value): value is Data => !!value);
}
async function ownedChild(userDataDir: string, parentId: string, childId: string): Promise<EventSession> {
  const child = await EventSession.open(userDataDir, childId, false);
  if (!parentId || child.events[0]?.data.parentSessionId !== parentId) throw new Error('subagent_parent_mismatch');
  return child;
}
export async function respondToAgent(userDataDir: string, parentId: string, childId: string, requestId: string, response: Data): Promise<Data> {
  const child = await ownedChild(userDataDir, parentId, childId), status = await readAgentStatus(userDataDir, childId);
  const previous = child.events.find(event => event.type === 'user_input/answered' && event.data.requestId === requestId);
  const resumeRequired = status?.status === 'stopped';
  if (!status || !active.has(str(status.status)) && !(resumeRequired && (previous || child.pendingInput()?.requestId === requestId))) throw new Error('subagent_not_running');
  if (previous) {
    if (JSON.stringify(previous.data.response) !== JSON.stringify(response)) throw new Error('input_already_answered_differently');
  } else await child.answer(requestId, response);
  return { ok: true, accepted: true, sessionId: childId, ...(resumeRequired ? { resumeRequired: true } : {}) };
}
export async function stopAgent(userDataDir: string, parentId: string, childId: string): Promise<Data> {
  const child = await ownedChild(userDataDir, parentId, childId), status = await readAgentStatus(userDataDir, childId);
  if (!status || !active.has(str(status.status))) throw new Error('subagent_not_running');
  await writeFile(filename(userDataDir, childId, '.agent.stop'), 'stop');
  if (status.status === 'awaiting_user') await child.cancelPermissions();
  await child.requestCancel('User stopped this subagent');
  return { ok: true, sessionId: childId };
}
export async function steerAgent(userDataDir: string, parentId: string, childId: string, instruction: string): Promise<Data> {
  const child = await ownedChild(userDataDir, parentId, childId), status = await readAgentStatus(userDataDir, childId);
  if (!status || !active.has(str(status.status))) throw new Error('subagent_not_running');
  if (!instruction.trim() || instruction.length > 12000 || child.pendingInbox('next-step').length >= 100) throw new Error('invalid_subagent_steer');
  const event = await child.enqueue(instruction, 'next-step');
  await child.cancelPermissions();
  return { ok: true, accepted: true, sessionId: childId, messageId: event.data.messageId };
}

export interface BackgroundPayload {
  root: string; userDataDir: string; workspace: string; sessionId: string; parentId: string; instruction: string;
  readonly: boolean; permissionMode: PermissionMode; parentCallId: string; config?: AgentOptions['config'];
  allowedTools?: string[]; deniedTools?: string[]; maxTokens?: number; contextTokens?: number;
}
async function launch(payload: BackgroundPayload): Promise<Data> {
  const previous = await readAgentStatus(payload.userDataDir, payload.sessionId);
  if (previous && active.has(str(previous.status))) throw new Error('subagent_already_running');
  await unlink(filename(payload.userDataDir, payload.sessionId, '.agent.stop')).catch(() => {});
  const meta: Data = { id: payload.sessionId, parentSessionId: payload.parentId, parentCallId: payload.parentCallId,
    description: payload.instruction || previous?.description || '', readonly: payload.readonly, status: 'starting', phase: 'starting', background: true,
    stepCount: 0, steps: [], currentTool: '', startedAt: Date.now() };
  const errorLog = await open(filename(payload.userDataDir, payload.sessionId, '.agent.stderr.log'), 'a');
  let worker: ReturnType<typeof spawn>;
  try {
    worker = spawn(process.execPath, [path.join(__dirname, 'agent_worker.js'), 'agent'], { detached: true, windowsHide: true,
      stdio: ['pipe', 'ignore', errorLog.fd], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    await new Promise<void>((resolve, reject) => { worker.once('spawn', resolve); worker.once('error', reject); });
  } finally { await errorLog.close(); }
  meta.pid = worker.pid;
  await persist(filename(payload.userDataDir, payload.sessionId), meta);
  worker.stdin!.end(JSON.stringify(payload)); worker.unref();
  return { ...meta, status: 'running' };
}

export function registerSubagentTools(registry: ToolRegistry, options: Pick<AgentOptions, 'root' | 'userDataDir' | 'workspace' | 'session' | 'config' | 'permissionMode' | 'allowedTools' | 'deniedTools' | 'maxTokens' | 'contextTokens' | 'onEvent'>): void {
  const { session: parent, userDataDir } = options;
  registry.register({ name: 'Agent', description: 'Delegate one self-contained coding task to an independent Agent with its own durable session. readonly=true limits it to reads. Background work survives the parent turn; AgentStatus shows progress and approval requests.',
    input_schema: { type: 'object', properties: { task: { type: 'string' }, context: { type: 'string' }, resume_id: { type: 'string' }, run_in_background: { type: 'boolean' }, readonly: { type: 'boolean' }, effort: { type: 'string', enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] } }, required: ['task'] },
    effect: 'reversible_write', effect_for: args => args.readonly ? 'read' : 'reversible_write', is_concurrency_safe_for: args => args.readonly === true, timeout_ms: 3600000, used_backend: 'subagent_loop',
    execute: async (args, context) => {
      if (!options.workspace) throw new Error('A workspace is required for coding subagents');
      const id = str(args.resume_id || `agent-${randomUUID()}`), instruction = [str(args.task), str(args.context)].filter(Boolean).join('\n\n');
      const child = args.resume_id ? await ownedChild(userDataDir, parent.id, id) : await EventSession.open(userDataDir, id, true, parent.id);
      const saved = child.events.find(event => event.type === 'subagent/configured')?.data;
      const readonly = saved?.readonly === true || args.readonly === true;
      if (!saved) {
        await child.append('subagent/configured', { task: instruction, readonly, effort: args.effort ?? options.config?.effort });
        await parent.append('subagent/created', { childSessionId: id, task: instruction, readonly });
      }
      const inherited = [...(options.allowedTools ?? [])];
      for (const event of parent.events) if (event.type === 'user_input/answered' && asObject(event.data.response).decision === 'grant') {
        const input = asObject(event.data.pendingInput); if (input.kind === 'permission') inherited.push(input.prefix ? `${input.tool}(${input.prefix})` : str(input.tool));
      }
      const payload: BackgroundPayload = { root: options.root, userDataDir, workspace: options.workspace, sessionId: id, parentId: parent.id,
        instruction, readonly, permissionMode: (parent.permissionMode(options.permissionMode ?? 'default') === 'plan' ? 'plan' : parent.permissionMode(options.permissionMode ?? 'default')) as PermissionMode,
        parentCallId: context.tool_call_id, config: options.config ? { ...options.config, effort: str(args.effort || saved?.effort || options.config.effort) } : undefined,
        allowedTools: inherited, deniedTools: options.deniedTools, maxTokens: options.maxTokens, contextTokens: options.contextTokens };
      const started = await launch(payload); options.onEvent?.({ kind: 'subagent_progress', payload: started });
      if (args.run_in_background) return { ...started, message: 'Running independently. Completion arrives in the task inbox.' };
      for (;;) {
        if (context.signal.aborted) { await stopAgent(userDataDir, parent.id, id); context.signal.throwIfAborted(); }
        await pause(250); const status = (await readAgentStatus(userDataDir, id))!;
        options.onEvent?.({ kind: 'subagent_progress', payload: status });
        if (status.status === 'awaiting_user' || !active.has(str(status.status))) return status;
      }
    } });
  registry.register({ name: 'AgentStatus', description: 'Read actual progress, outputs and pending approvals for independently running child Agents.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: [] }, effect: 'read', is_concurrency_safe: true,
    execute: async args => { const children = await listAgents(userDataDir, parent); return args.id ? children.find(child => child.id === args.id) ?? { error: 'unknown_subagent' } : { tasks: children }; }, used_backend: 'subagent_session' });
  registry.register({ name: 'AgentSteer', description: 'Correct a running child Agent. The instruction enters its durable next-step inbox before its next write.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, instruction: { type: 'string' } }, required: ['id', 'instruction'] }, effect: 'read', is_concurrency_safe: true,
    execute: args => steerAgent(userDataDir, parent.id, str(args.id), str(args.instruction)), used_backend: 'subagent_session' });
  registry.register({ name: 'AgentStop', description: 'Stop an independent child Agent and preserve completed work and resumable history.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, effect: 'read', is_concurrency_safe: true,
    execute: args => stopAgent(userDataDir, parent.id, str(args.id)), used_backend: 'subagent_session' });
}

export async function runBackgroundAgent(payload: BackgroundPayload): Promise<void> {
  const { userDataDir, sessionId } = payload, session = await ownedChild(userDataDir, payload.parentId, sessionId);
  const parent = await EventSession.open(userDataDir, payload.parentId, false);
  let state = (await readAgentStatus(userDataDir, sessionId))!, pendingWrite = Promise.resolve(), lastPublish = 0;
  const started = Number(state.startedAt), steps: Data[] = [];
  const publish = (patch: Data) => { state = { ...state, ...patch, elapsedMs: Date.now() - started, steps: structuredClone(steps), stepCount: steps.length }; const snapshot = state;
    pendingWrite = pendingWrite.then(() => persist(filename(userDataDir, sessionId), snapshot)); lastPublish = Date.now(); };
  const onEvent = (event: AgentEvent) => {
    if (event.kind === 'turn_started') publish({ status: 'running', phase: 'thinking', turn: event.turn, reasoning: '', answer: '' });
    else if (event.kind === 'model_chunk' || event.kind === 'reasoning_chunk') {
      const key = event.kind === 'model_chunk' ? 'answer' : 'reasoning'; state[key] = (str(state[key]) + str(event.text)).slice(-6000);
      if (Date.now() - lastPublish >= 120) publish({ phase: key === 'answer' ? 'writing' : 'thinking' });
    } else if (event.kind === 'tool_call_started') { steps.push({ index: steps.length + 1, callId: event.id, tool: event.name, status: 'running', input: event.arguments }); publish({ phase: 'tool', currentTool: event.name }); }
    else if (event.kind === 'tool_call_finished') { const result = asObject(event.result), step = steps.find(item => item.callId === result.tool_call_id); if (step) Object.assign(step, { status: result.is_error ? 'failed' : 'completed', output: str(result.value).slice(-6000), usedBackend: result.used_backend, latencyMs: result.latency_ms }); publish({ phase: 'thinking', currentTool: '' }); }
  };
  let instruction = payload.instruction;
  try {
    for (;;) {
      const controller = new AbortController();
      const poll = setInterval(() => { readFile(filename(userDataDir, sessionId, '.agent.stop')).then(() => controller.abort(new Error('Subagent stopped'))).catch(() => {}); }, 300);
      let result;
      try {
        const registry = new ToolRegistry(), hooks = new HookManager(), prompt = new PromptSections(), paths = extensionPaths(userDataDir);
        const builtins = [...modelPlugins(streamModel),
          { name: 'coding-tools', apply: (ctx: import('./agent_plugins').PluginContext) => { registerCodingTools(ctx.get('tools'), payload.workspace, session); } },
          { name: 'tool-result-reader', apply: (ctx: import('./agent_plugins').PluginContext) => registerToolResultReader(ctx.get('tools'), session) },
          { name: 'harness-tools', apply: (ctx: import('./agent_plugins').PluginContext) => registerAgentTools(ctx.get('tools'), session) }];
        const plugins = await bootPlugins({ directory: paths.plugins, patch: await loadHarnessPatch(paths.patch), builtins, rows: builtins.map(plugin => ({ id: plugin.name, plugin: plugin.name })), core: { tools: registry, hooks, prompt, session, runtime: payload } });
        try {
          for (const name of ['AskUser', 'EnterPlanMode', 'ExitPlanMode']) registry.unregister(name);
          if (payload.readonly) for (const name of ['Write', 'Edit', 'Patch', 'Rewind', 'Bash']) registry.unregister(name);
          registry.setInitialTools(initialToolNames({ workspace: payload.workspace, permissionMode: payload.permissionMode }));
          const common: AgentOptions = { ...payload, session, registry, hooks, model: request => plugins.context.get<AgentOptions['model']>('model_client')(request), instruction, signal: controller.signal, onEvent,
          allowedEffects: payload.readonly ? ['read'] : ['read', 'reversible_write', 'local_irreversible'],
          system: 'You are a Magic Pointer coding subagent. Complete the assigned task independently in the workspace. Read before editing, verify actual results, and return a concise factual report with paths and remaining limitations. Never claim work or checks you did not perform.' };
          common.system += '\n\n' + await prompt.build(common);
          result = await runAgent(common);
        } finally { await registry.close(); await plugins.close(); }
      } finally { clearInterval(poll); }
      const receiptStatus = str(result.receipt.status);
      const status = result.reason === 'completed' && receiptStatus === 'unverified' ? 'needs_verification'
        : result.reason === 'completed' && receiptStatus === 'partial' ? 'partial' : result.reason;
      const summary = status === result.reason ? result.message : `${result.message}\nTask remains ${status}; inspect the saved receipt before continuing.`;
      publish({ status, phase: status, summary, receiptStatus, pendingInput: result.pending_input, completedAt: Date.now() }); await pendingWrite;
      if (result.reason !== 'awaiting_user') {
        await parent.append('subagent/finished', { childSessionId: sessionId, status, receiptStatus, summary });
        await parent.enqueue(`[Agent ${sessionId} ${status}]\n${summary}`, 'next-step', undefined, `agent-result-${sessionId}-${session.events.length}`); break;
      }
      await parent.enqueue(`[Agent ${sessionId} awaiting user approval] ${result.pending_input?.question ?? ''}`, 'next-step', undefined, `agent-approval-${sessionId}-${result.pending_input?.requestId}`);
      while (true) {
        if (await readFile(filename(userDataDir, sessionId, '.agent.stop')).then(() => true).catch(() => false)) {
          const summary = 'User stopped this Agent while it was waiting for input.';
          await session.cancelPermissions();
          publish({ status: 'user_interrupt', phase: 'user_interrupt', summary, pendingInput: null, completedAt: Date.now() });
          await pendingWrite;
          await parent.append('subagent/finished', { childSessionId: sessionId, status: 'user_interrupt', summary });
          await parent.enqueue(`[Agent ${sessionId} user_interrupt]\n${summary}`, 'next-step', undefined, `agent-result-${sessionId}-${session.events.length}`);
          return;
        }
        await pause(300); await session.refresh();
        if (!session.pendingInput() && !await readFile(filename(userDataDir, sessionId, '.agent.stop')).then(() => true).catch(() => false)) break;
      }
      instruction = ''; publish({ status: 'running', phase: 'thinking', pendingInput: null });
    }
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    publish({ status: 'failed', phase: 'failed', summary, pendingInput: null, completedAt: Date.now() });
    await pendingWrite;
    await parent.append('subagent/finished', { childSessionId: sessionId, status: 'failed', summary });
    await parent.enqueue(`[Agent ${sessionId} failed]\n${summary}`, 'next-step');
  }
  finally { await pendingWrite; }
}
