'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');

for (const id of [
  'app-menu',
  'global-search-toggle',
  'global-search',
  'global-search-input',
  'global-search-results',
  'mode-work',
  'mode-design',
]) {
  assert(html.includes(`id="${id}"`), `navigation control missing: ${id}`);
}

assert(html.includes('src="studio_search.js'));
assert(source.includes('function openGlobalSearch('));
assert(source.includes('function closeGlobalSearch('));
assert(source.includes("event.key.toLocaleLowerCase() === 'k'"));
assert(source.includes("document.getElementById('global-search')?.hidden === false"));
assert(source.indexOf('closeGlobalSearch()') < source.indexOf('stopActiveConversation()'),
  'local search closes before Escape can stop a running task');
assert(source.includes("kind === 'conversation'"));
assert(source.includes("kind === 'project'"));
assert(source.includes("kind === 'route'"));
assert(html.includes('role="tablist"') && html.includes('role="tab"'));

console.log('studio navigation interaction test ok');
