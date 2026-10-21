'use strict';
require('./probe_studio_layout_preload.js');
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('permissionProbe', {
  call: (action, input = {}) =>
    ipcRenderer.invoke(
      action === 'select'
        ? 'conversations:set-permission'
        : `permission-probe:${action}`,
      input,
    ),
});
