'use strict';

/* 计划卡 × animated-checkbox 契约:
   勾选框/勾线/删除线的结构与动画参数逐字来自
   _sv_sources/sv-animations/animated-checkbox/src/spell/animated-checkbox/animated-checkbox.svelte */

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const css = fs.readFileSync('electron/renderer/sv.css', 'utf8');

/* ---- 资产挂载 ---- */
assert(html.includes('sv_motion.js'), 'studio.html must load sv_motion.js');
assert(html.includes('sv.css'), 'studio.html must load sv.css');

/* ---- renderPlanCard 使用源码同款勾线 ---- */
assert(source.includes('svMotionGlobals.PLAN_CHECK.path'), 'plan steps must take the check path from sv_motion');
assert(source.includes("class='sv-checkbox'") || source.includes('className = \'sv-checkbox\''),
  'plan step must render the animated checkbox box');
assert(source.includes('pathLength="1"'), 'check path must be normalized for dasharray draw');
assert(source.includes("'sv-plan-step-strike'"), 'plan step label must carry the spring strike line');
assert(source.includes("'sv-plan-step-label'"), 'plan step label span is the strike anchor');

/* ---- sv.css:盒子规格 = 源码 size-[18px] rounded-[6px] border-[1.5px] ---- */
assert.match(css, /\.sv-checkbox\s*\{[^}]*18px[^}]*\}/s, 'checkbox must be 18px');
assert.match(css, /\.sv-checkbox\s*\{[^}]*border-radius:\s*6px[^}]*\}/s);
assert.match(css, /\.sv-checkbox\s*\{[^}]*1\.5px[^}]*\}/s);
assert.match(css, /\.sv-checkbox\s*\{[^}]*transition[^\n;}]*200ms/s, 'box colors transition 200ms like source');

/* 完成态 = 源码 checked:bg-slate-950/text-white 的令牌映射(--mp-ink/--mp-canvas 自动随主题反转) */
assert.match(css, /\.dshw-plan-step\.is-done \.sv-checkbox\s*\{[^}]*var\(--mp-ink\)/s,
  'done box fills with ink token');
assert.match(css, /\.dshw-plan-step\.is-done \.sv-checkbox\s*\{[^}]*border-color:\s*transparent/s);

/* 勾线划入:pathLength draw,ease-out 300ms(源码 L78-L80);过渡在基类,反向同样生效 */
assert.match(css, /\.sv-checkbox-mark\s*\{[^}]*stroke-dasharray:\s*1/s);
assert.match(css, /\.sv-checkbox-mark\s*\{[^}]*stroke-dashoffset:\s*1/s);
assert.match(css, /\.sv-checkbox-mark\s*\{[^}]*transition:[^;\n}]*stroke-dashoffset\s+300ms\s+ease-out/s,
  'check draws in 300ms ease-out');
assert.match(css, /\.dshw-plan-step\.is-done \.sv-checkbox-mark\s*\{[^}]*stroke-dashoffset:\s*0/s);

/* 删除线:spring(duration .4 / bounce .2),宽与不透明度同步过渡(源码 L98-L106) */
assert.match(css, /\.sv-plan-step-strike\s*\{[^}]*height:\s*1\.5px/s);
assert.match(css, /\.sv-plan-step-strike\s*\{[^}]*var\(--sv-spring-strike\)/s,
  'strike uses the generated spring easing');
assert.match(css, /\.dshw-plan-step\.is-done \.sv-plan-step-strike\s*\{[^}]*width:\s*100%/s);

/* MP 扩展:in_progress 态(源码只有两态)——accent 边框呼吸,文档化扩展 */
assert.match(css, /\.dshw-plan-step\.is-active \.sv-checkbox\s*\{/s,
  'in_progress keeps its documented accent extension');

console.log('studio_plan_checkbox_contract ok');
