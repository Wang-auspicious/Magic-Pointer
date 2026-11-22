const {contextBridge, ipcRenderer} = require('electron');
import {normalizeModelSelection} from './conversation_model';
import {normalizePermissionPreset} from './permission_mode';

type PayloadCallback = (payload: unknown) => void;
type SignalCallback = () => void;
type UnknownRecord = Record<string, unknown>;

interface StageCommandPayload {
  command?: unknown;
  inputMode?: unknown;
  keptStrokeIndexes?: unknown;
  pickedElement?: {
    rect?: {height?: unknown; width?: unknown; x?: unknown; y?: unknown};
    source?: unknown;
  };
  selectionSessionToken?: unknown;
}

const MAX_COMMAND_CHARS = 4000;
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function normalizeEffort(value: unknown): string {
  const candidate = String(value || '')
    .trim()
    .toLowerCase();
  return EFFORT_LEVELS.has(candidate) ? candidate : 'high';
}

function boundedTaskInput(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  try {
    const encoded = JSON.stringify(value);
    if (encoded.length > 48 * 1024) {
      return null;
    }
    const parsed = JSON.parse(encoded);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function onPayload(channel: string, callback: PayloadCallback): void {
  ipcRenderer.on(
    channel,
    (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload),
  );
}

function onSubscribedPayload(
  channel: string,
  callback: PayloadCallback,
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown) =>
    callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function onSignal(channel: string, callback: SignalCallback): void {
  ipcRenderer.on(channel, () => callback());
}

contextBridge.exposeInMainWorld('magicPointer', {
  readFileDiff: (reference: {beforePath: string | null; afterPath: string}) =>
    ipcRenderer.invoke('files:diff-preview', reference),
  ready: () => ipcRenderer.send('overlay:renderer-ready'),
  gestureReady: (token: unknown) =>
    ipcRenderer.send('overlay:gesture-ready', {token}),
  hide: () => ipcRenderer.send('overlay:hide'),
  done: (payload: unknown) => ipcRenderer.send('overlay:done', payload),
  gestureStarted: (token: unknown) =>
    ipcRenderer.send('overlay:gesture-start', {token}),
  gestureStroke: (token: unknown, index: unknown) =>
    ipcRenderer.send('overlay:gesture-stroke', {token, index}),
  onShow: (callback: PayloadCallback) => onPayload('overlay:show', callback),
  onHide: (callback: SignalCallback) => onSignal('overlay:hide', callback),
  onCursor: (callback: PayloadCallback) =>
    onPayload('overlay:cursor', callback),
  onAgentCursor: (callback: PayloadCallback) =>
    onPayload('overlay:agent-cursor', callback),
  onGuidePoint: (callback: PayloadCallback) =>
    onPayload('overlay:guide-point', callback),
  onElementGhosts: (callback: PayloadCallback) =>
    onPayload('overlay:element-ghosts', callback),
  guideFinished: () => ipcRenderer.send('overlay:guide-finished'),
  onGestureInput: (callback: PayloadCallback) =>
    onPayload('overlay:gesture-input', callback),
  onGestureSubmit: (callback: PayloadCallback) =>
    onPayload('overlay:gesture-submit', callback),
  onResult: (callback: PayloadCallback) =>
    onPayload('overlay:result', callback),
});

contextBridge.exposeInMainWorld('magicPointerPanel', {
  hide: () => ipcRenderer.send('panel:hide'),
  resize: (payload: unknown) => ipcRenderer.send('panel:resize', payload),
  submitSelectionCommand: (payload: unknown) =>
    ipcRenderer.send('panel:submit-selection-command', payload),
  executeAction: (payload: unknown) =>
    ipcRenderer.send('panel:execute-action', payload),
  showContextualResult: (payload: unknown) =>
    ipcRenderer.send('panel:show-contextual-result', payload),
  onShow: (callback: PayloadCallback) => onPayload('panel:show', callback),
  onHide: (callback: SignalCallback) => onSignal('panel:hide', callback),
  onResult: (callback: PayloadCallback) => onPayload('panel:result', callback),
});

contextBridge.exposeInMainWorld('magicPointerStage', {
  respondInput: (payload: unknown) =>
    ipcRenderer.invoke('stage:respond-input', payload),
  listHistorySources: () => ipcRenderer.invoke('stage:history-sources'),
  onConversationProgress: (callback: PayloadCallback) =>
    onPayload('conversations:progress', callback),
  openArtifact: (payload: unknown) =>
    ipcRenderer.invoke('stage:open-artifact', payload),
  openTask: (payload: {
    selectionSessionToken: string;
    fallbackToStudio?: boolean;
  }) => ipcRenderer.invoke('stage:open-task', payload),
  saveToLearnNote: (payload: unknown) =>
    ipcRenderer.invoke('stage:save-to-learn-note', payload),
  handoffToLearn: (payload: unknown) =>
    ipcRenderer.invoke('stage:handoff-to-learn', payload),
  ready: () => ipcRenderer.send('stage:renderer-ready'),
  show: () => ipcRenderer.send('stage:show'),
  reportState: (payload: unknown) => ipcRenderer.send('stage:state', payload),
  hidden: () => ipcRenderer.send('stage:hidden'),
  dismiss: () => ipcRenderer.send('stage:dismiss'),
  retryActivation: () => ipcRenderer.send('stage:retry-activation'),
  triggerTourSteps: (steps: unknown[]) =>
    ipcRenderer.invoke('cu-overlay:teach-start', {steps}),
  submitSelectionCommand: (payload: StageCommandPayload) =>
    ipcRenderer.send('stage:submit-selection-command', {
      selectionSessionToken: payload?.selectionSessionToken || null,
      command: String(payload?.command || '').slice(0, MAX_COMMAND_CHARS),
      inputMode: payload?.inputMode || null,
      keptStrokeIndexes: Array.isArray(payload?.keptStrokeIndexes)
        ? payload.keptStrokeIndexes
            .slice(0, 12)
            .map((value: unknown) => Number(value) || 0)
        : [],
      pickedElement:
        payload?.pickedElement && payload.pickedElement.rect
          ? {
              rect: {
                x: Number(payload.pickedElement.rect.x) || 0,
                y: Number(payload.pickedElement.rect.y) || 0,
                width: Number(payload.pickedElement.rect.width) || 0,
                height: Number(payload.pickedElement.rect.height) || 0,
              },
              source: String(
                payload.pickedElement.source || 'structured',
              ).slice(0, 20),
            }
          : null,
    }),
  executeAction: (payload: unknown) =>
    ipcRenderer.send('stage:execute-action', payload),
  undoAction: (
    payload: {taskId?: unknown; sessionId?: unknown; actionId?: unknown} = {},
  ) =>
    ipcRenderer.invoke('actions:undo', {
      taskId: String(payload?.taskId || payload?.sessionId || '').slice(0, 200),
      actionId: String(payload?.actionId || '').slice(0, 200),
    }),
  contextAction: (payload: unknown) =>
    ipcRenderer.send('stage:context-action', payload),
  stopSelectionCommand: (payload: {selectionSessionToken?: unknown}) =>
    ipcRenderer.invoke('stage:stop-selection-command', {
      selectionSessionToken: String(payload?.selectionSessionToken || ''),
    }),
  steerSelectionCommand: (payload: {
    selectionSessionToken?: unknown;
    text?: unknown;
    taskInput?: unknown;
  }) =>
    ipcRenderer.invoke('stage:steer-selection-command', {
      selectionSessionToken: payload?.selectionSessionToken || null,
      text: String(payload?.text || '').slice(0, 4000),
      taskInput: boundedTaskInput(payload?.taskInput),
    }),
  insertResultText: (payload: {
    text?: unknown;
    selectionSessionToken?: unknown;
  }) =>
    ipcRenderer.send('stage:insert-result-text', {
      text: String(payload?.text || ''),
      selectionSessionToken: payload?.selectionSessionToken || null,
    }),
  expandPassage: (payload: {
    context?: unknown;
    passage?: unknown;
    selectionSessionToken?: unknown;
  }) =>
    ipcRenderer.invoke('stage:expand-passage', {
      selectionSessionToken: payload?.selectionSessionToken || null,
      passage: String(payload?.passage || '').slice(0, 8000),
      context: String(payload?.context || '').slice(0, 8000),
    }),
  pickElement: (payload: {
    selectionSessionToken?: unknown;
    x?: unknown;
    y?: unknown;
  }) =>
    ipcRenderer.invoke('stage:pick-element', {
      x: Number(payload?.x) || 0,
      y: Number(payload?.y) || 0,
      selectionSessionToken: String(payload?.selectionSessionToken || ''),
    }),
  listAgentSessions: (selectionSessionToken: unknown) =>
    ipcRenderer.invoke('stage:agent-sessions', {
      selectionSessionToken: String(selectionSessionToken || ''),
    }),
  dispatchAgentPrompt: (payload: {
    prompt?: unknown;
    provider?: unknown;
    selectionSessionToken?: unknown;
    sessionId?: unknown;
  }) =>
    ipcRenderer.invoke('stage:dispatch-agent-prompt', {
      selectionSessionToken: String(payload?.selectionSessionToken || ''),
      prompt: String(payload?.prompt || ''),
      provider: String(payload?.provider || ''),
      sessionId: String(payload?.sessionId || ''),
    }),
  setMouseCapture: (
    enabled: unknown,
    options: {requestFocus?: boolean; regions?: unknown[]} = {},
  ) =>
    ipcRenderer.send('stage:set-mouse-capture', {
      enabled: enabled === true,
      requestFocus: options?.requestFocus === true,
      regions: Array.isArray(options?.regions)
        ? options.regions.slice(0, 16)
        : [],
    }),
  onShow: (callback: PayloadCallback) => onPayload('stage:show', callback),
  onUpdate: (callback: PayloadCallback) => onPayload('stage:update', callback),
  onCardPatch: (callback: PayloadCallback) =>
    onPayload('stage:card-patch', callback),
  onHide: (callback: SignalCallback) => onSignal('stage:hide', callback),
  onPointerInput: (callback: PayloadCallback) =>
    onPayload('stage:pointer-input', callback),
  onModelHealth: (callback: PayloadCallback) =>
    onPayload('stage:model-health', callback),
});

contextBridge.exposeInMainWorld('magicPointerDashboard', {
  desktopPerception: {
    status: () => ipcRenderer.invoke('desktop-perception:status'),
    activate: () => ipcRenderer.invoke('desktop-perception:activate'),
    setPaused: (paused: boolean) => ipcRenderer.invoke('desktop-perception:set-paused', {paused}),
    onChanged: (callback: PayloadCallback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
      ipcRenderer.on('desktop-perception:changed', listener);
      return () => ipcRenderer.removeListener('desktop-perception:changed', listener);
    },
    onCaptured: (callback: (payload: unknown) => void) =>
      onPayload('desktop-perception:captured', callback),
  },
  guidedTour: {
    point: (payload: {
      x?: unknown;
      y?: unknown;
      normalized?: unknown;
      screen?: unknown;
      label?: unknown;
      caption?: unknown;
      ttlMs?: unknown;
    }) =>
      ipcRenderer.invoke('guided-tour:point', {
        x: Number(payload?.x) || 0,
        y: Number(payload?.y) || 0,
        normalized: payload?.normalized !== false,
        screen: Number(payload?.screen) || 1,
        label: String(payload?.label || '').slice(0, 80),
        caption: String(payload?.caption || '').slice(0, 140),
        ttlMs: Number(payload?.ttlMs) || 4000,
      }),
    clear: () => ipcRenderer.invoke('guided-tour:clear'),
  },
  cuOverlay: {
    startAutopilot: (payload: {
      windowTitle?: unknown;
      actionLabel?: unknown;
      steps?: unknown[];
    }) => ipcRenderer.invoke('cu-overlay:autopilot-start', payload),
    autopilotUpdate: (payload: {
      windowTitle?: unknown;
      actionLabel?: unknown;
      stepIndex?: unknown;
    }) => ipcRenderer.invoke('cu-overlay:autopilot-update', payload),
    teachStart: (steps: unknown[]) =>
      ipcRenderer.invoke('cu-overlay:teach-start', {steps}),
    recordStart: (title?: string) =>
      ipcRenderer.invoke('cu-overlay:record-start', {title}),
    recordStep: (payload: {label?: string; windowTitle?: string} = {}) =>
      ipcRenderer.invoke('cu-overlay:record-step', payload),
    recordFinish: () => ipcRenderer.invoke('cu-overlay:record-finish'),
    stop: () => ipcRenderer.invoke('cu-overlay:stop'),
    action: (action: string) => ipcRenderer.invoke('cu-overlay:action', action),
    onState: (cb: (state: unknown) => void) =>
      onPayload('cu-overlay:state', cb),
    onEvent: (cb: (event: unknown) => void) =>
      onPayload('cu-overlay:event', cb),
  },
  cuDesktop: {
    status: () => ipcRenderer.invoke('cu-desktop:status'),
    open: (payload: {width?: number; height?: number} = {}) =>
      ipcRenderer.invoke('cu-desktop:open', payload),
    resize: (payload: {width?: number; height?: number} = {}) =>
      ipcRenderer.invoke('cu-desktop:resize', payload),
    close: () => ipcRenderer.invoke('cu-desktop:close'),
    launch: (payload: {app: string; args?: string; cwd?: string}) =>
      ipcRenderer.invoke('cu-desktop:launch', payload),
    pause: (paused: boolean) =>
      ipcRenderer.invoke('cu-desktop:pause', {paused}),
    humanInput: (payload: UnknownRecord) =>
      ipcRenderer.invoke('cu-desktop:human-input', payload),
    setStreamVisible: (visible: boolean) =>
      ipcRenderer.invoke('cu-desktop:set-stream-visible', {visible}),
    snapshot: () => ipcRenderer.invoke('cu-desktop:snapshot'),
    agentAct: (payload: UnknownRecord) =>
      ipcRenderer.invoke('cu-desktop:agent-act', payload),
    onFrame: (cb: (frame: unknown) => void) =>
      onPayload('cu-desktop:frame', cb),
    onState: (cb: (state: unknown) => void) =>
      onPayload('cu-desktop:state', cb),
    onCursor: (cb: (cursors: unknown) => void) =>
      onPayload('cu-desktop:cursor', cb),
    onOpenViewport: (cb: (reason: unknown) => void) =>
      onPayload('cu-desktop:open-viewport', cb),
  },
  vault: {
    overview: () => ipcRenderer.invoke('vault:overview'),
    selectDir: () => ipcRenderer.invoke('vault:select-dir'),
    readNote: (relativePath: string) =>
      ipcRenderer.invoke('vault:read-note', {relativePath}),
    saveNote: (payload: {
      title?: unknown;
      folder?: unknown;
      tags?: unknown;
      source?: unknown;
      body?: unknown;
    }) => ipcRenderer.invoke('vault:save-note', payload),
    toggleTodo: (payload: {
      filePath?: unknown;
      lineIndex?: unknown;
      done?: unknown;
    }) => ipcRenderer.invoke('vault:toggle-todo', payload),
  },
  learn: {
    listCourses: () => ipcRenderer.invoke('learn:courses:list'),
    getCourse: (payload?: {courseId?: unknown; activate?: unknown}) =>
      ipcRenderer.invoke('learn:course:get', payload || {}),
    annotate: (payload: {
      courseId?: unknown;
      mark?: Record<string, unknown>;
      type?: unknown;
      fb?: unknown;
      quote?: unknown;
      section?: unknown;
      note?: unknown;
    }) => ipcRenderer.invoke('learn:course:annotate', payload),
    promoteLemma: (payload: {
      courseId?: unknown;
      title?: unknown;
      quote?: unknown;
      insight?: unknown;
      section?: unknown;
    }) => ipcRenderer.invoke('learn:course:promote-lemma', payload),
    recordCheckin: (payload: {
      courseId?: unknown;
      question?: unknown;
      selectedIndex?: unknown;
      selectedLabel?: unknown;
      unsure?: unknown;
      reasoningNote?: unknown;
      nodeId?: unknown;
    }) => ipcRenderer.invoke('learn:course:checkin', payload),
    getGraph: (payload?: {courseId?: unknown}) =>
      ipcRenderer.invoke('learn:graph:get', payload || {}),
    runDream: (payload?: {courseId?: unknown}) =>
      ipcRenderer.invoke('learn:dream:run', payload || {}),
  },
  hide: () => ipcRenderer.send('dashboard:hide'),
  setTheme: (theme: unknown) => ipcRenderer.send('dashboard:theme', {theme}),
  fabricRequest: (operation: unknown, payload: UnknownRecord = {}) =>
    ipcRenderer.send('dashboard:fabric-request', {operation, ...payload}),
  saveFabricSettings: (settings: unknown) =>
    ipcRenderer.invoke('dashboard:settings:save', {settings}),
  getFabricSettings: () => ipcRenderer.invoke('dashboard:settings:get'),
  modelsCatalog: (options: {refresh?: boolean} = {}) =>
    ipcRenderer.invoke('models:catalog', {refresh: options.refresh === true}),
  connectModel: (input: import('./model_connection').ModelConnectionInput) =>
    ipcRenderer.invoke('models:connect', input),
  testModelConnection: (
    input: import('./model_connection').ModelConnectionInput,
  ) => ipcRenderer.invoke('models:test-connection', input),
  listModelConnectionModels: (input: import('./model_connection').ModelConnectionInput) =>
    ipcRenderer.invoke('models:list-connection', input),
  selectModel: (model: unknown, profileId?: string) =>
    ipcRenderer.invoke('models:select', {model, profileId}),
  modelQuota: (options: {force?: unknown; selection?: unknown} = {}) =>
    ipcRenderer.invoke('models:quota', {
      force: options?.force === true,
      selection: normalizeModelSelection(options.selection),
    }),
  slashDirectory: () => ipcRenderer.invoke('slash:directory'),
  undoAction: (
    payload: {taskId?: unknown; sessionId?: unknown; actionId?: unknown} = {},
  ) =>
    ipcRenderer.invoke('actions:undo', {
      taskId: String(payload?.taskId || payload?.sessionId || '').slice(0, 200),
      actionId: String(payload?.actionId || '').slice(0, 200),
    }),
  openRoute: (payload: unknown) =>
    ipcRenderer.send('dashboard:route-open', payload),
  runtimeSnapshot: {
    get: (options: {force?: boolean} = {}) =>
      ipcRenderer.invoke('runtime-snapshot:get', {
        force: options?.force === true,
      }),
    onChanged: (callback: PayloadCallback) =>
      onPayload('runtime-snapshot:changed', callback),
  },
  onShow: (callback: PayloadCallback) => onPayload('dashboard:show', callback),
  onFabricState: (callback: PayloadCallback) =>
    onPayload('dashboard:fabric-state', callback),
  onRouteResult: (callback: PayloadCallback) =>
    onPayload('dashboard:route-result', callback),
  onPreflightEvent: (callback: PayloadCallback) =>
    onPayload('dashboard:preflight-event', callback),
  onModelHealth: (callback: PayloadCallback) =>
    onPayload('dashboard:model-health', callback),
  refreshModelHealth: () =>
    ipcRenderer.invoke('dashboard:model-health-refresh'),
  sessionTimeline: () => ipcRenderer.invoke('dashboard:session-timeline'),
  stash: {
    list: () => ipcRenderer.invoke('stash:list'),
    addNote: (payload: UnknownRecord = {}) =>
      ipcRenderer.invoke('stash:add-note', {
        text: String(payload.text || '').slice(0, 200_000),
        summary: String(payload.summary || '').slice(0, 2000),
        userCategory: String(payload.userCategory || '').slice(0, 80),
        sourceId: String(payload.sourceId || '').slice(0, 300),
        sourceTimeMs: Number(payload.sourceTimeMs) || undefined,
        locator: boundedTaskInput(payload.locator),
      }),
    addFiles: () => ipcRenderer.invoke('stash:add-files'),
    search: (payload: UnknownRecord = {}) =>
      ipcRenderer.invoke('stash:search', {
        query: String(payload.query || '').slice(0, 2000),
        category: String(payload.category || '').slice(0, 80),
        limit: Math.max(1, Math.min(200, Number(payload.limit) || 50)),
      }),
    open: (id: unknown) =>
      ipcRenderer.invoke('stash:open', String(id || '').slice(0, 200)),
    updateCategory: (id: unknown, category: unknown) =>
      ipcRenderer.invoke('stash:update-category', {
        id: String(id || '').slice(0, 200),
        category: String(category || '').slice(0, 80),
      }),
    remove: (id: unknown) =>
      ipcRenderer.invoke('stash:remove', String(id || '').slice(0, 200)),
    describe: (imagePath: unknown) =>
      ipcRenderer.invoke('stash:describe', imagePath),
    onEntry: (callback: PayloadCallback) => onPayload('stash:entry', callback),
  },
  personalActivity: {
    read: (date?: string) =>
      ipcRenderer.invoke('personal-activity:read', {date}),
    configure: (patch: UnknownRecord) =>
      ipcRenderer.invoke('personal-activity:configure', patch),
    generate: (date: string) =>
      ipcRenderer.invoke('personal-activity:generate', {date}),
    pickRoot: () => ipcRenderer.invoke('personal-activity:pick-root'),
    openSource: (payload: UnknownRecord) =>
      ipcRenderer.invoke('personal-activity:open-source', payload),
    clear: () => ipcRenderer.invoke('personal-activity:clear'),
  },
  projects: {
    startTerminal: (projectRoot: string, relativePath = '') =>
      ipcRenderer.invoke('projects:terminal-start', {
        projectRoot,
        path: relativePath,
      }),
    writeTerminal: (input: string) =>
      ipcRenderer.invoke('projects:terminal-write', {input}),
    stopTerminal: () => ipcRenderer.invoke('projects:terminal-stop'),
    onTerminalEvent: (callback: PayloadCallback) =>
      onPayload('projects:terminal-event', callback),
    list: () => ipcRenderer.invoke('projects:list'),
    create: (input: import('./project_store').ProjectCreateInput) =>
      ipcRenderer.invoke('projects:create', input),
    update: (
      root: string,
      patch: import('./project_context').ProjectDetailsPatch,
    ) => ipcRenderer.invoke('projects:update', {root, patch}),
    open: () => ipcRenderer.invoke('projects:open'),
    addDocuments: (projectId: string, paths: string[]) =>
      ipcRenderer.invoke('projects:add-documents', {projectId, paths}),
    addText: (
      projectId: string,
      input: import('./project_context').ProjectTextInput,
    ) => ipcRenderer.invoke('projects:add-text', {projectId, input}),
    removeDocument: (projectId: string, documentId: string) =>
      ipcRenderer.invoke('projects:remove-document', {projectId, documentId}),
    readMaterial: (
      projectId: string,
      reference: import('./project_context').ProjectMaterialRef,
    ) =>
      ipcRenderer.invoke('projects:read-material', {projectId, reference}),
    openMaterial: (
      projectId: string,
      reference: import('./project_context').ProjectMaterialRef,
    ) =>
      ipcRenderer.invoke('projects:open-material', {projectId, reference}),
    pickFiles: (projectRoot: unknown, kind: unknown = 'files') =>
      ipcRenderer.invoke('projects:pick-files', {
        projectRoot: String(projectRoot || '')
          .trim()
          .slice(0, 500),
        kind: kind === 'folder' ? 'folder' : 'files',
      }),
    tree: (projectRoot: unknown, relativePath: unknown = '') =>
      ipcRenderer.invoke('projects:tree', {
        projectRoot: String(projectRoot || '')
          .trim()
          .slice(0, 500),
        path: String(relativePath || '')
          .trim()
          .slice(0, 1000),
      }),
    prepareDeletedFile: (
      projectRoot: string,
      relativePath: string,
      base: 'head' | 'index',
    ) =>
      ipcRenderer.invoke('projects:prepare-deleted-file', {
        projectRoot,
        path: relativePath,
        base,
      }),
    readFile: (projectRoot: unknown, relativePath: unknown) =>
      ipcRenderer.invoke('projects:read-file', {
        projectRoot: String(projectRoot || '')
          .trim()
          .slice(0, 500),
        path: String(relativePath || '')
          .trim()
          .slice(0, 1000),
      }),
    environment: (projectRoot: unknown, conversationId: unknown = '') =>
      ipcRenderer.invoke('projects:environment', {
        projectRoot: String(projectRoot || '')
          .trim()
          .slice(0, 500),
        conversationId: String(conversationId || '')
          .trim()
          .slice(0, 120),
      }),
    worktree: (
      payload: {
        action?: unknown;
        projectRoot?: unknown;
        conversationId?: unknown;
        path?: unknown;
        baseBranch?: unknown;
        previousBranch?: unknown;
      } = {},
    ) =>
      ipcRenderer.invoke('projects:worktree', {
        action:
          payload?.action === 'remove'
            ? 'remove'
            : payload?.action === 'checkout'
              ? 'checkout'
              : 'create',
        projectRoot: String(payload?.projectRoot || '')
          .trim()
          .slice(0, 500),
        conversationId: String(payload?.conversationId || '')
          .trim()
          .slice(0, 120),
        path: String(payload?.path || '')
          .trim()
          .slice(0, 1000),
        baseBranch: String(payload?.baseBranch || '')
          .trim()
          .slice(0, 200),
        ...(typeof payload.previousBranch === 'string'
          ? {previousBranch: payload.previousBranch.trim()}
          : {}),
      }),
    contextMenu: (projectRoot: unknown, relativePath: unknown, kind: unknown) =>
      ipcRenderer.invoke('projects:context-menu', {
        projectRoot: String(projectRoot || '')
          .trim()
          .slice(0, 500),
        path: String(relativePath || '')
          .trim()
          .slice(0, 1000),
        kind: kind === 'directory' ? 'directory' : 'file',
      }),
    openPath: (projectRoot: unknown, relativePath: unknown) =>
      ipcRenderer.invoke('projects:open-path', {
        projectRoot: String(projectRoot || '')
          .trim()
          .slice(0, 500),
        path: String(relativePath || '')
          .trim()
          .slice(0, 1000),
      }),
    openUrl: (url: unknown) =>
      ipcRenderer.invoke('projects:open-url', {
        url: String(url || '')
          .trim()
          .slice(0, 3000),
      }),
  },
  resources: {
    request: (action: import('./resource_collection_api').ResourceAction, input: import('./resource_collection_api').ResourceRequest = {}) =>
      ipcRenderer.invoke('resources:command', {action, input}),
  },
  browserView: {
    // Website content never receives this preload; only the Studio surface does.
    open: (
      url: unknown,
      bounds: UnknownRecord = {},
      projectRoot = '',
      relativePath = '',
      resourceKey = '',
    ) =>
      ipcRenderer.invoke('browser:view-open', {
        url: String(url || '')
          .trim()
          .slice(0, 3000),
        bounds,
        projectRoot,
        path: relativePath,
        resourceKey: String(resourceKey || '')
          .trim()
          .slice(0, 500),
      }),
    resize: (bounds: UnknownRecord = {}) =>
      ipcRenderer.invoke('browser:view-resize', {bounds}),
    command: (command: unknown, key: unknown = '') =>
      ipcRenderer.invoke('browser:view-command', {
        command: String(command || '')
          .trim()
          .slice(0, 40),
        key: String(key || '')
          .trim()
          .slice(0, 500),
      }),
    onState: (callback: PayloadCallback) =>
      onPayload('browser:view-state', callback),
  },
  windowControls: {
    command: (command: unknown) =>
      ipcRenderer.invoke('window:command', {
        command: String(command || '')
          .trim()
          .slice(0, 40),
      }),
  },
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    onStatus: (callback: PayloadCallback) =>
      onPayload('dashboard:update-status', callback),
  },
  conversations: {
    recovery: (payload: Record<string, unknown>) =>
      ipcRenderer.invoke('conversations:recovery', {
        conversationId: String(payload.conversationId || ''),
        action: payload.action,
        operationId: payload.operationId,
        verificationCallId: payload.verificationCallId,
        confirmed: payload.confirmed === true,
      }),
    list: () => ipcRenderer.invoke('conversations:list'),
    stats: () => ipcRenderer.invoke('conversations:stats'),
    get: (id: unknown) => ipcRenderer.invoke('conversations:get', id),
    branch: (payload: {id?: unknown; turnIndex?: unknown}) =>
      ipcRenderer.invoke('conversations:branch', {
        id: String(payload?.id || '').slice(0, 120),
        turnIndex: Number(payload?.turnIndex),
      }),
    pickWorkspace: () => ipcRenderer.invoke('conversations:pick-workspace'),
    send: (payload: {
      branch?: unknown;
      worktree?: unknown;
      workMode?: unknown;
      conversationId?: unknown;
      projectId?: unknown;
      modelSelection?: unknown;
      question?: unknown;
      resume?: unknown;
      attachments?: unknown;
      taskInput?: unknown;
      permissionPreset?: unknown;
      requestId?: unknown;
      workspaceRoot?: unknown;
      additionalFolders?: unknown;
      executionWorkspaceRoot?: unknown;
      effort?: unknown;
      permissionGrant?: unknown;
      permissionDeny?: unknown;
      permissionGrantOnce?: unknown;
      coachMode?: unknown;
      computerUseMode?: unknown;
      guidedTourSteps?: unknown;
      selectionSessionToken?: unknown;
      designCanvasSlug?: unknown;
      designViewContextXml?: unknown;
      designAnnotationsXml?: unknown;
      projectAutoModeRules?: unknown;
    }) =>
      ipcRenderer.invoke('conversations:send', {
        ...(typeof payload.branch === 'string'
          ? {branch: payload.branch.trim()}
          : {}),
        ...(typeof payload.worktree === 'boolean'
          ? {worktree: payload.worktree}
          : {}),
        ...(typeof payload?.resume === 'boolean'
          ? {resume: payload.resume}
          : {}),
        workMode:
          payload.workMode === 'learn' ||
          payload.workMode === 'design' ||
          payload.workMode === 'work' ||
          payload.workMode === 'project_coordinator'
            ? payload.workMode
            : 'code',
        ...(typeof payload.designCanvasSlug === 'string' &&
        payload.designCanvasSlug.trim()
          ? {designCanvasSlug: payload.designCanvasSlug.trim().slice(0, 120)}
          : {}),
        ...(typeof payload.designViewContextXml === 'string' &&
        payload.designViewContextXml.trim()
          ? {designViewContextXml: payload.designViewContextXml.slice(0, 64 * 1024)}
          : {}),
        ...(typeof payload.designAnnotationsXml === 'string' &&
        payload.designAnnotationsXml.trim()
          ? {designAnnotationsXml: payload.designAnnotationsXml.slice(0, 64 * 1024)}
          : {}),
        ...(Array.isArray(payload.projectAutoModeRules)
          ? {
              projectAutoModeRules: payload.projectAutoModeRules
                .filter((rule): rule is string => typeof rule === 'string')
                .slice(0, 50),
            }
          : {}),
        conversationId: String(payload?.conversationId || '').slice(0, 120),
        ...(typeof payload?.projectId === 'string'
          ? {projectId: payload.projectId}
          : {}),
        question: String(payload?.question || ''),
        modelSelection: normalizeModelSelection(payload.modelSelection),
        attachments: Array.isArray(payload?.attachments)
          ? [
              ...new Set(
                payload.attachments
                  .map(item => String(item || '').trim())
                  .filter(Boolean),
              ),
            ]
              .slice(0, 32)
              .map(item => item.slice(0, 1000))
          : [],
        taskInput: boundedTaskInput(payload?.taskInput),
        ...(Array.isArray(payload.additionalFolders)
          ? {
              additionalFolders: payload.additionalFolders.filter(
                (folder): folder is string => typeof folder === 'string',
              ),
            }
          : {}),
        permissionPreset: normalizePermissionPreset(payload.permissionPreset),
        requestId: String(payload?.requestId || '').slice(0, 120),
        ...(String(payload?.workspaceRoot || '').trim()
          ? {
              workspaceRoot: String(payload?.workspaceRoot || '')
                .trim()
                .slice(0, 500),
            }
          : {}),
        ...(String(payload?.executionWorkspaceRoot || '').trim()
          ? {
              executionWorkspaceRoot: String(
                payload?.executionWorkspaceRoot || '',
              )
                .trim()
                .slice(0, 500),
            }
          : {}),
        ...(payload.effort !== undefined
          ? {effort: normalizeEffort(payload.effort)}
          : {}),
        ...(String(payload?.permissionGrant || '').trim()
          ? {
              permissionGrant: String(payload?.permissionGrant)
                .trim()
                .slice(0, 200),
            }
          : {}),
        ...(String(payload?.permissionDeny || '').trim()
          ? {
              permissionDeny: String(payload?.permissionDeny)
                .trim()
                .slice(0, 200),
            }
          : {}),
        ...(String(payload?.permissionGrantOnce || '').trim()
          ? {
              permissionGrantOnce: String(payload?.permissionGrantOnce)
                .trim()
                .slice(0, 200),
            }
          : {}),
        ...(typeof payload?.coachMode === 'boolean'
          ? {coachMode: payload.coachMode}
          : {}),
        ...(payload?.computerUseMode === 'autopilot' ||
        payload?.computerUseMode === 'coach'
          ? {computerUseMode: payload.computerUseMode}
          : {}),
        ...(Array.isArray(payload?.guidedTourSteps)
          ? {
              guidedTourSteps: payload.guidedTourSteps
                .slice(0, 40)
                .map(step => ({...(step && typeof step === 'object' ? step : {})})),
            }
          : {}),
        ...(typeof payload?.selectionSessionToken === 'string' &&
        payload.selectionSessionToken.trim()
          ? {selectionSessionToken: payload.selectionSessionToken.trim().slice(0, 120)}
          : {}),
      }),
    respond: (payload: unknown) =>
      ipcRenderer.invoke('conversations:respond', payload),
    stopSubagent: (payload: {conversationId: string; subagentId: string}) =>
      ipcRenderer.invoke('conversations:stop-subagent', payload),
    stopWorkflow: (payload: {conversationId: string; runId: string}) =>
      ipcRenderer.invoke('conversations:stop-workflow', payload),
    subagents: (payload: {conversationId: string}) =>
      ipcRenderer.invoke('conversations:subagents', payload),
    respondSubagent: (payload: unknown) =>
      ipcRenderer.invoke('conversations:respond-subagent', payload),
    export: (id: unknown) =>
      ipcRenderer.invoke(
        'conversations:export',
        String(id || '').slice(0, 120),
      ),
    rename: (payload: {id?: unknown; title?: unknown}) =>
      ipcRenderer.invoke('conversations:rename', {
        id: String(payload?.id || '').slice(0, 120),
        title: String(payload?.title || '').slice(0, 200),
      }),
    delete: (id: unknown) =>
      ipcRenderer.invoke('conversations:delete', {
        id: String(id || '').slice(0, 120),
      }),
    setProject: (id: string, root: string) =>
      ipcRenderer.invoke('conversations:set-project', {id, root}),
    setModel: (id: string, selection: unknown) =>
      ipcRenderer.invoke('conversations:set-model', {
        id,
        selection: normalizeModelSelection(selection),
      }),
    setPermission: (id: string, preset: unknown) =>
      ipcRenderer.invoke('conversations:set-permission', {
        id,
        preset: normalizePermissionPreset(preset),
      }),
    suggest: (payload: {turns?: unknown; object?: unknown} = {}) =>
      ipcRenderer.invoke('conversations:suggest', {
        turns: Array.isArray(payload?.turns) ? payload.turns.slice(-12) : [],
        object:
          payload?.object && typeof payload.object === 'object'
            ? payload.object
            : {},
      }),
    stop: (requestId: unknown) =>
      ipcRenderer.invoke('conversations:stop', {
        requestId: String(requestId || '').slice(0, 120),
      }),
    steer: (payload: {
      agentSessionId?: unknown;
      text?: unknown;
      taskInput?: unknown;
      sources?: unknown;
    }) =>
      ipcRenderer.invoke('conversations:steer', {
        agentSessionId: String(payload?.agentSessionId || '').slice(0, 120),
        text: String(payload?.text || ''),
        taskInput: boundedTaskInput(payload?.taskInput),
        sources: Array.isArray(payload?.sources)
          ? payload.sources.slice(0, 32)
          : [],
      }),
    timeline: () => ipcRenderer.invoke('conversations:timeline'),
    eventSummaries: (payload: UnknownRecord = {}) =>
      ipcRenderer.invoke('conversations:event-summaries', {
        fromMs: Math.max(0, Number(payload.fromMs) || 0),
        toMs: Math.max(0, Number(payload.toMs) || Date.now()),
        conversationIds: Array.isArray(payload.conversationIds)
          ? payload.conversationIds
              .slice(0, 500)
              .map(value => String(value || '').slice(0, 120))
          : [],
        limit: Math.max(1, Math.min(500, Number(payload.limit) || 200)),
      }),
    memories: () => ipcRenderer.invoke('conversations:memories'),
    artifacts: () => ipcRenderer.invoke('conversations:artifacts'),
    onTurn: (callback: PayloadCallback) =>
      onPayload('conversations:turn', callback),
    onProgress: (callback: PayloadCallback) =>
      onPayload('conversations:progress', callback),
    learnSend: (payload: UnknownRecord = {}) =>
      ipcRenderer.invoke('conversations:learn-send', {
        conversationId: String(payload.conversationId || '').slice(0, 120),
        ...(payload.branchId
          ? {branchId: String(payload.branchId).slice(0, 120)}
          : {}),
        parentBranchId: payload.parentBranchId
          ? String(payload.parentBranchId).slice(0, 120)
          : null,
        parentTurnIndex: Math.max(
          0,
          Math.floor(Number(payload.parentTurnIndex) || 0),
        ),
        anchor:
          payload.anchor && typeof payload.anchor === 'object'
            ? payload.anchor
            : undefined,
        ...(typeof payload.kind === 'string' && payload.kind
          ? {kind: String(payload.kind).slice(0, 32)}
          : {}),
        ...(payload.surface === 'side' || payload.surface === 'inline'
          ? {surface: payload.surface}
          : {}),
        question: String(payload.question || '').slice(0, 12000),
        lemmaRefs: Array.isArray(payload.lemmaRefs)
          ? payload.lemmaRefs.slice(0, 8)
          : [],
        requestId: String(payload.requestId || '').slice(0, 120),
        effort:
          payload.effort !== undefined
            ? normalizeEffort(payload.effort)
            : undefined,
      }),
    learnStop: (payload: {branchId?: unknown; requestId?: unknown} = {}) =>
      ipcRenderer.invoke('conversations:learn-stop', {
        branchId: String(payload.branchId || '').slice(0, 120),
        requestId: String(payload.requestId || '').slice(0, 120),
      }),
    learnPatch: (payload: UnknownRecord = {}) =>
      ipcRenderer.invoke('conversations:learn-patch', payload),
    onLearnProgress: (callback: PayloadCallback) =>
      onPayload('conversations:learn-progress', callback),
  },
  contextTrackers: {
    list: () => ipcRenderer.invoke('context-trackers:list'),
    create: (payload: Record<string, unknown>) =>
      ipcRenderer.invoke('context-trackers:create', payload),
    update: (payload: Record<string, unknown>) =>
      ipcRenderer.invoke('context-trackers:update', payload),
    runNow: (trackerId: string) =>
      ipcRenderer.invoke('context-trackers:run-now', {trackerId}),
    onChanged: (callback: () => void) =>
      onPayload('context-trackers:changed', callback),
    setEnabled: (trackerId: string, enabled: boolean) =>
      ipcRenderer.invoke('context-trackers:set-enabled', {trackerId, enabled}),
    remove: (trackerId: string) =>
      ipcRenderer.invoke('context-trackers:remove', {trackerId}),
    material: (payload: {
      conversationId: string;
      sourceId: string;
      action: string;
      task?: string;
      cadence?: string;
      startAtMs?: number;
    }) =>
      ipcRenderer.invoke('context-trackers:material', {
        conversationId: String(payload.conversationId || '').slice(0, 120),
        sourceId: String(payload.sourceId || '').slice(0, 4096),
        action: String(payload.action || ''),
        task: String(payload.task || '').slice(0, 4000),
        cadence: String(payload.cadence || 'filesystem'),
        startAtMs: payload.startAtMs,
      }),
  },
  extensions: {
    inventory: () => ipcRenderer.invoke('extensions:inventory'),
    setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('extensions:set-enabled', {id, enabled}),
  },
  modules: {
    list: (payload: {conversationId: string}) => ipcRenderer.invoke('modules:list', payload),
    invoke: (payload: Omit<import('./runtime/module_contract').ModuleActionRequest, 'sessionId'> & {conversationId: string}) => ipcRenderer.invoke('modules:invoke', payload),
  },
  artifacts: {
    undo: (payload: {
      conversationId?: unknown;
      artifactId?: unknown;
      revision?: unknown;
      confirmed?: unknown;
    }) =>
      ipcRenderer.invoke('artifacts:undo', {
        conversationId: String(payload.conversationId || ''),
        artifactId: String(payload.artifactId || ''),
        revision: payload.revision,
        confirmed: payload.confirmed === true,
      }),
    read: (payload: {
      conversationId?: unknown;
      artifactId?: unknown;
      revision?: unknown;
    }) =>
      ipcRenderer.invoke('artifacts:read', {
        conversationId: String(payload?.conversationId || '').slice(0, 120),
        artifactId: String(payload?.artifactId || '').slice(0, 128),
        revision: payload?.revision,
      }),
    restore: (payload: {
      conversationId?: unknown;
      artifactId?: unknown;
      revision?: unknown;
      expectedRevision?: unknown;
    }) =>
      ipcRenderer.invoke('artifacts:restore', {
        conversationId: String(payload?.conversationId || '').slice(0, 120),
        artifactId: String(payload?.artifactId || '').slice(0, 128),
        revision: payload?.revision,
        expectedRevision: payload?.expectedRevision,
      }),
    edit: (payload: {
      conversationId?: unknown;
      artifactId?: unknown;
      expectedRevision?: unknown;
      content?: unknown;
      patchPayload?: unknown;
    }) =>
      ipcRenderer.invoke('artifacts:edit', {
        conversationId: String(payload?.conversationId || '').slice(0, 120),
        artifactId: String(payload?.artifactId || '').slice(0, 128),
        expectedRevision: payload?.expectedRevision,
        content: String(payload?.content ?? '').slice(0, 1_000_000),
        ...(payload?.patchPayload && typeof payload.patchPayload === 'object'
          ? {patchPayload: payload.patchPayload}
          : {}),
      }),
    accept: (payload: {
      conversationId?: unknown;
      artifactId?: unknown;
      revision?: unknown;
    }) =>
      ipcRenderer.invoke('artifacts:accept', {
        conversationId: String(payload?.conversationId || '').slice(0, 120),
        artifactId: String(payload?.artifactId || '').slice(0, 128),
        revision: payload?.revision,
      }),
    apply: (payload: {
      conversationId?: unknown;
      artifactId?: unknown;
      revision?: unknown;
    }) =>
      ipcRenderer.invoke('artifacts:apply', {
        conversationId: String(payload?.conversationId || '').slice(0, 120),
        artifactId: String(payload?.artifactId || '').slice(0, 128),
        revision: payload?.revision,
      }),
  },
  dashboard: {
    list: () => ipcRenderer.invoke('dashboard:list'),
    createSample: () => ipcRenderer.invoke('dashboard:create-sample'),
    trace: (payload: {snapshotId: string; traceId: string; offset?: number}) =>
      ipcRenderer.invoke('dashboard:trace', payload),
    exportCsv: (payload: {snapshotId: string; traceId: string}) =>
      ipcRenderer.invoke('dashboard:export-csv', payload),
    open: (dashboardId: unknown) =>
      ipcRenderer.invoke('dashboard:open', String(dashboardId || '')),
    exportHtml: (payload: {title?: unknown; html?: unknown; css?: unknown}) =>
      ipcRenderer.invoke('dashboard:export', {
        title: String(payload?.title || '').slice(0, 120),
        html: String(payload?.html ?? ''),
        css: String(payload?.css ?? ''),
      }),
    runSql: (payload: {dashboardId: string; chartId: string; sql: string}) =>
      ipcRenderer.invoke('dashboard:run-sql', payload),
    exportInteractiveHtml: (payload: {dashboardId: string; title?: string}) =>
      ipcRenderer.invoke('dashboard:export-interactive', payload),
    exportChartCsv: (payload: {dashboardId: string; chartId: string}) =>
      ipcRenderer.invoke('dashboard:export-chart-csv', payload),
    remix: (payload: {
      dashboardId: string;
      format: 'design_canvas' | 'markdown_memo' | 'slides';
    }) => ipcRenderer.invoke('dashboard:remix', payload),
  },
  design: {
    list: () => ipcRenderer.invoke('design:list'),
    read: (slug: string) => ipcRenderer.invoke('design:read', {slug}),
    init: (payload: {
      slug?: string;
      title: string;
      pages?: Array<{id: string; name: string}>;
    }) => ipcRenderer.invoke('design:init', payload),
    upsertBoard: (payload: {
      slug: string;
      file: string;
      html: string;
      title?: string;
      w?: number;
      h?: number;
      x?: number;
      y?: number;
      page?: string;
    }) => ipcRenderer.invoke('design:upsert-board', payload),
    saveFile: (payload: {slug: string; file: string; content: string}) =>
      ipcRenderer.invoke('design:save-file', payload),
    importAsset: (payload: {slug: string; sourcePath?: string}) =>
      ipcRenderer.invoke('design:import-asset', payload),
    check: (slug: string) => ipcRenderer.invoke('design:check', {slug}),
    generateBrand: (payload: {
      slug: string;
      seed: Record<string, unknown>;
      install?: boolean;
    }) => ipcRenderer.invoke('design:generate-brand', payload),
    export: (payload: {
      slug: string;
      format: 'html' | 'png' | 'pdf' | 'zip';
      boardFile?: string;
    }) => ipcRenderer.invoke('design:export', payload),
    onChanged: (cb: (payload: {slug?: string}) => void) =>
      onSubscribedPayload('design:changed', cb as PayloadCallback),
  },
  projectsMa: {
    getOverviewState: (payload: {projectId: string; projectRoot?: string}) =>
      ipcRenderer.invoke('projects:ma:overview', payload),
    getSidebarBadges: () => ipcRenderer.invoke('projects:ma:sidebar-badges'),
    sendGoal: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:send-goal', payload),
    startThread: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:start-thread', payload),
    messageThread: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:message-thread', payload),
    resolveThread: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:resolve-thread', payload),
    remindThread: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:remind-thread', payload),
    answerDecision: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:answer-decision', payload),
    withdrawDecision: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:withdraw-decision', payload),
    readFile: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:read-file', payload),
    writeFile: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:write-file', payload),
    deleteFile: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:delete-file', payload),
    readMemory: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:read-memory', payload),
    writeMemory: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:write-memory', payload),
    updateSections: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:update-sections', payload),
    dismissRecap: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:dismiss-recap', payload),
    togglePinArtifact: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:pin-artifact', payload),
    inspectDiff: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:inspect-diff', payload),
    mergeWorktree: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:merge-worktree', payload),
    discardThread: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:discard-thread', payload),
    updateConfig: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:update-config', payload),
    stopRun: (payload: unknown) =>
      ipcRenderer.invoke('projects:ma:stop-run', payload),
    onEvent: (cb: (payload: unknown) => void) =>
      onSubscribedPayload('projects:ma:event', cb),
  },
  figma: {
    pair: (conversationId: unknown) =>
      ipcRenderer.invoke('figma:pair', {
        conversationId: String(conversationId || '').slice(0, 120),
      }),
    status: (conversationId: unknown) =>
      ipcRenderer.invoke('figma:status', {
        conversationId: String(conversationId || '').slice(0, 120),
      }),
    disconnect: (conversationId: unknown, documentSessionId: unknown) =>
      ipcRenderer.invoke('figma:disconnect', {
        conversationId: String(conversationId || '').slice(0, 120),
        documentSessionId: String(documentSessionId || '').slice(0, 256),
      }),
    inspectSelection: (conversationId: unknown, documentSessionId?: unknown) =>
      ipcRenderer.invoke('figma:inspect-selection', {
        conversationId: String(conversationId || '').slice(0, 120),
        documentSessionId: String(documentSessionId || '').slice(0, 256),
      }),
    exportPreview: (
      conversationId: unknown,
      documentSessionId: unknown,
      nodeId: unknown,
    ) =>
      ipcRenderer.invoke('figma:export-preview', {
        conversationId: String(conversationId || '').slice(0, 120),
        documentSessionId: String(documentSessionId || '').slice(0, 256),
        nodeId: String(nodeId || '').slice(0, 256),
      }),
  },
  learningCandidates: {
    request: (payload: UnknownRecord = {}) =>
      ipcRenderer.invoke('learning-candidates:request', payload),
  },
  onCardPatch: (callback: PayloadCallback) =>
    onPayload('stage:card-patch', callback),
  onLiveBrowserOpenPanel: (callback: PayloadCallback) =>
    onPayload('live-browser:open-panel', callback),
});

contextBridge.exposeInMainWorld('magicPointerCompanion', {
  hide: () => ipcRenderer.send('companion:hide'),
  pin: (pinned: unknown) => ipcRenderer.send('companion:pin', {pinned}),
  expand: () => ipcRenderer.send('companion:expand'),
  onShow: (callback: PayloadCallback) => onPayload('companion:show', callback),
  onTurn: (callback: PayloadCallback) => onPayload('stage:turn', callback),
  onCardPatch: (callback: PayloadCallback) =>
    onPayload('stage:card-patch', callback),
});

contextBridge.exposeInMainWorld('magicPointerOnboarding', {
  start: () => ipcRenderer.send('onboarding:start'),
  cancel: () => ipcRenderer.send('onboarding:cancel'),
  continue: () => ipcRenderer.send('onboarding:continue'),
  onShow: (callback: PayloadCallback) => onPayload('onboarding:show', callback),
  onPreflightEvent: (callback: PayloadCallback) =>
    onPayload('onboarding:preflight-event', callback),
});
