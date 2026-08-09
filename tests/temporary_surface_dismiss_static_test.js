'use strict';

const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.ts', 'utf8');
const overlay = fs.readFileSync('electron/renderer/overlay.ts', 'utf8');
const pointerDismissPolicy = fs.readFileSync('electron/pointer_dismiss_policy.ts', 'utf8');

assert(main.includes("globalShortcut.register('Escape'"), 'active surfaces need a global Escape exit');
assert(main.includes("globalShortcut.unregister('Escape')"), 'Escape capture must be released after dismissal');
assert(pointerDismissPolicy.includes('(Number(currentButtons) & 2) !== 0'),
  'right click must dismiss an accidental passive activation');
assert(main.includes('shouldDismissFromGlobalPointer'),
  'global button sampling must use the ownership-aware dismissal policy');
assert.match(overlay, /e\.button\s*===\s*2[\s\S]*?magicPointer\?\.hide\(\)/,
  'the interactive overlay itself must own right-click dismissal');
assert(main.includes('pointerStateRestartTimer = setTimeout'),
  'the right-click safety stream must restart after an unexpected host exit');
assert.match(
  main,
  /ipcMain\.on\('overlay:hide',[\s\S]*?dismissTemporarySurfaces\(\{ invalidateSession: true, hideObserver: true \}\)/,
  'overlay Escape/right-click must invalidate the selection session, not only hide one window',
);

console.log('temporary_surface_dismiss_static_test: all assertions passed');
