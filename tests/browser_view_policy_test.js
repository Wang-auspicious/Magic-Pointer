'use strict';

const assert = require('node:assert');
const {
  isBrowserOpenableProjectPath,
  normalizeBrowserUrl,
  projectContextActions,
} = require('../electron/browser_view_policy');

assert.equal(normalizeBrowserUrl('openai.com/codex'), 'https://openai.com/codex');
assert.equal(normalizeBrowserUrl(' https://sv-table.vercel.app/docs '), 'https://sv-table.vercel.app/docs');
assert.throws(() => normalizeBrowserUrl('javascript:alert(1)'), /invalid_browser_url/);
assert.throws(() => normalizeBrowserUrl('file:///C:/secret.txt'), /invalid_browser_url/);

assert.equal(isBrowserOpenableProjectPath('site/index.html'), true);
assert.equal(isBrowserOpenableProjectPath('assets/diagram.svg'), true);
assert.equal(isBrowserOpenableProjectPath('docs/report.pdf'), true);
assert.equal(isBrowserOpenableProjectPath('src/main.ts'), false);

assert.deepStrictEqual(projectContextActions('file', 'site/index.html'), [
  'preview', 'open', 'reveal', 'open-in-browser', 'copy-path',
]);
assert.deepStrictEqual(projectContextActions('file', 'src/main.ts'), [
  'preview', 'open', 'reveal', 'copy-path',
]);
assert.deepStrictEqual(projectContextActions('directory', 'src'), [
  'open', 'reveal', 'terminal-here', 'copy-path',
]);

console.log('browser view policy test ok');
