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
  onShow: (callback) => ipcRenderer.on('panel:show', (_event, payload) => callback(payload)),
  onHide: (callback) => ipcRenderer.on('panel:hide', callback),
  onResult: (callback) => ipcRenderer.on('panel:result', (_event, payload) => callback(payload)),
});
