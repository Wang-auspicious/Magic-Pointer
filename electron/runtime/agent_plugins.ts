import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ToolRegistry, validate, type ToolSpec, type JsonSchema } from './tools';
import { HookManager, asObject, type Data, type ToolHook, type AgentOptions, type ModelRunner } from './agent';

type Disposer = () => void | Promise<void>;
type Listener = (payload: unknown, next?: () => Promise<unknown>) => unknown | Promise<unknown>;
type Injection = { deps: string[]; activate: (context: PluginContext) => void | Promise<void>; child?: PluginContext; state: string; error?: string };
const activeWork = new AsyncLocalStorage<PluginContext>();
export class PluginContext {
  private services = new Map<string, unknown>();
  private effects: Disposer[] = [];
  private children = new Set<PluginContext>();
  private injections = new Set<Injection>();
  private events = new Map<string, { mode: string; listeners: Listener[] }>();
  private closing = false;
  private work = new Set<Promise<unknown>>();
  constructor(readonly parent?: PluginContext) { parent?.children.add(this); }
  private serviceViews = new Map<string, { value: object; view: object }>();
  private resolve<T>(key: string): T { if (this.services.has(key)) return this.services.get(key) as T; if (this.parent) return this.parent.resolve<T>(key); throw new Error(`Missing service: ${key}`); }
  get<T = unknown>(key: string): T {
    const value = this.resolve<T>(key);
    if (!value || typeof value !== 'object' || !['tools', 'hooks', 'prompt', 'surface_adapters'].includes(key)) return value;
    const cached = this.serviceViews.get(key); if (cached?.value === value) return cached.view as T;
    const view = new Proxy(value, { get: (target, property) => {
      if (key === 'tools' && property === 'register') return (spec: ToolSpec) => this.registerTool(spec);
      const member = Reflect.get(target, property);
      if (typeof member !== 'function') return member;
      if (key === 'hooks' && property === 'add' || key === 'prompt' && property === 'add' || key === 'surface_adapters' && property === 'register' || key === 'tools' && property === 'onSessionEnd')
        return (...args: unknown[]) => this.effect(member.apply(target, args));
      return member.bind(target);
    } });
    this.serviceViews.set(key, { value, view }); return view as T;
  }
  has(key: string): boolean { return this.services.has(key) || !!this.parent?.has(key); }
  keys(): string[] { return [...new Set([...(this.parent?.keys() ?? []), ...this.services.keys()])]; }
  async provide(key: string, value: unknown): Promise<void> { if (this.closing) throw new Error('Context is closing'); if (this.services.has(key)) throw new Error(`Duplicate service ${key}`); this.services.set(key, value); await this.refresh(); }
  async revoke(key: string): Promise<boolean> { if (!this.services.delete(key)) return false; await this.refresh(); return true; }
  async provideUp(key: string, value: unknown): Promise<void> {
    let root: PluginContext = this; while (root.parent) root = root.parent;
    await root.provide(key, value); this.effect(async () => { await root.revoke(key); });
  }
  effect(disposer: Disposer): Disposer {
    if (this.closing) throw new Error('Context is closing');
    let done = false; const owned = async () => { if (done) return; done = true; const index = this.effects.indexOf(owned); if (index >= 0) this.effects.splice(index, 1); await disposer(); };
    this.effects.push(owned); return owned;
  }
  scope(): PluginContext { if (this.closing) throw new Error('Context is closing'); return new PluginContext(this); }
  async inject(deps: string[], activate: Injection['activate']): Promise<Injection> {
    const injection: Injection = { deps, activate, state: 'waiting' }; this.injections.add(injection);
    this.effect(async () => { this.injections.delete(injection); injection.state = 'unmounted'; await injection.child?.unload(); });
    await this.refresh(); return injection;
  }
  private async refresh(): Promise<void> {
    for (const injection of this.injections) {
      const ready = injection.deps.every(dep => this.has(dep));
      if (!ready && injection.child) { const child = injection.child; injection.child = undefined; injection.state = 'waiting'; await child.unload(); }
      else if (ready && injection.state === 'waiting') {
        const child = this.scope(); injection.child = child; injection.state = 'active';
        try { await injection.activate(child); } catch (error) { injection.error = (error as Error).message; injection.state = 'error'; injection.child = undefined; await child.unload(); }
      }
    }
    for (const child of this.children) if (!child.closing) await child.refresh();
  }
  async run<T>(callback: () => T | Promise<T>): Promise<T> {
    if (this.closing) throw new Error('Context is closing');
    const promise = Promise.resolve().then(() => activeWork.run(this, callback)); this.work.add(promise);
    try { return await promise; } finally { this.work.delete(promise); }
  }
  declare(kind: string, mode: 'emit' | 'serial' | 'parallel' | 'waterfall'): void {
    const previous = this.events.get(kind); if (previous && previous.mode !== mode) throw new Error(`Event mode mismatch: ${kind}`);
    if (!previous) this.events.set(kind, { mode, listeners: [] });
  }
  private event(kind: string): { mode: string; listeners: Listener[] } | undefined { return this.events.get(kind) ?? this.parent?.event(kind); }
  on(kind: string, listener: Listener, prepend = false): Disposer {
    const event = this.event(kind); if (!event) throw new Error(`Undeclared event: ${kind}`);
    if (prepend) event.listeners.unshift(listener); else event.listeners.push(listener);
    return this.effect(() => { const index = event.listeners.indexOf(listener); if (index >= 0) event.listeners.splice(index, 1); });
  }
  async dispatch(kind: string, payload: unknown): Promise<unknown> {
    const event = this.event(kind); if (!event) throw new Error(`Undeclared event: ${kind}`);
    return this.run(async () => {
      const listeners = [...event.listeners];
      if (event.mode === 'parallel') return Promise.allSettled(listeners.map(listener => listener(payload)));
      if (event.mode === 'waterfall') { const next = async (index: number): Promise<unknown> => index < listeners.length ? listeners[index](payload, () => next(index + 1)) : payload; return next(0); }
      let result: unknown; for (const listener of listeners) result = await listener(payload); return event.mode === 'serial' ? result : undefined;
    });
  }
  registerTool(spec: ToolSpec): ToolSpec {
    const registry = this.resolve<ToolRegistry>('tools'); const owned = { ...spec, execute: (args: Data, context: Parameters<ToolSpec['execute']>[1]) => this.run(() => spec.execute(args, context)) };
    registry.register(owned); this.effect(() => { registry.unregister(owned.name, owned); });
    return owned;
  }
  registerHook(phase: 'pre' | 'post' | 'stop', hook: ToolHook): void { this.effect(this.get<HookManager>('hooks').add(phase, payload => this.run(() => hook(payload)))); }
  async unload(): Promise<void> {
    for (let current = activeWork.getStore(); current; current = current.parent) if (current === this) throw new Error('Cannot unload a context from its own active work');
    if (this.closing) return; this.closing = true;
    await Promise.allSettled(this.work);
    for (const child of [...this.children]) await child.unload();
    for (const dispose of [...this.effects].reverse()) { try { await dispose(); } catch {} }
    this.services.clear(); this.parent?.children.delete(this);
  }
}

