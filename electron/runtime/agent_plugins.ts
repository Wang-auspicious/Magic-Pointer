import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {validate, type JsonSchema} from './tools';
import type {Data, ModelRunner} from './agent';
import {record as asObject} from './context';
import {PluginContext} from './plugin_context';
import {RuntimeModules} from './runtime_modules';
import type {EventSession} from './session';
import type {ToolRegistry} from './tools';
import type {HookManager} from './hooks';
export {PluginContext, PromptSections} from './plugin_context';

export interface RuntimePlugin {
  name: string;
  inject?: string[];
  scopes?: string[];
  defaults?: Data;
  config_schema?: JsonSchema;
  apply(context: PluginContext, config: Data): void | Promise<void>;
}
export interface PluginRow {
  id: string;
  plugin: string;
  config?: Data;
  disabled?: boolean;
}
export function extensionPaths(userDataDir: string) {
  return {
    plugins:
      process.env.MAGIC_POINTER_PLUGIN_DIR ||
      path.join(userDataDir, 'data', 'plugins'),
    mcp:
      process.env.MAGIC_POINTER_MCP_CONFIG ||
      path.join(userDataDir, 'data', 'mcp.json'),
    patch:
      process.env.MAGIC_POINTER_HARNESS_CONFIG ||
      path.join(userDataDir, 'data', 'harness.patch.json'),
  };
}
export interface HarnessConfiguration {
  schemaVersion: 1;
  patch: Record<string, Partial<PluginRow>>;
  disabledPluginDirectories: string[];
  [key: string]: unknown;
}
export async function loadHarnessConfiguration(
  file: string,
): Promise<HarnessConfiguration> {
  try {
    const document = asObject(JSON.parse(await readFile(file, 'utf8')));
    if (
      document.schemaVersion !== 1 ||
      !document.patch ||
      Array.isArray(document.patch) ||
      typeof document.patch !== 'object'
    ) {
      throw new Error(`Invalid harness configuration: ${file}`);
    }
    const disabled = document.disabledPluginDirectories ?? [];
    if (
      !Array.isArray(disabled) ||
      disabled.some(id => typeof id !== 'string')
    ) {
      throw new Error(`Invalid disabled plugin directories: ${file}`);
    }
    return {
      ...document,
      schemaVersion: 1,
      patch: document.patch as Record<string, Partial<PluginRow>>,
      disabledPluginDirectories: disabled,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {schemaVersion: 1, patch: {}, disabledPluginDirectories: []};
    }
    throw error;
  }
}
const merge = (base: Data, patch: Data): Data =>
  Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(patch)])].map(key => [
      key,
      key in patch
        ? Object.keys(asObject(base[key])).length &&
          Object.keys(asObject(patch[key])).length
          ? merge(asObject(base[key]), asObject(patch[key]))
          : patch[key]
        : base[key],
    ]),
  );
const pluginScopes = (plugin: RuntimePlugin) =>
  plugin.scopes ??
  (plugin.inject?.includes('surface_adapters') ? ['surface'] : ['agent']);
