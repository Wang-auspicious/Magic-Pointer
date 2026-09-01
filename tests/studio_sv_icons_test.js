'use strict';

/* Studio 图标契约：保留真实文件树与主题切换所需的 SVG，渲染尺寸
   统一进入新的 Claude-fidelity 样式表；已经删除的 Design bento 不再
   为了旧测试继续携带一套展示专用图标。 */

const assert = require('node:assert');
const fs = require('node:fs');

const icons = fs.readFileSync('electron/renderer/icons.ts', 'utf8');
const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const shellCss = fs.readFileSync('electron/renderer/claude_shell.css', 'utf8');

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
