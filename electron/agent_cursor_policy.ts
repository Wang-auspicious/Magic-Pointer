'use strict';

/* Twin cursor（双生鼠标）主进程策略层。
 *
 * 三层结构，各管一段，互不重叠：
 *   - app/computer_operator/windows.py  真实指针怎么走、按下前留多少前置量
 *   - 本文件                            主进程：显式光标指令归一化、每屏窗口
 *                                        几何、光标采样去重/合并
 *   - electron/renderer/overlay.ts      渲染进程：60 fps 的贝塞尔飞行、跟随弹簧、
 *                                        光环与点击辉光
 *
 * 为什么光标窗口必须"每屏一个、创建后永不移动"：main.ts:3518-3524 已经记
 * 录过，高频 setBounds 会让 Windows 每次重设光标区域，光标在 CSS 光标和原
 * 生光标之间闪。Clicky 也是这个模型——每个屏一个全屏窗口，buddy 在窗口内
 * 移动（OverlayWindow.swift:340、:783-808）。
 *
 * 常量与 Python 侧逐字对应，tests/agent_cursor_policy_test.ts 会直接读
 * cursors.py / motion.py 的源码做交叉校验，防止两边漂移。
 */

export interface AgentCursorPoint { x: number; y: number }

export interface AgentDisplay {
  displayId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
}

export interface AgentSurfaceBounds {
  displayId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/* ── 与 app/computer_operator 对齐的常量 ───────────────────────────── */

/** 跟随锚点偏移。clicky/OverlayWindow.swift:348、:439-440。 */
export const OFFSET_X = 35;
export const OFFSET_Y = 25;
/** 三角几何。clicky/OverlayWindow.swift:307；ui/overlay.py:38。 */
export const TRIANGLE_SIZE = 16;
export const TRIANGLE_REST_DEGREES = -35;
/** ui/overlay.py:43。 */
export const ACCENT_BLUE = '#3380FF';
/** 跟随弹簧，每 16ms tick 一步、无 dt 项。ui/overlay.py:492-502。 */
export const SPRING_STIFFNESS = 0.28;
export const SPRING_DAMPING = 0.62;
export const TICK_MS = 16;
/** 飞行时长钳制。clicky/OverlayWindow.swift:510。 */
export const FLIGHT_MIN_MS = 600;
export const FLIGHT_MAX_MS = 1400;
export const FLIGHT_MS_PER_PIXEL = 1.25;
/** 停留与返程。clicky/OverlayWindow.swift:592；ui/overlay.py:164。 */
export const DWELL_MS = 3000;
export const RETURN_MS = 1400;
/** 弧线。clicky/OverlayWindow.swift:521。 */
export const ARC_FRACTION = 0.2;
export const ARC_MAX_PX = 80;
export const SCALE_PULSE = 0.3;
/** 光环。ui/overlay.py:272、:506、:695。 */
export const RING_BASE_RADIUS = 26;
export const RING_PULSE_PX = 6;
export const RING_PHASE_STEP = 0.08;
/** 点击辉光，带上下限。openclicky/CompanionManager.swift:2921、:2939。 */
export const GLOW_MS = 2400;
export const GLOW_MIN_MS = 400;
export const GLOW_MAX_MS = 12000;
/** 次级光标的 TTL 下限与默认值。CompanionManager.swift:2531-2534、:545-551。 */
export const TTL_MIN_MS = 200;
export const DEFAULT_TTL_MS = 2000;
/** 按下前的前置量。见 app/computer_operator/motion.py。 */
export const APPROACH_LEAD_MS = 600;
/** 指针移动超过这个距离就取消返程。clicky/OverlayWindow.swift:426。 */
export const CANCEL_DISTANCE_PX = 100;
/** 采样去重的最小位移。openclicky/OverlayWindow.swift:1243。 */
export const SAMPLE_EPSILON_PX = 0.5;

/**
 * Windows 自动隐藏任务栏需要的那 2px。
 *
 * 置顶全屏窗口会压掉任务栏的悬停唤出热区。Qt 移植版专门在底部留了 2px
 * （clicky-windows/ui/overlay.py:390-392）。少了它，用户会失去任务栏——而
 * 这个 bug 在开发者自己机器上（任务栏固定）根本看不出来。
 */
export const TASKBAR_SHAVE_PX = 2;
export const MIN_SURFACE_PX = 1;

/* ── 每屏几何 ──────────────────────────────────────────────────────── */

function asFiniteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parseAgentDisplays(raw: unknown): AgentDisplay[] {
  if (!Array.isArray(raw)) return [];
  const displays: AgentDisplay[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const bounds = (entry as { bounds?: unknown }).bounds;
    const source = entry as { id?: unknown; scaleFactor?: unknown };
    if (!bounds || typeof bounds !== 'object') return;
    const rect = bounds as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    const x = asFiniteNumber(rect.x);
    const y = asFiniteNumber(rect.y);
    const width = asFiniteNumber(rect.width);
    const height = asFiniteNumber(rect.height);
    if (x === null || y === null || width === null || height === null) return;
    if (width <= 0 || height <= 0) return;
    const rawScale = asFiniteNumber(source.scaleFactor);
    displays.push({
      displayId: source.id === undefined || source.id === null ? `display-${index}` : String(source.id),
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
      scaleFactor: rawScale === null || rawScale <= 0 ? 1 : rawScale,
    });
  });
  return displays;
}

