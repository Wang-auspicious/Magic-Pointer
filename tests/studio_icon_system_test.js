'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const DshIcons = require('../electron/renderer/dsh_icons');
const DshChat = require('../electron/renderer/dsh_chat');
const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const sprite = fs.readFileSync('electron/renderer/icons.ts', 'utf8');
const studio = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const shellCss = fs.readFileSync('electron/renderer/claude_shell.css', 'utf8');

// Tool/message glyphs and shell glyphs now share the same 24px, 1.5px,
// round-cap geometry. This is intentionally the opposite of the old copied
// filled icon mixture the supplied screenshots rejected.
for (const name of ['think', 'edit', 'api', 'copy', 'send', 'branch', 'search']) {
  const icon = DshIcons.node(name, 16).outerHTML;
  assert(icon.includes('viewBox="0 0 24 24"'), `${name} must use the shared 24px grid`);
  assert(icon.includes('stroke-width="1.5"'), `${name} must use the thin stroke system`);
  assert(icon.includes('stroke-linecap="round"'), `${name} must use rounded terminals`);
  assert(!icon.includes('fill="currentColor"'), `${name} must not regress to a chunky filled glyph`);
}

const branch = DshChat.userNode('建立分支', undefined, { conversationId: 'c1', turnIndex: 2 }).outerHTML;
assert(branch.includes('data-dsh-act="branch"'));
assert(branch.includes('data-dsh-branch-conversation="c1"'));
assert(branch.includes('data-dsh-branch-turn="2"'));

for (const id of [
  'ic-panel-left', 'ic-message-plus', 'ic-folder-plus', 'ic-message',
  'ic-activity', 'ic-ellipsis', 'ic-triangle-right', 'ic-branch',
  'ic-command-line', 'ic-file-add', 'ic-play', 'ic-dots-vertical',
  'ic-agent-workflow',
]) {
  assert(sprite.includes(`id="${id}"`), `${id} must exist in the unified shell sprite`);
}

assert(sprite.includes('<path d="M5 6h14M5 12h10M5 18h6"/>'),
  'the application menu uses Claude\'s descending three-line silhouette');
assert(sprite.includes('<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>'),
  'the file preview Code action includes the measured slash rather than a generic angle pair');
assert(sprite.includes('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
  'Inspector maximise uses the two diagonal corner arrows visible in Claude');
const headerOrder = [
  'id="bottom-panel-toggle"',
  'id="inspector-toggle"',
  'id="header-preview-toggle"',
  'id="thread-more"',
].map((needle) => html.indexOf(needle));
assert(headerOrder.every((index) => index >= 0));
assert.deepStrictEqual([...headerOrder].sort((a, b) => a - b), headerOrder,
  'conversation header follows Claude: terminal, file browser, preview, more');
assert.match(html, /id="inspector-toggle"[\s\S]*?<use href="#ic-file-add"/,
  'Claude FileAdd glyph opens the file browser');
assert(html.includes('class="mp-conversation-view" aria-label="对话视图" hidden'),
  'the old permanent Chat/Trajectory buttons move into the more menu');
assert.match(shellCss, /\.dshw-new-session:not\(\.is-on\) svg\s*\{[^}]*border-radius:\s*50%[^}]*background:\s*var\(--mp-hover\)/s,
  'the unselected light conversation state keeps Claude\'s small circular plus surface');

assert(html.includes('id="chat-source-thumb"'), 'the source thumbnail remains a useful header affordance');
assert(!html.includes('#ic-dsh-'), 'the visible Studio shell must not mix in legacy filled DSH symbols');
assert(!html.includes('id="mp-context-tag"'), 'the meaningless product context pill must stay removed');
assert(!html.includes('id="session-log"'), 'the download pill must stay removed');
assert(studio.includes("icon(expanded ? 'ic-tree-folder-open' : 'ic-tree-folder')"),
  'project rows use the registered Claude-style open/closed folder pair');
assert(studio.includes("icon('ic-ellipsis')"), 'conversation actions use the shared quiet ellipsis');
assert(studio.includes("href=\"#ic-agent-workflow\""),
  'Tasks use a redistributable workflow glyph corresponding to Claude\'s Agent icon');
assert(DshIcons.node('think', 16).outerHTML.includes('M12 6v6h4'),
  'thinking uses a clock-family glyph corresponding to Claude ExtendedThinking');

console.log('studio icon system test ok');
