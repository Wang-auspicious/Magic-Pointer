import {AsyncLocalStorage} from 'node:async_hooks';
import {ToolRegistry, type ToolSpec} from './tools';
import type {SurfaceAdapter} from './desktop_adapters';
import type {RuntimeModule} from './runtime_modules';
import type {Data, AgentOptions} from './agent';
import type {HookManager, ToolHook} from './hooks';

type Disposer = () => void | Promise<void>;
type Listener = (
  payload: unknown,
  next?: () => Promise<unknown>,
) => unknown | Promise<unknown>;
type Injection = {
  deps: string[];
  activate: (context: PluginContext) => void | Promise<void>;
  child?: PluginContext;
  state: string;
  error?: string;
};
const activeWork = new AsyncLocalStorage<PluginContext>();
export class PluginContext {
  private services = new Map<string, unknown>();
  private effects: Disposer[] = [];
  private children = new Set<PluginContext>();
  private injections = new Set<Injection>();
  private events = new Map<string, {mode: string; listeners: Listener[]}>();
  private closing = false;
  private unloading?: Promise<void>;
  private work = new Set<Promise<unknown>>();
  constructor(readonly parent?: PluginContext) {
    parent?.children.add(this);
  }
  private serviceViews = new Map<string, {value: object; view: object}>();
  private resolve<T>(key: string): T {
    if (this.services.has(key)) {
      return this.services.get(key) as T;
    }
    if (this.parent) {
      return this.parent.resolve<T>(key);
    }
    throw new Error(`Missing service: ${key}`);
  }
  get<T = unknown>(key: string): T {
    const value = this.resolve<T>(key);
    if (
      !value ||
      typeof value !== 'object' ||
      !['tools', 'hooks', 'prompt', 'surface_adapters', 'modules'].includes(key)
    ) {
      return value;
    }
    const cached = this.serviceViews.get(key);
    if (cached?.value === value) {
      return cached.view as T;
    }
    const view = new Proxy(value, {
      get: (target, property) => {
        if (key === 'tools' && property === 'register') {
          return (spec: ToolSpec) => this.registerTool(spec);
        }
        const member = Reflect.get(target, property);
        if (typeof member !== 'function') {
          return member;
        }
        if (key === 'modules' && property === 'register') {
          return (definition: RuntimeModule) =>
            member.call(target, definition, this);
        }
        if (key === 'hooks' && property === 'add') {
          return (phase: 'pre' | 'post' | 'stop', hook: ToolHook) =>
            this.effect(
              member.call(target, phase, (payload: Data) =>
                this.run(() => hook(payload)),
              ),
            );
        }
        if (key === 'prompt' && property === 'add') {
          return (section: Parameters<PromptSections['add']>[0]) =>
            this.effect(
              member.call(target, {
                ...section,
                render: (options: AgentOptions) =>
                  this.run(() => section.render(options)),
              }),
            );
        }
        if (key === 'surface_adapters' && property === 'register') {
          return (adapter: SurfaceAdapter) =>
            this.effect(
              member.call(target, {
                id: adapter.id,
                matches: (window: Data) =>
                  !this.closing && adapter.matches(window),
                resolve: (...args: Parameters<SurfaceAdapter['resolve']>) =>
                  this.run(() => adapter.resolve(...args)),
              }),
            );
        }
        if (key === 'tools' && property === 'onSessionEnd') {
          return (listener: () => void | Promise<void>) =>
            this.effect(member.call(target, () => this.run(listener)));
        }
        return member.bind(target);
      },
    });
    this.serviceViews.set(key, {value, view});
    return view as T;
  }
  has(key: string): boolean {
    return this.services.has(key) || !!this.parent?.has(key);
  }
  keys(): string[] {
    return [
      ...new Set([...(this.parent?.keys() ?? []), ...this.services.keys()]),
    ];
  }
  async provide(key: string, value: unknown): Promise<void> {
    if (this.closing) {
      throw new Error('Context is closing');
    }
    if (this.services.has(key)) {
      throw new Error(`Duplicate service ${key}`);
    }
    this.services.set(key, value);
    await this.refresh();
  }
  async revoke(key: string): Promise<boolean> {
    if (!this.services.delete(key)) {
      return false;
    }
    await this.refresh();
    return true;
  }
  async provideUp(key: string, value: unknown): Promise<void> {
    let root: PluginContext = this;
    while (root.parent) {
      root = root.parent;
    }
    await root.provide(key, value);
    this.effect(async () => {
      await root.revoke(key);
    });
  }
  effect(disposer: Disposer): Disposer {
    if (this.closing) {
      throw new Error('Context is closing');
    }
    let done = false;
    const owned = async () => {
      if (done) {
        return;
      }
      done = true;
      const index = this.effects.indexOf(owned);
      if (index >= 0) {
        this.effects.splice(index, 1);
      }
      await disposer();
    };
    this.effects.push(owned);
    return owned;
  }
  scope(): PluginContext {
    if (this.closing) {
      throw new Error('Context is closing');
    }
    return new PluginContext(this);
  }
  async inject(
    deps: string[],
    activate: Injection['activate'],
  ): Promise<Injection> {
    const injection: Injection = {deps, activate, state: 'waiting'};
    this.injections.add(injection);
    this.effect(async () => {
      this.injections.delete(injection);
      injection.state = 'unmounted';
      await injection.child?.unload();
    });
    await this.refresh();
    return injection;
  }
  private async refresh(): Promise<void> {
    for (const injection of this.injections) {
      const ready = injection.deps.every(dep => this.has(dep));
      if (!ready && injection.child) {
        const child = injection.child;
        injection.child = undefined;
        injection.state = 'waiting';
        await child.unload();
      } else if (ready && injection.state === 'waiting') {
        const child = this.scope();
        injection.child = child;
        injection.state = 'active';
        try {
          await injection.activate(child);
        } catch (error) {
          injection.error = (error as Error).message;
          injection.state = 'error';
          injection.child = undefined;
          await child.unload();
        }
      }
    }
    for (const child of this.children) {
      if (!child.closing) {
        await child.refresh();
      }
    }
  }
  async run<T>(callback: () => T | Promise<T>): Promise<T> {
    if (this.closing) {
      throw new Error('Context is closing');
    }
    const promise = Promise.resolve().then(() =>
      activeWork.run(this, callback),
    );
    this.work.add(promise);
    try {
      return await promise;
    } finally {
      this.work.delete(promise);
    }
  }
  declare(
    kind: string,
    mode: 'emit' | 'serial' | 'parallel' | 'waterfall',
  ): void {
    const previous = this.events.get(kind);
    if (previous && previous.mode !== mode) {
      throw new Error(`Event mode mismatch: ${kind}`);
    }
    if (!previous) {
      this.events.set(kind, {mode, listeners: []});
    }
  }
  private event(
    kind: string,
  ): {mode: string; listeners: Listener[]} | undefined {
    return this.events.get(kind) ?? this.parent?.event(kind);
  }
  on(kind: string, listener: Listener, prepend = false): Disposer {
    const event = this.event(kind);
    if (!event) {
      throw new Error(`Undeclared event: ${kind}`);
    }
    const owned: Listener = (payload, next) =>
      this.run(() => listener(payload, next));
    if (prepend) {
      event.listeners.unshift(owned);
    } else {
      event.listeners.push(owned);
    }
    return this.effect(() => {
      const index = event.listeners.indexOf(owned);
      if (index >= 0) {
        event.listeners.splice(index, 1);
      }
    });
  }
  async dispatch(kind: string, payload: unknown): Promise<unknown> {
    const event = this.event(kind);
    if (!event) {
      throw new Error(`Undeclared event: ${kind}`);
    }
    return this.run(async () => {
      const listeners = [...event.listeners];
      if (event.mode === 'parallel') {
        return Promise.allSettled(listeners.map(listener => listener(payload)));
      }
      if (event.mode === 'waterfall') {
        const next = async (index: number): Promise<unknown> =>
          index < listeners.length
            ? listeners[index](payload, () => next(index + 1))
            : payload;
        return next(0);
      }
      let result: unknown;
      for (const listener of listeners) {
        result = await listener(payload);
      }
      return event.mode === 'serial' ? result : undefined;
    });
  }
  registerTool(spec: ToolSpec): ToolSpec {
    const registry = this.resolve<ToolRegistry>('tools');
    const owned = {
      ...spec,
      execute: (args: Data, context: Parameters<ToolSpec['execute']>[1]) =>
        this.run(() => spec.execute(args, context)),
    };
    registry.register(owned);
    this.effect(() => {
      registry.unregister(owned.name, owned);
    });
    return owned;
  }
  registerHook(phase: 'pre' | 'post' | 'stop', hook: ToolHook): void {
    this.get<HookManager>('hooks').add(phase, hook);
  }
  async unload(): Promise<void> {
    for (
      let current = activeWork.getStore();
      current;
      current = current.parent
    ) {
      if (current === this) {
        throw new Error('Cannot unload a context from its own active work');
      }
    }
    if (this.unloading) {
      return this.unloading;
    }
    this.closing = true;
    this.unloading = this.dispose();
    return this.unloading;
  }
  private async dispose(): Promise<void> {
    await Promise.allSettled(this.work);
    for (const child of [...this.children]) {
      await child.unload();
    }
    for (const dispose of [...this.effects].reverse()) {
      try {
        await dispose();
      } catch {}
    }
    this.services.clear();
    this.parent?.children.delete(this);
  }
}

export class PromptSections {
  private sections = new Map<
    string,
    {
      id: string;
      order?: number;
      render: (options: AgentOptions) => string | Promise<string>;
    }
  >();
  add(section: {
    id: string;
    order?: number;
    render: (options: AgentOptions) => string | Promise<string>;
  }): Disposer {
    if (this.sections.has(section.id)) {
      throw new Error(`Duplicate prompt section: ${section.id}`);
    }
    this.sections.set(section.id, section);
    return () => {
      if (this.sections.get(section.id) === section) {
        this.sections.delete(section.id);
      }
    };
  }
  async build(options: AgentOptions): Promise<string> {
    const sections = [...this.sections.values()].sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100),
    );
    return (await Promise.all(sections.map(section => section.render(options))))
      .filter(Boolean)
      .join('\n\n');
  }
}
