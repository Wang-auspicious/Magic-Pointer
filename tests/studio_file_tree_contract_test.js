'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const css = fs.readFileSync('electron/renderer/claude_shell.css', 'utf8');
const icons = fs.readFileSync('electron/renderer/icons.ts', 'utf8');

for (const id of ['ic-tree-folder-open', 'ic-tree-folder', 'ic-tree-file']) {
  assert(source.includes(`'${id}'`), `${id} must remain wired`);
  assert(icons.includes(`id="${id}"`), `${id} must remain in the sprite`);
}
assert(source.includes("row.setAttribute('aria-expanded', String(expanded))"));
assert(source.includes('nodes.push(...buildLevel(entry.path, depth + 1))'));
assert(!source.includes('sv-tree-branch'));
assert(!source.includes('pendingTreeCollapseTimer'));
assert(!source.includes('lastExpandedTreeDirectory'));

assert.match(css, /\.mp-file-tree-row\s*\{[^}]*min-height:\s*26px/s);
assert.match(css, /\.mp-file-tree-row svg\s*\{[^}]*width:\s*16px[^}]*height:\s*16px/s);
assert.match(css, /\.mp-file-tree-row\[data-depth\]:not\(\[data-depth="0"\]\)::after\s*\{[^}]*width:\s*1px/s);
assert(!/\.mp-file-tree-row[^}]*animation:/s.test(css), 'file rows must not replay decorative entrance motion');

console.log('studio file tree contract ok');
