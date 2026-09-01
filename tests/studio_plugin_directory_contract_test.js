'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const model = fs.readFileSync('electron/renderer/settings_model.ts', 'utf8');

assert(!html.includes('id="nav-plugins"'), 'plugins no longer occupy a permanent sidebar row');
assert(html.includes('data-directory-open'), 'Customize links to the real local directory');
for (const id of ['skills', 'plugins', 'connectors']) {
  assert(model.includes(`id: '${id}'`), `Customize model missing ${id}`);
}
for (const id of ['plugin-directory', 'plugin-directory-search', 'plugin-directory-list']) {
  assert(html.includes(`id="${id}"`), `plugin directory surface missing ${id}`);
}
assert(source.includes('await Data.slashDirectory()'), 'directory must read the real command/skill catalog');
assert(source.includes('insertSlashToken(entry.name)'), 'selecting a real entry must insert its slash token');

console.log('studio plugin directory contract ok');
