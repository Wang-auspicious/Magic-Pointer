'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const iconSource = fs.readFileSync('electron/renderer/cds_icons.ts', 'utf8');
const sandbox = { module: { exports: {} } };
vm.runInNewContext(ts.transpileModule(iconSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
const icons = sandbox.module.exports;

// The actual font has ANIM on these outlines; static glyphs must not be animated by accident.
for (const name of ['artifacts', 'customize', 'projects', 'design']) {
  assert.match(icons.html(name), /data-cds-anim="ANIM"/, `${name} must carry its font animation axis`);
}
assert.match(icons.html('code'), /data-cds-anim="ANIM ANM2"/);
for (const name of ['new-chat', 'search', 'scheduled']) assert.doesNotMatch(icons.html(name), /data-cds-anim=/);

// Both user-triggered collapse and the supported narrow-window layout previously hid glyph spans.
const shell = fs.readFileSync('electron/renderer/claude_shell.css', 'utf8');
assert.doesNotMatch(shell, /\.dshw-(?:customize|new-session) span\s*[,{]/,
  'sidebar collapse must target labels, not all spans (including the icon font)');
const css = fs.readFileSync('electron/renderer/cds_icons.css', 'utf8');
assert.match(css, /font-variation-settings:[^;]*"ANIM"/);
assert.match(css, /prefers-reduced-motion/);
assert.match(css, /cubic-bezier\(\.34,\s*1\.3,\s*\.64,\s*1\)/, 'use the desktop bundle spring curve');
assert.match(css, /1s linear \.1s infinite/, 'Code ANM2 uses the original delayed square-wave loop');

const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const artifacts = source.slice(source.indexOf('interface ArtifactEntry'), source.indexOf('const artifactEditor ='));
const elements = new Map();
function element() { return { attrs: {}, dataset: {}, innerHTML: '', setAttribute(key, value) { this.attrs[key] = value; } }; }
for (const id of ['artifact-kind-menu', 'artifact-kind-label', 'artifact-layout-toggle', 'art-list']) elements.set(id, element());
const runtime = {
  studioLibraries: { artifactPreviewMarkup: (entry, content) => `<strong>${entry.name}</strong><span>${content}</span>` },
  document: { getElementById: id => elements.get(id), querySelectorAll: () => [] },
  CdsIcons: icons, icon: name => `<svg data-icon="${name}"></svg>`,
  esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
  formatTime: () => '10:00',
};
vm.createContext(runtime);
vm.runInContext(ts.transpileModule(artifacts, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, runtime);
vm.runInContext("artifactLayout = 'grid'; paintArtifactToolbar([{kind:'text'}])", runtime);
assert.match(elements.get('artifact-layout-toggle').innerHTML, /data-glyph="&#xE09C;/, 'grid state offers the original list action glyph');
assert.match(elements.get('artifact-kind-menu').innerHTML, /data-glyph="&#xE03B;/, 'selected type has an actual check glyph');
const card = vm.runInContext("artifactRowMarkup({artifactId:'a1',conversationId:'c1',kind:'text',name:'Actual draft',summary:'The saved draft excerpt',revision:3})", runtime);
assert.match(card, /mp-artifact-preview/);
assert.match(card, /The saved draft excerpt/);
assert.doesNotMatch(card, /revision 3/, 'revision numbers belong to details, not the primary browse metadata');
console.log('Claude reference parity behavior ok');
