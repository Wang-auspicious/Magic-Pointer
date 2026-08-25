'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const css = fs.readFileSync('electron/renderer/magic_studio.css', 'utf8');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const settings = fs.readFileSync('electron/renderer/settings.ts', 'utf8');
const main = fs.readFileSync('electron/main.ts', 'utf8');
const preload = fs.readFileSync('electron/preload.ts', 'utf8');
const data = fs.readFileSync('electron/renderer/data.ts', 'utf8');

/* ---- quiet Claude/Codex product shell ---- */
assert.strictEqual((html.match(/class="dshw-frame"/g) || []).length, 1);
assert(html.includes('class="dshw-sidebar"'));
assert(html.includes('class="dshw-conversation"'));
assert(html.includes('class="mp-library-nav"'));
assert(html.includes('class="mp-projects-label">项目'));
assert(!html.includes('工作区'));
assert(!html.includes('data-studio-mode'));
assert(!html.includes('data-goto="timeline"'));
assert(!html.includes('data-goto="memory"'));
assert(!html.includes('id="mp-surface-menu"'));
assert(!html.includes('id="session-log"'));
assert(!html.includes('DeepSeek'));

/* ---- project is a real folder, not a fake global default ---- */
assert(html.includes('id="workspace-add"'));
assert(!html.includes('id="composer-workspace"'));
assert(html.includes('id="chat-project-label"'));
assert(source.includes('await Data.openProject()'));
assert(source.includes('renderProjectGate'));
assert(source.includes('activeProjectRoot'));
assert(!source.includes('默认工作区'));
assert(!source.includes('其他对话'));
assert(source.includes("head.className = 'dshw-project-row'"));
assert(source.includes("row.className = 'side-item'"));
assert(!source.includes("className = 'side-time'"), 'conversation rows must not carry noisy timestamps');

/* ---- top bar and per-conversation trajectory ---- */
assert(html.includes('class="mp-chat-project"'));
assert(html.includes('data-conversation-tab="chat"'));
assert(html.includes('data-conversation-tab="trajectory"'));
assert(html.includes('id="trajectory"'));
assert(source.includes('DshTrajectory.render('));
assert(html.includes('id="chat-source-thumb"'));

/* ---- compact working composer, not a decorative mock ---- */
assert(html.includes('class="dshw-input-form mp-compact-composer"'));
assert(html.includes('id="composer-add"'));
assert(html.includes('id="composer-attachments"'));
assert(html.includes('id="composer-permission"'));
assert(html.includes('id="composer-model"'));
assert(html.includes('id="composer-context"'));
assert(html.includes('id="composer-usage-popover"'));
assert(source.includes('fitComposer('));
assert(source.includes("e.key !== 'Enter' || e.shiftKey || e.isComposing"));
assert(source.includes('.requestSubmit()'));
assert(source.includes('Data.models()'));
assert(source.includes('Data.selectModel(modelId)'));
assert.match(css, /\.dshw-input-form\s*\{[^}]*max-width:\s*768px/s);
assert.match(css, /\.dshw-card\s*\{[^}]*border-radius:\s*18px/s);

/* ---- real transcript, progress, branch and hover actions ---- */
assert(source.includes("flow.className = 'dsh-flow'"));
assert(source.includes('DshChat.userNode('));
assert(source.includes('DshChat.assistantTurnNode('));
assert(source.includes('Data.onConversationProgress('));
assert(source.includes('DshChat.liveActivityNode('));
assert(source.includes("document.addEventListener('mp:branch-conversation'"));
assert(source.includes('Data.branchConversation('));
assert(preload.includes("ipcRenderer.invoke('conversations:branch'"));
assert(main.includes("ipcMain.handle('conversations:branch'"));
assert(data.includes('branchConversation'));
assert(main.includes("ipcMain.handle('projects:pick-files'"));
assert(preload.includes("ipcRenderer.invoke('projects:pick-files'"));
assert(data.includes('pickProjectFiles'));
assert(source.includes('renderComposerAttachments'));

/* ---- Claude-like settings: grouped rail, flat pages, memory placement ---- */
assert(html.includes('class="dshw-settings-panel"'));
assert(html.includes('id="settings-search"'));
assert(html.includes('id="set-nav"'));
assert(html.includes('id="set-body"'));
assert(settings.includes('settings-nav-group'));
assert(settings.includes("page.id === 'memory-context'"));
assert(settings.includes('claude-memory-library'));
assert(!settings.includes('settings-section-toggle'));
assert.match(css, /\.dshw-settings-panel\s*\{[^}]*border-radius:\s*16px/s);
assert.match(css, /\.dshw-settings-nav\s*\{[^}]*width:\s*230px/s);
assert(source.includes("if (view !== 'settings') lastNonSettingsView = view"));
assert(source.includes("closest('[data-settings-close]')"));

/* ---- theme is resolved before paint without forcing dark ---- */
assert(!html.includes('<html lang="zh-CN" data-theme="dark">'));
assert(html.includes('theme_boot.js'), 'theme boot must load before first paint');
{
  const boot = fs.readFileSync('electron/renderer/theme_boot.js', 'utf8');
  assert(boot.includes("matchMedia('(prefers-color-scheme: dark)')"), 'boot resolves system theme');
  const bootAt = html.indexOf('theme_boot.js');
  const firstCss = html.indexOf('stylesheet');
  assert(bootAt >= 0 && bootAt < firstCss, 'theme boot must run before any stylesheet');
}
assert(settings.includes("document.body.toggleAttribute('data-ds-dark-theme'"));
for (const color of ['#f7f6f2', '#efede6', '#fbfaf7', '#f1efe9', '#e9e6de', '#2b2a27', '#292927', '#181817', '#343431']) {
  assert(css.includes(color));
}

/* ---- collections and installed runtime channels stay real ---- */
assert(html.includes('id="canvas"'));
assert(html.includes('id="art-list"'));
assert.match(source, /const summaryHeight = it\.summary \? 66 : 0/);
assert.match(main, /function createDashboardWindow\(initialView = 'chat'\)/);
assert.match(source, /if \(initialView !== 'chat'\) \{\s*show\(initialView\);\s*return;/s);

console.log('studio visual contract test ok');
