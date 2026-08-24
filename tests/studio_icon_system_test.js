'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const DshIcons = require('../electron/renderer/dsh_icons');
const DshChat = require('../electron/renderer/dsh_chat');
const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const sprite = fs.readFileSync('electron/renderer/icons.ts', 'utf8');
const studio = fs.readFileSync('electron/renderer/studio.ts', 'utf8');

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
]) {
  assert(sprite.includes(`id="${id}"`), `${id} must exist in the unified shell sprite`);
}

assert(html.includes('id="chat-source-thumb"'), 'the source thumbnail remains a useful header affordance');
assert(!html.includes('#ic-dsh-'), 'the visible Studio shell must not mix in legacy filled DSH symbols');
assert(!html.includes('id="mp-context-tag"'), 'the meaningless product context pill must stay removed');
assert(!html.includes('id="session-log"'), 'the download pill must stay removed');
assert(studio.includes("icon('ic-folder')"), 'project rows use the shared thin folder icon');
assert(studio.includes("icon('ic-ellipsis')"), 'conversation actions use the shared quiet ellipsis');

console.log('studio icon system test ok');
