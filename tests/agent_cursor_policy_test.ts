/*
 * Twin cursor 主进程策略（electron/agent_cursor_policy.ts）。
 *
 * 三层实现（Python 策略 / 主进程策略 / 渲染进程绘制）里，这一层能独立单测，
 * 所以它同时承担一件事：**交叉校验**。最后一段直接读 app/computer_operator
 * 的源码，把常量逐个比对。两边一旦漂移（有人只改了一个 0.28），这里立刻红
 * ——否则表现是"光标在 Windows 上手感和 macOS 不一样"，而这种问题没人能在
 * CI 里看见。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const policy = require('../electron/agent_cursor_policy');
const {
  CursorSampleGate,
  agentDisplayForPoint,
  agentSurfaceBounds,
  agentSurfaceForPoint,
  approachLeadMs,
  flightDurationMs,
  normalizeAgentCursorCommand,
  parseAgentDisplays,
} = policy;

const ROOT = path.resolve(__dirname, '..');

/* ── Electron display 对象解析 ─────────────────────────────────────── */

const PRIMARY = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
const SECONDARY = { id: 2, bounds: { x: 1920, y: -200, width: 1600, height: 900 }, scaleFactor: 1.25 };
const LEFT = { id: 3, bounds: { x: -1280, y: 0, width: 1280, height: 1024 }, scaleFactor: 1 };

assert.deepStrictEqual(
  parseAgentDisplays([PRIMARY, SECONDARY]).map((d: { displayId: string }) => d.displayId),
  ['1', '2'],
  'display 顺序必须保持：Electron 把主屏放第一个',
);
assert.strictEqual(parseAgentDisplays([SECONDARY])[0].scaleFactor, 1.25, 'scaleFactor 要带过来');
assert.deepStrictEqual(
  parseAgentDisplays([PRIMARY, { id: 9 }, null, { id: 8, bounds: { x: 0, y: 0, width: 0, height: 10 } }])
    .map((d: { displayId: string }) => d.displayId),
  ['1'],
  '坏掉的 display 条目必须被跳过，不能拖垮整个光标面',
);
assert.deepStrictEqual(parseAgentDisplays(null), [], '不是数组就是没有显示器');
assert.strictEqual(
  parseAgentDisplays([{ bounds: { x: 0, y: 0, width: 10, height: 10 } }])[0].displayId,
  'display-0',
  '没有 id 的显示器仍需要一个稳定的名字',
);
assert.strictEqual(
  parseAgentDisplays([{ id: 4, bounds: { x: 0, y: 0, width: 10, height: 10 } }])[0].scaleFactor,
  1,
  '缺 scaleFactor 默认 1',
);

/* ── 每屏归属 ──────────────────────────────────────────────────────── */

const displays = parseAgentDisplays([PRIMARY, SECONDARY, LEFT]);
assert.strictEqual(agentDisplayForPoint(displays, { x: 100, y: 100 })!.displayId, '1');
assert.strictEqual(agentDisplayForPoint(displays, { x: 2000, y: -100 })!.displayId, '2');
assert.strictEqual(agentDisplayForPoint(displays, { x: -500, y: 300 })!.displayId, '3');
assert.strictEqual(agentDisplayForPoint(displays, { x: 5000, y: 5000 }), null, '屏幕外的点没有归属');
assert.strictEqual(agentDisplayForPoint(displays, { x: -1, y: 10 })!.displayId, '3', '负原点的屏幕要能接管左侧的点');
assert.strictEqual(
  agentDisplayForPoint(parseAgentDisplays([PRIMARY, SECONDARY]), { x: -1, y: 10 }),
  null,
  '没有任何屏幕覆盖左边时，那个点是屏幕外的',
);
assert.strictEqual(agentDisplayForPoint([], { x: 10, y: 10 }), null, '没有显示器就没有归属');

