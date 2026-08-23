const { contextBridge, ipcRenderer } = require('electron');

type PayloadCallback = (payload: unknown) => void;
type SignalCallback = () => void;
type UnknownRecord = Record<string, unknown>;

interface StageCommandPayload {
  command?: unknown;
  inputMode?: unknown;
  keptStrokeIndexes?: unknown;
  pickedElement?: {
    rect?: { height?: unknown; width?: unknown; x?: unknown; y?: unknown };
    source?: unknown;
  };
  selectionSessionToken?: unknown;
}

const MAX_COMMAND_CHARS = 4000;

function onPayload(channel: string, callback: PayloadCallback): void {
  // The ipcRenderer return value must never cross the bridge: it IS
  // ipcRenderer, and contextBridge would proxy send/invoke/sendSync into the
  // isolated world (electron audit P2). Return nothing.
  ipcRenderer.on(channel, (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload));
}

// Signal channels carry no payload, so the callback is invoked with no arguments
// at all. Forwarding ipcRenderer's own listener signature would hand the renderer
// an IpcRendererEvent — and `event.sender` is ipcRenderer itself, which
// contextBridge would proxy straight into the isolated world. Dropping the
// arguments here is what keeps `SignalCallback = () => void` true at runtime.
function onSignal(channel: string, callback: SignalCallback): void {
  ipcRenderer.on(channel, () => callback());
}

contextBridge.exposeInMainWorld('magicPointer', {
  ready: () => ipcRenderer.send('overlay:renderer-ready'),
  gestureReady: (token: unknown) => ipcRenderer.send('overlay:gesture-ready', { token }),
  hide: () => ipcRenderer.send('overlay:hide'),
  done: (payload: unknown) => ipcRenderer.send('overlay:done', payload),
  gestureStarted: (token: unknown) => ipcRenderer.send('overlay:gesture-start', { token }),
  gestureStroke: (token: unknown, index: unknown) => ipcRenderer.send('overlay:gesture-stroke', { token, index }),
  startDictation: () => ipcRenderer.send('dictation:start', { surface: 'overlay' }),
  onShow: (callback: PayloadCallback) => onPayload('overlay:show', callback),
  onHide: (callback: SignalCallback) => onSignal('overlay:hide', callback),
  onCursor: (callback: PayloadCallback) => onPayload('overlay:cursor', callback),
  onGuidePoint: (callback: PayloadCallback) => onPayload('overlay:guide-point', callback),
  guideFinished: () => ipcRenderer.send('overlay:guide-finished'),
  onGestureInput: (callback: PayloadCallback) => onPayload('overlay:gesture-input', callback),
  onGestureSubmit: (callback: PayloadCallback) => onPayload('overlay:gesture-submit', callback),
  onResult: (callback: PayloadCallback) => onPayload('overlay:result', callback),
  onDictationResult: (callback: PayloadCallback) => onPayload('dictation:result', callback),
});

contextBridge.exposeInMainWorld('magicPointerPanel', {
  hide: () => ipcRenderer.send('panel:hide'),
  resize: (payload: unknown) => ipcRenderer.send('panel:resize', payload),
  submitSelectionCommand: (payload: unknown) => ipcRenderer.send('panel:submit-selection-command', payload),
  executeAction: (payload: unknown) => ipcRenderer.send('panel:execute-action', payload),
  showContextualResult: (payload: unknown) => ipcRenderer.send('panel:show-contextual-result', payload),
  startDictation: () => ipcRenderer.send('dictation:start', { surface: 'panel' }),
  onShow: (callback: PayloadCallback) => onPayload('panel:show', callback),
  onHide: (callback: SignalCallback) => onSignal('panel:hide', callback),
  onResult: (callback: PayloadCallback) => onPayload('panel:result', callback),
  onDictationResult: (callback: PayloadCallback) => onPayload('dictation:result', callback),
});

