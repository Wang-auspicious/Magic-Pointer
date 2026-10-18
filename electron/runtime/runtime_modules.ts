import {randomUUID} from 'node:crypto';
import type {Data} from './agent';
import type {HookManager} from './hooks';
import {
  authorizeAccess,
  scopeFromEvents,
  record as asObject,
  type AccessRequest,
} from './context';
import type {PluginContext} from './plugin_context';
import type {EventSession} from './session';
import type {ToolRegistry, ToolSpec} from './tools';
import type {
  ModsPanel,
  ModuleActionRequest,
  ModuleActionResult,
  ModuleRequestContext,
  ModuleWorkspaceSnapshot,
} from './module_contract';

export interface RuntimeModuleCommand {
  id: string;
  label: string;
  tool: Omit<ToolSpec, 'name'> & {name?: string};
  present?(
    value: unknown,
  ):
    | NonNullable<ModuleActionResult['result']>
    | Promise<NonNullable<ModuleActionResult['result']>>;
}
export interface RuntimeModulePanel {
  id: string;
  render(): Omit<ModsPanel, 'moduleId'> | Promise<Omit<ModsPanel, 'moduleId'>>;
  actions?: Record<string, {commandId: string; arguments?: Data}>;
}
export interface RuntimeModule {
  id: string;
  title: string;
  description?: string;
  commands?: RuntimeModuleCommand[];
  panels?: RuntimeModulePanel[];
  requestContext?(request: {
    sessionId: string;
    turn: number;
    signal: AbortSignal;
  }): string | Promise<string>;
}
interface RegisteredModule {
  definition: RuntimeModule;
  owner: PluginContext;
  commands: Map<string, string>;
}
const validId = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class RuntimeModules {
  private modules = new Map<string, RegisteredModule>();
  private contextErrors = new Map<string, string>();
  constructor(
    private readonly context: PluginContext,
    private readonly tools?: ToolRegistry,
    private readonly session?: EventSession,
    private readonly hooks?: HookManager,
  ) {}

  private savedContextError(moduleId: string): string | undefined {
    const event = [...(this.session?.events ?? [])]
      .reverse()
      .find(
        row =>
          row.data.moduleId === moduleId &&
          (row.type === 'module/context_recovered' ||
            (row.type === 'module/error' &&
              row.data.phase === 'request_context')),
      );
    return event?.type === 'module/error'
      ? String(event.data.message)
      : undefined;
  }

  register(
    definition: RuntimeModule,
    owner = this.context,
  ): () => Promise<void> {
    if (!validId.test(definition.id) || !definition.title.trim()) {
      throw new Error('Module requires a kebab-case id and a title');
    }
    if (this.modules.has(definition.id)) {
      throw new Error(`Duplicate module: ${definition.id}`);
    }
    const moduleScope = owner.scope();
    const commands = new Map<string, string>();
    for (const command of definition.commands ?? []) {
      if (!validId.test(command.id) || commands.has(command.id)) {
        throw new Error(`Invalid or duplicate module command: ${command.id}`);
      }
      if (!this.tools) {
        throw new Error('Module commands require the tools service');
      }
      const name =
        command.tool.name ??
        `Modules.${definition.id.replaceAll('-', '_')}.${command.id.replaceAll('-', '_')}`;
      moduleScope.registerTool({
        ...command.tool,
        name,
        deferred: true,
        used_backend:
          command.tool.used_backend ?? `runtime.module.${definition.id}`,
      });
      commands.set(command.id, name);
    }
    const panelIds = new Set<string>();
    for (const panel of definition.panels ?? []) {
      if (!validId.test(panel.id) || panelIds.has(panel.id)) {
        throw new Error(`Invalid or duplicate module panel: ${panel.id}`);
      }
      panelIds.add(panel.id);
      for (const action of Object.values(panel.actions ?? {})) {
        if (!commands.has(action.commandId)) {
          throw new Error(`Unknown module command: ${action.commandId}`);
        }
      }
    }
    const registration = {definition, owner: moduleScope, commands};
    this.modules.set(definition.id, registration);
    moduleScope.effect(() => {
      if (this.modules.get(definition.id) === registration) {
        this.modules.delete(definition.id);
        this.contextErrors.delete(definition.id);
      }
    });
    const dispose = owner.effect(() => moduleScope.unload());
    return async () => {
      await dispose();
    };
  }

  async snapshot(): Promise<ModuleWorkspaceSnapshot> {
    await this.session?.refresh();
    const result: ModuleWorkspaceSnapshot = {
      ok: true,
      sessionId: this.session?.id ?? '',
      modules: [],
      errors: [],
    };
    for (const {definition, owner} of this.modules.values()) {
      const panels: ModsPanel[] = [];
      let error =
        this.contextErrors.get(definition.id) ??
        (definition.requestContext
          ? this.savedContextError(definition.id)
          : undefined);
      for (const panel of definition.panels ?? []) {
        try {
          const rendered = await owner.run(() => panel.render());
          panels.push({...rendered, id: panel.id, moduleId: definition.id});
        } catch (failure) {
          error = (failure as Error).message;
          result.errors.push({moduleId: definition.id, message: error});
        }
      }
      result.modules.push({
        id: definition.id,
        title: definition.title,
        description: definition.description,
        status: error ? 'error' : 'active',
        commands: (definition.commands ?? []).map(command => ({
          id: command.id,
          label: command.label,
          description: command.tool.description,
        })),
        panels,
      });
      if (error && !result.errors.some(row => row.moduleId === definition.id)) {
        result.errors.push({moduleId: definition.id, message: error});
      }
    }
    return result;
  }

  async requestContext(request: {
    sessionId: string;
    turn: number;
    signal: AbortSignal;
  }): Promise<ModuleRequestContext[]> {
    const contexts: ModuleRequestContext[] = [];
    for (const {definition, owner} of this.modules.values()) {
      if (!definition.requestContext) {
        continue;
      }
      request.signal.throwIfAborted();
      try {
        const text = await owner.run(() => definition.requestContext!(request));
        if (typeof text !== 'string') {
          throw new Error('Module request context must be text');
        }
        if (text.trim()) {
          contexts.push({moduleId: definition.id, text});
        }
        this.contextErrors.delete(definition.id);
        if (this.savedContextError(definition.id)) {
          await this.session?.append('module/context_recovered', {
            moduleId: definition.id,
            step: request.turn,
          });
        }
      } catch (error) {
        request.signal.throwIfAborted();
        const message = (error as Error).message;
        this.contextErrors.set(definition.id, message);
        await this.session?.append('module/error', {
          moduleId: definition.id,
          phase: 'request_context',
          step: request.turn,
          message,
        });
      }
    }
    return contexts;
  }

  async invoke(
    request: ModuleActionRequest,
    signal?: AbortSignal,
  ): Promise<ModuleActionResult> {
    const started = performance.now();
    let usedBackend: string | undefined;
    try {
      if (
        !this.session ||
        request.sessionId !== this.session.id ||
        !this.tools
      ) {
        throw new Error('Module action requires the current task session');
      }
      await this.session.refresh();
      const module = this.modules.get(request.moduleId);
      const panel = module?.definition.panels?.find(
        row => row.id === request.panelId,
      );
      if (!module || !panel) {
        throw new Error('Unknown module action');
      }
      const current = await module.owner.run(() => panel.render());
      const action = panel.actions?.[request.actionId];
      if (!action) {
        throw new Error('Unknown module action');
      }
      const button = current.sections
        .flatMap(section => section.actions ?? [])
        .find(row => row.id === request.actionId);
      if (!button || button.disabled || current.status.state === 'disabled') {
        throw new Error('Module action is unavailable');
      }
      const name = module.commands.get(action.commandId)!;
      const spec = this.tools.get(name);
      const hook = await this.hooks?.run('pre', {
        tool_name: name,
        input: structuredClone(action.arguments ?? {}),
      });
      if (hook?.allowed === false) {
        throw new Error(String(hook.reason));
      }
      const args = hook
        ? asObject(hook.input)
        : structuredClone(action.arguments ?? {});
      const call = {id: `module-${randomUUID()}`, name, arguments: args};
      const errors = this.tools.validateInput(spec, args);
      if (errors.length) {
        throw new Error(errors.join('; '));
      }
      const {permissionFor} = require('./agent') as typeof import('./agent');
      if (
        this.tools.effect(name, args) !== 'read' ||
        permissionFor(
          {
            registry: this.tools,
            session: this.session,
            allowedEffects: ['read'],
          },
          call,
          new Set(),
        ) !== 'allow'
      ) {
        throw new Error(
          'This command requires an Agent turn and its normal permission flow',
        );
      }
      if (spec.access_for) {
        const access = authorizeAccess(
          scopeFromEvents(this.session.events, this.session.id),
          spec.access_for(args) as AccessRequest,
        );
        if (!access.allowed) {
          throw new Error(access.reason);
        }
      }
      await this.session.append('module/command_started', {
        ...request,
        commandId: action.commandId,
        callId: call.id,
      });
      const result = await this.tools.execute(call, {signal});
      usedBackend = result.used_backend ?? undefined;
      await this.session.append('module/command_finished', {
        ...request,
        commandId: action.commandId,
        result,
      });
      const post = await this.hooks?.run('post', {
        tool_name: name,
        input: args,
        result,
      });
      if (result.is_error || post?.allowed === false) {
        throw new Error(
          result.error_message ||
            String(post?.reason || 'Module command failed'),
        );
      }
      const value = asObject(result.value);
      const command = module.definition.commands?.find(
        row => row.id === action.commandId,
      );
      const presented = command?.present
        ? await module.owner.run(() => command.present!(result.value))
        : undefined;
      return {
        ...(await this.snapshot()),
        result: presented ?? {
          text:
            typeof value.text === 'string'
              ? value.text
              : JSON.stringify(result.value),
          panelId:
            typeof value.panelId === 'string' ? value.panelId : request.panelId,
        },
        usedBackend,
        timingMs: performance.now() - started,
      };
    } catch (error) {
      return {
        ...(await this.snapshot()),
        ok: false,
        error: (error as Error).message,
        usedBackend,
        timingMs: performance.now() - started,
      };
    }
  }
}
