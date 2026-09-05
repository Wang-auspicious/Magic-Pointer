'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const css = fs.readFileSync('electron/renderer/claude_chat.css', 'utf8');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const preload = fs.readFileSync('electron/preload.ts', 'utf8');

// Codex Desktop shell anatomy: primary destinations, project-owned threads,
// a thread header, and an inspector with the three working surfaces.
for (const id of [
  'nav-new-chat', 'settings-open', 'app-menu', 'global-search-toggle',
  'thread-more', 'inspector-toggle', 'project-inspector',
  'inspector-files', 'inspector-browser', 'inspector-terminal',
  'composer-voice',
]) {
  assert(html.includes(`id="${id}"`), `Claude workbench control is missing: ${id}`);
}
for (const removed of ['nav-pull-requests', 'nav-sites', 'nav-scheduled', 'nav-plugins']) {
  assert(!html.includes(`id="${removed}"`), `${removed} must not occupy permanent sidebar space`);
}

// A click must paint a visible menu immediately. Network/catalog refresh may
// continue afterwards, but it may never hold the popover hostage.
const openModel = source.slice(source.indexOf('async function openModelMenu'), source.indexOf('function modelMenuNote'));
const positionPopover = source.slice(source.indexOf('function positionAnchoredPopover'), source.indexOf('interface StudioSubagentStep'));
assert(positionPopover.indexOf('popup.hidden = false') >= 0, 'anchored popovers must become visible synchronously');
assert(positionPopover.indexOf("aria-expanded', 'true") >= 0, 'popover triggers must expose their open state synchronously');
assert(openModel.indexOf("positionAnchoredPopover('composer-model-menu', 'composer-model')") < openModel.indexOf('await Data.models()'),
  'model menu visibility must not wait for the provider catalog');
assert(!openModel.includes('btn.disabled = true'), 'model selector must remain responsive while the catalog refreshes');

// Codex uses one composer focus surface. The textarea caret must not draw a
// second blue rounded rectangle inside that surface.
assert.match(css, /\.dshw-input-root:focus-within \.dshw-scroll\s*\{[^}]*border-color:/s);
assert.match(css, /\.dshw-input\s*\{[^}]*border:\s*0[^}]*resize:\s*none/s);
assert(!/\.dshw-input-root:focus-within[^}]*var\(--mp-focus\)/s.test(css),
  'composer focus uses quiet border contrast rather than a blue inner ring');

// Voice is a real dashboard channel, not a dead microphone icon.
assert.match(preload, /startDictation:\s*\(\)\s*=>\s*ipcRenderer\.send\('dictation:start',\s*\{\s*surface:\s*'dashboard'/);
assert.match(preload, /onDictationResult:\s*\(callback:[^)]*\)\s*=>\s*onPayload\('dictation:result'/);
assert(source.includes("getElementById('composer-voice')"));

console.log('studio Codex shell interaction contract ok');
