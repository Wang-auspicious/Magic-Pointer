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
for (const action of ['canvas', 'list', 'files', 'artifacts']) {
  assert(html.includes(`data-design-action="${action}"`), `Design action missing: ${action}`);
}
assert.match(css, /\.mp-design-action-row\s*\{[^}]*border-bottom:\s*1px solid var\(--mp-rule\)/s);
assert(!css.includes('scale(0.75)'), 'Design rows do not shrink icons for decoration');

/* ---- bento demo 五枚 Lucide 图标全部入 sprite(官方路径,外壳 1.5 描边约定) ---- */
for (const id of ['ic-file-text', 'ic-file-input', 'ic-calendar', 'ic-bell', 'ic-globe']) {
  assert(icons.includes(`id="${id}"`), `sprite must contain ${id}`);
}
console.log('studio_bento_contract ok');
