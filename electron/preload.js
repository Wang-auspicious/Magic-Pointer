const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('magicPointer', {
  hide: () => ipcRenderer.send('overlay:hide'),
  done: (payload) => ipcRenderer.send('overlay:done', payload),
  onShow: (callback) => ipcRenderer.on('overlay:show', callback),
  onHide: (callback) => ipcRenderer.on('overlay:hide', callback),
});