export function agentSurfaceBounds(
  display: AgentDisplay,
  shavePx: number = TASKBAR_SHAVE_PX,
): AgentSurfaceBounds {
  const shave = Math.max(0, Math.round(Number(shavePx) || 0));
  return {
    displayId: display.displayId,
    x: display.x,
    y: display.y,
    width: Math.max(MIN_SURFACE_PX, display.width),
    height: Math.max(MIN_SURFACE_PX, display.height - shave),
  };
}

/** 半开区间：两屏共享的那条边只能属于一块屏，否则两个窗口会各画一遍。 */
export function agentDisplayForPoint(
  displays: AgentDisplay[],
  point: AgentCursorPoint,
): AgentDisplay | null {
  if (!displays.length || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  for (const display of displays) {
    if (
      point.x >= display.x
      && point.x < display.x + display.width
      && point.y >= display.y
      && point.y < display.y + display.height
    ) {
      return display;
    }
  }
  return null;
}

export function agentSurfaceForPoint(
  displays: AgentDisplay[],
  point: AgentCursorPoint,
  shavePx: number = TASKBAR_SHAVE_PX,
): { surface: AgentSurfaceBounds; localX: number; localY: number } | null {
  const display = agentDisplayForPoint(displays, point);
  if (!display) return null;
  const surface = agentSurfaceBounds(display, shavePx);
  return {
    surface,
    localX: Math.round(point.x - surface.x),
    localY: Math.round(point.y - surface.y),
  };
}

/* ── 采样去重与合并 ───────────────────────────────────────────────── */

/**
 * openclicky 的两道闸门（OverlayWindow.swift:1243、:1246）。
 *
 * 去重：指针没动就什么都不做。合并：上一帧还没被渲染进程消费掉就跳过——
 * 它注释里写的症状正是"忙一下之后，攒下来的 60Hz 陈旧更新一起回放成可见
 * 卡顿"。合并标记必须在渲染进程 ack 之后才清。
 */
export class CursorSampleGate {
  private lastX = Number.NaN;
  private lastY = Number.NaN;
  private queued = false;

  /** 返回是否需要把这一帧发给渲染进程。 */
  accept(point: AgentCursorPoint, epsilonPx: number = SAMPLE_EPSILON_PX): boolean {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    if (this.queued) return false;
    if (
      Number.isFinite(this.lastX)
      && Math.abs(point.x - this.lastX) <= epsilonPx
      && Math.abs(point.y - this.lastY) <= epsilonPx
    ) {
      return false;
    }
    this.lastX = point.x;
    this.lastY = point.y;
    this.queued = true;
    return true;
  }

  /** 渲染进程确认收到后调用。 */
  ack(): void {
    this.queued = false;
  }

  /** 窗口不可见或重建时必须重置，否则新窗口永远收不到第一帧。 */
  reset(): void {
    this.lastX = Number.NaN;
    this.lastY = Number.NaN;
    this.queued = false;
  }

  get isQueued(): boolean {
    return this.queued;
  }
}

/* ── 显式光标指令 ─────────────────────────────────────────────────── */

export type AgentCursorCommandKind =
  | 'approach'
  | 'mark'
  | 'move'
  | 'click'
  | 'hold'
  | 'release'
  | 'clear';

export interface AgentCursorCommand {
  kind: AgentCursorCommandKind;
  id: string;
  x: number;
  y: number;
  leadMs: number;
  accent: string;
  caption: string | null;
  ttlMs: number;
  glowMs: number;
  held: boolean;
}

function stringOr(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function intOr(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function clamp(value: number, low: number, high: number): number {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

/**
 * 把一条来自 Python 的光标指令归一化，非法输入一律返回 null。
 *
 * 为什么归一化放在主进程：TSL/agent 侧的 duration、TTL、坐标都可能来自模型。
 * 一个 NaN 坐标画出来是窗口左上角的一枚幽灵光标，而 report 里看不出任何异
 * 常。宁可不画。
 */
export function normalizeAgentCursorCommand(raw: unknown): AgentCursorCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const kind = stringOr(source.kind, '') as AgentCursorCommandKind;
  const known: AgentCursorCommandKind[] = ['approach', 'mark', 'move', 'click', 'hold', 'release', 'clear'];
  if (!known.includes(kind)) return null;
  const x = asFiniteNumber(source.x);
  const y = asFiniteNumber(source.y);
  if (kind !== 'clear' && (x === null || y === null)) return null;
  const ttlRaw = asFiniteNumber(source.ttlMs);
  return {
    kind,
    id: stringOr(source.id, kind === 'approach' ? 'primary' : ''),
    x: x === null ? 0 : x,
    y: y === null ? 0 : y,
    leadMs: Math.max(0, intOr(source.leadMs, APPROACH_LEAD_MS)),
    accent: stringOr(source.accent, ACCENT_BLUE),
    caption: typeof source.caption === 'string' && source.caption.trim() ? source.caption.trim() : null,
    // 与 Python 侧同一条规则：TTL 有下限，缺省时给一个默认值而不是无限。
    ttlMs: ttlRaw === null ? DEFAULT_TTL_MS : Math.max(TTL_MIN_MS, Math.round(ttlRaw)),
    glowMs: clamp(intOr(source.glowMs, GLOW_MS), GLOW_MIN_MS, GLOW_MAX_MS),
    held: Boolean(source.held),
  };
}

/** 由距离推飞行时长，与 Python 的 flight_duration_ms 同一条规则。 */
export function flightDurationMs(distance: number, requestedMs = 0): number {
  if (Number.isFinite(requestedMs) && requestedMs > 0) return Math.round(requestedMs);
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  return Math.round(clamp(distance * FLIGHT_MS_PER_PIXEL, FLIGHT_MIN_MS, FLIGHT_MAX_MS));
}

/** 由距离推前置量：至少一次完整飞行，且不低于 600ms 下限。 */
export function approachLeadMs(distance: number, floorMs: number = APPROACH_LEAD_MS): number {
  return Math.max(Math.round(floorMs), flightDurationMs(distance));
}

module.exports = {
  ACCENT_BLUE,
  APPROACH_LEAD_MS,
  ARC_FRACTION,
  ARC_MAX_PX,
  CANCEL_DISTANCE_PX,
  DEFAULT_TTL_MS,
  DWELL_MS,
  FLIGHT_MAX_MS,
  FLIGHT_MIN_MS,
  FLIGHT_MS_PER_PIXEL,
  GLOW_MAX_MS,
  GLOW_MIN_MS,
  GLOW_MS,
  MIN_SURFACE_PX,
  OFFSET_X,
  OFFSET_Y,
  RETURN_MS,
  RING_BASE_RADIUS,
  RING_PHASE_STEP,
  RING_PULSE_PX,
  SAMPLE_EPSILON_PX,
  SCALE_PULSE,
  SPRING_DAMPING,
  SPRING_STIFFNESS,
  TASKBAR_SHAVE_PX,
  TICK_MS,
  TRIANGLE_REST_DEGREES,
  TRIANGLE_SIZE,
  TTL_MIN_MS,
  CursorSampleGate,
  agentDisplayForPoint,
  agentSurfaceBounds,
  agentSurfaceForPoint,
  approachLeadMs,
  flightDurationMs,
  normalizeAgentCursorCommand,
  parseAgentDisplays,
};
