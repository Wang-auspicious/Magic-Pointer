'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const store = fs.readFileSync('electron/conversation_store.ts', 'utf8');
const main = fs.readFileSync('electron/main.ts', 'utf8');
const preload = fs.readFileSync('electron/preload.ts', 'utf8');
const data = fs.readFileSync('electron/renderer/data.ts', 'utf8');

assert(store.includes("require('./studio_home_stats')"), 'store consumes the pure projection');
assert(store.includes('function stats('), 'store exposes bounded aggregate stats');
assert(main.includes("ipcMain.handle('conversations:stats'"), 'main exposes stats IPC');
assert(main.includes('conversations().stats()'), 'IPC reads the existing store instead of a second ledger');
assert(preload.includes("ipcRenderer.invoke('conversations:stats')"), 'preload exposes stats safely');
assert(data.includes('async conversationStats()'), 'renderer data layer owns the bridge fallback');

console.log('studio home stats wiring test ok');
