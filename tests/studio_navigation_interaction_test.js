'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const shellCss = fs.readFileSync('electron/renderer/claude_shell.css', 'utf8');

for (const id of [
  'app-menu',
  'global-search-toggle',
  'global-search',
  'global-search-input',
  'global-search-results',
  'mode-work',
  'mode-design',
  'account-footer',
  'account-menu',
]) {
  assert(html.includes(`id="${id}"`), `navigation control missing: ${id}`);
}

for (const command of ['settings', 'models', 'updates', 'changelog', 'shortcuts', 'about']) {
  assert(html.includes(`data-account-command="${command}"`), `account action missing: ${command}`);
}
assert(source.includes("document.getElementById('account-footer')?.addEventListener('click'"),
  'account footer opens its popup');
assert(source.includes("document.getElementById('account-menu')?.addEventListener('click'"),
  'account actions are delegated through one real menu binding');
assert(source.includes("if (command === 'updates')"));
assert(source.includes("if (command === 'changelog')"));
assert.match(shellCss, /\.mp-account-menu\s*\{[^}]*min-width:\s*208px/s,
  'account popup uses Claude compact menu width');

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
assert.match(html, /id="mode-work" data-product-mode="design" role="tab" aria-selected="false"[\s\S]*?<span>Cowork<\/span>/,
  'Cowork is the left MP design/collaboration surface');
assert.match(html, /id="mode-design" data-product-mode="walker" role="tab" aria-selected="true"[\s\S]*?<span>Code<\/span>/,
  'Code is the default right-side Agent work surface');
assert(source.includes("document.getElementById('mode-work')?.addEventListener('click', () => setProductMode('design'))"));
assert(source.includes("document.getElementById('mode-design')?.addEventListener('click', () => setProductMode('walker'))"));
assert(source.includes("document.getElementById('nav-new-chat')?.classList.toggle('is-on', visible)"));
assert(source.includes("document.getElementById('header-preview-toggle')?.addEventListener('click', () => setInspector(true, 'browser'))"));
assert(source.includes("make('Conversation', () => setConversationTab('chat'))"));
assert(source.includes("make('Trajectory', () => setConversationTab('trajectory'))"));
assert(source.includes("make('Open project folder', () =>"));
assert(source.includes("make('Project context', () =>"));
assert(source.includes("browser?.classList.toggle('is-empty', groups.length === 0)"));
assert(source.includes("empty.className = 'side-empty'"));
assert(source.includes("label.className = 'side-empty-label'"));
assert(source.includes("'Sessions you start will show up here'"));
assert(source.includes('function emptySessionsPictogram()'),
  'empty Code sidebar must render Claude Desktop\'s local pixel pictogram');
assert(source.includes("viewBox', '0 0 150 140'"));
assert(source.includes("width', '82.5'"), 'Claude renders the 150px pictogram at scale .55');
assert(source.includes("height', '77'"), 'Claude renders the 140px pictogram at scale .55');
assert(source.includes("path.setAttribute('d', emptySessionsPictogramPath())"));
assert.match(shellCss, /\.side-empty\s*\{[^}]*gap:\s*16px[^}]*padding:\s*0 16px 40px/s,
  'empty-sidebar stack must use Claude\'s measured gap and lower optical inset');
assert.match(shellCss, /\.side-empty-pictogram\s*\{[^}]*color:\s*hsl\(var\(--mp-pictogram-200\)\)/s,
  'empty-sidebar pictogram must use the local Claude pictogram tone');
assert(source.includes("className = 'dshw-project-actions'"));
assert(source.includes('data-project-new'));
assert(source.includes('data-project-tools'));
assert(!source.includes('dshw-project-folder'));
assert(source.includes("const parentCallId = String(detail?.parentCallId || '')"));
assert(source.includes('tasks.find((task) => task.id === requestedId || task.parentCallId === parentCallId)'));
assert(source.includes("document.querySelector<HTMLElement>(`.mp-subagent-task[data-task-id=\"${CSS.escape(focusedSubagentId)}\"]`)"),
  'opening an Agent row focuses and reveals its matching Tasks item');
assert(source.includes("{ type: 'open', tab, availableWidth: inspectorAvailableWidth() }"),
  'opening any Inspector tab must clamp a persisted width to the live content area');
assert(source.includes("{ type: 'viewport', availableWidth: inspectorAvailableWidth() }"),
  'window resizing must re-clamp an open Inspector before it crushes the conversation');
assert(source.includes('window.innerWidth - 288'),
  'initial Inspector width must account for the expanded sidebar');

console.log('studio navigation interaction test ok');
