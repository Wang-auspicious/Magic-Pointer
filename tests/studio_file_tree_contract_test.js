'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const css = fs.readFileSync('electron/renderer/claude_shell.css', 'utf8');
const icons = fs.readFileSync('electron/renderer/icons.ts', 'utf8');
const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');

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

for (const id of ['project-file-code', 'project-file-search', 'project-file-back', 'project-file-copy']) {
  assert(html.includes(`id="${id}"`), `file preview action is missing: ${id}`);
}
assert(!html.includes('id="project-file-open"'), 'Claude File context row has exactly Code, Search, Folder, Copy');
assert.match(html, /id="project-file-code"[^>]*>[\s\S]*?<use href="#ic-code"/);
assert(source.includes('let projectFileCodeView = false'));
assert(source.includes("document.getElementById('project-file-code')?.addEventListener('click'"));
assert(source.includes('renderSelectedProjectFile()'));
assert(source.includes("panel?.classList.add('is-previewing')"));
assert(source.includes('DshMarkdown.render(selectedProjectFileText)'));
assert.match(css, /\.mp-inspector-panel\.is-previewing \.mp-inspector-filter,[\s\S]*\.mp-file-tree\s*\{[^}]*display:\s*none/s);
assert.match(css, /\.mp-file-preview header button svg\s*\{[^}]*width:\s*16px[^}]*height:\s*16px/s);
assert.match(css, /\.mp-file-preview\.is-markdown \.mp-file-preview-content\s*\{/s);
assert.match(css, /\.mp-file-preview\.is-markdown \.dsh-markdown table\s*\{[^}]*width:\s*100%[^}]*border-collapse:\s*separate[^}]*border-spacing:\s*2px/s,
  'Inspector Markdown tables must use Claude\'s separated soft-cell grid');
assert.match(css, /\.mp-file-preview\.is-markdown \.dsh-markdown :is\(th, td\)\s*\{[^}]*padding:\s*4px 8px[^}]*background:\s*var\(--mp-markdown-cell\)[^}]*border-radius:\s*2px/s,
  'Inspector Markdown table cells must keep the measured inset, fill, and radius');
assert.match(css, /\.mp-file-preview\.is-markdown \.dsh-markdown th\s*\{[^}]*font-weight:\s*var\(--mp-weight-medium\)/s,
  'Inspector Markdown table headers use the same quiet medium weight as Claude');
assert.match(css, /\.mp-inspector-tabs\s*\{[^}]*display:\s*none/s,
  'Claude side panes do not expose a permanent tab strip');

console.log('studio file tree contract ok');