export async function bootPlugins(options: {
  context?: PluginContext;
  directory: string;
  scope?: string;
  core?: Record<string, unknown>;
  builtins?: RuntimePlugin[];
  rows?: PluginRow[];
  patch?: Record<string, Partial<PluginRow>>;
  disabledPluginDirectories?: string[];
}) {
  const context = options.context ?? new PluginContext();
  const specs = new Map<string, RuntimePlugin>(
    (options.builtins ?? []).map(plugin => [plugin.name, plugin]),
  );
  for (const [key, value] of Object.entries(options.core ?? {})) {
    await context.provide(key, value);
  }
  const modules = context.has('modules')
    ? context.get<RuntimeModules>('modules')
    : new RuntimeModules(
        context,
        context.has('tools') ? context.get<ToolRegistry>('tools') : undefined,
        context.has('session')
          ? context.get<EventSession>('session')
          : undefined,
        context.has('hooks') ? context.get<HookManager>('hooks') : undefined,
      );
  if (!context.has('modules')) {
    await context.provide('modules', modules);
  }
  const warnings: string[] = [];
  const rows = [...(options.rows ?? [])];
  if ((options.scope ?? 'agent') === 'agent' && context.has('session')) {
    const {taskContextModule} =
      require('./task_context_module') as typeof import('./task_context_module');
    specs.set('task-context-module', {
      name: 'task-context-module',
      inject: ['modules', 'session'],
      apply: ctx => {
        ctx
          .get<RuntimeModules>('modules')
          .register(taskContextModule(ctx.get<EventSession>('session')));
      },
    });
    rows.push({id: 'task-context-module', plugin: 'task-context-module'});
  }
  const disabledDirectories: Data[] = [];
  for (const entry of await readdir(options.directory, {
    withFileTypes: true,
  }).catch(() => [])) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (options.disabledPluginDirectories?.includes(entry.name)) {
      disabledDirectories.push({
        id: `directory:${entry.name}`,
        plugin: entry.name,
        directory: entry.name,
        status: 'disabled',
        config: {},
        error: '',
        missingDeps: [],
      });
      continue;
    }
    try {
      const directory = path.join(options.directory, entry.name);
      const manifest = asObject(
        JSON.parse(await readFile(path.join(directory, 'plugin.json'), 'utf8')),
      );
      const modulePath = path.resolve(
        directory,
        String(manifest.main || 'plugin.js'),
      );
      const loaded = await import(pathToFileURL(modulePath).href);
      const plugin = (loaded.default ??
        loaded.plugin ??
        loaded) as RuntimePlugin;
      if (!plugin.name || typeof plugin.apply !== 'function') {
        throw new Error('Plugin needs name and apply');
      }
      if (manifest.name && manifest.name !== plugin.name) {
        throw new Error('Plugin manifest name does not match its export');
      }
      if (specs.has(plugin.name)) {
        throw new Error(`Duplicate plugin ${plugin.name}`);
      }
      specs.set(plugin.name, plugin);
      if (pluginScopes(plugin).includes(options.scope ?? 'agent')) {
        rows.push({id: `user:${plugin.name}`, plugin: plugin.name});
      }
    } catch (error) {
      warnings.push(`${entry.name}: ${(error as Error).message}`);
    }
  }
  const byId = new Map<string, PluginRow>();
  for (const row of rows) {
    if (byId.has(row.id)) {
      throw new Error(`Duplicate plugin row ${row.id}`);
    }
    byId.set(row.id, {...row, ...options.patch?.[row.id]});
  }
  for (const [id, patch] of Object.entries(options.patch ?? {})) {
    if (!byId.has(id) && patch.plugin) {
      byId.set(id, {id, plugin: patch.plugin, ...patch});
    }
  }
  const reports: Data[] = [...disabledDirectories];
  const scopes = new Map<string, PluginContext>();
  for (const row of byId.values()) {
    const report: Data = {
      id: row.id,
      plugin: row.plugin,
      config: row.config ?? {},
      status: row.disabled ? 'disabled' : 'waiting',
      error: '',
      missingDeps: [],
    };
    reports.push(report);
    if (row.disabled) {
      continue;
    }
    const spec = specs.get(row.plugin);
    if (!spec) {
      report.status = 'error';
      report.error = 'Unknown plugin';
      continue;
    }
    if (!pluginScopes(spec).includes(options.scope ?? 'agent')) {
      report.status = 'out_of_scope';
      continue;
    }
    const config = structuredClone(
      merge(spec.defaults ?? {}, row.config ?? {}),
    );
    report.config = config;
    const errors = spec.config_schema
      ? validate(config, spec.config_schema)
      : [];
    if (errors.length) {
      report.status = 'error';
      report.error = errors.join('; ');
      continue;
    }
    const scope = context.scope();
    scopes.set(row.id, scope);
    const injection = await scope.inject(spec.inject ?? [], child =>
      spec.apply(child, structuredClone(config)),
    );
    Object.defineProperties(report, {
      status: {enumerable: true, get: () => injection.state},
      error: {enumerable: true, get: () => injection.error ?? ''},
      missingDeps: {
        enumerable: true,
        get: () => injection.deps.filter(dep => !scope.has(dep)),
      },
    });
  }
  return {
    context,
    modules,
    warnings,
    rows: reports,
    dumpConfig: () => reports.map(row => ({...row})),
    unmount: async (id: string) => {
      const scope = scopes.get(id);
      if (!scope) {
        return false;
      }
      await scope.unload();
      scopes.delete(id);
      return true;
    },
    close: () => context.unload(),
  };
}

export function modelPlugins(model: ModelRunner): RuntimePlugin[] {
  return [
    {name: 'llm-provider', apply: ctx => ctx.provideUp('llm', model)},
    {
      name: 'model-client',
      inject: ['llm'],
      apply: ctx => ctx.provideUp('model_client', ctx.get('llm')),
    },
  ];
}

export async function bootSurfacePlugins(
  userDataDir: string,
  adapters: unknown,
  builtins: RuntimePlugin[] = [],
) {
  const paths = extensionPaths(userDataDir);
  return bootPlugins({
    directory: paths.plugins,
    scope: 'surface',
    ...(await loadHarnessConfiguration(paths.patch)),
    builtins,
    rows: builtins.map(plugin => ({id: plugin.name, plugin: plugin.name})),
    core: {surface_adapters: adapters},
  });
}

export class HarnessRuntimeHost {
  private closed = false;
  private constructor(
    readonly report: Awaited<ReturnType<typeof bootPlugins>>,
    readonly options: Parameters<typeof bootPlugins>[0],
  ) {}
  static async create(
    options: Parameters<typeof bootPlugins>[0],
  ): Promise<HarnessRuntimeHost> {
    return new HarnessRuntimeHost(
      await bootPlugins({...options, directory: '', scope: 'global'}),
      options,
    );
  }
  async openScope(
    core: Record<string, unknown> = {},
    rows: PluginRow[] = [],
  ): Promise<Awaited<ReturnType<typeof bootPlugins>>> {
    if (this.closed) {
      throw new Error('Harness runtime host is closed');
    }
    return bootPlugins({
      ...this.options,
      context: this.report.context.scope(),
      core,
      rows,
      scope: 'agent',
    });
  }
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.report.close();
  }
}
