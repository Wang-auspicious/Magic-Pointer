const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('magicPointer', {
  ready: () => ipcRenderer.send('overlay:renderer-ready'),
  gestureReady: (token) => ipcRenderer.send('overlay:gesture-ready', { token }),
  hide: () => ipcRenderer.send('overlay:hide'),
  done: (payload) => ipcRenderer.send('overlay:done', payload),
  gestureStarted: (token) => ipcRenderer.send('overlay:gesture-start', { token }),
  gestureStroke: (token, index) => ipcRenderer.send('overlay:gesture-stroke', { token, index }),
  startDictation: () => ipcRenderer.send('dictation:start', { surface: 'overlay' }),
  onShow: (callback) => ipcRenderer.on('overlay:show', (_event, payload) => callback(payload)),
  onHide: (callback) => ipcRenderer.on('overlay:hide', () => callback()),
  onCursor: (callback) => ipcRenderer.on('overlay:cursor', (_event, payload) => callback(payload)),
  onGuidePoint: (callback) => ipcRenderer.on('overlay:guide-point', (_event, payload) => callback(payload)),
  guideFinished: () => ipcRenderer.send('overlay:guide-finished'),
  onGestureInput: (callback) => ipcRenderer.on('overlay:gesture-input', (_event, payload) => callback(payload)),
  onGestureSubmit: (callback) => ipcRenderer.on('overlay:gesture-submit', (_event, payload) => callback(payload)),
  onResult: (callback) => ipcRenderer.on('overlay:result', (_event, payload) => callback(payload)),
  onDictationResult: (callback) => ipcRenderer.on('dictation:result', (_event, payload) => callback(payload)),
});

contextBridge.exposeInMainWorld('magicPointerPanel', {
  hide: () => ipcRenderer.send('panel:hide'),
  resize: (payload) => ipcRenderer.send('panel:resize', payload),
  submitSelectionCommand: (payload) => ipcRenderer.send('panel:submit-selection-command', payload),
  executeAction: (payload) => ipcRenderer.send('panel:execute-action', payload),
  showContextualResult: (payload) => ipcRenderer.send('panel:show-contextual-result', payload),
  startDictation: () => ipcRenderer.send('dictation:start', { surface: 'panel' }),
  onShow: (callback) => ipcRenderer.on('panel:show', (_event, payload) => callback(payload)),
  onHide: (callback) => ipcRenderer.on('panel:hide', callback),
  onResult: (callback) => ipcRenderer.on('panel:result', (_event, payload) => callback(payload)),
  onDictationResult: (callback) => ipcRenderer.on('dictation:result', (_event, payload) => callback(payload)),
});

