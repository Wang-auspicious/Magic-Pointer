import {createHash, randomUUID} from 'node:crypto';
import {stat, mkdir, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {
  runAgent,
  registerAgentTools,
  compactSession,
  buildSystemPrompt,
  HookManager,
  type AgentEvent,
  type AgentOptions,
} from './agent';
import {
  normalizePermissionPreset,
  PERMISSION_MODES,
  presetForPermissionMode,
} from '../permission_mode';
import {registerCodingTools} from './agent_files';
import {registerDurableMemoryTools} from './agent_memory';
import {validateAdditionalFolders} from '../workspace_folders';
import {savedWorkspaceSettings} from './workspace_settings';
import {registerSubagentTools} from './agent_background';
import {
  contextWindowFor,
  registerMemoryTools,
  registerSkillTools,
  registerWebTools,
  registerWaitTool,
  registerToolResultReader,
  initialToolNames,
  directoryPayload,
  expandSkillCommand,
  suggestNextPrompt,
} from './agent_services';
import {
  bootPlugins,
  extensionPaths,
  loadHarnessConfiguration,
  PromptSections,
  modelPlugins,
  type RuntimePlugin,
} from './agent_plugins';
import {RuntimeActivitySink} from './agent_activity';
import {EventSession} from './session';
import {ToolRegistry} from './tools';
import {resolveModelConfig, streamModel, requestVision} from './model';
import {bindDesktopWindow, prepareTaskContext} from './context_prepare';
import {latestTurnArtifactSummaries} from './artifacts';
import {registerDashboardTools} from './dashboard_tools';
import {taskSources, taskReferences, referenceRevision} from './context';
import {registerBrowserTools} from './desktop_browser';
import {
  configureDesktop,
  closeDesktop,
  registerDesktopTools,
  desktopSession,
  listWindows,
  listElements,
} from './desktop';
import {
  registerPerceptionTools,
  registerLookTool,
  lookStaleness,
  createSnapshotPerceptionBackend,
  closeOcr,
  agentModelVision,
  isAgentModelVision,
  type PerceptionBackend,
  type VisionBackend,
} from './desktop_perception';
import {registerSelectionQuickTools} from './selection_quick_tools';
import {readMcpConfigs, registerMcpDiscovery} from './mcp';
import {settingsStore} from './model_admin';
import {Fabric, registerRecipeTools} from './fabric';
import {ScreenMemory} from './context_memory';

export type Data = Record<string, any>;
export interface RuntimeOptions {
  root: string;
  userDataDir: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  onProgress?: (phase: string, fields: Data) => void;
}

export function resolveSessionId(payload: Data): string {
  const explicit = String(
    payload.agentSessionId || payload.sessionId || '',
  ).trim();
  if (
    /^agent-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(explicit) ||
    (/^(agent-studio-conv-|agent-studio-new-)[A-Za-z0-9._-]+$/.test(explicit) &&
      explicit.length <= 128)
  ) {
    return explicit;
  }
  if (payload.conversationId) {
    return `agent-studio-conv-${createHash('sha256').update(String(payload.conversationId).trim()).digest('hex').slice(0, 32)}`;
  }
  return `agent-studio-new-${randomUUID().replaceAll('-', '')}`;
}

function learningReview(payload: Data, options: RuntimeOptions): void {
  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'worker.js'), 'learning_review'],
    {
      windowsHide: true,
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        MAGIC_POINTER_USER_DATA_DIR: options.userDataDir,
      },
    },
  );
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({...payload, root: options.root}));
  child.unref();
}