export class PromptSections {
  private sections = new Map<string, { id: string; order?: number; render: (options: AgentOptions) => string | Promise<string> }>();
  add(section: { id: string; order?: number; render: (options: AgentOptions) => string | Promise<string> }): Disposer {
    if (this.sections.has(section.id)) throw new Error(`Duplicate prompt section: ${section.id}`);
    this.sections.set(section.id, section); return () => { if (this.sections.get(section.id) === section) this.sections.delete(section.id); };
  }
  async build(options: AgentOptions): Promise<string> {
    const sections = [...this.sections.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    return (await Promise.all(sections.map(section => section.render(options)))).filter(Boolean).join('\n\n');
  }
}

export interface RuntimePlugin { name: string; inject?: string[]; scopes?: string[]; defaults?: Data; config_schema?: JsonSchema; apply(context: PluginContext, config: Data): void | Promise<void> }
export interface PluginRow { id: string; plugin: string; config?: Data; disabled?: boolean }
export function extensionPaths(userDataDir: string) {
  return {
    plugins: process.env.MAGIC_POINTER_PLUGIN_DIR || path.join(userDataDir, 'data', 'plugins'),
    mcp: process.env.MAGIC_POINTER_MCP_CONFIG || path.join(userDataDir, 'data', 'mcp.json'),
    patch: process.env.MAGIC_POINTER_HARNESS_CONFIG || path.join(userDataDir, 'data', 'harness.patch.json'),
  };
}
export async function loadHarnessPatch(file: string): Promise<Record<string, Partial<PluginRow>>> {
  try {
    const document = asObject(JSON.parse(await readFile(file, 'utf8')));
    if (document.schemaVersion !== 1 || !document.patch || Array.isArray(document.patch) || typeof document.patch !== 'object') throw new Error(`Invalid harness configuration: ${file}`);
    return document.patch as Record<string, Partial<PluginRow>>;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}
const merge = (base: Data, patch: Data): Data => Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(patch)])].map(key => [key, key in patch ? Object.keys(asObject(base[key])).length && Object.keys(asObject(patch[key])).length ? merge(asObject(base[key]), asObject(patch[key])) : patch[key] : base[key]]));
const pluginScopes = (plugin: RuntimePlugin) => plugin.scopes ?? (plugin.inject?.includes('surface_adapters') ? ['surface'] : ['agent']);
export async function bootPlugins(options: { context?: PluginContext; directory: string; scope?: string; core?: Record<string, unknown>; builtins?: RuntimePlugin[]; rows?: PluginRow[]; patch?: Record<string, Partial<PluginRow>> }) {
  const context = options.context ?? new PluginContext(), specs = new Map<string, RuntimePlugin>((options.builtins ?? []).map(plugin => [plugin.name, plugin]));
  for (const [key, value] of Object.entries(options.core ?? {})) await context.provide(key, value);
  const warnings: string[] = [], rows = [...options.rows ?? []];
  for (const entry of await readdir(options.directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    try {
      const directory = path.join(options.directory, entry.name), manifest = asObject(JSON.parse(await readFile(path.join(directory, 'plugin.json'), 'utf8')));
      const modulePath = path.resolve(directory, String(manifest.main || 'plugin.js'));
      const loaded = await import(pathToFileURL(modulePath).href); const plugin = (loaded.default ?? loaded.plugin ?? loaded) as RuntimePlugin;
      if (!plugin.name || typeof plugin.apply !== 'function') throw new Error('Plugin needs name and apply');
      if (specs.has(plugin.name)) throw new Error(`Duplicate plugin ${plugin.name}`);
      specs.set(plugin.name, plugin);
      if (pluginScopes(plugin).includes(options.scope ?? 'agent')) rows.push({ id: `user:${plugin.name}`, plugin: plugin.name });
    } catch (error) { warnings.push(`${entry.name}: ${(error as Error).message}`); }
  }
  const byId = new Map<string, PluginRow>();
  for (const row of rows) { if (byId.has(row.id)) throw new Error(`Duplicate plugin row ${row.id}`); byId.set(row.id, { ...row, ...options.patch?.[row.id] }); }
  for (const [id, patch] of Object.entries(options.patch ?? {})) if (!byId.has(id) && patch.plugin) byId.set(id, { id, plugin: patch.plugin, ...patch });
  const reports: Data[] = [], scopes = new Map<string, PluginContext>();
  for (const row of byId.values()) {
    const report: Data = { id: row.id, plugin: row.plugin, config: row.config ?? {}, status: row.disabled ? 'disabled' : 'waiting', error: '', missingDeps: [] }; reports.push(report);
    if (row.disabled) continue;
    const spec = specs.get(row.plugin); if (!spec) { report.status = 'error'; report.error = 'Unknown plugin'; continue; }
    if (!pluginScopes(spec).includes(options.scope ?? 'agent')) { report.status = 'out_of_scope'; continue; }
    const config = structuredClone(merge(spec.defaults ?? {}, row.config ?? {})); report.config = config;
    const errors = spec.config_schema ? validate(config, spec.config_schema) : [];
    if (errors.length) { report.status = 'error'; report.error = errors.join('; '); continue; }
    const scope = context.scope(); scopes.set(row.id, scope);
    const injection = await scope.inject(spec.inject ?? [], child => spec.apply(child, structuredClone(config)));
    Object.defineProperties(report, { status: { enumerable: true, get: () => injection.state }, error: { enumerable: true, get: () => injection.error ?? '' }, missingDeps: { enumerable: true, get: () => injection.deps.filter(dep => !scope.has(dep)) } });
  }
  return { context, warnings, rows: reports, dumpConfig: () => reports.map(row => ({ ...row })), unmount: async (id: string) => { const scope = scopes.get(id); if (!scope) return false; await scope.unload(); scopes.delete(id); return true; }, close: () => context.unload() };
}

export function modelPlugins(model: ModelRunner): RuntimePlugin[] {
  return [
    { name: 'llm-provider', apply: ctx => ctx.provideUp('llm', model) },
    { name: 'model-client', inject: ['llm'], apply: ctx => ctx.provideUp('model_client', ctx.get('llm')) },
  ];
}

export async function bootSurfacePlugins(userDataDir: string, adapters: unknown, builtins: RuntimePlugin[] = []) {
  const paths = extensionPaths(userDataDir);
  return bootPlugins({ directory: paths.plugins, scope: 'surface', patch: await loadHarnessPatch(paths.patch), builtins, rows: builtins.map(plugin => ({ id: plugin.name, plugin: plugin.name })), core: { surface_adapters: adapters } });
}

export class HarnessRuntimeHost {
  private closed = false;
  private constructor(readonly report: Awaited<ReturnType<typeof bootPlugins>>, readonly options: Parameters<typeof bootPlugins>[0]) {}
  static async create(options: Parameters<typeof bootPlugins>[0]): Promise<HarnessRuntimeHost> { return new HarnessRuntimeHost(await bootPlugins({ ...options, directory: '', scope: 'global' }), options); }
  async openScope(core: Record<string, unknown> = {}, rows: PluginRow[] = []): Promise<Awaited<ReturnType<typeof bootPlugins>>> {
    if (this.closed) throw new Error('Harness runtime host is closed');
    return bootPlugins({ ...this.options, context: this.report.context.scope(), core, rows, scope: 'agent' });
  }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; await this.report.close(); }
}