contextBridge.exposeInMainWorld('magicPointerStage', {
  ready: () => ipcRenderer.send('stage:renderer-ready'),
  show: () => ipcRenderer.send('stage:show'),
  reportState: (payload) => ipcRenderer.send('stage:state', payload),
  hidden: () => ipcRenderer.send('stage:hidden'),
  dismiss: () => ipcRenderer.send('stage:dismiss'),
  submitSelectionCommand: (payload) => ipcRenderer.send('stage:submit-selection-command', {
    selectionSessionToken: payload?.selectionSessionToken || null,
    command: String(payload?.command || ''),
    inputMode: payload?.inputMode || null,
    // Which strokes survived the user's edits in the composer. Bounded here so a
    // renderer cannot send an unbounded list into the main process.
    keptStrokeIndexes: Array.isArray(payload?.keptStrokeIndexes)
      ? payload.keptStrokeIndexes.slice(0, 12).map((value) => Number(value) || 0)
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
  executeAction: (payload) => ipcRenderer.send('stage:execute-action', payload),
  contextAction: (payload) => ipcRenderer.send('stage:context-action', payload),
  // The renderer sends the text it is showing; the target window and point stay
  // in main, bound to the selection session, so a renderer cannot aim a write.
  insertResultText: (payload) => ipcRenderer.send('stage:insert-result-text', {
    text: String(payload?.text || ''),
    selectionSessionToken: payload?.selectionSessionToken || null,
  }),
  // 就地展开回答里的一段。invoke 而不是 send：调用方要等展开后的那段字回来
  // 换掉原来那段，而不是等一条新的舞台事件——它不是新的一轮。
  expandPassage: (payload) => ipcRenderer.invoke('stage:expand-passage', {
    selectionSessionToken: payload?.selectionSessionToken || null,
    passage: String(payload?.passage || '').slice(0, 8000),
    context: String(payload?.context || '').slice(0, 8000),
  }),
  pickElement: (payload) => ipcRenderer.invoke('stage:pick-element', {
    x: Number(payload?.x) || 0,
    y: Number(payload?.y) || 0,
    selectionSessionToken: String(payload?.selectionSessionToken || ''),
  }),
  listAgentSessions: (selectionSessionToken) => ipcRenderer.invoke('stage:agent-sessions', {
    selectionSessionToken: String(selectionSessionToken || ''),
  }),
  dispatchAgentPrompt: (payload) => ipcRenderer.invoke('stage:dispatch-agent-prompt', {
    selectionSessionToken: String(payload?.selectionSessionToken || ''),
    prompt: String(payload?.prompt || ''),
    provider: String(payload?.provider || ''),
    sessionId: String(payload?.sessionId || ''),
  }),
  startDictation: () => ipcRenderer.send('dictation:start', { surface: 'stage' }),
  stopDictation: (options = {}) => ipcRenderer.send('dictation:stop', {
    surface: 'stage',
    graceful: options?.graceful === true,
  }),
  setMouseCapture: (enabled, options = {}) => ipcRenderer.send('stage:set-mouse-capture', {
    enabled: enabled === true,
    requestFocus: options?.requestFocus === true,
    regions: Array.isArray(options?.regions) ? options.regions.slice(0, 16) : [],
  }),
  onShow: (callback) => ipcRenderer.on('stage:show', (_event, payload) => callback(payload)),
  onUpdate: (callback) => ipcRenderer.on('stage:update', (_event, payload) => callback(payload)),
  // 桥跑到哪一步了。结果还没出来之前，这是界面上唯一有信息量的东西。
  onCardPatch: (callback) => ipcRenderer.on('stage:card-patch', (_event, payload) => callback(payload)),
  onHide: (callback) => ipcRenderer.on('stage:hide', () => callback()),
  onDictationResult: (callback) => ipcRenderer.on('dictation:result', (_event, payload) => callback(payload)),
  onPointerInput: (callback) => ipcRenderer.on('stage:pointer-input', (_event, payload) => callback(payload)),
  onModelHealth: (callback) => ipcRenderer.on('stage:model-health', (_event, payload) => callback(payload)),
});

contextBridge.exposeInMainWorld('magicPointerDashboard', {
  hide: () => ipcRenderer.send('dashboard:hide'),
  setTheme: (theme) => ipcRenderer.send('dashboard:theme', { theme }),
  fabricRequest: (operation, payload = {}) => ipcRenderer.send('dashboard:fabric-request', { operation, ...payload }),
  saveFabricSettings: (settings) => ipcRenderer.send('dashboard:fabric-request', { operation: 'settings.save', settings }),
  requestState: () => ipcRenderer.send('dashboard:request-state'),
  setChecked: (payload) => ipcRenderer.send('dashboard:set-checked', payload),
  undoAdd: (payload) => ipcRenderer.send('dashboard:undo-add', payload),
  calendarRequestState: () => ipcRenderer.send('dashboard:calendar-request-state'),
  calendarPreview: (payload) => ipcRenderer.send('dashboard:calendar-preview', payload),
  calendarCreate: (payload) => ipcRenderer.send('dashboard:calendar-create', payload),
  calendarUndoCreate: (payload) => ipcRenderer.send('dashboard:calendar-undo-create', payload),
  openRoute: (payload) => ipcRenderer.send('dashboard:route-open', payload),
  runtimeSnapshot: {
    get: (options = {}) => ipcRenderer.invoke('runtime-snapshot:get', {
      force: options?.force === true,
    }),
    onChanged: (callback) => ipcRenderer.on('runtime-snapshot:changed', (_event, payload) => callback(payload)),
  },
  onShow: (callback) => ipcRenderer.on('dashboard:show', (_event, payload) => callback(payload)),
  onFabricState: (callback) => ipcRenderer.on('dashboard:fabric-state', (_event, payload) => callback(payload)),
  onState: (callback) => ipcRenderer.on('dashboard:state', (_event, payload) => callback(payload)),
  onCalendarState: (callback) => ipcRenderer.on('dashboard:calendar-state', (_event, payload) => callback(payload)),
  onRouteResult: (callback) => ipcRenderer.on('dashboard:route-result', (_event, payload) => callback(payload)),
  onVoiceResidencyStatus: (callback) => ipcRenderer.on('dashboard:voice-residency-status', (_event, payload) => callback(payload)),
  onPreflightEvent: (callback) => ipcRenderer.on('dashboard:preflight-event', (_event, payload) => callback(payload)),
  onModelHealth: (callback) => ipcRenderer.on('dashboard:model-health', (_event, payload) => callback(payload)),
  refreshModelHealth: () => ipcRenderer.invoke('dashboard:model-health-refresh'),
  sessionTimeline: () => ipcRenderer.invoke('dashboard:session-timeline'),
  stash: {
    list: () => ipcRenderer.invoke('stash:list'),
    describe: (imagePath) => ipcRenderer.invoke('stash:describe', imagePath),
    onEntry: (callback) => ipcRenderer.on('stash:entry', (_event, payload) => callback(payload)),
  },
  conversations: {
    list: () => ipcRenderer.invoke('conversations:list'),
    get: (id) => ipcRenderer.invoke('conversations:get', id),
    timeline: () => ipcRenderer.invoke('conversations:timeline'),
    memories: () => ipcRenderer.invoke('conversations:memories'),
    artifacts: () => ipcRenderer.invoke('conversations:artifacts'),
    onTurn: (callback) => ipcRenderer.on('conversations:turn', (_event, payload) => callback(payload)),
  },
  // 后台任务的进度。走的是和胶囊同一条通道——三个界面收到的是同一份补丁，
  // 所以同一次出图在哪个窗口看都是同一个进度。
  onCardPatch: (callback) => ipcRenderer.on('stage:card-patch', (_event, payload) => callback(payload)),
});

contextBridge.exposeInMainWorld('magicPointerCompanion', {
  hide: () => ipcRenderer.send('companion:hide'),
  pin: (pinned) => ipcRenderer.send('companion:pin', { pinned }),
  expand: () => ipcRenderer.send('companion:expand'),
  onShow: (callback) => ipcRenderer.on('companion:show', (_event, payload) => callback(payload)),
  onTurn: (callback) => ipcRenderer.on('stage:turn', (_event, payload) => callback(payload)),
  onCardPatch: (callback) => ipcRenderer.on('stage:card-patch', (_event, payload) => callback(payload)),
});

contextBridge.exposeInMainWorld('magicPointerOnboarding', {
  start: () => ipcRenderer.send('onboarding:start'),
  cancel: () => ipcRenderer.send('onboarding:cancel'),
  continue: () => ipcRenderer.send('onboarding:continue'),
  onShow: (callback) => ipcRenderer.on('onboarding:show', (_event, payload) => callback(payload)),
  onPreflightEvent: (callback) => ipcRenderer.on('onboarding:preflight-event', (_event, payload) => callback(payload)),
});
