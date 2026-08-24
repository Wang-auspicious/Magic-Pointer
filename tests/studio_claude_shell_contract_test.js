'use strict';

// Product-shell contract rebuilt from the supplied Claude/Codex/Oreo screenshots.
// This intentionally rejects the previous Work/Design skin: a project is a real
// folder, memory is configuration, and message chrome stays quiet until hover.

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const studio = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const settings = fs.readFileSync('electron/renderer/settings.ts', 'utf8');
const settingsModel = fs.readFileSync('electron/renderer/settings_model.ts', 'utf8');
const css = fs.readFileSync('electron/renderer/magic_studio.css', 'utf8');
const chatCss = fs.readFileSync('electron/renderer/dsh_chat.css', 'utf8');
const chat = fs.readFileSync('electron/renderer/dsh_chat.ts', 'utf8');
const preload = fs.readFileSync('electron/preload.ts', 'utf8');
const main = fs.readFileSync('electron/main.ts', 'utf8');
const data = fs.readFileSync('electron/renderer/data.ts', 'utf8');

assert(!html.includes('id="studio-mode-switch"'), 'the rejected Work/Design switch must be removed');
assert(!html.includes('data-studio-mode='), 'views must not be split into artificial Work/Design modes');
assert(!html.includes('data-goto="timeline"'), 'global timeline must not compete with projects in primary navigation');
assert(!html.includes('data-goto="memory"'), 'memory belongs in Settings, not primary navigation');
assert(!html.includes('id="mp-surface-menu"'), 'the meaningless green Magic Pointer pill must be removed');
assert(!html.includes('id="session-log"'), 'Session log/download must not occupy the conversation header');

assert(html.includes('class="mp-projects-label">项目'), 'the sidebar hierarchy must be named 项目');
assert(!html.includes('工作区'), 'the visible product vocabulary must use 项目 consistently');
assert(!studio.includes('默认工作区'), 'folderless conversations must not pretend to be a default project');
assert(settingsModel.includes("id: 'memory-context'"), 'Hermes-style memory and context controls need a settings page');
assert(settingsModel.includes("group: '自定义'"), 'settings navigation must have Claude-like groups');
assert(settings.includes('settings-nav-group'), 'settings navigation must render group headings');
assert(!settings.includes('settings-section-toggle'), 'settings content must be flat rows, not nested plastic accordions');

for (const color of ['#f7f6f2', '#efede6', '#fbfaf7', '#f1efe9', '#e9e6de', '#2b2a27', '#292927', '#181817', '#343431']) {
  assert(css.includes(color), `the supplied Claude/Oreo palette must include ${color}`);
}
assert.match(css, /\.dshw-settings-panel\s*\{[^}]*border-radius:\s*16px/s,
  'the Claude-like settings sheet needs a restrained 16px outer radius');
assert.match(css, /\.dshw-settings-nav\s*\{[^}]*width:\s*230px/s,
  'the settings rail must have deliberate Claude-like proportions');
assert.match(css, /\.dshw-input-form\s*\{[^}]*max-width:\s*768px/s,
  'the compact Oreo-like composer needs a controlled reading width');

assert(!chat.includes('class: \'dsh-time\''), 'messages must not render timestamps');
assert(chat.includes("data-dsh-act', 'branch'"), 'message hover actions must include a real branch action');
assert.match(chatCss, /\.dsh-actions\s*\{[^}]*opacity:\s*0/s,
  'message actions must be invisible at rest');
assert.match(chatCss, /(?:\.dsh-user|\.dsh-assistant):hover[^{]*\.dsh-actions[^{]*\{[^}]*opacity:\s*1/s,
  'message actions must appear only when the message is hovered');

assert(!html.includes('#ic-dsh-'), 'the Studio shell must use one thin icon family');
assert(!studio.includes("icon('dsh-"), 'dynamic Studio icons must use the same thin family');
assert(preload.includes("ipcRenderer.invoke('conversations:branch'"), 'branch action needs a preload channel');
assert(main.includes("ipcMain.handle('conversations:branch'"), 'branch action needs a main-process handler');
assert(data.includes('branchConversation'), 'renderer data layer must expose conversation branching');

assert(!html.includes('<html lang="zh-CN" data-theme="dark">'),
  'boot must not force a dark flash before the saved/system theme resolves');

console.log('studio Claude shell contract test ok');
