'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const css = fs.readFileSync('electron/renderer/claude_shell.css', 'utf8');
const studio = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const main = fs.readFileSync('electron/main.ts', 'utf8');
const preload = fs.readFileSync('electron/preload.ts', 'utf8');

for (const id of [
  'window-titlebar', 'app-menu', 'global-search-toggle', 'window-back', 'window-forward',
  'mode-switch', 'mode-work', 'mode-design',
  'theme-toggle', 'theme-toggle-icon', 'view-design', 'design-actions',
  'magic-brain-popover',
  'magic-brain-changes', 'magic-brain-branch', 'magic-brain-sources',
  'bottom-panel-toggle', 'bottom-panel',
  'inspector-resize-handle', 'inspector-maximize',
  'project-browser-back', 'project-browser-forward', 'project-browser-reload',
  'project-browser-external', 'project-browser-host',
]) {
  assert(html.includes(`id="${id}"`), `Codex chrome control is missing: ${id}`);
}
assert(!html.includes('id="header-open-location"'));
assert(!html.includes('id="magic-brain-toggle"'));
assert(studio.includes("make('Open project folder', () =>"));
assert(studio.includes("make('Project context', () =>"));
assert.match(html, /id="project-browser-form"[\s\S]*?<button type="submit" aria-label="Go"[^>]*>[\s\S]*?<use href="#ic-arrow-right"/,
  'Browser address bar uses Claude\'s compact icon submit control');
assert(!html.includes('>前往</button>'));
assert.match(css, /\.mp-browser-toolbar svg\s*\{[^}]*width:\s*16px[^}]*height:\s*16px/s);

assert(!html.includes('class="dshw-brand-mark"'), 'the Walker/Design switch must not carry a decorative logo');
assert(!html.includes('class="dshw-brand-name">Magic Pointer'), 'the sidebar must not repeat the product name');
assert(!html.includes('魔脑'), 'the project environment surface must use a literal, useful name');
assert(html.includes('项目上下文'), 'the project environment surface must be named 项目上下文');
assert(!html.includes('class="mp-design-bento"'), 'Design must not retain the old marketing Bento');
assert(html.includes('class="mp-design-action-row"') && html.includes('data-design-action="canvas"'),
  'Design workbench rows must remain real actions');
assert.match(css, /\.mp-shell\s*\{[^}]*grid-template-rows:\s*var\(--mp-window-bar\)\s+minmax\(0,\s*1fr\)/s,
  'the window titlebar must occupy a real independent grid row');
assert.match(css, /\.mp-window-titlebar\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s,
  'the window titlebar must span the entire shell');
assert.match(css, /\.mp-window-titlebar\s*\{[^}]*-webkit-app-region:\s*drag/s,
  'the independent titlebar must own window dragging');
assert.match(css, /\.mp-window-titlebar button[^}]*-webkit-app-region:\s*no-drag/s,
  'titlebar controls must remain interactive');

assert(studio.includes("setProductMode('walker'"), 'Walker must be a real product mode');
assert(studio.includes("setProductMode('design'"), 'Design must be a real product mode');
assert(studio.includes("show(mode === 'design' ? 'design' : 'chat')"), 'Design mode must open its own home');
assert(studio.includes("toggleAnimatedTheme({ x:"), 'the visible sidebar theme control must drive the theme transition origin');
assert(studio.includes("icon(expanded ? 'ic-tree-folder-open' : 'ic-tree-folder')"), 'the file tree must show distinct open and closed folder glyphs');
assert(studio.includes('renderMagicBrain'), 'environment information must render from live project state');
assert(studio.includes("addEventListener('contextmenu'"), 'the file tree must expose a real right-click menu');
assert(studio.includes('Data.showProjectContextMenu'), 'file context actions must cross the preload boundary');
assert(studio.includes('Data.openBrowserView'), 'the browser panel must create a real browser surface');
assert(studio.includes('function scheduleProjectBrowserResize()'),
  'Inspector/browser resizing must be animation-frame coalesced');
assert(studio.includes('requestAnimationFrame(() =>'),
  'coalesced browser resizing must use the next animation frame');
assert(studio.includes('inspectorState.maximized'), 'maximise/restore must use the Inspector reducer state');
assert(studio.includes('shell.dataset.inspectorMaximized'), 'maximised state must reach shell layout');

assert(preload.includes("ipcRenderer.invoke('projects:environment'"));
assert(preload.includes("ipcRenderer.invoke('projects:context-menu'"));
assert(preload.includes("ipcRenderer.invoke('browser:view-open'"));
assert(main.includes("ipcMain.handle('projects:environment'"));
assert(main.includes("ipcMain.handle('projects:context-menu'"));
assert(main.includes("ipcMain.handle('browser:view-open'"));
assert(main.includes('new WebContentsView('), 'the inspector browser must be backed by a real WebContentsView');

console.log('studio Codex chrome contract ok');