contextBridge.exposeInMainWorld('magicPointerStage', {
  ready: () => ipcRenderer.send('stage:renderer-ready'),
  show: () => ipcRenderer.send('stage:show'),
  reportState: (payload: unknown) => ipcRenderer.send('stage:state', payload),
  hidden: () => ipcRenderer.send('stage:hidden'),
  dismiss: () => ipcRenderer.send('stage:dismiss'),
  submitSelectionCommand: (payload: StageCommandPayload) => ipcRenderer.send('stage:submit-selection-command', {
    selectionSessionToken: payload?.selectionSessionToken || null,
    // Bounded at the bridge like keptStrokeIndexes: a compromised renderer
    // must not feed megabyte commands into the bridge / pendingQuestions
    // (electron audit P2).
    command: String(payload?.command || '').slice(0, MAX_COMMAND_CHARS),
    inputMode: payload?.inputMode || null,
    // Which strokes survived the user's edits in the composer. Bounded here so a
    // renderer cannot send an unbounded list into the main process.
    keptStrokeIndexes: Array.isArray(payload?.keptStrokeIndexes)
      ? payload.keptStrokeIndexes.slice(0, 12).map((value: unknown) => Number(value) || 0)
      : [],
    // The element the user clicked on, if any. Geometry only — the renderer
    // never gets to name a window or an app, so it cannot aim a read at one.
    pickedElement: payload?.pickedElement && payload.pickedElement.rect ? {
      rect: {
        x: Number(payload.pickedElement.rect.x) || 0,
        y: Number(payload.pickedElement.rect.y) || 0,
        width: Number(payload.pickedElement.rect.width) || 0,
        height: Number(payload.pickedElement.rect.height) || 0,
      },
      source: String(payload.pickedElement.source || 'structured').slice(0, 20),
    } : null,
  }),
  executeAction: (payload: unknown) => ipcRenderer.send('stage:execute-action', payload),
  contextAction: (payload: unknown) => ipcRenderer.send('stage:context-action', payload),
  // Mid-run steer: a distinct IPC from submit so it can never start a second
  // loop — it only writes the durable inbox the running loop already claims.
  steerSelectionCommand: (payload: { selectionSessionToken?: unknown; text?: unknown }) =>
    ipcRenderer.invoke('stage:steer-selection-command', {
      selectionSessionToken: payload?.selectionSessionToken || null,
      text: String(payload?.text || '').slice(0, 4000),
    }),
  // The renderer sends the text it is showing; the target window and point stay
  // in main, bound to the selection session, so a renderer cannot aim a write.
  insertResultText: (payload: { text?: unknown; selectionSessionToken?: unknown }) => ipcRenderer.send('stage:insert-result-text', {
    text: String(payload?.text || ''),
    selectionSessionToken: payload?.selectionSessionToken || null,
  }),
  // 就地展开回答里的一段。invoke 而不是 send：调用方要等展开后的那段字回来
  // 换掉原来那段，而不是等一条新的舞台事件——它不是新的一轮。
  expandPassage: (payload: { context?: unknown; passage?: unknown; selectionSessionToken?: unknown }) => ipcRenderer.invoke('stage:expand-passage', {
    selectionSessionToken: payload?.selectionSessionToken || null,
    passage: String(payload?.passage || '').slice(0, 8000),
    context: String(payload?.context || '').slice(0, 8000),
  }),
  pickElement: (payload: { selectionSessionToken?: unknown; x?: unknown; y?: unknown }) => ipcRenderer.invoke('stage:pick-element', {
    x: Number(payload?.x) || 0,
    y: Number(payload?.y) || 0,
    selectionSessionToken: String(payload?.selectionSessionToken || ''),
  }),
  listAgentSessions: (selectionSessionToken: unknown) => ipcRenderer.invoke('stage:agent-sessions', {
    selectionSessionToken: String(selectionSessionToken || ''),
  }),
  dispatchAgentPrompt: (payload: { prompt?: unknown; provider?: unknown; selectionSessionToken?: unknown; sessionId?: unknown }) => ipcRenderer.invoke('stage:dispatch-agent-prompt', {
    selectionSessionToken: String(payload?.selectionSessionToken || ''),
    prompt: String(payload?.prompt || ''),
    provider: String(payload?.provider || ''),
    sessionId: String(payload?.sessionId || ''),
  }),
  startDictation: () => ipcRenderer.send('dictation:start', { surface: 'stage' }),
  stopDictation: (options: { graceful?: boolean } = {}) => ipcRenderer.send('dictation:stop', {
    surface: 'stage',
    graceful: options?.graceful === true,
  }),
  setMouseCapture: (enabled: unknown, options: { requestFocus?: boolean; regions?: unknown[] } = {}) => ipcRenderer.send('stage:set-mouse-capture', {
    enabled: enabled === true,
    requestFocus: options?.requestFocus === true,
    regions: Array.isArray(options?.regions) ? options.regions.slice(0, 16) : [],
  }),
  onShow: (callback: PayloadCallback) => onPayload('stage:show', callback),
  onUpdate: (callback: PayloadCallback) => onPayload('stage:update', callback),
  // 桥跑到哪一步了。结果还没出来之前，这是界面上唯一有信息量的东西。
  onCardPatch: (callback: PayloadCallback) => onPayload('stage:card-patch', callback),
  onHide: (callback: SignalCallback) => onSignal('stage:hide', callback),
  onDictationResult: (callback: PayloadCallback) => onPayload('dictation:result', callback),
  onPointerInput: (callback: PayloadCallback) => onPayload('stage:pointer-input', callback),
  onModelHealth: (callback: PayloadCallback) => onPayload('stage:model-health', callback),
});

