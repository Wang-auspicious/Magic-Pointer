'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const studio = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const sidebar = fs.readFileSync('electron/renderer/sidebar_groups.ts', 'utf8');
const main = fs.readFileSync('electron/main.ts', 'utf8');
const preload = fs.readFileSync('electron/preload.ts', 'utf8');
const data = fs.readFileSync('electron/renderer/data.ts', 'utf8');
const store = fs.readFileSync('electron/conversation_store.ts', 'utf8');

// A folder is the project. There is no folderless Studio conversation and no
// second project selector inside the Composer.
assert(!html.includes('id="composer-workspace"'), 'Composer must not duplicate project selection');
assert(!html.includes('id="composer-workspace-label"'), 'Composer must not carry a project label');
assert(!html.includes('其他对话'), 'folderless conversations must not be exposed as a fake project');
assert(!studio.includes('其他对话'), 'renderer must not synthesize an unassigned project');
assert(!sidebar.includes('__unassigned__'), 'project grouping must drop folderless records');
assert(!sidebar.includes('其他对话'), 'project grouping must never name a fake bucket');

// Projects are durable even before their first conversation, otherwise an
// opened empty folder disappears from the sidebar.
assert(store.includes('projects.json'), 'project registry must persist independently of conversations');
assert(store.includes('registerProject'), 'store must register an opened folder as a project');
assert(store.includes('listProjects'), 'store must expose registered projects');
assert(main.includes("ipcMain.handle('projects:list'"), 'main process must expose durable projects');
assert(main.includes("ipcMain.handle('projects:open'"), 'folder picker must register and return a project');
assert(preload.includes("ipcRenderer.invoke('projects:list'"), 'preload must expose project listing');
assert(preload.includes("ipcRenderer.invoke('projects:open'"), 'preload must expose opening a project');
assert(data.includes('async projects()'), 'renderer data layer must list projects');
assert(data.includes('async openProject()'), 'renderer data layer must open projects');

// Both the renderer and the main process enforce the same product boundary.
assert(studio.includes('activeProjectRoot'), 'selected project must be explicit renderer state');
assert(studio.includes('renderProjectGate'), 'no-project state must replace, not decorate, the conversation surface');
assert(main.includes("if (!effectiveWorkspaceRoot) return { ok: false, error: '请先打开项目。' }"),
  'main process must reject folderless Studio sends');

console.log('studio project gate contract test ok');
