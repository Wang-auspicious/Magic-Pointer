'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const ChatIcons = require('../electron/renderer/chat_icons');
const ChatView = require('../electron/renderer/chat_view');
const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const sprite = fs.readFileSync('electron/renderer/icons.ts', 'utf8');
const studio = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const shellCss = fs.readFileSync('electron/renderer/studio_layout.css', 'utf8');

for (const name of ['think', 'edit', 'api', 'copy', 'send', 'branch', 'search']) {
  const icon = ChatIcons.node(name, 16).outerHTML;
  assert(icon.includes('viewBox="0 0 24 24"'), `${name} must use the shared 24px grid`);
  assert(icon.includes('stroke-width="1.5"'), `${name} must use the thin stroke system`);
  assert(icon.includes('stroke-linecap="round"'), `${name} must use rounded terminals`);
  assert(!icon.includes('fill="currentColor"'), `${name} must not regress to a chunky filled glyph`);
}

const branch = ChatView.userNode('建立分支', undefined, { conversationId: 'c1', turnIndex: 2 }).outerHTML;
assert(branch.includes('data-mp-chat-act="branch"'));
assert(branch.includes('data-mp-chat-branch-conversation="c1"'));
assert(branch.includes('data-mp-chat-branch-turn="2"'));

for (const id of [
  'ic-panel-left', 'ic-message-plus', 'ic-folder-plus', 'ic-message',
  'ic-activity', 'ic-ellipsis', 'ic-triangle-right', 'ic-branch',
  'ic-command-line', 'ic-file-add', 'ic-play', 'ic-dots-vertical',
  'ic-agent-workflow',
]) {
  assert(sprite.includes(`id="${id}"`), `${id} must exist in the unified shell sprite`);
}

assert(sprite.includes('<path d="M5 6h14M5 12h10M5 18h6"/>'),
  'the application menu uses the interface descending three-line silhouette');
assert(sprite.includes('<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>'),
  'the file preview Code action includes the measured slash rather than a generic angle pair');
assert(sprite.includes('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
  'Inspector maximise uses the two diagonal corner arrows visible in Studio');
const headerOrder = [
  'id="bottom-panel-toggle"',
  'id="inspector-toggle"',
  'id="header-preview-toggle"',
  'id="thread-more"',
].map((needle) => html.indexOf(needle));
assert(headerOrder.every((index) => index >= 0));
assert.deepStrictEqual([...headerOrder].sort((a, b) => a - b), headerOrder,
  'conversation header follows Studio: terminal, file browser, preview, more');
assert.match(html, /id="inspector-toggle"[\s\S]*?<use href="#ic-file-add"/,
  'Studio FileAdd glyph opens the file browser');
assert(html.includes('class="mp-conversation-view" aria-label="对话视图" hidden'),
  'the old permanent Chat/Trajectory buttons move into the more menu');
assert.match(shellCss, /\.mp-new-circle\s*\{[^}]*width:\s*18px[^}]*border-radius:\s*50%[^}]*background:\s*color-mix/s,
  'the supplied Code sidebar uses the compact 18px New circle');
assert.match(html, /class="mp-new-circle"[\s\S]*?data-glyph="&#xE001;"/);

assert(html.includes('id="chat-source-thumb"'), 'the source thumbnail remains a useful header affordance');
assert.match(html, /class="mpw-title-cluster"[\s\S]*?data-glyph="&#xE093;"[\s\S]*?id="chat-title"/,
  'the Code conversation title starts with the original laptop glyph');
assert.match(html, /class="mpw-primary"[\s\S]*?data-glyph="&#xE00F;"/,
  'the Code composer uses the original ArrowReturn glyph');
assert(studio.includes("api.CdsIcons.html('code-send')"), 'settling a run must restore the same Code send glyph');
assert.match(fs.readFileSync('electron/renderer/chat_styles.css', 'utf8'), /#composer-mention\s*\{\s*display:\s*none;/,
  'the reference composer has no permanent extra @ button');
assert(!html.includes('#ic-mp-chat-'), 'the visible Studio shell must not mix in legacy filled symbols');
assert(!html.includes('id="mp-context-tag"'), 'the meaningless product context pill must stay removed');
assert(!html.includes('id="session-log"'), 'the download pill must stay removed');
assert(studio.includes("icon(expanded ? 'ic-tree-folder-open' : 'ic-tree-folder')"),
  'project rows use the registered shared open/closed folder pair');
assert(studio.includes("icon('ic-ellipsis')"), 'conversation actions use the shared quiet ellipsis');
assert(!studio.includes('class="mp-subagent-badge"'),
  'the supplied compact Background tasks cards do not add an invented workflow badge');
assert(ChatIcons.node('think', 16).outerHTML.includes('M12 6v6h4'),
  'thinking uses a clock-family glyph corresponding to Studio ExtendedThinking');

console.log('studio icon system test ok');
