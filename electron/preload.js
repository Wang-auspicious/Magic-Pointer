const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('magicPointer', {
  hide: () => ipcRenderer.send('overlay:hide'),
  done: (payload) => ipcRenderer.send('overlay:done', payload),
  executeAction: (payload) => ipcRenderer.send('overlay:execute-action', payload),
  startDictation: () => ipcRenderer.send('dictation:start', { surface: 'overlay' }),
  onShow: (callback) => ipcRenderer.on('overlay:show', (_event, payload) => callback(payload)),
  onHide: (callback) => ipcRenderer.on('overlay:hide', () => callback()),
  onCursor: (callback) => ipcRenderer.on('overlay:cursor', (_event, payload) => callback(payload)),
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
  show: () => ipcRenderer.send('stage:show'),
  reportState: (payload) => ipcRenderer.send('stage:state', payload),
  hidden: () => ipcRenderer.send('stage:hidden'),
  dismiss: () => ipcRenderer.send('stage:dismiss'),
  submitSelectionCommand: (payload) => ipcRenderer.send('stage:submit-selection-command', payload),
  executeAction: (payload) => ipcRenderer.send('stage:execute-action', payload),
  contextAction: (payload) => ipcRenderer.send('stage:context-action', payload),
  startDictation: () => ipcRenderer.send('dictation:start', { surface: 'stage' }),
  stopDictation: () => ipcRenderer.send('dictation:stop', { surface: 'stage' }),
  setMouseCapture: (enabled) => ipcRenderer.send('stage:set-mouse-capture', { enabled: enabled === true }),
  onShow: (callback) => ipcRenderer.on('stage:show', (_event, payload) => callback(payload)),
  onUpdate: (callback) => ipcRenderer.on('stage:update', (_event, payload) => callback(payload)),
  onHide: (callback) => ipcRenderer.on('stage:hide', () => callback()),
  onDictationResult: (callback) => ipcRenderer.on('dictation:result', (_event, payload) => callback(payload)),
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
  onShow: (callback) => ipcRenderer.on('dashboard:show', (_event, payload) => callback(payload)),
  onFabricState: (callback) => ipcRenderer.on('dashboard:fabric-state', (_event, payload) => callback(payload)),
  onState: (callback) => ipcRenderer.on('dashboard:state', (_event, payload) => callback(payload)),
  onCalendarState: (callback) => ipcRenderer.on('dashboard:calendar-state', (_event, payload) => callback(payload)),
  onRouteResult: (callback) => ipcRenderer.on('dashboard:route-result', (_event, payload) => callback(payload)),
});
