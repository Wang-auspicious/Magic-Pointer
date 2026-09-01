'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const tokens = fs.readFileSync('electron/renderer/claude_tokens.css', 'utf8');
const shell = fs.readFileSync('electron/renderer/claude_shell.css', 'utf8');
const chat = fs.readFileSync('electron/renderer/claude_chat.css', 'utf8');

for (const href of ['claude_tokens.css', 'claude_shell.css', 'claude_chat.css']) {
  assert(html.includes(`href="${href}`), `missing ${href}`);
}
assert(!html.includes('studio_system.css'));
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

console.log('studio Claude fidelity contract ok');
