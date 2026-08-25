'use strict';

/* Design 概览 × bento-grid 契约:
   悬停编排逐字来自 _sv_sources/sv-animations/bento-grid/src/magic/bento-grid/bento-card.svelte
   L34-L87(内容上浮 / 图标缩至 75% / CTA 自下而上浮现 / 全卡微罩层,duration 300);
   图标来自同仓库 demo L5-L9 的 Lucide 集(file-text / file-input / globe / calendar / bell)。 */

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const css = fs.readFileSync('electron/renderer/sv.css', 'utf8');
const icons = fs.readFileSync('electron/renderer/icons.ts', 'utf8');

/* ---- 卡片挂上 sv-bento-card ---- */
assert.strictEqual((html.match(/class="mp-design-card[^"]*sv-bento-card"/g) || []).length, 4,
  'all four design-home cards must carry sv-bento-card');
assert(html.includes('sv-bento-card-icon'), 'icon wrapper marked for hover choreography');
assert(html.includes('sv-bento-card-arrow'), 'arrow acts as the rising CTA');

/* ---- 悬停语言(源参数) ---- */
assert.match(css, /\.sv-bento-card\.is-hoverable:hover \.mp-design-card-copy|\.sv-bento-card:hover \.mp-design-card-copy/s,
  'copy block lifts on hover');
assert.match(css, /\.sv-bento-card:hover \.sv-bento-card-icon\s*\{[^}]*scale\(0\.75\)|\.sv-bento-card\.is-hoverable:hover \.sv-bento-card-icon\s*\{[^}]*scale\(0\.75\)/s,
  'icon scales to 75% like the source');
assert.match(css, /\.sv-bento-card:hover \.sv-bento-card-arrow[^{]*\{[^}]*opacity:\s*1/s, 'CTA rises to visible');
assert.match(css, /\.sv-bento-card::after\s*\{[^}]*transition[^\n;}]*300ms/s, 'overlay tint transitions 300ms');
assert.match(css, /\.sv-bento-card:hover::after\s*\{[^}]*opacity:\s*1/s, 'hover shows the tint layer');
/* 紧凑卡适配:源 -translate-y-10 是营销行高;这里按卡片高度等比缩小并注释说明 */
assert.match(css, /translateY\(-4px\)/s, 'lift adapted for compact card height');

/* ---- bento demo 五枚 Lucide 图标全部入 sprite(官方路径,外壳 1.5 描边约定) ---- */
for (const id of ['ic-file-text', 'ic-file-input', 'ic-calendar', 'ic-bell', 'ic-globe']) {
  assert(icons.includes(`id="${id}"`), `sprite must contain ${id}`);
}
assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.sv-bento-card[^{]*\{/s,
  'reduced motion disables bento choreography');

console.log('studio_bento_contract ok');
