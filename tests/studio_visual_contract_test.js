'use strict';

const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const css = fs.readFileSync('electron/renderer/studio.css', 'utf8');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const main = fs.readFileSync('electron/main.ts', 'utf8');

assert.strictEqual((html.match(/class="side"/g) || []).length, 1, 'Studio must have one navigation rail');
assert.strictEqual((html.match(/id="workspace-header"/g) || []).length, 1, 'all views share one workspace header');
assert(html.includes('id="workspace-title"'));
assert(html.includes('id="workspace-description"'));
assert(html.includes('class="workspace-composer"'), 'chat must use one fixed Oreo composer');
assert(html.includes('class="settings-search"'), 'settings navigation must expose a real search field');
assert(!html.includes('LOCAL AGENT HARNESS'), 'the sidebar must not show a robotic product subtitle');
assert(!html.includes('class="chat-context workspace-card"'), 'chat context must not sit inside a decorative card');
assert(!html.includes('class="stream workspace-card"'), 'the answer stream must be open text, not a card inside the workspace');
assert(!html.includes('class="settings-layout workspace-card"'), 'settings must not be a rounded panel inside the workspace');
assert(!html.includes('class="crail-btn is-on"'), 'the stash toolbar must not expose a fake selection button');
assert(html.includes('../studio_shell.js'));
assert(!html.includes('id="hero"'));
assert(!html.includes('hero.mp4'));
assert(!html.includes('你指过的每一处'));
assert(!source.includes('function makeOrb('), 'decorative moving avatar generation must be removed');
assert(!source.includes("ta.style.height = 'auto'"), 'composer shell must not grow with textarea content');
assert(source.includes("flow.className = 'dsh-flow'"),
  'the chat transcript must render through the DSH chat model');
assert(source.includes('DshChat.userNode('),
  'user messages must use the DSH right-aligned bubble');
assert(source.includes('DshChat.assistantTurnNode('),
  'assistant turns must render DSH text + Think + tool rows');
assert(source.includes('<article class="mem-row enter"'),
  'read-only memories must not pretend to be clickable buttons');
assert.match(source, /const summaryHeight = it\.summary \? 66 : 0/,
  'stash layout must reserve space for the visible image summary');
assert.match(source, /renderStashList\(laid, force\);\s*resetCanvas\(\);/s,
  'stash must open at a readable scale instead of shrinking every item into one viewport');
assert.match(source, /function resetCanvas\(\)/);
assert.match(css, /\.node-summary\s*\{[^}]*-webkit-line-clamp:\s*3/s,
  'stash summaries must stay inside their card');
assert.match(main, /function createDashboardWindow\(initialView = 'chat'\)/,
  'the first dashboard window must know which Studio view was requested');
assert.match(main, /loadFile\([^;]+query:\s*\{\s*view:\s*initialView\s*\}/s,
  'the first requested Studio view must be present in the initial document URL');
assert.match(main, /createDashboardWindow\(String\(payload\.view \|\| 'chat'\)\)/,
  'showDashboard must pass the requested view into first-window creation');
assert.match(source, /if \(initialView !== 'chat'\) \{\s*show\(initialView\);\s*return;/s,
  'conversation hydration must not overwrite a requested settings or stash first view');
assert(!source.includes('\nboot();'), 'Studio boot must receive the requested initial view');

assert.match(css, /\.shell\s*\{[^}]*background:\s*transparent/s,
  'the shell must be transparent so the paper canvas shows through');
const oreoCss = fs.readFileSync('electron/renderer/oreo.css', 'utf8');
assert.match(oreoCss, /html,\s*body\s*\{[^}]*background:\s*var\(--paper\)/s,
  'the warm paper canvas must live on the document root, not a shell card');
assert.match(css, /\.workspace-composer\s*\{[^}]*height:\s*116px/s);
assert(!css.includes('.workspace-card {'), 'global card chrome must be removed from page layout');
assert(html.includes('dsh_chat.css'), 'the DSH chat stylesheet must be linked');
assert(html.includes('dsh_chat.js'), 'the DSH chat renderer must be loaded');
assert.match(css, /\.btn-solid\s*\{[^}]*background:\s*#16181d/s);
assert.match(css, /\.workspace-header\s*\{[^}]*min-height:\s*88px/s);
assert.match(css, /\.workspace-eyebrow\s*\{[^}]*display:\s*none/s,
  'the main header must not carry dashboard-style machine labels');
assert(!/radial-gradient\([^)]*#[0-9a-f]{3,8}/i.test(css), 'marketing color orbs must not return');

console.log('studio visual contract test ok');