contextBridge.exposeInMainWorld('magicPointerDashboard', {
  hide: () => ipcRenderer.send('dashboard:hide'),
  setTheme: (theme: unknown) => ipcRenderer.send('dashboard:theme', { theme }),
  fabricRequest: (operation: unknown, payload: UnknownRecord = {}) => ipcRenderer.send('dashboard:fabric-request', { operation, ...payload }),
  saveFabricSettings: (settings: unknown) => ipcRenderer.invoke('dashboard:settings:save', { settings }),
  getFabricSettings: () => ipcRenderer.invoke('dashboard:settings:get'),
  modelsCatalog: () => ipcRenderer.invoke('models:catalog'),
  selectModel: (model: unknown) => ipcRenderer.invoke('models:select', { model }),
  slashDirectory: () => ipcRenderer.invoke('slash:directory'),
  requestState: () => ipcRenderer.send('dashboard:request-state'),
  setChecked: (payload: unknown) => ipcRenderer.send('dashboard:set-checked', payload),
  undoAdd: (payload: unknown) => ipcRenderer.send('dashboard:undo-add', payload),
  calendarRequestState: () => ipcRenderer.send('dashboard:calendar-request-state'),
  calendarPreview: (payload: unknown) => ipcRenderer.send('dashboard:calendar-preview', payload),
  calendarCreate: (payload: unknown) => ipcRenderer.send('dashboard:calendar-create', payload),
  calendarUndoCreate: (payload: unknown) => ipcRenderer.send('dashboard:calendar-undo-create', payload),
  openRoute: (payload: unknown) => ipcRenderer.send('dashboard:route-open', payload),
  runtimeSnapshot: {
    get: (options: { force?: boolean } = {}) => ipcRenderer.invoke('runtime-snapshot:get', {
      force: options?.force === true,
    }),
    onChanged: (callback: PayloadCallback) => onPayload('runtime-snapshot:changed', callback),
  },
  onShow: (callback: PayloadCallback) => onPayload('dashboard:show', callback),
  onFabricState: (callback: PayloadCallback) => onPayload('dashboard:fabric-state', callback),
  onState: (callback: PayloadCallback) => onPayload('dashboard:state', callback),
  onCalendarState: (callback: PayloadCallback) => onPayload('dashboard:calendar-state', callback),
  onRouteResult: (callback: PayloadCallback) => onPayload('dashboard:route-result', callback),
  onVoiceResidencyStatus: (callback: PayloadCallback) => onPayload('dashboard:voice-residency-status', callback),
  onPreflightEvent: (callback: PayloadCallback) => onPayload('dashboard:preflight-event', callback),
  onModelHealth: (callback: PayloadCallback) => onPayload('dashboard:model-health', callback),
  refreshModelHealth: () => ipcRenderer.invoke('dashboard:model-health-refresh'),
  sessionTimeline: () => ipcRenderer.invoke('dashboard:session-timeline'),
  stash: {
    list: () => ipcRenderer.invoke('stash:list'),
    describe: (imagePath: unknown) => ipcRenderer.invoke('stash:describe', imagePath),
    onEntry: (callback: PayloadCallback) => onPayload('stash:entry', callback),
  },
  conversations: {
    list: () => ipcRenderer.invoke('conversations:list'),
    get: (id: unknown) => ipcRenderer.invoke('conversations:get', id),
    pickWorkspace: () => ipcRenderer.invoke('conversations:pick-workspace'),
    send: (payload: { conversationId?: unknown; question?: unknown; permissionPreset?: unknown; requestId?: unknown; workspaceRoot?: unknown; replyStyle?: unknown }) => ipcRenderer.invoke('conversations:send', {
      conversationId: String(payload?.conversationId || '').slice(0, 120),
      question: String(payload?.question || '').slice(0, MAX_COMMAND_CHARS),
      permissionPreset: String(payload?.permissionPreset || 'workspace-write').slice(0, 40),
      requestId: String(payload?.requestId || '').slice(0, 120),
      ...(String(payload?.workspaceRoot || '').trim()
        ? { workspaceRoot: String(payload?.workspaceRoot || '').trim().slice(0, 500) }
        : {}),
      replyStyle: String(payload?.replyStyle || 'normal').trim().slice(0, 20),
    }),
    export: (id: unknown) => ipcRenderer.invoke('conversations:export', String(id || '').slice(0, 120)),
    timeline: () => ipcRenderer.invoke('conversations:timeline'),
    memories: () => ipcRenderer.invoke('conversations:memories'),
    artifacts: () => ipcRenderer.invoke('conversations:artifacts'),
    onTurn: (callback: PayloadCallback) => onPayload('conversations:turn', callback),
    onProgress: (callback: PayloadCallback) => onPayload('conversations:progress', callback),
  },
  learningCandidates: {
    request: (payload: UnknownRecord = {}) => ipcRenderer.invoke(
      'learning-candidates:request',
      payload,
    ),
  },
  // 后台任务的进度。走的是和胶囊同一条通道——三个界面收到的是同一份补丁，
  // 所以同一次出图在哪个窗口看都是同一个进度。
  onCardPatch: (callback: PayloadCallback) => onPayload('stage:card-patch', callback),
});

contextBridge.exposeInMainWorld('magicPointerCompanion', {
  hide: () => ipcRenderer.send('companion:hide'),
  pin: (pinned: unknown) => ipcRenderer.send('companion:pin', { pinned }),
  expand: () => ipcRenderer.send('companion:expand'),
  onShow: (callback: PayloadCallback) => onPayload('companion:show', callback),
  onTurn: (callback: PayloadCallback) => onPayload('stage:turn', callback),
  onCardPatch: (callback: PayloadCallback) => onPayload('stage:card-patch', callback),
});

contextBridge.exposeInMainWorld('magicPointerOnboarding', {
  start: () => ipcRenderer.send('onboarding:start'),
  cancel: () => ipcRenderer.send('onboarding:cancel'),
  continue: () => ipcRenderer.send('onboarding:continue'),
  onShow: (callback: PayloadCallback) => onPayload('onboarding:show', callback),
  onPreflightEvent: (callback: PayloadCallback) => onPayload('onboarding:preflight-event', callback),
});
