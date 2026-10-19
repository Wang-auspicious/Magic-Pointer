import path from 'node:path';
import {readFile} from 'node:fs/promises';
import type {RuntimeOptions} from './index';

type Data = Record<string, any>;
export async function handleFabric(
  payload: Data,
  options: RuntimeOptions,
): Promise<Data> {
  const {root, userDataDir, signal} = options;
  const operation = String(payload.operation || 'catalog');
  if (operation === 'modules.list' || operation === 'modules.invoke') {
    const {handleModuleWorkspace} =
      require('./module_workspace') as typeof import('./module_workspace');
    return handleModuleWorkspace(
      {
        operation,
        sessionId: String(payload.sessionId || ''),
        moduleId: payload.moduleId,
        panelId: payload.panelId,
        actionId: payload.actionId,
        inputs: payload.inputs,
      },
      options,
    );
  }
  const {settingsStore} =
    require('./model_admin') as typeof import('./model_admin');
  const store = settingsStore(userDataDir);
  const settings = store.load();
  if (operation === 'catalog') {
    const {Fabric} = require('./fabric') as typeof import('./fabric');
    const fabric = new Fabric(options);
    return {ok: true, recipes: await fabric.catalog()};
  }
  if (operation.startsWith('skills.candidates.')) {
    const {handleSkillCandidates} =
      require('./context_skill_candidates') as typeof import('./context_skill_candidates');
    return handleSkillCandidates(payload, userDataDir);
  }
  if (
    operation.startsWith('models.') ||
    operation.startsWith('model.') ||
    operation === 'visual_relay.plan'
  ) {
    const {handleModels} =
      require('./model_admin') as typeof import('./model_admin');
    return handleModels(payload, root, userDataDir, signal);
  }
  if (operation === 'slash.directory') {
    const {directoryPayload} =
      require('./agent_services') as typeof import('./agent_services');
    return directoryPayload(payload.workspaceRoot, userDataDir);
  }
  if (operation === 'settings.get') {
    return {ok: true, settings};
  }
  if (operation === 'settings.save') {
    const {mergeSettings} =
      require('./model_admin') as typeof import('./model_admin');
    store.save(mergeSettings(settings, payload.settings || {}));
    return {ok: true, settings: store.load()};
  }
  if (operation === 'providers') {
    const {discoverProviders} =
      require('./external') as typeof import('./external');
    return {ok: true, providers: await discoverProviders()};
  }
  if (operation === 'agent.sessions') {
    const {discoverExternalSessions} =
      require('./external') as typeof import('./external');
    return {
      ok: true,
      state: 'completed',
      sessions: await discoverExternalSessions({
        ...payload,
        cwd: payload.cwd || root,
        cwdMatch: payload.cwdMatch || settings.agents.cwd_match,
      }),
      cwd: path.resolve(payload.cwd || root),
    };
  }
  if (operation === 'agent.prompt.dispatch') {
    const {dispatchAgentPrompt} =
      require('./context_handoff') as typeof import('./context_handoff');
    return dispatchAgentPrompt(payload, userDataDir);
  }
  if (
    operation === 'agent.contexts.list' ||
    operation === 'agent.context.dispatch'
  ) {
    const {handleAgentContexts} =
      require('./context_handoff') as typeof import('./context_handoff');
    return handleAgentContexts(payload, userDataDir, {
      sessionId: payload.sessionId,
    });
  }
  if (operation === 'browser.status') {
    const endpoints: string[] =
      settings.connections.browser_devtools_endpoints || [];
    if (!settings.connections.browser_devtools_enabled) {
      return {
        ok: true,
        state: 'disabled',
        configuredEndpointCount: endpoints.length,
        reachableEndpointCount: 0,
        pageCount: 0,
        endpoints,
        reason: 'disabled_by_user',
      };
    }
    const probes = await Promise.all(
      endpoints.map(async endpoint => {
        try {
          const reply = await fetch(
            `${endpoint.replace(/\/$/, '')}/json/list`,
            {
              signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(2000)])
                : AbortSignal.timeout(2000),
            },
          );
          if (!reply.ok) {
            throw new Error(`HTTP ${reply.status}`);
          }
          const tabs = (await reply.json()) as Data[];
          return {
            endpoint,
            reachable: true,
            pages: tabs.filter(tab => tab.type === 'page'),
          };
        } catch (error) {
          return {endpoint, reachable: false, pages: [], error: String(error)};
        }
      }),
    );
    return {
      ok: true,
      state: probes.some(item => item.reachable) ? 'ready' : 'unavailable',
      configuredEndpointCount: endpoints.length,
      reachableEndpointCount: probes.filter(item => item.reachable).length,
      pageCount: probes.flatMap(item => item.pages).length,
      endpoints: probes,
    };
  }
  if (operation === 'runtime.snapshot') {
    const {Fabric} = require('./fabric') as typeof import('./fabric');
    const {locateExecutable} =
      require('./external') as typeof import('./external');
    const {resolveCapabilities} =
      require('./model_admin') as typeof import('./model_admin');
    const fabric = new Fabric(options);
    const recipes = await fabric.catalog();
    const agentIds = [
      'codex',
      'pi',
      'claude',
      'gemini',
      'cursor',
      'opencode',
      'aider',
    ];
    const agents: Data = {};
    await Promise.all(
      agentIds.map(async id => {
        agents[id] = {
          state: (await locateExecutable(id === 'cursor' ? 'cursor-agent' : id))
            ? 'ready'
            : 'unavailable',
          command: id,
          source: 'path_lookup',
        };
      }),
    );
    const capabilities = recipes.map(recipe => ({
      id: recipe.id,
      title: recipe.title,
      provider: recipe.provider,
      risk: recipe.risk,
      state:
        settings.recipe_enabled?.[recipe.id] === false
          ? 'disabled'
          : recipe.provider.startsWith('unavailable:')
            ? 'unavailable'
            : recipe.provider === 'agent.task' &&
                !Object.values(agents).some(
                  (agent: any) => agent.state === 'ready',
                )
              ? 'unavailable'
              : 'ready',
      verification: recipe.verification,
    }));
    const blocked = capabilities.filter(
      item => item.state === 'unavailable',
    ).length;
    return {
      ok: true,
      snapshot: {
        readiness: {
          state: blocked ? 'degraded' : 'ready',
          blockedCapabilityCount: blocked,
          source: 'bounded_local_probe',
        },
        workers: {agents},
        models: {
          items: await Promise.all(
            settings.models.profiles.map(async (profile: Data) => ({
              ...profile,
              resolved: await resolveCapabilities(profile, root),
            })),
          ),
          defaultProfileId: settings.models.defaultProfileId,
        },
        permissions: payload.runtimeEvidence?.permissions || {},
        capabilities,
        repairs: [],
        diagnostics: {
          platform: process.platform,
          networkRequests: 0,
          spawnedProcesses: 0,
          probeKind: 'filesystem_presence_only',
          usedBackend: 'typescript',
        },
        settings,
        recipes,
      },
    };
  }
  if (operation === 'extensions.inventory') {
    const {listSkills, extensionsInventory} =
      require('./agent_services') as typeof import('./agent_services');
    const skills = await listSkills(payload.workspaceRoot, userDataDir);
    return {
      ...(await extensionsInventory(userDataDir)),
      skills: skills.skills,
      warnings: skills.errors,
    };
  }
  if (operation === 'extensions.set-enabled') {
    const {setPluginEnabled} =
      require('./agent_services') as typeof import('./agent_services');
    try {
      return await setPluginEnabled(userDataDir, payload.id, payload.enabled);
    } catch (error) {
      return {ok: false, error: (error as Error).message};
    }
  }
  if (operation === 'capabilities.search') {
    const {Fabric} = require('./fabric') as typeof import('./fabric');
    const fabric = new Fabric(options);
    return {
      ok: true,
      capabilities: await fabric.search(
        payload.command || '',
        payload.objects || [],
        payload.selectedRecipeId || '',
        payload.limit || 6,
      ),
    };
  }
  if (operation === 'current_object') {
    const {readJson} = require('./learning') as typeof import('./learning');
    const episode = await readJson(
      path.join(userDataDir, 'current-object.json'),
      null,
    );
    return episode
      ? {ok: true, episode}
      : {ok: false, error: 'no_frozen_object'};
  }
  if (operation === 'audit.tail') {
    const raw = await readFile(
      path.join(userDataDir, 'audit.jsonl'),
      'utf8',
    ).catch(() => '');
    return {
      ok: true,
      events: raw
        .split('\n')
        .filter(Boolean)
        .slice(-Math.min(payload.limit || 100, 1000))
        .flatMap(line => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        }),
    };
  }
  if (operation.startsWith('artifacts.')) {
    const {ArtifactRegistry} =
      require('./artifacts') as typeof import('./artifacts');
    const registry = new ArtifactRegistry(userDataDir);
    if (operation === 'artifacts.list') {
      return {ok: true, artifacts: await registry.list(payload.limit || 100)};
    }
    if (operation === 'artifacts.cleanup') {
      return {
        ok: true,
        cleanup: await registry.cleanupExpired(payload.confirmed === true),
      };
    }
    if (operation === 'artifacts.restore') {
      return {
        ok: true,
        restore: payload.confirmed
          ? await registry.restore(payload.artifactId)
          : {status: 'confirmation_required', artifactId: payload.artifactId},
      };
    }
  }
  if (operation === 'provenance.objects') {
    const {ProvenanceIndex} =
      require('./context_memory') as typeof import('./context_memory');
    return {
      ok: true,
      state: 'completed',
      objects: await new ProvenanceIndex(userDataDir).objects(
        payload.limit || 200,
      ),
    };
  }
  if (operation === 'provenance.trace') {
    const {ProvenanceIndex} =
      require('./context_memory') as typeof import('./context_memory');
    return {
      ok: true,
      state: 'completed',
      trace: await new ProvenanceIndex(userDataDir).trace(
        payload.objectId || '',
      ),
    };
  }
  if (operation.startsWith('task.')) {
    const {ExternalTasks} =
      require('./external') as typeof import('./external');
    const tasks = new ExternalTasks(userDataDir);
    const id = String(payload.taskId || '');
    if (operation === 'task.list' || operation === 'task.recover') {
      return {
        ok: true,
        tasks: await tasks.list(
          payload.limit || (operation === 'task.recover' ? 500 : 100),
        ),
      };
    }
    let task: Data;
    if (operation === 'task.status') {
      task = await tasks.status(id);
    } else if (operation === 'task.cancel') {
      task = await tasks.cancel(id);
    } else if (operation === 'task.steer') {
      task = await tasks.steer(id, payload.message || '');
    } else if (operation === 'task.resume') {
      task = await tasks.resume(id);
    } else if (operation === 'task.reconfirm_target') {
      if (!payload.confirmed) {
        task = {
          taskId: id,
          status: 'confirmation_required',
          reconfirmationRequired: true,
        };
      } else {
        const {reconfirmTargetLease} =
          require('./context_policy') as typeof import('./context_policy');
        const {listWindows} =
          require('./desktop') as typeof import('./desktop');
        await tasks.mutate(id, async current => {
          if (current.status !== 'paused_target_mismatch') {
            throw new Error('target_not_paused');
          }
          current.targetLease = {
            state: 'active',
            lease: await reconfirmTargetLease(
              current.targetLease.lease,
              await listWindows(signal),
            ),
          };
          current.status = 'interrupted';
        });
        task = await tasks.resume(id);
      }
    } else {
      throw new Error(`Unknown task operation: ${operation}`);
    }
    return {ok: true, task};
  }
  const {Fabric} = require('./fabric') as typeof import('./fabric');
  const fabric = new Fabric(options);
  const {Workflows} = require('./workflow') as typeof import('./workflow');
  const workflows = new Workflows(userDataDir);
  const surface = payload.surface || 'gui';
  if (operation.startsWith('workflow.')) {
    if (operation === 'workflow.list') {
      return {
        ok: true,
        state: 'completed',
        workflows: await workflows.list(payload.limit || 100),
      };
    }
    if (operation === 'workflow.get') {
      return {
        ok: true,
        state: 'completed',
        workflowTask: workflows.public(await workflows.get(payload.taskId)),
      };
    }
    if (operation === 'workflow.approve') {
      return {
        ok: true,
        state: payload.confirmed ? 'ready' : 'confirmation_required',
        workflowTask: payload.confirmed
          ? await workflows.approve(payload.taskId, surface)
          : workflows.public(await workflows.get(payload.taskId)),
      };
    }
    if (operation === 'workflow.execute') {
      return workflows.execute(payload.taskId, fabric, surface);
    }
  }
  if (operation === 'route') {
    const result = await fabric.search(
      payload.command || '',
      payload.objects || [],
    );
    return {
      ok: true,
      match: {
        recipeId: result.length === 1 ? result[0].id : null,
        reason: result.length === 1 ? 'matched' : 'ambiguous_command',
        referenceMode: 'this',
        alternatives: result.map(item => item.id),
      },
    };
  }
  if (operation === 'plan' || operation === 'execute') {
    const planned = await fabric.plan(payload);
    if (!planned.ok) {
      return planned;
    }
    let task = await workflows.create(planned.plan, surface);
    if (operation === 'plan') {
      return {...planned, workflowTask: task};
    }
    if (payload.confirmed && task.approvalState === 'pending') {
      task = await workflows.approve(task.taskId, surface);
    }
    return workflows.execute(task.taskId, fabric, surface);
  }
  throw new Error(`Unknown fabric operation: ${operation}`);
}
