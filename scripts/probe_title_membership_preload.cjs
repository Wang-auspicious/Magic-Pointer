'use strict';
require('./probe_studio_layout_preload.js');
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('titleProbe', {
  invoke: (action, input = {}) =>
    ipcRenderer.invoke(
      ['rename', 'branch'].includes(action)
        ? `conversations:${action}`
        : `title-membership:${action}`,
      input,
    ),
});