assert.strictEqual(
  agentDisplayForPoint(parseAgentDisplays([PRIMARY, SECONDARY]), { x: 1920, y: 10 })!.displayId,
  '2',
  '两屏共享的那条边只能归一块屏，否则两个窗口会各画一遍同一个光标',
);
assert.strictEqual(
  agentDisplayForPoint(parseAgentDisplays([PRIMARY, SECONDARY]), { x: 1919, y: 10 })!.displayId,
  '1',
);
assert.strictEqual(agentDisplayForPoint(parseAgentDisplays([PRIMARY]), { x: 10, y: 1079 }) !== null, true);
assert.strictEqual(agentDisplayForPoint(parseAgentDisplays([PRIMARY]), { x: 10, y: 1080 }), null, '半开区间');
assert.strictEqual(agentDisplayForPoint(displays, { x: Number.NaN, y: 10 }), null);
assert.strictEqual(agentDisplayForPoint(displays, { x: 10, y: Number.POSITIVE_INFINITY }), null);

/* ── 窗口矩形与 2px 任务栏留白 ─────────────────────────────────────── */

assert.deepStrictEqual(
  agentSurfaceBounds(parseAgentDisplays([PRIMARY])[0]),
  { displayId: '1', x: 0, y: 0, width: 1920, height: 1078 },
  '底部必须留 2px，否则置顶全屏窗口会压掉任务栏的呼出热区',
);
assert.strictEqual(policy.TASKBAR_SHAVE_PX, 2);
assert.deepStrictEqual(
  agentSurfaceBounds(parseAgentDisplays([SECONDARY])[0]),
  { displayId: '2', x: 1920, y: -200, width: 1600, height: 898 },
  '只削底边，左/上/宽都不动',
);
assert.strictEqual(
  agentSurfaceBounds({ displayId: 't', x: 0, y: 0, width: 10, height: 1, scaleFactor: 1 }).height,
  1,
  '比留白还矮的屏幕仍然要有一个窗口，高度不能变 0',
);
assert.strictEqual(
  agentSurfaceBounds(parseAgentDisplays([PRIMARY])[0], 0).height,
  1080,
  '留白可配置',
);

/* ── 采样 → 窗口本地坐标 ───────────────────────────────────────────── */

const routed = agentSurfaceForPoint(parseAgentDisplays([PRIMARY, SECONDARY]), { x: 2000, y: -100 })!;
assert.deepStrictEqual(routed.surface, {
  displayId: '2', x: 1920, y: -200, width: 1600, height: 898,
}, '一次调用要同时给出"哪个窗口"和"窗口里的哪里"');
assert.strictEqual(routed.localX, 80);
assert.strictEqual(routed.localY, 100);
assert.strictEqual(agentSurfaceForPoint(parseAgentDisplays([PRIMARY]), { x: 9999, y: 9999 }), null);
assert.strictEqual(
  agentSurfaceForPoint(parseAgentDisplays([LEFT]), { x: -1280, y: 10 })!.localX,
  0,
  '负原点屏要正确换算',
);

/* ── 校验：Python 与 TS 的常量必须逐字一致 ─────────────────────────── */

