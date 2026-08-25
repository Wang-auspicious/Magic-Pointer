'use strict';

/* exported SvMotion */

/**
 * sv_motion —— 把 _sv_sources(Svelte/motion-sv)组件里的 spring 规格换算成
 * Chromium CSS `linear()` 缓动的纯函数层。
 *
 * 来源(参数逐字,MIT © Sikandar Bhide):
 *   sv-animations/src/spell/animated-checkbox/animated-checkbox.svelte
 *     - 勾线 path "M 0 4.5 L 3.182 8 L 10 0" transform translate(5 6) stroke-width 1.5
 *     - pathLength 划入 easeOut 0.3s;opacity 时长 0
 *     - 删除线 spring { duration: 0.4, bounce: 0.2 }
 *   sv-animations/src/magic/animated-list/animated-list.svelte
 *     - 入场 initial { scale 0, opacity 0, y -8 } → spring { stiffness 500, damping 30 }
 *     - 退场 { scale 0, opacity 0, y 8 } transition { duration: 0.18 }
 *
 * motion-sv 的运行时在本仓库(无框架渲染器)不可用;这里用解析解阻尼谐振子
 * 生成等价的 linear() 采样:视觉参数(时长/弹度/stiffness/damping)与源一致,
 * 不做手感再创作。生成结果由 tests/sv_motion_test.ts 与 sv.css 双向钉死。
 */

/** animated-checkbox 删除线弹簧(源码 L14-L18)。 */
const PLAN_STRIKE_SPRING = { duration: 0.4, bounce: 0.2 };

/** animated-checkbox 勾线规格(源码 L64-L82)。 */
const PLAN_CHECK = {
  path: 'M 0 4.5 L 3.182 8 L 10 0',
  transform: 'translate(5 6)',
  strokeWidth: 1.5,
  drawEase: 'ease-out',
  drawDurationMs: 300,
};

/** animated-list 入场弹簧(源码 L57)。 */
const LIST_ENTRANCE_SPRING = { stiffness: 500, damping: 30, mass: 1 };

/** animated-list 退场(源码 L59-L64)。 */
const LIST_EXIT = { durationMs: 180, yPx: 8 };

/** 单位阶跃下阻尼谐振子的解析响应:x(0)=0,x(∞)=1,初速度 0。 */
function stepResponse(timeSeconds: number, naturalFreq: number, zeta: number): number {
  if (timeSeconds <= 0) return 0;
  const t = timeSeconds;
  if (zeta < 1) {
    const dampedFreq = naturalFreq * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * naturalFreq * t);
    return 1 - decay * (Math.cos(dampedFreq * t) + ((zeta * naturalFreq) / dampedFreq) * Math.sin(dampedFreq * t));
  }
  if (Math.abs(zeta - 1) < 1e-9) {
    return 1 - Math.exp(-naturalFreq * t) * (1 + naturalFreq * t);
  }
  const rootA = -naturalFreq * (zeta - Math.sqrt(zeta * zeta - 1));
  const rootB = -naturalFreq * (zeta + Math.sqrt(zeta * zeta - 1));
  return 1 + (rootB * Math.exp(rootA * t) - rootA * Math.exp(rootB * t)) / (rootA - rootB);
}

/** 从 0 起以 1ms 步进找最后一次 |x-1|>restDelta 的时刻,即沉降时间(秒)。 */
function settleTimeSeconds(response: (t: number) => number, restDelta: number, horizonSeconds = 8): number {
  const step = 0.001;
  let lastActive = 0;
  for (let t = step; t <= horizonSeconds; t += step) {
    if (Math.abs(response(t) - 1) > restDelta) lastActive = t;
    else if (t - lastActive > 0.05) break; // 连续 50ms 安静即可提前收工
  }
  return lastActive + step;
}

interface LinearEasing {
  easing: string;
  durationMs: number;
  samples: number[];
}

interface PhysicalSpring {
  stiffness: number;
  damping: number;
  mass: number;
  restDelta?: number;
}

/** 均匀采样并序列化成 CSS linear() 缓动;粒度约等于一帧(~16ms)。 */
function sampleLinear(response: (t: number) => number, durationSeconds: number): LinearEasing {
  const durationMs = durationSeconds * 1000;
  const count = Math.max(12, Math.ceil(durationMs / 16));
  const samples: number[] = [];
  for (let i = 0; i <= count; i += 1) {
    const value = response((i / count) * durationSeconds);
    samples.push(Math.abs(value) < 1e-9 ? 0 : Number(value.toFixed(4)));
  }
  samples[samples.length - 1] = 1;
  return { easing: `linear(${samples.join(', ')})`, durationMs: Math.round(durationMs), samples };
}

/** Motion 风格 duration/bounce 弹簧:bounce=1−ζ,包络在 duration 时落到 restDelta。 */
function springLinearFromDurationBounce(durationSeconds: number, bounce: number, restDelta = 0.001): LinearEasing {
  const zeta = 1 - bounce;
  const envelopePeak = zeta < 1 ? 1 / Math.sqrt(1 - zeta * zeta) : 1;
  const naturalFreq =
    zeta > 1e-9 ? Math.log(envelopePeak / restDelta) / (zeta * durationSeconds) : (2 * Math.PI) / (2 * durationSeconds);
  const response = (t: number) => stepResponse(t, naturalFreq, zeta);
  return sampleLinear(response, settleTimeSeconds(response, restDelta));
}

/** 物理 spring(stiffness/damping/mass)直接换算 ωn 与 ζ。 */
function springLinearPhysical(spring: PhysicalSpring): LinearEasing {
  const mass = spring.mass || 1;
  const naturalFreq = Math.sqrt(spring.stiffness / mass);
  const zeta = spring.damping / (2 * Math.sqrt(spring.stiffness * mass));
  const response = (t: number) => stepResponse(t, naturalFreq, zeta);
  return sampleLinear(response, settleTimeSeconds(response, spring.restDelta ?? 0.001));
}

/* 供 sv.css 引用的具名缓动(tests/sv_motion_test.ts 与文件字面量双向钉死)。 */
const SV_EASINGS = {
  planStrike: springLinearFromDurationBounce(PLAN_STRIKE_SPRING.duration, PLAN_STRIKE_SPRING.bounce).easing,
  listEntrance: springLinearPhysical(LIST_ENTRANCE_SPRING).easing,
};

const SvMotion = {
  PLAN_STRIKE_SPRING,
  PLAN_CHECK,
  LIST_ENTRANCE_SPRING,
  LIST_EXIT,
  SV_EASINGS,
  springLinearFromDurationBounce,
  springLinearPhysical,
};

if (typeof module !== 'undefined' && module.exports) module.exports = SvMotion;
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { SvMotion?: typeof SvMotion }).SvMotion = SvMotion;
}
