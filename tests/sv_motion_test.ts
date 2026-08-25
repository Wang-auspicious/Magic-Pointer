'use strict';

/* sv_motion 契约:动画参数逐字来自 _sv_sources 源码,生成器只负责把
   motion-sv 的 spring 规格换算成 Chromium CSS linear() 缓动。
   任何参数漂移都必须在这里先红。 */

import assert from 'node:assert';
import fs from 'node:fs';

const {
  springLinearFromDurationBounce,
  springLinearPhysical,
  PLAN_CHECK,
  PLAN_STRIKE_SPRING,
  LIST_ENTRANCE_SPRING,
  LIST_EXIT,
} = require('../electron/renderer/sv_motion');

const svCss = fs.readFileSync('electron/renderer/sv.css', 'utf8');

function assertLinearEasing(easing: string): number {
  assert.match(easing, /^linear\(/);
  const body = easing.slice('linear('.length, -1);
  const stops = body.split(',').map((raw) => Number(raw.trim()));
  assert(stops.length >= 8, 'spring easing needs enough samples');
  for (const stop of stops) {
    assert(Number.isFinite(stop), 'sample must be finite');
    assert(stop > -0.2 && stop < 1.3, 'sample out of plausible spring range');
  }
  assert(Math.abs(stops[0]) < 1e-9, 'spring starts at 0');
  assert(Math.abs(stops[stops.length - 1] - 1) < 1e-3, 'spring settles at 1');
  return stops.length;
}

/* animated-checkbox 删除线:spring(duration .4s / bounce .2) —— 源码逐字 */
{
  const { easing, durationMs } = springLinearFromDurationBounce(0.4, 0.2);
  assertLinearEasing(easing);
  assert(durationMs > 300 && durationMs <= 450, `strike spring settles near 400ms, got ${durationMs}`);
  /* bounce .2 ⇒ 必须真的越过 1 再回来(欠阻尼),否则删除线没有弹性 */
  const peak = Math.max(...springLinearFromDurationBounce(0.4, 0.2).samples);
  assert(peak > 1.005, `underdamped spring should overshoot, peak=${peak}`);
}

/* animated-list 入场:spring(stiffness 500 / damping 30 / mass 1) —— 源码逐字 */
{
  const { easing, durationMs } = springLinearPhysical(LIST_ENTRANCE_SPRING);
  assertLinearEasing(easing);
  assert(durationMs > 250 && durationMs < 800, `list spring settles sub-second, got ${durationMs}`);
}

/* 生成的缓动必须与 sv.css 内的常量一致 —— 单一事实源,防 CSS 与生成器漂移 */
assert(
  svCss.includes(springLinearFromDurationBounce(PLAN_STRIKE_SPRING.duration, PLAN_STRIKE_SPRING.bounce).easing),
  'sv.css must embed the exact strike-spring linear() easing',
);

/* 源码常量钉死:_sv_sources/sv-animations/animated-checkbox/animated-checkbox.svelte L66 */
assert.strictEqual(PLAN_CHECK.path, 'M 0 4.5 L 3.182 8 L 10 0');
assert.strictEqual(PLAN_CHECK.transform, 'translate(5 6)');
assert.strictEqual(PLAN_CHECK.strokeWidth, 1.5);
assert.strictEqual(PLAN_CHECK.drawEase, 'ease-out');
assert.strictEqual(PLAN_CHECK.drawDurationMs, 300);
assert.strictEqual(PLAN_STRIKE_SPRING.duration, 0.4);
assert.strictEqual(PLAN_STRIKE_SPRING.bounce, 0.2);
/* animated-list.svelte L52-L64 */
assert.deepStrictEqual(LIST_ENTRANCE_SPRING, { stiffness: 500, damping: 30, mass: 1 });
assert.strictEqual(LIST_EXIT.durationMs, 180);
assert.strictEqual(LIST_EXIT.yPx, 8);
