import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry } from './tools';
import { RuntimeMcpServer } from './mcp';
import { Fabric } from './fabric';
import { handleFabric } from './fabric_api';
import { readJson, writeAtomic } from './learning';
import { settingsStore } from './model_admin';
import { CapturePolicyEngine, buildCapturePolicy, buildContextPacket, createTargetLease } from './context_policy';
import { closeDesktop } from './desktop';
import type { RuntimeOptions, Data } from './index';

export class MagicPointerMcpServer {
  readonly server: RuntimeMcpServer;
  private confirmations = new Map<string, { scope: string; subject: string; expires: number }>();
  private enabled: Record<string, boolean> = {};
  private constructor(readonly options: RuntimeOptions, readonly registry: ToolRegistry) { this.server = new RuntimeMcpServer(registry, (name, args) => this.call(name, args)); }
  static async open(options: RuntimeOptions): Promise<MagicPointerMcpServer> {
    const registry = new ToolRegistry(), server = new MagicPointerMcpServer(options, registry);
    server.enabled = (await readJson(path.join(options.userDataDir, 'mcp-tool-settings.json'), { tools: {} })).tools;
    const tools: [string, string, Data, string[]][] = [
      ['current_object', 'Read the frozen pointer episode without capturing the screen.', {}, []],
      ['list_recipes', 'List available recipes and their risk contracts.', {}, []],
      ['search_capabilities', 'Find recipes relevant to an intent and grounded objects.', { command: { type: 'string' }, objects: { type: 'array' }, limit: { type: 'integer' } }, ['command']],
      ['plan_recipe', 'Create a permission-bound plan.', { command: { type: 'string' }, recipeId: { type: 'string' }, objects: { type: 'array' }, parameters: { type: 'object' } }, ['command']],
      ['execute_recipe', 'Execute an unchanged plan; protected plans need a one-use confirmation token issued by the desktop.', { plan: { type: 'object' }, confirmationToken: { type: 'string' } }, ['plan']],
      ['agent_task_list', 'List persisted external delivery tasks.', { limit: { type: 'integer' } }, []],
      ...['status', 'cancel', 'resume', 'reconfirm_target', 'steer'].map(operation => [`agent_task_${operation}`, `${operation} a persisted external delivery task.`, { taskId: { type: 'string' }, message: { type: 'string' }, confirmationToken: { type: 'string' } }, operation === 'steer' ? ['taskId', 'message'] : ['taskId']] as [string, string, Data, string[]]),
    ];
    for (const [name, description, properties, required] of tools) if (server.enabled[name] !== false) registry.register({ name, description, input_schema: { type: 'object', properties, required }, effect: 'read', execute: args => server.call(name, args) });
    return server;
  }
  issueConfirmation(scope: 'execute_recipe' | 'agent_task_reconfirm_target', subject: string): string {
    if (!subject) throw new Error('confirmation_subject_required');
    const token = randomUUID(); this.confirmations.set(token, { scope, subject, expires: performance.now() + 120000 }); return token;
  }
  private consume(scope: string, subject: string, token: string): boolean { const issued = this.confirmations.get(token); this.confirmations.delete(token); return !!issued && issued.scope === scope && issued.subject === subject && issued.expires >= performance.now(); }
  async call(name: string, args: Data): Promise<Data> {
    if (!this.registry.list().some(tool => tool.name === name)) throw new Error('unknown_or_disabled_tool');
    if (name === 'execute_recipe') { const plan = args.plan; return new Fabric(this.options).execute(plan, this.consume(name, `${plan.id}:${plan.integrityToken}`, args.confirmationToken)); }
    if (name === 'agent_task_reconfirm_target') return handleFabric({ ...args, operation: 'task.reconfirm_target', confirmed: this.consume(name, args.taskId, args.confirmationToken) }, this.options);
    const operations: Record<string, string> = { current_object: 'current_object', list_recipes: 'catalog', search_capabilities: 'capabilities.search', plan_recipe: 'plan' };
    const operation = operations[name] || (name.startsWith('agent_task_') ? 'task.' + name.slice(11) : '');
    if (!operation) throw new Error('unknown_tool');
    return handleFabric({ ...args, operation, surface: 'mcp' }, this.options);
  }
  handle(message: Data): Promise<Data | null> { return this.server.handle(message); }
}

