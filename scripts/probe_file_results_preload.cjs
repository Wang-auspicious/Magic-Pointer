'use strict';
require('./probe_studio_layout_preload.js');
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('fileResultsProbe', {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
});
