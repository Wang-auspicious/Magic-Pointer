'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const css = fs.readFileSync('electron/renderer/magic_studio.css', 'utf8');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const preload = fs.readFileSync('electron/preload.ts', 'utf8');

// Codex Desktop shell anatomy: primary destinations, project-owned threads,
// a thread header, and an inspector with the three working surfaces.
for (const id of [
  'nav-new-chat', 'nav-pull-requests', 'nav-sites', 'nav-scheduled', 'nav-plugins',
  'thread-more', 'inspector-toggle', 'project-inspector',
  'inspector-files', 'inspector-browser', 'inspector-terminal',
  'composer-voice',
]) {
  assert(html.includes(`id="${id}"`), `Codex shell control is missing: ${id}`);
}

// A click must paint a visible menu immediately. Network/catalog refresh may
// continue afterwards, but it may never hold the popover hostage.
const openModel = source.slice(source.indexOf('async function openModelMenu'), source.indexOf('function modelMenuNote'));
assert(openModel.indexOf("menu.hidden = false") >= 0, 'model menu must become visible synchronously');
assert(openModel.indexOf("aria-expanded', 'true") >= 0, 'model button must expose its open state synchronously');
assert(openModel.indexOf('menu.hidden = false') < openModel.indexOf('await Data.models()'),
  'model menu visibility must not wait for the provider catalog');
assert(!openModel.includes('btn.disabled = true'), 'model selector must remain responsive while the catalog refreshes');

// Codex uses one composer focus surface. The textarea caret must not draw a
// second blue rounded rectangle inside that surface.
assert.match(css, /\.dshw-input:focus-visible\s*\{[^}]*outline:\s*none[^}]*\}/s);
assert.match(css, /\.dshw-card:focus-within\s*\{[^}]*box-shadow:\s*var\(--mp-shadow-composer\)[^}]*\}/s);
assert(!/\.dshw-card:focus-within\s*\{[^}]*var\(--mp-info\)/s.test(css),
  'composer focus treatment must not introduce a blue inner ring');

// Voice is a real dashboard channel, not a dead microphone icon.
assert.match(preload, /startDictation:\s*\(\)\s*=>\s*ipcRenderer\.send\('dictation:start',\s*\{\s*surface:\s*'dashboard'/);
assert.match(preload, /onDictationResult:\s*\(callback:[^)]*\)\s*=>\s*onPayload\('dictation:result'/);
assert(source.includes("getElementById('composer-voice')"));

console.log('studio Codex shell interaction contract ok');
