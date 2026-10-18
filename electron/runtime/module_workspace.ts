import {
  bootPlugins,
  extensionPaths,
  loadHarnessConfiguration,
  PromptSections,
} from './agent_plugins';
import {HookManager} from './agent';
import {ToolRegistry} from './tools';
import {EventSession} from './session';
import type {
  ModuleActionRequest,
  ModuleActionResult,
  ModuleWorkspaceSnapshot,
} from './module_contract';

export async function handleModuleWorkspace(
  request: {
    operation: string;
    sessionId: string;
  } & Partial<ModuleActionRequest>,
  options: {root: string; userDataDir: string; signal?: AbortSignal},
): Promise<ModuleWorkspaceSnapshot | ModuleActionResult> {
  try {
    const session = await EventSession.open(
      options.userDataDir,
      request.sessionId,
      false,
    );
    const paths = extensionPaths(options.userDataDir);
    const tools = new ToolRegistry();
    const plugins = await bootPlugins({
      directory: paths.plugins,
      ...(await loadHarnessConfiguration(paths.patch)),
      core: {
        session,
        tools,
        hooks: new HookManager(),
        prompt: new PromptSections(),
        runtime: options,
      },
    });
    try {
      if (request.operation === 'modules.list') {
        const result = await plugins.modules.snapshot();
        result.errors.push(...plugins.warnings.map(message => ({message})));
        for (const row of plugins.dumpConfig()) {
          if (row.status === 'error' || row.status === 'waiting') {
            result.errors.push({
              message: `${row.id}: ${row.error || `missing services: ${JSON.stringify(row.missingDeps)}`}`,
            });
          }
        }
        return result;
      }
      if (request.operation === 'modules.invoke') {
        return await plugins.modules.invoke(
          {
            sessionId: request.sessionId,
            moduleId: request.moduleId ?? '',
            panelId: request.panelId ?? '',
            actionId: request.actionId ?? '',
          },
          options.signal,
        );
      }
      throw new Error('Unknown module workspace operation');
    } finally {
      try {
        await tools.close();
      } finally {
        await plugins.close();
      }
    }
  } catch (error) {
    return {
      ok: false,
      sessionId: request.sessionId,
      modules: [],
      errors: [],
      error: (error as Error).message,
    };
  }
}
