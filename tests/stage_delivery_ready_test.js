'use strict';

const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.ts', 'utf8');
const preload = fs.readFileSync('electron/preload.ts', 'utf8');
const stage = fs.readFileSync('electron/renderer/stage.ts', 'utf8');
const showStage = main.slice(
  main.indexOf('function showStage(payload = {})'),
  main.indexOf('function updateStage(payload = {})'),
);

assert(showStage.includes('stageReadiness.whenReady(send)'),
  'Stage delivery must wait for the renderer-owned ready handshake');
assert(preload.includes("ipcRenderer.send('stage:renderer-ready')"));
assert(stage.includes('api.ready()'),
  'Stage may announce readiness only after its listeners are installed');
assert(main.includes("ipcMain.on('stage:renderer-ready'"));
assert(!showStage.includes("once('did-finish-load'"),
  'a one-shot load edge can be missed during cold-start activation');

console.log('stage_delivery_ready_test: all assertions passed');
