'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const tokens = fs.readFileSync('electron/renderer/claude_tokens.css', 'utf8');
const shell = fs.readFileSync('electron/renderer/claude_shell.css', 'utf8');
const chat = fs.readFileSync('electron/renderer/claude_chat.css', 'utf8');
const main = fs.readFileSync('electron/main.ts', 'utf8');

for (const href of ['claude_tokens.css', 'claude_shell.css', 'claude_chat.css']) {
  assert(html.includes(`href="${href}`), `missing ${href}`);
}
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
assert.match(tokens, /--mp-window-bar:\s*36px/);
assert.match(tokens, /--mp-sidebar-width:\s*288px/);
assert.match(tokens, /--mp-content-width:\s*768px/);
assert.match(tokens, /--mp-page:\s*#FCFCFB/);
assert.match(tokens, /--mp-page:\s*#151515/);
assert.match(tokens, /--mp-ease-out:\s*cubic-bezier\(\.32,\.72,0,1\)/);
assert.match(shell, /grid-template-rows:\s*var\(--mp-window-bar\) minmax\(0,\s*1fr\)/);
assert.match(shell, /\.mp-inspector\s*\{[^}]*margin:\s*8px 8px 8px 0/s);
assert.match(chat, /max-width:\s*calc\(var\(--mp-content-width\) \+ 64px\)/);
assert(!main.includes('startTitleBarSampling'));
assert(!main.includes('stopTitleBarSampling'));
assert(!main.includes('sampleTitleBarSymbolColor'));
assert(!main.includes('TITLEBAR_SAMPLE_REGION'));
assert.strictEqual((main.match(/ipcMain\.on\('dashboard:theme'/g) || []).length, 1);
assert.match(main, /function titleBarColors\([\s\S]*?height:\s*36/);
assert.match(main, /ipcMain\.on\('dashboard:theme'[\s\S]*?setTitleBarOverlay\(titleBarColors\(/);
assert(!main.includes('height: 46'));

console.log('studio Claude fidelity contract ok');
