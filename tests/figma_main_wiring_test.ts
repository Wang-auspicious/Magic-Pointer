import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');
const main = read('electron/main.ts');
const preload = read('electron/preload.ts');
const studio = read('electron/renderer/studio.ts');
const html = read('electron/renderer/studio.html');

assert.match(main, /FigmaRuntimeController/);
assert.match(main, /ipcMain\.handle\('figma:pair'/);
assert.match(main, /ipcMain\.handle\('figma:status'/);
assert.match(main, /ipcMain\.handle\('figma:disconnect'/);
assert.match(main, /ipcMain\.handle\('figma:inspect-selection'/);
assert.match(main, /ipcMain\.handle\('figma:export-preview'/);
assert.match(main, /_figmaRuntimeConnections/);
assert.match(main, /figmaRuntime\.stop\(\)/);
assert.match(preload, /figma:pair/);
assert.match(preload, /figma:status/);
assert.match(preload, /figma:disconnect/);
assert.match(preload, /figma:inspect-selection/);
assert.match(preload, /figma:export-preview/);
assert.match(html, /id="figma-connect"/);
assert.match(html, /id="figma-connection-status"/);
assert.match(studio, /Data\.pairFigma/);
assert.match(studio, /Data\.figmaStatus/);
assert.match(studio, /Data\.inspectFigmaSelection/);
assert.match(studio, /Data\.exportFigmaPreview/);
assert.match(studio, /ArtifactEditor\.retargetFigmaPatch/);
assert.match(studio, /Task materials & Figma/);

console.log('figma main wiring test ok');
