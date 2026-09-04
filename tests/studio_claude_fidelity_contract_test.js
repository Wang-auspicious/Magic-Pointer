'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const tokens = fs.readFileSync('electron/renderer/claude_tokens.css', 'utf8');
const shell = fs.readFileSync('electron/renderer/claude_shell.css', 'utf8');
const chat = fs.readFileSync('electron/renderer/claude_chat.css', 'utf8');
const main = fs.readFileSync('electron/main.ts', 'utf8');
const homeSource = fs.readFileSync('electron/renderer/studio_home.ts', 'utf8');
const permissionSource = fs.readFileSync('electron/renderer/permission_presets.ts', 'utf8');

for (const href of ['claude_tokens.css', 'claude_shell.css', 'claude_chat.css']) {
  assert(html.includes(`href="${href}`), `missing ${href}`);
}
assert(html.includes('src="studio_subagents.js'));
const retiredStudioAssets = [
  'electron/renderer/studio_system.css',
  'electron/renderer/dsh_tokens.css',
  'electron/renderer/dsh_chat.css',
  'electron/renderer/studio.css',
  'electron/renderer/dsh_web.css',
  'electron/renderer/magic_studio.css',
  'electron/renderer/sv.css',
  'electron/renderer/sv_motion.ts',
  'electron/titlebar_contrast.ts',
  'scripts/consolidate_studio_css.ts',
  'tests/titlebar_contrast_test.js',
];
for (const asset of retiredStudioAssets) {
  assert(!fs.existsSync(path.join(process.cwd(), asset)), `${asset} must be retired`);
}
for (const legacyAsset of [
  'studio_system.css',
  'dsh_tokens.css',
  'dsh_chat.css',
  'studio.css',
  'dsh_web.css',
  'magic_studio.css',
  'sv.css',
  'sv_motion.js',
]) {
  assert(!html.includes(legacyAsset), `Studio must not load ${legacyAsset}`);
}
assert(!html.includes('mp-window-menu-bar'));
assert(html.includes('id="app-menu"'));
assert(html.includes('id="global-search-toggle"'));
assert(html.includes('id="mode-work"') && html.includes('id="mode-design"'));
assert(html.includes('id="studio-home"'));
assert(html.includes('id="composer-workspace"'));
for (const copy of [
  'Cowork',
  'Code',
  'New',
  'Customize',
  "What's up next, zjz65?",
  'Overview',
  'Models',
  'All',
  '30d',
  '7d',
  'Local',
  'Select folder…',
  'Describe a task or ask a question',
]) {
  assert(html.includes(copy) || sourceIncludes(copy), `reference copy is missing: ${copy}`);
}
for (const copy of ['Sessions', 'Messages', 'Total tokens', 'Active days', 'Current streak', 'Longest streak', 'Peak hour', 'Favorite model']) {
  assert(homeSource.includes(`'${copy}'`), `home metric copy is missing: ${copy}`);
}
assert(permissionSource.includes("label: 'Accept edits'"));
assert(html.indexOf('id="chat-title"') < html.indexOf('id="chat-project-label"'),
  'Claude conversation header shows title before the project chip');
assert(!html.includes('class="mp-title-separator"'));
assert.match(tokens, /--mp-window-bar:\s*36px/);
assert.match(tokens, /--mp-sidebar-width:\s*288px/);
assert.match(tokens, /--mp-content-width:\s*768px/);
assert.match(tokens, /--mp-page:\s*#FCFCFB/);
assert.match(tokens, /--mp-page:\s*#151515/);
assert.match(tokens, /--mp-ease-out:\s*cubic-bezier\(\.32,\.72,0,1\)/);
assert.match(shell, /grid-template-rows:\s*var\(--mp-window-bar\) minmax\(0,\s*1fr\)/);
assert.match(shell, /\.mp-inspector\s*\{[^}]*margin:\s*8px 8px 8px 0/s);
assert.match(chat, /max-width:\s*calc\(var\(--mp-content-width\) \+ 64px\)/);
assert.match(shell, /\.mp-studio-home\s*\{[^}]*align-items:\s*stretch/s);
assert.match(shell, /\.mp-home-heading\s*\{[^}]*align-self:\s*center/s);
assert.match(shell, /\.mp-home-stats\s*\{[^}]*margin-top:\s*44px[^}]*margin-left:\s*max\(/s);
assert.match(shell, /\.mp-home-stats\s*\{[^}]*gap:\s*0[^}]*background:\s*var\(--mp-panel\)/s);
assert.match(shell, /\.mp-home-stat-grid\s*\{[^}]*margin-top:\s*12px/s);
assert.match(shell, /\.mp-home-stat\s*\{[^}]*background:\s*var\(--mp-panel-subtle\)/s);
assert.match(shell, /\.mp-home-heatmap\s*\{[^}]*height:\s*120px/s);
assert.match(shell, /\.mp-home-heatmap\s*\{[^}]*margin-top:\s*6px/s);
assert.match(shell, /\.mp-home-heatmap i\s*\{[^}]*background:\s*var\(--mp-panel-subtle\)/s);
for (const [token, value] of [
  ['--mp-repository-surface', '#F2F2F1'],
  ['--mp-heat-level-1', '#86ACEA'],
  ['--mp-heat-level-2', '#6394E3'],
  ['--mp-heat-level-3', '#407CDD'],
  ['--mp-heat-level-4', '#2566D0'],
]) {
  assert(tokens.includes(`${token}: ${value}`), `measured Claude token missing: ${token}`);
}
assert.match(shell, /\.mp-home-heatmap i\[data-level="1"\]\s*\{[^}]*background:\s*var\(--mp-heat-level-1\);\s*opacity:\s*1/s);
assert.match(chat, /\.mp-repository-context\s*\{[^}]*background:\s*var\(--mp-repository-surface\)/s,
  'repository bar must consume its measured theme token without an inline fallback');
assert.match(shell, /\.mp-home-stats-note\s*\{[^}]*margin:\s*10px 0 0/s);
assert.match(chat, /\.dshw-input-form\s*\{[^}]*padding:\s*0/s);
assert.match(chat, /\.dshw-input-root\s*\{[^}]*position:\s*relative/s);
assert.match(shell, /\.mp-account-footer > span:nth-child\(2\)\s*\{[^}]*flex-direction:\s*row/s);
assert.match(shell, /\.mp-account-footer small::before\s*\{[^}]*content:\s*'·'/s);
assert.match(shell, /\.dshw-workspace-header\s*\{[^}]*display:\s*none/s);
assert(!main.includes('startTitleBarSampling'));
assert(!main.includes('stopTitleBarSampling'));
assert(!main.includes('sampleTitleBarSymbolColor'));
assert(!main.includes('TITLEBAR_SAMPLE_REGION'));
assert.strictEqual((main.match(/ipcMain\.on\('dashboard:theme'/g) || []).length, 1);
assert.match(main, /function titleBarColors\([\s\S]*?height:\s*36/);
assert.match(main, /ipcMain\.on\('dashboard:theme'[\s\S]*?setTitleBarOverlay\(titleBarColors\(/);
assert(!main.includes('height: 46'));

console.log('studio Claude fidelity contract ok');

function sourceIncludes(value) {
  return homeSource.includes(value) || permissionSource.includes(value);
}
