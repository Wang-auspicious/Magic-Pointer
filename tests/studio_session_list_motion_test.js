'use strict';

/* 会话列表 × animated-list 入场契约:
   弹簧参数逐字来自 _sv_sources/sv-animations/animated-list/src/magic/animated-list/animated-list.svelte
   L52-L58(scale 0→1 / opacity / y -8→0,spring stiffness 500 damping 30)。 */

const assert = require('node:assert');
const fs = require('node:fs');

const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const css = fs.readFileSync('electron/renderer/sv.css', 'utf8');

/* ---- 编排:签名变化才入场,搜索每个键击不重播 ---- */
assert(source.includes('sidebarListSignature'), 'entrance must be gated by a list-signature change');
assert(source.includes("'sv-row-in'"), 'fresh rows must carry the entrance class');
assert(source.includes("'--sv-i'"), 'rows get a stable index for stagger');

/* ---- 动画体:源关键帧与弹簧缓动 ---- */
assert.match(css, /@keyframes sv-list-in\s*\{[^}]*translateY\(-8px\)/s, 'entrance starts at y -8 like the source');
assert.match(css, /@keyframes sv-list-in\s*\{[^}]*scale\(0\)|@keyframes sv-list-in\s*\{[^}]*scale\(0\.001\)/s,
  'entrance starts at scale ~0 like the source');
assert.match(css, /\.sv-row-in\s*\{[^}]*animation:[^;\n}]*var\(--sv-spring-list\)/s,
  'rows ride the generated spring easing');
assert.match(css, /\.sv-row-in\s*\{[^}]*backwards/s, 'delayed rows stay hidden until their turn');
assert.match(css, /animation-delay:\s*min\(/s, 'stagger delay is capped for long lists');
assert.match(css, /\* 24ms/s, 'per-row stagger step is documented');

/* ---- 安静退场说明:替换式渲染没有可观测的 exit,LIST_EXIT 常量仅登记不使用 ---- */
assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.side-item\.sv-row-in\s*\{[^}]*animation:\s*none/s);

console.log('studio_session_list_motion_contract ok');
