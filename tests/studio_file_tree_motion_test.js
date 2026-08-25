'use strict';

/* Inspector 文件树 × file-tree(folder/file)契约:
   展开高度 0→auto + opacity、200ms easeInOut、左缘 1px 竖导轨,
   参数逐字来自 _sv_sources/sv-animations/file-tree/src/magic/file-tree/folder.svelte L88-L109 */

const assert = require('node:assert');
const fs = require('node:fs');

const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const css = fs.readFileSync('electron/renderer/sv.css', 'utf8');
const icons = fs.readFileSync('electron/renderer/icons.ts', 'utf8');

/* ---- 树行图标 = 源码内嵌默认 trio(folder.svelte L61-62 / file.svelte L41,
   经典 Lucide folder-open/folder/file 的逐字 path;描边按外壳 1.5 约定) ---- */
assert(source.includes("'ic-tree-folder-open'"), 'expanded folder uses the source open icon');
assert(source.includes("'ic-tree-folder'"), 'collapsed folder uses the source closed icon');
assert(source.includes("'ic-tree-file'"), 'file rows use the source file icon');
assert(icons.includes('id="ic-tree-folder-open"') && icons.includes('M2 10h20'),
  'sprite carries the source open-folder path verbatim');
assert(icons.includes('id="ic-tree-folder"') && icons.includes('L9.6 3.9A2 2 0 0 0 7.93 3'),
  'sprite carries the source closed-folder path verbatim');
assert(icons.includes('id="ic-tree-file"') && icons.includes('M14 2v4a2 2 0 0 0 2 2h4'),
  'sprite carries the source file path verbatim');

/* ---- studio.ts:嵌套分支渲染 + 入场/退场编排 ---- */
assert(source.includes("'sv-tree-branch'"), 'expanded directories must wrap children in an animated branch');
assert(source.includes("'sv-tree-branch-inner'"), 'branch needs its inner clipping layer');
assert(source.includes("'is-open'"), 'branch open state drives the grid-rows transition');
assert(source.includes('lastExpandedTreeDirectory'), 'freshly expanded branch must animate in (rAF flip)');
assert.match(source, /requestAnimationFrame\(\(\) => \{[^}]*classList\.add\('is-open'\)/s,
  'entrance flips is-open on the next frame so the transition runs');
assert(source.includes('pendingTreeCollapseTimer'), 'collapse plays the exit animation before re-render');

/* ---- sv.css:折叠容器 = 源 motion height 0→auto / opacity / 200ms easeInOut ---- */
assert.match(css, /\.sv-tree-branch\s*\{[^}]*display:\s*grid/s);
assert.match(css, /\.sv-tree-branch\s*\{[^}]*grid-template-rows:\s*0fr/s);
assert.match(css, /\.sv-tree-branch\.is-open\s*\{[^}]*grid-template-rows:\s*1fr/s);
assert.match(css, /\.sv-tree-branch\s*\{[^}]*opacity:\s*0/s);
assert.match(css, /\.sv-tree-branch\s*\{[^}]*200ms ease-in-out,\s*opacity 200ms ease-in-out|\.sv-tree-branch\s*\{[^}]*opacity 200ms ease-in-out,\s*grid-template-rows 200ms ease-in-out/s,
  'branch animates 200ms ease-in-out like the source');

/* 内层裁剪 + 左缘竖导轨(源 indicator,L97-L103) */
assert.match(css, /\.sv-tree-branch-inner\s*\{[^}]*min-height:\s*0/s);
assert.match(css, /\.sv-tree-branch-inner\s*\{[^}]*overflow:\s*hidden/s);
assert.match(css, /\.sv-tree-branch-inner::before\s*\{[^}]*width:\s*1px/s, 'guide rail is a hairline');
assert.match(css, /\.sv-tree-branch-inner::before\s*\{[^}]*var\(--mp-border-/s, 'guide rail uses the muted token');

/* reduced-motion 直接呈现 */
assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.sv-tree-branch\s*\{[^}]*transition:\s*none/s);

console.log('studio_file_tree_motion_contract ok');
