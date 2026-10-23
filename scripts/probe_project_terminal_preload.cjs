'use strict';
require('./probe_studio_layout_preload.js');
const {contextBridge, ipcRenderer} = require('electron');
const prefix = '--mp-probe-terminal-root=';
contextBridge.exposeInMainWorld('terminalProbe', {
  workspace: process.argv
    .find(value => value.startsWith(prefix))
    .slice(prefix.length),
  start: (projectRoot, path) =>
    ipcRenderer.invoke('projects:terminal-start', {projectRoot, path}),
  write: input => ipcRenderer.invoke('projects:terminal-write', {input}),
  stop: () => ipcRenderer.invoke('projects:terminal-stop'),
  onEvent: callback => {
    ipcRenderer.on('projects:terminal-event', (_event, update) =>
      callback(update),
    );
  },
});