export async function runRuntime(
  payload: Data,
  options: RuntimeOptions,
): Promise<Data> {
  const started = performance.now();
  const {root, userDataDir, signal} = options;
  const requestedPreset = normalizePermissionPreset(payload.permissionPreset);
  const config = resolveModelConfig(
    {
      ...payload.modelRuntime,
      effort: payload.effort || payload.modelRuntime?.effort || 'high',
    },
    root,
    userDataDir,
  );
  const envContextTokens = Number(process.env.MAGIC_POINTER_CONTEXT_TOKENS);
  const contextTokens =
    Number.isFinite(envContextTokens) && envContextTokens > 0
      ? Math.trunc(envContextTokens)
      : config.defaultContextWindow || contextWindowFor(config.model);
  if (payload.operation === 'suggest_next') {
    const turns = Array.isArray(payload.turns) ? payload.turns : [];
    // Only turns the assistant actually answered count. A session with one
    // exchange has nothing to extrapolate from, and the reference waits for
    // two before it predicts at all.
    const assistantTurns = turns.filter(turn => {
      if (!turn || typeof turn !== 'object') {
        return false;
      }
      const record = turn as Data;
      const answer = record.answer ?? record.liveProgress;
      if (typeof answer === 'string') {
        return answer.trim() !== '';
      }
      return Boolean(
        answer &&
        typeof answer === 'object' &&
        String((answer as Data).answer || '').trim() !== '',
      );
    }).length;
    return {
      ok: true,
      suggestion: await suggestNextPrompt(
        streamModel,
        {root, userDataDir, config, signal},
        JSON.stringify({
          turns,
          object: payload.object || {},
        }),
        {assistantTurns, aborted: signal?.aborted === true},
      ),
    };
  }
  let instruction = String(
    payload.question || payload.instruction || '',
  ).trim();
  if (!instruction && !payload.inputResponse && !payload.resume) {
    throw new Error('问题不能为空。');
  }
  if ([...instruction].length > 12000) {
    throw new Error('问题最多 12000 字。');
  }
  const session = await EventSession.open(
    userDataDir,
    resolveSessionId(payload),
  );
  const preset =
    requestedPreset ??
    presetForPermissionMode(session.permissionMode('default')) ??
    'workspace-write';
  const permissionMode = PERMISSION_MODES[preset];
  if (payload.resume && !instruction && !payload.inputResponse) {
    const pendingInput = session.pendingInput();
    if (pendingInput) {
      return {
        ok: true,
        answer: String(
          pendingInput.question || 'This task is waiting for your answer.',
        ),
        agentSessionId: session.id,
        permissionPreset: preset,
        hasPendingWork: true,
        awaitingUserInput: true,
        pendingInput,
        usedBackend: 'magic_pointer.session_recovery',
        timingMs: performance.now() - started,
      };
    }
  }
  const savedFolders = savedWorkspaceSettings(session);
  const workspaceState = path.join(userDataDir, 'workspace.txt');
  const savedWorkspace = (
    await readFile(workspaceState, 'utf8').catch(() => '')
  ).trim();
  const validSavedWorkspace =
    savedWorkspace &&
    (await stat(savedWorkspace).then(
      info => info.isDirectory(),
      () => false,
    ))
      ? savedWorkspace
      : undefined;
  const selectedWorkspace = String(payload.workspaceRoot ?? '').trim();
  const workspace = Object.hasOwn(payload, 'workspaceRoot')
    ? selectedWorkspace
      ? path.resolve(selectedWorkspace)
      : undefined
    : savedFolders
      ? savedFolders.root || undefined
      : validSavedWorkspace;
  if (workspace && !(await stat(workspace)).isDirectory()) {
    throw new Error('Workspace must be an existing directory');
  }
  const additionalFolders = await validateAdditionalFolders(
    workspace || '',
    payload.additionalFolders ??
      (workspace ? savedFolders?.additionalFolders : []),
  );
  const sink = new RuntimeActivitySink(
    (phase, fields) => options.onProgress?.(phase, fields),
    {model: config.model, apiMode: config.apiMode},
  );
  const onEvent = (event: AgentEvent) => {
    sink.onEvent(event);
    options.onEvent?.(event);
  };
  const registry = new ToolRegistry();
  const hooks = new HookManager();
  configureDesktop(root);
  let files: ReturnType<typeof registerCodingTools> | undefined;
  const contextTools = new ToolRegistry();
  const prepared = await prepareTaskContext(
    session,
    {...payload, workspacePath: workspace || '', additionalFolders},
    {root, userDataDir, registry: contextTools},
  );
  const settings = settingsStore(userDataDir).load();
  const extensions = extensionPaths(userDataDir);
  const prompt = new PromptSections();
  const selectionSnapshot =
    payload.selectionSnapshot || payload.object?.selectionSnapshot || {};
  const perception = createSnapshotPerceptionBackend(selectionSnapshot);
  const lookFreshness = (): {stale: boolean; detail?: string} => {
    const frame = selectionSnapshot.frame_lease || selectionSnapshot.frameLease;
    return lookStaleness(
      session.events,
      String(frame?.capturedAtUtc || selectionSnapshot.captured_at || ''),
    );
  };
  const vision: VisionBackend = agentModelVision((images, prompt, signal) =>
    requestVision(config, {images, prompt, signal, timeoutMs: 30000}),
  );
  const perceptionOptions = {
    snapshot: selectionSnapshot,
    uploadScreenshots: settings.privacy.upload_screenshots !== false,
    sources: (id: string) =>
      prepared.taskContext.sources?.find(
        (source: Data) => source.sourceId === id,
      ),
    windowReadScope: (hwnd: number) =>
      prepared.authorizeAccess({action: 'read', windowIds: [`w-${hwnd}`]})
        .allowed,
  };
  const builtins: RuntimePlugin[] = [
    {
      name: 'harness-tools',
      apply: ctx => registerAgentTools(ctx.get('tools'), session, onEvent),
    },
    {
      name: 'tool-result-reader',
      apply: ctx => registerToolResultReader(ctx.get('tools'), session),
    },
    {
      name: 'coding-tools',
      apply: ctx => {
        if (workspace) {
          files = registerCodingTools(
            ctx.get('tools'),
            workspace,
            session,
            additionalFolders,
          );
        }
      },
    },
    {
      name: 'memory-tools',
      apply: ctx => {
        registerMemoryTools(ctx.get('tools'), userDataDir, session);
        registerDurableMemoryTools(ctx.get('tools'), {userDataDir, workspace});
      },
    },
    {
      name: 'context-tools',
      apply: ctx => {
        const tools = ctx.get<ToolRegistry>('tools');
        for (const tool of contextTools.list()) {
          if (!tools.list().some(existing => existing.name === tool.name)) {
            tools.register(tool);
          }
        }
      },
    },
    {
      name: 'dashboard-tools',
      apply: ctx =>
        registerDashboardTools(ctx.get('tools'), {
          userDataDir,
          authorizeAccess: prepared.authorizeAccess,
          sources: () => taskSources(session.events),
        }),
    },
    {
      name: 'skill-writer',
      apply: ctx => {
        if (workspace) {
          registerSkillTools(ctx.get('tools'), userDataDir);
        }
      },
    },
    {name: 'web-tools', apply: ctx => registerWebTools(ctx.get('tools'))},
    {
      name: 'wait-tools',
      apply: ctx =>
        registerWaitTool(ctx.get('tools'), {
          workspace,
          windows: async () =>
            (await listWindows(signal)).filter(window =>
              perceptionOptions.windowReadScope(window.hwnd),
            ),
          elements: async hwnd =>
            perceptionOptions.windowReadScope(hwnd)
              ? listElements(hwnd, signal)
              : [],
        }),
    },
    {
      name: 'desktop-action-tools',
      apply: ctx =>
        registerDesktopTools(
          ctx.get('tools'),
          desktopSession(
            session.id,
            Number(payload.object?.hwnd || payload.object?.windowHwnd || 0) ||
              undefined,
          ),
          prepared.authorizeAccess,
          window => bindDesktopWindow(session, window),
          options.onProgress
            ? guide =>
                options.onProgress?.('agent_cursor', {
                  action: 'guide',
                  id: 'guide',
                  x: guide.x,
                  y: guide.y,
                  ttlMs: guide.ttlMs,
                  captionB64: Buffer.from(guide.caption, 'utf8').toString(
                    'base64',
                  ),
                })
            : undefined,
        ),
    },
    {
      name: 'browser-tools',
      apply: ctx =>
        registerBrowserTools(
          ctx.get('tools'),
          desktopSession(session.id),
          window => bindDesktopWindow(session, window),
        ),
    },
    {
      name: 'local-action-tools',
      apply: ctx =>
        registerRecipeTools(
          ctx.get('tools'),
          new Fabric(options, config),
          session,
        ),
    },
    {
      name: 'selection-quick-tools',
      apply: ctx => {
        const snapshot =
          payload.selectionSnapshot || payload.object?.selectionSnapshot;
        if (snapshot) {
          registerSelectionQuickTools(ctx.get('tools'), snapshot);
        }
      },
    },
    {
      name: 'perception-provider',
      apply: ctx => ctx.provideUp('perception', perception),
    },
    {name: 'vision-provider', apply: ctx => ctx.provideUp('vision', vision)},
    {
      name: 'perception-tools',
      inject: ['tools', 'perception'],
      apply: ctx =>
        registerPerceptionTools(ctx.get('tools'), {
          ...perceptionOptions,
          backend: ctx.get<PerceptionBackend>('perception'),
          vision:
            ctx.has('vision') && isAgentModelVision(ctx.get('vision'))
              ? ctx.get<VisionBackend>('vision')
              : (images, prompt, signal) =>
                  ctx.has('vision')
                    ? ctx.get<VisionBackend>('vision')(images, prompt, signal)
                    : Promise.resolve({
                        text: '',
                        usedBackend: 'vision_unavailable',
                      }),
        }),
    },
    {
      name: 'look-tool',
      inject: ['tools', 'vision'],
      apply: ctx =>
        registerLookTool(ctx.get('tools'), {
          ...perceptionOptions,
          vision: ctx.get<VisionBackend>('vision'),
          freshness: lookFreshness,
        }),
    },
    {
      name: 'mcp-provider',
      defaults: {config_path: extensions.mcp},
      apply: (ctx, cfg) => {
        ctx.effect(
          registerMcpDiscovery(
            ctx.get('tools'),
            readMcpConfigs(String(cfg.config_path)),
          ),
        );
      },
    },
    {
      name: 'system-prompt',
      apply: ctx => {
        ctx
          .get<PromptSections>('prompt')
          .add({id: 'default', order: 0, render: buildSystemPrompt});
      },
    },
    {
      name: 'delegate-tool',
      apply: ctx => {
        registerSubagentTools(ctx.get('tools'), {
          root,
          userDataDir,
          workspace,
          additionalFolders,
          projectContext: payload.projectContext,
          session,
          config,
          permissionMode,
          onEvent,
          allowedTools: payload.permissionGrants || [],
          deniedTools: payload.permissionDenials || [],
          maxTokens: config.defaultMaxTokens || 32768,
          contextTokens,
        });
      },
    },
    ...modelPlugins(streamModel),
  ];
  const plugins = await bootPlugins({
    directory: extensions.plugins,
    ...(await loadHarnessConfiguration(extensions.patch)),
    scope: 'agent',
    builtins,
    rows: builtins.map(plugin => ({id: plugin.name, plugin: plugin.name})),
    core: {tools: registry, session, hooks, prompt, runtime: options},
  });
  registry.setInitialTools(
    initialToolNames({
      workspace,
      taskContext: prepared.taskContext,
      selectionSnapshot:
        payload.selectionSnapshot ||
        payload.snapshot ||
        payload.object?.selectionSnapshot,
      object: payload.object,
      permissionMode,
    }),
  );
  let accepted: Data | null = null;
  try {
    if (payload.inputResponse) {
      const response = payload.inputResponse;
      const requestId = String(response.requestId || response.request_id || '');
      const answered = await session.answer(
        requestId,
        response.response || response,
      );
      accepted = answered.data;
      instruction = '';
      options.onProgress?.('user_input_accepted', {
        b64: Buffer.from(JSON.stringify(accepted)).toString('base64'),
      });
    }
    const common: AgentOptions = {
      root,
      userDataDir,
      session,
      registry,
      instruction,
      inputId: String(payload.taskInput?.inputId || '') || undefined,
      outputArtifact:
        payload.outputArtifact === undefined
          ? undefined
          : payload.outputArtifact === null
            ? null
            : {
                title: String(payload.outputArtifact.title || 'Result')
                  .trim()
                  .slice(0, 160),
                kind:
                  payload.outputArtifact.kind === 'text' ? 'text' : 'markdown',
              },
      projectContext: payload.projectContext,
      additionalFolders,
      evidence: prepared.evidence,
      hasSelection: Boolean(
        selectionSnapshot.frameLease ||
        selectionSnapshot.frameLeaseId ||
        prepared.taskContext.references?.some(
          (reference: Data) => reference.active && reference.frameLeaseId,
        ),
      ),
      model: request =>
        plugins.context.get<AgentOptions['model']>('model_client')(request),
      requestContext: request => plugins.modules.requestContext(request),
      config,
      workspace: workspace || '',
      permissionMode,
      signal,
      onEvent,
      hooks,
      allowedTools: payload.permissionGrants || [],
      deniedTools: payload.permissionDenials || [],
      onceTools: Array.isArray(payload.permissionGrantOnce)
        ? payload.permissionGrantOnce
            .map(String)
            .map((rule: string) => rule.trim())
            .filter(Boolean)
        : [],
      contextTokens,
      maxTokens: config.defaultMaxTokens || 32768,
      authorizeAccess: prepared.authorizeAccess,
      metadata: {
        conversationId: payload.conversationId || '',
        object: payload.object || {},
      },
    };
    common.system = await prompt.build(common);
    const command =
      /^\/(help|compact|permission|model|cwd|rewind)(?:\s+([\s\S]*))?$/.exec(
        instruction,
      );
    if (command) {
      const name = command[1];
      const rest = (command[2] || '').trim();
      if (name === 'help') {
        return {
          ok: true,
          answer: JSON.stringify(
            {
              ...(await directoryPayload(workspace, userDataDir)),
              plugins: plugins.dumpConfig(),
              warnings: plugins.warnings,
            },
            null,
            2,
          ),
          command: {type: name},
          agentSessionId: session.id,
          usedBackend: 'runtime.slash_help',
        };
      }
      if (name === 'compact') {
        const compacted = await compactSession(
          common,
          common.system,
          signal || new AbortController().signal,
          true,
        );
        return {
          ok: compacted,
          answer: compacted ? '已压缩任务上下文。' : '当前上下文未压缩。',
          command: {type: name},
          agentSessionId: session.id,
          usedBackend: 'runtime.compaction',
        };
      }
      if (name === 'permission') {
        const selected = normalizePermissionPreset(rest || undefined) ?? preset;
        if (rest) {
          const mode = PERMISSION_MODES[selected];
          await session.append('permission/mode', {mode, requested: mode});
        }
        return {
          ok: true,
          command: {type: name, preset: selected},
          permissionPreset: selected,
          agentSessionId: session.id,
          taskContext: {
            ...prepared.taskContext,
            permissionMode: session.permissionMode(permissionMode),
          },
          answer: rest
            ? `权限预设：${rest}`
            : Object.keys(PERMISSION_MODES).join(' · '),
        };
      }
      if (name === 'model') {
        return {
          ok: true,
          command: {type: name, value: rest},
          answer: config.model,
        };
      }
      if (name === 'cwd') {
        if (!rest) {
          return {
            ok: true,
            command: {type: name},
            answer: workspace || '未绑定工作区。',
          };
        }
        const raw = rest.replace(/^"(.*)"$/, '$1');
        const target = path.resolve(
          raw === '~'
            ? os.homedir()
            : raw.startsWith('~/') || raw.startsWith('~\\')
              ? path.join(os.homedir(), raw.slice(2))
              : raw,
        );
        if (!(await stat(target)).isDirectory()) {
          throw new Error('Workspace must be an existing directory');
        }
        await mkdir(path.dirname(workspaceState), {recursive: true});
        await writeFile(workspaceState, target, 'utf8');
        return {
          ok: true,
          command: {type: name, path: target},
          answer: `工作区已切换为 ${target}，下一次发送即生效。`,
        };
      }
      if (name === 'rewind') {
        if (!files) {
          throw new Error('未绑定工作区。');
        }
        const result = await files.rewind(rest ? Number(rest) : 0);
        return {
          ok: true,
          command: {type: name},
          answer: JSON.stringify(result),
          result,
        };
      }
    }
    instruction = await expandSkillCommand(instruction, workspace, userDataDir);
    if (session.deriveMessages().length === 0 && payload.turns?.length) {
      await session.appendMessage({
        role: 'user',
        origin: 'data',
        injected: true,
        content: `[旧对话首次迁移]\n${JSON.stringify(payload.turns)}`,
      });
    }
    await session.append('runtime/effort', {effort: config.effort});
    const terminal = await runAgent({
      ...common,
      instruction,
      evidence: prepared.evidence,
    });
    sink.flush();
    const successful = ['completed', 'awaiting_user'].includes(terminal.reason);
    const plan =
      [...session.events].reverse().find(event => event.type === 'plan/updated')
        ?.data || null;
    const result = {
      ok: successful,
      answer: terminal.message,
      error: successful ? undefined : terminal.message,
      loopTerminated: !successful,
      loopTerminatedReason: successful ? undefined : terminal.reason,
      usedBackend: terminal.usedBackend,
      permissionPreset: presetForPermissionMode(
        session.permissionMode(permissionMode),
      ),
      receipts: [terminal.receipt],
      events: terminal.results,
      activities: sink.activities,
      trajectory: sink.trajectory,
      modelUsage: terminal.model_usage,
      timingMs: performance.now() - started,
      agentSessionId: session.id,
      hasPendingWork:
        terminal.reason !== 'completed' ||
        terminal.receipt.status !== 'succeeded',
      pluginReport: {rows: plugins.dumpConfig(), warnings: plugins.warnings},
      interactionLedger: session.events
        .filter(
          event =>
            event.type.startsWith('interaction/') ||
            event.type === 'receipt/issued',
        )
        .map(event => event.data),
      awaitingUserInput: terminal.reason === 'awaiting_user',
      pendingInput: terminal.pending_input,
      taskContext: {
        ...prepared.taskContext,
        sources: taskSources(session.events),
        references: taskReferences(session.events),
        referenceRevision: referenceRevision(session.events),
        permissionMode: session.permissionMode(permissionMode),
      },
      artifacts: latestTurnArtifactSummaries(session.events),
      runtimeTurn:
        [...session.events].reverse().find(event => event.type === 'turn/end')
          ?.data.turn ?? null,
      plan,
      thinking: sink.trajectory
        .filter(item => item.kind === 'message')
        .map(item => item.reasoning || '')
        .join(''),
      ...(accepted ? {accepted: true, inputAnswer: accepted} : {}),
    };
    if (
      settings.privacy.screen_memory_enabled === true &&
      terminal.reason === 'completed' &&
      (payload.selectionSnapshot || payload.snapshot)
    ) {
      const snapshot = payload.selectionSnapshot || payload.snapshot;
      const context = snapshot.context || {};
      const window = snapshot.source_window || context.window || {};
      const originalCommand = String(
        payload.command || payload.question || payload.instruction || '',
      );
      const reference = (
        (prepared.inputArtifact.references as Data[]) || []
      ).find(item => item?.sourceId && item?.locator);
      const sensitive =
        /密码|口令|验证码|密钥|secret|password|token|sk-[A-Za-z0-9]/i.test(
          `${originalCommand}\n${terminal.message}`,
        );
      try {
        await new ScreenMemory(
          path.join(userDataDir, 'screen-memory.json'),
          true,
        ).record({
          app: String(context.app || ''),
          windowTitle: String(window.title || ''),
          excerpt: originalCommand,
          sourceId: reference?.sourceId || null,
          locator: reference?.locator || null,
          sensitive,
        });
      } catch (error) {
        options.onProgress?.('screen_memory_error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (
      settings.privacy.background_learning_enabled === true &&
      ['completed', 'stalled', 'invariant_failed', 'budget_exhausted'].includes(
        terminal.reason,
      )
    ) {
      learningReview(
        {
          sessionId: session.id,
          terminalReason: terminal.reason,
          modelRuntime: config,
        },
        options,
      );
    }
    return result;
  } finally {
    sink.flush();
    try {
      await registry.close();
    } finally {
      try {
        await plugins.close();
      } finally {
        closeOcr();
        closeDesktop();
      }
    }
  }
}
