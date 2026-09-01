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

// Studio is a complete Agent surface. A folder enables coding tools but is not
// a prerequisite for ordinary conversation, desktop work, attachments, MCP, or
// Skills. The folder selector lives beside the shared composer.
assert(html.includes('id="composer-workspace"'), 'Composer must expose the optional folder chip');
assert(html.includes('id="composer-workspace-label"'), 'folder chip must expose its current label');
assert(!html.includes('id="project-gate"'), 'the mandatory project gate must be deleted');
assert(!studio.includes('renderProjectGate'), 'renderer must not replace conversation with a project gate');
assert(!main.includes("if (!effectiveWorkspaceRoot) return { ok: false, error: '请先打开项目。' }"),
  'main process must accept an unbound Studio conversation');
assert(main.includes('resolveConversationWorkspace'), 'main process must use the shared workspace policy');

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

// Explicit project binding remains durable and thread-scoped.
assert(studio.includes('activeProjectRoot'), 'selected project remains explicit renderer state');
assert(store.includes('workspaceRoot?: string'), 'thread workspace stays optional in the durable schema');
assert(sidebar.includes('groupByWorkspace'), 'sidebar still groups genuinely bound project sessions');

console.log('studio project gate contract test ok');
