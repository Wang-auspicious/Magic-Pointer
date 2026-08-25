'use strict';

/* 移植组件图标 100% 网站同款契约:
   - file-tree 内嵌默认 trio:stroke-width 2(源 SVG 原样)
   - bento demo 五图标:stroke-width 1.4(源 iconClass stroke-[1.4])
   - animated-theme-toggler:Lucide 官方 Moon/Sun path,stroke-width 2
   - 树行图标渲染 16px(源 size-4)
   用户裁决:图标不允许"神似",必须与网站渲染参数一致。 */

const assert = require('node:assert');
const fs = require('node:fs');

const icons = fs.readFileSync('electron/renderer/icons.ts', 'utf8');
const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const shellCss = fs.readFileSync('electron/renderer/magic_studio.css', 'utf8');

function symbolLine(id) {
  const match = icons.match(new RegExp(`<symbol id="${id}"[^>]*>[\\s\\S]*?</symbol>`));
  assert(match, `sprite must contain ${id}`);
  return match[0];
}

/* file-tree trio:源内嵌 SVG 的 stroke-width=2 */
for (const id of ['ic-tree-folder-open', 'ic-tree-folder', 'ic-tree-file']) {
  assert(symbolLine(id).includes('stroke-width="2"'), `${id} must render at source stroke 2`);
}
assert(symbolLine('ic-tree-folder-open').includes('M2 10h20'), 'open folder carries the source second path');

/* bento demo 五图标:stroke-[1.4] */
for (const id of ['ic-file-text', 'ic-file-input', 'ic-calendar', 'ic-bell', 'ic-globe']) {
  assert(symbolLine(id).includes('stroke-width="1.4"'), `${id} must render at the demo stroke 1.4`);
}

/* theme-toggler:Lucide 官方 Moon/Sun,stroke 2 */
{
  const sun = symbolLine('ic-sun');
  const moon = symbolLine('ic-moon');
  assert(sun.includes('stroke-width="2"') && sun.includes('<circle cx="12" cy="12" r="4"/>'),
    'sun must be the official Lucide sun');
  assert(sun.includes('m19.07 4.93-1.41 1.41'), 'sun carries the official diagonal ray');
  assert(moon.includes('stroke-width="2"') && moon.includes('M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'),
    'moon must be the official Lucide moon');
  assert(html.includes('#ic-moon'), 'theme toggle boots with the moon glyph');
  assert(fs.readFileSync('electron/renderer/studio.ts', 'utf8').includes("'#ic-sun'"),
    'theme toggle swaps to the sun glyph at runtime');
}

/* 树行图标 16px(源 size-4) */
assert.match(shellCss, /\.mp-file-tree-row svg\s*\{[^}]*width:\s*16px/s, 'tree icons render at 16px like the source');

console.log('studio_sv_icons_contract ok');
