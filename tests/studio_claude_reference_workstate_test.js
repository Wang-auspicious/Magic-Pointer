'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const studio = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const tokens = fs.readFileSync('electron/renderer/claude_tokens.css', 'utf8');
const shell = fs.readFileSync('electron/renderer/claude_shell.css', 'utf8');
const chat = fs.readFileSync('electron/renderer/claude_chat.css', 'utf8');
const icons = fs.readFileSync('electron/renderer/icons.ts', 'utf8');
const dshChat = fs.readFileSync('electron/renderer/dsh_chat.ts', 'utf8');
const probe = fs.readFileSync('scripts/probe_studio_claude.ts', 'utf8');
const preload = fs.readFileSync('scripts/probe_studio_claude_preload.js', 'utf8');

// The supplied Claude Desktop 1.40609.1 screenshot is a 1199x800 CSS work
// state at DPR 2.  It is a first-class probe state, not an incidental variant
// of an empty landing or Inspector fixture.
assert(probe.includes("'conversation'"), 'probe must expose the exact conversation work state');
assert(probe.includes("openReference('magic-pointer-review')"),
  'conversation work-state probe must open the supplied Magic Pointer fixture');
assert(!probe.includes("appendSwitch('disable-lcd-text'"),
  'visual fidelity probe must not force a text rasterizer that production does not use');
assert(!probe.includes('app.disableHardwareAcceleration()'),
  'visual fidelity probe must retain the production compositor path');

for (const copy of [
  'Magic Pointer 项目代码审查与问题排查',
  'Magic Pointer agent debugging',
  "Ready. What's the task for Magic Pointer?",
  'Checked git status and recent commits',
  'Read STATUS.md',
  'Magic-Pointer',
]) {
  assert(preload.includes(copy), `Claude work-state fixture is missing: ${copy}`);
}
assert(html.includes('Create PR'), 'repository action must use the Claude Desktop label');

// Claude Code Desktop's repository row sits immediately above the shared
// composer and is backed by the real project environment projection.
for (const id of [
  'composer-repository-context',
  'composer-repository-name',
  'composer-branch-name',
  'composer-diff-added',
  'composer-diff-deleted',
  'composer-create-pr',
  'composer-pr-menu',
  'composer-repository-dismiss',
]) {
  assert(html.includes(`id="${id}"`), `repository context is missing #${id}`);
}
assert(studio.includes('renderRepositoryContextBar'),
  'Studio must project live Git state into the Claude repository row');
assert(studio.includes('pullRequestUrl'), 'Create PR must use the real project URL');
assert.match(chat, /\.mp-repository-context\s*\{[^}]*min-height:\s*40px/s,
  'repository row must use the measured 40px work-state height');
assert.match(chat, /\.dsh-user-stack\s*\{[^}]*max-width:\s*min\(85%,\s*680px\)/s,
  'long user prompts must reach Claude Desktop\'s measured 85% transcript width');
assert.match(chat, /\.dsh-bubble\s*\{[^}]*background:\s*var\(--mp-user-bubble\)/s,
  'user bubbles must use the sampled Claude surface instead of an approximate color mix');
assert.match(chat, /\.dsh-bubble\s*\{[^}]*overflow-wrap:\s*break-word/s,
  'paths in user messages must wrap at natural separators like Claude Desktop');
assert.match(tokens, /--mp-user-bubble:\s*#F0F0EF/,
  'light user-bubble token must match the supplied Claude Desktop pixels');
assert.match(tokens, /--mp-composer:\s*#FEFEFE/,
  'current Claude Desktop uses a distinct near-white composer surface');
assert.match(shell, /\.dshw-header\s*\{[^}]*padding:\s*0 16px/s,
  '1199px work-state header uses the measured 16px horizontal inset');
assert.match(shell, /\.mp-chat-project\s*\{[^}]*padding:\s*3px 8px/s,
  'project badge must match the current Claude pill width');
assert.match(shell, /\.mp-window-titlebar[\s\S]*background:\s*linear-gradient\(to right,\s*var\(--mp-sidebar\) 0 var\(--mp-sidebar-width\),\s*var\(--mp-page\) var\(--mp-sidebar-width\) 100%\)/,
  'titlebar must continue the sidebar surface through the left 288px');

// The left rail in the supplied state distinguishes failed and ordinary
// sessions instead of drawing every row as the same empty circle.
assert(icons.includes('id="ic-warning"'), 'failed session rows need the Claude warning glyph');
assert(studio.includes("dot.classList.toggle('is-error'"),
  'sidebar state must derive an error marker from real conversation data');

assert(dshChat.includes("class: 'dsh-thinking-mark'"),
  'an active turn must render the compact Claude-style working mark');
assert.match(chat, /\.dsh-turn-status\s*\{[^}]*min-height:\s*28px/s,
  'active-turn status owns a stable one-line slot');
assert.match(chat, /\.dsh-thinking-mark\s*\{[^}]*width:\s*18px[^}]*height:\s*18px/s,
  'working mark must retain the current Claude 18px footprint');
assert.match(chat, /\.mp-shell:not\(\[data-inspector="open"\]\) \.dsh-flow\s*\{[^}]*padding-left:\s*36px[^}]*padding-right:\s*28px/s,
  'the scrollbar-compensated transcript must align with the 768px composer');
assert.match(shell, /\.mp-account-mark\s*\{[^}]*width:\s*16px[^}]*height:\s*16px/s,
  'local account mark must match the current Claude footer footprint');

// A render is not evidence when its state-specific content is absent.
for (const metric of ['repositoryContext', 'sidebarProjects', 'sidebarSessions', 'flowChildren']) {
  assert(probe.includes(metric), `probe metadata must report ${metric}`);
}

console.log('studio Claude reference work-state contract ok');