function pythonConstants(relativePath: string): Map<string, number | string> {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const values = new Map<string, number | string>();
  for (const match of source.matchAll(/^([A-Z][A-Z0-9_]*)\s*(?::[^=\n]+)?=\s*([^\n]+)$/gm)) {
    const name = match[1];
    // 值里可能带 `#`（如 "#3380FF"），所以只能砍掉「空白 + #」形式的尾注释。
    const raw = match[2].trim().split(/\s+#/)[0].trim();
    if (/^["']/.test(raw)) {
      values.set(name, raw.replace(/["']/g, ''));
      continue;
    }
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      values.set(name, numeric);
      continue;
    }
    // motion.py 把 800px/s 写成 `1000.0 / 800.0`，不是字面量。只对纯算术
    // 表达式求值——源码来自本仓库，不是外部输入。
    if (/^[0-9.\s+\-*/()]+$/.test(raw)) {
      const evaluated = Number(Function(`"use strict";return (${raw});`)());
      if (Number.isFinite(evaluated)) values.set(name, evaluated);
    }
  }
  return values;
}

const cursorsPy = pythonConstants('app/computer_operator/cursors.py');
const motionPy = pythonConstants('app/computer_operator/motion.py');

const shared: Array<[string, number]> = [
  ['OFFSET_X', policy.OFFSET_X],
  ['OFFSET_Y', policy.OFFSET_Y],
  ['TRIANGLE_SIZE', policy.TRIANGLE_SIZE],
  ['SPRING_STIFFNESS', policy.SPRING_STIFFNESS],
  ['SPRING_DAMPING', policy.SPRING_DAMPING],
  ['TICK_MS', policy.TICK_MS],
  ['DWELL_MS', policy.DWELL_MS],
  ['RETURN_MS', policy.RETURN_MS],
  ['ARC_FRACTION', policy.ARC_FRACTION],
  ['ARC_MAX_PX', policy.ARC_MAX_PX],
  ['SCALE_PULSE', policy.SCALE_PULSE],
  ['RING_BASE_RADIUS', policy.RING_BASE_RADIUS],
  ['RING_PULSE_PX', policy.RING_PULSE_PX],
  ['RING_PHASE_STEP', policy.RING_PHASE_STEP],
  ['GLOW_MS', policy.GLOW_MS],
  ['GLOW_MIN_MS', policy.GLOW_MIN_MS],
  ['GLOW_MAX_MS', policy.GLOW_MAX_MS],
  ['TTL_MIN_MS', policy.TTL_MIN_MS],
  ['DEFAULT_TTL_MS', policy.DEFAULT_TTL_MS],
  ['CANCEL_DISTANCE_PX', policy.CANCEL_DISTANCE_PX],
];

for (const [name, value] of shared) {
  const pythonValue = cursorsPy.get(name);
  assert.notStrictEqual(pythonValue, undefined, `cursors.py 里找不到 ${name}，常量名已经漂移`);
  assert.strictEqual(
    value,
    pythonValue,
    `${name} 在主进程策略与 Python 模型之间不一致：TS=${value} PY=${pythonValue}`,
  );
}

assert.strictEqual(policy.FLIGHT_MIN_MS, motionPy.get('FLIGHT_MIN_MS'));
assert.strictEqual(policy.FLIGHT_MAX_MS, motionPy.get('FLIGHT_MAX_MS'));
assert.strictEqual(policy.FLIGHT_MS_PER_PIXEL, motionPy.get('FLIGHT_MS_PER_PIXEL'));
assert.strictEqual(policy.APPROACH_LEAD_MS, motionPy.get('APPROACH_LEAD_MS'));
assert.strictEqual(policy.ACCENT_BLUE, cursorsPy.get('ACCENT_BLUE'));
assert.strictEqual(policy.TRIANGLE_REST_DEGREES, cursorsPy.get('TRIANGLE_REST_DEGREES'));

/* ── 纯函数：飞行时长与前置量 ─────────────────────────────────────── */

assert.strictEqual(flightDurationMs(0), 0, '零距离不花时间');
assert.strictEqual(flightDurationMs(1), 600, '短距离走下限');
assert.strictEqual(flightDurationMs(800), 1000, '800px 一秒');
assert.strictEqual(flightDurationMs(100000), 1400, '长距离走上限');
assert.strictEqual(flightDurationMs(5000, 250), 250, '显式时长优先');
assert.strictEqual(approachLeadMs(0), 600, '同点点击也要有 600ms 前置量');
assert.ok(approachLeadMs(1200) > approachLeadMs(10), '前置量随距离增长');
assert.ok(approachLeadMs(1000) >= flightDurationMs(1000), '前置量绝不能短于飞行本身');
assert.strictEqual(approachLeadMs(1000000), 1400, '前置量被飞行上限卡住');

/* ── 采样闸门 ──────────────────────────────────────────────────────── */

const gate = new CursorSampleGate();
assert.strictEqual(gate.accept({ x: 10, y: 10 }), true, '第一帧必须发出去');
assert.strictEqual(gate.accept({ x: 10, y: 10 }), false, '没动就不发（openclicky :1243）');
assert.strictEqual(gate.accept({ x: 10.2, y: 10 }), false, '亚像素抖动不算移动');
assert.strictEqual(gate.isQueued, true, '在 ack 之前一直处于已排队状态');
assert.strictEqual(gate.accept({ x: 90, y: 90 }), false, '上一帧还没被消费就不再发（openclicky :1246）');
gate.ack();
assert.strictEqual(gate.accept({ x: 90, y: 90 }), true, 'ack 之后恢复投递');
gate.ack();
assert.strictEqual(gate.accept({ x: Number.NaN, y: 5 }), false, 'NaN 采样不投递');
assert.strictEqual(gate.accept({ x: 5, y: Number.POSITIVE_INFINITY }), false);
gate.ack();
gate.reset();
assert.strictEqual(gate.accept({ x: 90, y: 90 }), true, '窗口重建后必须能收到第一帧');

/* ── 指令归一化 ────────────────────────────────────────────────────── */

assert.strictEqual(normalizeAgentCursorCommand(null), null);
assert.strictEqual(normalizeAgentCursorCommand('approach'), null);
assert.strictEqual(normalizeAgentCursorCommand({ kind: 'teleport', x: 1, y: 2 }), null, '未知指令不猜');
assert.strictEqual(normalizeAgentCursorCommand({ kind: 'approach', x: Number.NaN, y: 2 }), null, 'NaN 坐标宁可不画');

const approach = normalizeAgentCursorCommand({ kind: 'approach', x: 100, y: 200 })!;
assert.strictEqual(approach.id, 'primary', '没有 id 的 approach 默认挂在主光标上');
assert.strictEqual(approach.leadMs, 600, '缺省前置量就是下限');
assert.strictEqual(approach.accent, '#3380FF');
assert.strictEqual(approach.ttlMs, 2000, '缺省 TTL 而不是无限');

const marker = normalizeAgentCursorCommand({ kind: 'mark', id: 'm1', x: 1, y: 2, ttlMs: 0, caption: ' 这里 ' })!;
assert.strictEqual(marker.id, 'm1');
assert.strictEqual(marker.ttlMs, 200, 'TTL 有 200ms 下限（openclicky :2531-2534）');
assert.strictEqual(marker.caption, '这里', '标题要去空白');

const click = normalizeAgentCursorCommand({ kind: 'click', id: 'primary', x: 1, y: 2, glowMs: 0 })!;
assert.strictEqual(click.glowMs, 400, '辉光下限');
assert.strictEqual(normalizeAgentCursorCommand({ kind: 'click', x: 1, y: 2, glowMs: 10_000_000 })!.glowMs, 12000);
assert.strictEqual(normalizeAgentCursorCommand({ kind: 'click', x: 1, y: 2 })!.glowMs, 2400);

assert.strictEqual(normalizeAgentCursorCommand({ kind: 'clear' })!.kind, 'clear', 'clear 不需要坐标');
assert.strictEqual(normalizeAgentCursorCommand({ kind: 'hold', id: 'primary', x: 0, y: 0, held: true })!.held, true);

/* ── 组合：一条 approach 指令能算出窗口与本地坐标 ──────────────────── */

const command = normalizeAgentCursorCommand({
  kind: 'approach', x: 2000, y: -100, leadMs: 900,
})!;
const target = agentSurfaceForPoint(parseAgentDisplays([PRIMARY, SECONDARY]), { x: command.x, y: command.y })!;
assert.strictEqual(target.surface.displayId, '2');
assert.strictEqual(target.localX, 80);
assert.strictEqual(target.localY, 100);
assert.strictEqual(command.leadMs, 900);

console.log('agent cursor policy test ok');