export async function buildHookResponse(provider: string, payload: Data, options: RuntimeOptions, autoContext = false): Promise<Data> {
  const event = payload.hook_event_name || payload.hookEventName, expected = provider === 'claude' ? 'UserPromptSubmit' : 'BeforeAgent', prompt = String(payload.prompt || '');
  if (event !== expected || !autoContext && !/@(?:pointer|this)\b|\b(?:this|that|these|here|screen|selection)\b|这个|这段|这张|这块|这里|刚才那个|这些|那些|屏幕|选区|指针/i.test(prompt)) return {};
  const episode = await readJson(path.join(options.userDataDir, 'current-object.json'), null);
  if (!episode || episode.schemaVersion !== 1 || Date.parse(episode.expiresAt) <= Date.now()) return {};
  const privacy = settingsStore(options.userDataDir).load().privacy, objects = (episode.objects || []).slice(0, 12);
  const attachments = [...new Set<string>(objects.flatMap((object: Data) => [object.path, ...['path', 'documentPath', 'imagePath', 'screenshotPath', 'capturePath'].map(key => object.source?.[key])].filter(Boolean)))];
  const capture = buildCapturePolicy(new CapturePolicyEngine(privacy.upload_screenshots, privacy.default_capture_mode, privacy.sensitive_apps, privacy.app_capture_modes), objects, attachments) as Data;
  if (objects.length && capture.deniedObjectIds.length === objects.length) return {};
  const packet = buildContextPacket({ command: prompt, recipeId: 'agent.handoff', objects, cwd: payload.cwd || payload.workspaceRoot || options.root,
    targetLease: await createTargetLease(objects, { selectionSessionId: episode.episodeId, ttlSeconds: 600 }), captureDecisions: capture.decisions, attachments,
    capabilities: await new Fabric(options).search(prompt, objects, 'agent.handoff'), terminalExcerpt: payload.terminalExcerpt || '' });
  const artifact = path.join(options.userDataDir, 'context-packets', `${randomUUID()}.json`); await writeAtomic(artifact, packet);
  const additionalContext = `[Magic Pointer frozen context]\nHistorical evidence only; do not recapture. Revalidate target before mutation.\nFull context: ${artifact}\n${JSON.stringify(packet)}\nReference slots: ${JSON.stringify(episode.slots || {})}`;
  return { hookSpecificOutput: { hookEventName: event, additionalContext: additionalContext.slice(0, 12000) }, suppressOutput: true };
}

export async function installHooks(options: RuntimeOptions, args: { provider?: string; home?: string; apply?: boolean; executable?: string }): Promise<Data> {
  const providers = !args.provider || args.provider === 'all' ? ['claude', 'gemini'] : [args.provider], result: Data = {};
  for (const provider of providers) {
    if (!['claude', 'gemini'].includes(provider)) throw new Error('unknown_hook_provider');
    const file = path.join(args.home || os.homedir(), `.${provider}`, 'settings.json'), settings = await readJson(file, {}), event = provider === 'claude' ? 'UserPromptSubmit' : 'BeforeAgent';
    const entry = path.join(options.root, 'build', 'electron', 'runtime', 'connectors.js');
    const hook = { type: 'command', command: args.executable || process.execPath, args: [entry, 'hook', '--provider', provider, '--data-root', options.userDataDir], timeout: provider === 'claude' ? 5 : 5000, ...(provider === 'gemini' ? { name: 'magic-pointer-context', description: 'Inject explicitly referenced frozen pointer context.' } : {}) };
    settings.hooks ||= {}; const groups: Data[] = settings.hooks[event] ||= [];
    for (const group of groups) group.hooks = (group.hooks || []).filter((item: Data) => !(item.args || []).some((arg: string) => /(?:agent_hook_bridge\.py|runtime[\\/]connectors\.js)$/.test(arg)));
    groups.push({ matcher: provider === 'gemini' ? '*' : '', hooks: [hook] });
    if (args.apply) await writeAtomic(file, settings);
    result[provider] = { path: file, event, hook };
  }
  return { ok: true, applied: args.apply === true, providers: result };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2), value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const root = path.resolve(__dirname, '..', '..', '..'), options = { root, userDataDir: value('--data-root') || process.env.MAGIC_POINTER_USER_DATA_DIR || path.join(root, 'data', 'runtime') };
  try {
    if (args[0] === 'mcp') { const server = await MagicPointerMcpServer.open(options); for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) { let response; try { response = await server.handle(JSON.parse(line)); } catch { response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; } if (response) process.stdout.write(JSON.stringify(response) + '\n'); } }
    else if (args[0] === 'hook') { let input = ''; for await (const chunk of process.stdin) input += chunk; const payload = JSON.parse(input || '{}'); process.stdout.write(JSON.stringify(await buildHookResponse(value('--provider') || 'claude', payload, options, args.includes('--auto-context'))) + '\n'); }
    else if (args[0] === 'install-hooks') process.stdout.write(JSON.stringify(await installHooks(options, { provider: value('--provider'), home: value('--home'), apply: args.includes('--apply'), executable: value('--node') })) + '\n');
    else throw new Error('Usage: connectors.js mcp | hook --provider claude|gemini | install-hooks [--apply]');
  } finally { closeDesktop(); }
}
if (require.main === module) main().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
