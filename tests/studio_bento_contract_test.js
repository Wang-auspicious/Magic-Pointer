'use strict';

/* Design 与其余 Studio 共用 Claude workbench 语法：普通动作行，不再用
   营销 bento、罩层、图标缩放和漂浮 CTA。 */

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const css = fs.readFileSync('electron/renderer/claude_shell.css', 'utf8');
const icons = fs.readFileSync('electron/renderer/icons.ts', 'utf8');

assert(!html.includes('mp-design-bento'), 'Design marketing bento is deleted');
assert(!html.includes('sv-bento-card'), 'Design does not retain SV hover choreography');
assert.strictEqual((html.match(/class="mp-design-action-row"/g) || []).length, 4,
  'Design exposes four real workbench actions');
assert.match(html, /class="mp-design-intro">\s*<h1>Cowork<\/h1>/,
  'the left segment and its destination use the same Claude product name');
for (const label of ['Canvas', 'Assets', 'Files', 'Artifacts']) {
  assert(html.includes(`<strong>${label}</strong>`), `Cowork row missing: ${label}`);
}
for (const action of ['canvas', 'list', 'files', 'artifacts']) {
  assert(html.includes(`data-design-action="${action}"`), `Design action missing: ${action}`);
}
assert.match(css, /\.mp-design-action-row\s*\{[^}]*border-bottom:\s*1px solid var\(--mp-rule\)/s);
assert(!css.includes('scale(0.75)'), 'Design rows do not shrink icons for decoration');

/* Design 只保留四个真实动作正在使用的图标，描边服从 Studio 统一 1.5px。 */
for (const id of ['ic-file-text', 'ic-file-input', 'ic-folder-open', 'ic-docs']) {
  const symbol = icons.match(new RegExp(`<symbol id="${id}"[^>]*>[\\s\\S]*?</symbol>`));
  assert(symbol, `sprite must contain ${id}`);
  assert(symbol[0].includes('stroke-width="1.5"'), `${id} must use the Studio 1.5px stroke`);
}
assert(!icons.includes('id="ic-calendar"'));
assert(!icons.includes('id="ic-bell"'));
console.log('studio_bento_contract ok');
