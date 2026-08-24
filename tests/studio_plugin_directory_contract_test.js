'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');

assert.match(html, /id="nav-plugins"[^>]*data-directory-open/);
for (const id of ['plugin-directory', 'plugin-directory-search', 'plugin-directory-list']) {
  assert(html.includes(`id="${id}"`), `plugin directory surface missing ${id}`);
}
assert(source.includes('await Data.slashDirectory()'), 'directory must read the real command/skill catalog');
assert(source.includes('insertSlashToken(entry.name)'), 'selecting a real entry must insert its slash token');

console.log('studio plugin directory contract ok');
