'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const ChatIcons = require('../electron/renderer/chat_icons');
const ChatView = require('../electron/renderer/chat_view');
const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const sprite = fs.readFileSync('electron/renderer/icons.ts', 'utf8');
const studio = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const shellCss = fs.readFileSync('electron/renderer/studio_layout.css', 'utf8');

for (const [name, glyph] of [
  ['think', '\uE068'],
  ['edit', '\uE064'],
  ['api', '\uE051'],
  ['copy', '\uE056'],
  ['check', '\uE03B'],
  ['send', '\uE013'],
  ['branch', '\uE078'],
  ['search', '\uE0D3'],
]) {
  const icon = ChatIcons.node(name, 16).outerHTML;
  assert(icon.includes('class="cds-icon"'), `${name} must use Anthropicons-Variable cds-icon`);
  assert(icon.includes(`data-glyph="${glyph}"`), `${name} must render exact Claude Desktop 4.23118 codepoint`);
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

const headerOrder = [
  'id="header-vault-toggle"',
  'id="header-sidechat-toggle"',
  'id="header-files-toggle"',
  'id="header-changes-toggle"',
  'id="header-terminal-toggle"',
  'id="header-browser-toggle"',
  'id="thread-more"',
].map((needle) => html.indexOf(needle));
assert(headerOrder.every((index) => index >= 0), 'header workspace toggles must exist in studio.html');
assert.deepStrictEqual([...headerOrder].sort((a, b) => a - b), headerOrder,
  'conversation header follows Claude Desktop workspace order ending with More');
assert(!html.includes('href="#ic-'), 'studio.html must have zero legacy #ic-* SVG icon references');
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
assert(!studio.includes('class="mp-subagent-badge"'),
  'the supplied compact Background tasks cards do not add an invented workflow badge');

console.log('studio icon system test ok');
