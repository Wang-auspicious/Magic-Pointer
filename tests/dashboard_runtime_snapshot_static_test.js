'use strict';

const assert = require('assert');
const fs = require('fs');

const dashboard = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');
const preload = fs.readFileSync('electron/preload.js', 'utf8');
const main = fs.readFileSync('electron/main.js', 'utf8');

assert(preload.includes("ipcRenderer.invoke('runtime-snapshot:get'"),
  'Dashboard snapshot must use request/response IPC');
assert(preload.includes("ipcRenderer.on('runtime-snapshot:changed'"),
  'renderer must refresh only after an explicit invalidation event');
assert(main.includes("require('./runtime_snapshot')"));
assert(main.includes("ipcMain.handle('runtime-snapshot:get'"));
assert(main.includes("operation: 'runtime.snapshot'"));
assert(main.includes('runtimeSnapshot.invalidate('));

const requestStart = dashboard.indexOf('function requestFabricState(');
const requestEnd = dashboard.indexOf('\nfunction applyTheme(', requestStart);
assert(requestStart >= 0 && requestEnd > requestStart);
const requestBody = dashboard.slice(requestStart, requestEnd);
assert(requestBody.includes('api.runtimeSnapshot.get('));
assert(!requestBody.includes('fabricRequest('),
  'bootstrap must not fan out into independent bridge processes');
assert(requestBody.includes('runtimeSnapshotLoaded'),
  'initial script load and onShow must share one renderer bootstrap');

const activeViewStart = dashboard.indexOf('function setActiveView(');
const activeViewEnd = dashboard.indexOf('\nfunction fabricRequest(', activeViewStart);
const activeViewBody = dashboard.slice(activeViewStart, activeViewEnd);
assert(!activeViewBody.includes('setInterval('),
  'activity view must not continuously spawn Python bridge processes');
assert(activeViewBody.includes("activeView === 'activity'"),
  'activity data remains lazy and loads when the user opens that page');

console.log('dashboard runtime snapshot static test ok');
