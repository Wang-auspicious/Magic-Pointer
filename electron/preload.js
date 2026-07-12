const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('magicPointer', {
  hide: () => ipcRenderer.send('overlay:hide'),
  done: (payload) => ipcRenderer.send('overlay:done', payload),
  executeAction: (payload) => ipcRenderer.send('overlay:execute-action', payload),
  onShow: (callback) => ipcRenderer.on('overlay:show', (_event, payload) => callback(payload)),
  onHide: (callback) => ipcRenderer.on('overlay:hide', () => callback()),
  onCursor: (callback) => ipcRenderer.on('overlay:cursor', (_event, payload) => callback(payload)),
  onResult: (callback) => ipcRenderer.on('overlay:result', (_event, payload) => callback(payload)),
});

contextBridge.exposeInMainWorld('magicPointerPanel', {
  hide: () => ipcRenderer.send('panel:hide'),
  resize: (payload) => ipcRenderer.send('panel:resize', payload),
  submitSelectionCommand: (payload) => ipcRenderer.send('panel:submit-selection-command', payload),
  executeAction: (payload) => ipcRenderer.send('panel:execute-action', payload),
  showContextualResult: (payload) => ipcRenderer.send('panel:show-contextual-result', payload),
  onShow: (callback) => ipcRenderer.on('panel:show', (_event, payload) => callback(payload)),
  onHide: (callback) => ipcRenderer.on('panel:hide', callback),
  onResult: (callback) => ipcRenderer.on('panel:result', (_event, payload) => callback(payload)),
});

contextBridge.exposeInMainWorld('magicPointerResult', {
  hide: () => ipcRenderer.send('result:hide'),
  ready: (payload) => ipcRenderer.send('result:ready', payload),
  expand: (payload) => ipcRenderer.send('result:expand', payload),
  executeAction: (payload) => ipcRenderer.send('result:execute-action', payload),
  onShow: (callback) => ipcRenderer.on('result:show', (_event, payload) => callback(payload)),
  onHide: (callback) => ipcRenderer.on('result:hide', () => callback()),
  onResult: (callback) => ipcRenderer.on('result:result', (_event, payload) => callback(payload)),
});

contextBridge.exposeInMainWorld('magicPointerReader', {
  hide: () => ipcRenderer.send('reader:hide'),
  resize: (payload) => ipcRenderer.send('reader:resize', payload),
  setPinned: (pinned) => ipcRenderer.send('reader:set-pinned', { pinned }),
  executeAction: (payload) => ipcRenderer.send('reader:execute-action', payload),
  onShow: (callback) => ipcRenderer.on('reader:show', (_event, payload) => callback(payload)),
  onHide: (callback) => ipcRenderer.on('reader:hide', () => callback()),
  onResult: (callback) => ipcRenderer.on('reader:result', (_event, payload) => callback(payload)),
});

contextBridge.exposeInMainWorld('magicPointerDashboard', {
  hide: () => ipcRenderer.send('dashboard:hide'),
  requestState: () => ipcRenderer.send('dashboard:request-state'),
  setChecked: (payload) => ipcRenderer.send('dashboard:set-checked', payload),
  undoAdd: (payload) => ipcRenderer.send('dashboard:undo-add', payload),
  calendarRequestState: () => ipcRenderer.send('dashboard:calendar-request-state'),
  calendarPreview: (payload) => ipcRenderer.send('dashboard:calendar-preview', payload),
  calendarCreate: (payload) => ipcRenderer.send('dashboard:calendar-create', payload),
  calendarUndoCreate: (payload) => ipcRenderer.send('dashboard:calendar-undo-create', payload),
  openRoute: (payload) => ipcRenderer.send('dashboard:route-open', payload),
  onShow: (callback) => ipcRenderer.on('dashboard:show', (_event, payload) => callback(payload)),
  onState: (callback) => ipcRenderer.on('dashboard:state', (_event, payload) => callback(payload)),
  onCalendarState: (callback) => ipcRenderer.on('dashboard:calendar-state', (_event, payload) => callback(payload)),
  onRouteResult: (callback) => ipcRenderer.on('dashboard:route-result', (_event, payload) => callback(payload)),
});
