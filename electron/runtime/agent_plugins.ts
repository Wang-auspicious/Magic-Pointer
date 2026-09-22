import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ToolRegistry, type ToolSpec } from './tools';
import { HookManager, asObject, type Data, type ToolHook } from './agent';

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
  get<T = unknown>(key: string): T { if (this.services.has(key)) return this.services.get(key) as T; if (this.parent) return this.parent.get<T>(key); throw new Error(`Missing service: ${key}`); }
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
  registerTool(spec: ToolSpec): void {
    const registry = this.get<ToolRegistry>('tools'); const owned = { ...spec, execute: (args: Data, context: Parameters<ToolSpec['execute']>[1]) => this.run(() => spec.execute(args, context)) };
    registry.register(owned); this.effect(() => { registry.unregister(owned.name, owned); });
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

export interface RuntimePlugin { name: string; inject?: string[]; scopes?: string[]; defaults?: Data; apply(context: PluginContext, config: Data): void | Promise<void> }
export interface PluginRow { id: string; plugin: string; config?: Data; disabled?: boolean }
const merge = (base: Data, patch: Data): Data => Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(patch)])].map(key => [key, key in patch ? Object.keys(asObject(base[key])).length && Object.keys(asObject(patch[key])).length ? merge(asObject(base[key]), asObject(patch[key])) : patch[key] : base[key]]));
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
      if (!plugin.scopes || plugin.scopes.includes(options.scope ?? 'agent')) rows.push({ id: `user:${plugin.name}`, plugin: plugin.name });
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
    const scope = context.scope(); scopes.set(row.id, scope);
    const injection = await scope.inject(spec.inject ?? [], child => spec.apply(child, structuredClone(merge(spec.defaults ?? {}, row.config ?? {}))));
    Object.defineProperties(report, { status: { enumerable: true, get: () => injection.state }, error: { enumerable: true, get: () => injection.error ?? '' }, missingDeps: { enumerable: true, get: () => injection.deps.filter(dep => !scope.has(dep)) } });
  }
  return { context, warnings, rows: reports, dumpConfig: () => reports.map(row => ({ ...row })), unmount: async (id: string) => { const scope = scopes.get(id); if (!scope) return false; await scope.unload(); scopes.delete(id); return true; }, close: () => context.unload() };
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
