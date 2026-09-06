'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const main = fs.readFileSync('electron/main.ts', 'utf8');
const preload = fs.readFileSync('electron/preload.ts', 'utf8');
const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const studio = fs.readFileSync('electron/renderer/studio.ts', 'utf8');

for (const channel of [
  'stash:add-note',
  'stash:add-files',
  'stash:search',
  'stash:open',
  'stash:update-category',
  'stash:remove',
]) {
  assert.ok(main.includes(`ipcMain.handle('${channel}'`), `${channel} must be handled by the main process`);
  assert.ok(preload.includes(`'${channel}'`), `${channel} must cross the isolated preload bridge`);
}

for (const id of ['stash-search', 'stash-add-file', 'stash-add-note']) {
  assert.ok(html.includes(`id="${id}"`), `${id} must be reachable from the material toolbar`);
  assert.ok(studio.includes(id), `${id} must have renderer behavior`);
}

assert.ok(studio.includes('data-stash-open'), 'saved material rows must offer an open-source action');
assert.ok(studio.includes('data-stash-category'), 'saved material rows must offer editable categories');
assert.ok(studio.includes('data-stash-remove'), 'saved material rows must offer explicit removal');

console.log('stash management contract test ok');
