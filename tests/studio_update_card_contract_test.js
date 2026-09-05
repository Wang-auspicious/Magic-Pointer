'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const studio = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const data = fs.readFileSync('electron/renderer/data.ts', 'utf8');
const preload = fs.readFileSync('electron/preload.ts', 'utf8');
const main = fs.readFileSync('electron/main.ts', 'utf8');
const css = fs.readFileSync('electron/renderer/claude_shell.css', 'utf8');

assert(html.includes('id="update-card"'));
assert(html.includes('id="update-card-title"'));
assert(html.includes('id="update-card-detail"'));

assert(main.includes("ipcMain.handle('updates:status'"));
assert(main.includes("ipcMain.handle('updates:check'"));
assert(main.includes("dashboard:update-status"));
assert(preload.includes("ipcRenderer.invoke('updates:status')"));
assert(preload.includes("ipcRenderer.invoke('updates:check')"));
assert(preload.includes("onPayload('dashboard:update-status'"));

assert(data.includes('updateStatus():'));
assert(data.includes('checkForUpdates():'));
assert(data.includes('onUpdateStatus('));
assert(studio.includes('function renderUpdateCard('));
for (const state of ['available', 'downloading', 'downloaded']) {
  assert(studio.includes(`case '${state}':`), `update card is missing ${state}`);
}
for (const state of ['checking', 'current', 'error']) {
  assert(!studio.includes(`case '${state}':`),
    `update card must remain hidden for transient/non-actionable ${state}`);
}
assert(studio.includes('Data.updateStatus()'));
assert(studio.includes('Data.onUpdateStatus('));
assert(studio.includes('Data.checkForUpdates()'));
assert.match(studio, /case 'downloading':[\s\S]*?heading = 'Downloading update…';\s*note = '';/,
  'Claude downloading state is a single aligned line, without a displaced percentage');
assert(studio.includes('detail.hidden = !note'));
assert.match(css, /\.mp-update-card > svg\s*\{[^}]*width:\s*16px[^}]*height:\s*16px/s);
assert.match(css, /\.mp-account-footer > svg\s*\{[^}]*width:\s*14px[^}]*height:\s*14px/s);
assert(main.includes("command === 'changelog'"));
assert(main.includes('https://github.com/Wang-auspicious/Magic-Pointer/releases'));

console.log('studio update card contract ok');
