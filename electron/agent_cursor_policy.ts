'use strict';


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


export const OFFSET_X = 35;
export const OFFSET_Y = 25;
export const TRIANGLE_SIZE = 16;
export const TRIANGLE_REST_DEGREES = -35;
export const ACCENT_BLUE = '#3380FF';
export const SPRING_STIFFNESS = 0.28;
export const SPRING_DAMPING = 0.62;
export const TICK_MS = 16;
export const FLIGHT_MIN_MS = 600;
export const FLIGHT_MAX_MS = 1400;
export const FLIGHT_MS_PER_PIXEL = 1.25;
export const DWELL_MS = 3000;
export const RETURN_MS = 1400;
export const ARC_FRACTION = 0.2;
export const ARC_MAX_PX = 80;
export const SCALE_PULSE = 0.3;
export const RING_BASE_RADIUS = 26;
export const RING_PULSE_PX = 6;
export const RING_PHASE_STEP = 0.08;
export const GLOW_MS = 2400;
export const GLOW_MIN_MS = 400;
export const GLOW_MAX_MS = 12000;
export const TTL_MIN_MS = 200;
export const DEFAULT_TTL_MS = 2000;
export const APPROACH_LEAD_MS = 600;
export const CANCEL_DISTANCE_PX = 100;
export const SAMPLE_EPSILON_PX = 0.5;

export const TASKBAR_SHAVE_PX = 2;
export const MIN_SURFACE_PX = 1;


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


export class CursorSampleGate {
  private lastX = Number.NaN;
  private lastY = Number.NaN;
  private queued = false;

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

  ack(): void {
    this.queued = false;
  }

  reset(): void {
    this.lastX = Number.NaN;
    this.lastY = Number.NaN;
    this.queued = false;
  }

  get isQueued(): boolean {
    return this.queued;
  }
}


export type AgentCursorCommandKind =
  | 'approach'
  | 'mark'
  | 'move'
  | 'click'
  | 'hold'
  | 'release'
  | 'clear'
  | 'idle';

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
  button: 'left' | 'right';
  count: number;
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

export function normalizeAgentCursorCommand(raw: unknown): AgentCursorCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const kind = stringOr(source.kind, '') as AgentCursorCommandKind;
  const known: AgentCursorCommandKind[] = ['approach', 'mark', 'move', 'click', 'hold', 'release', 'clear', 'idle'];
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
    ttlMs: ttlRaw === null ? DEFAULT_TTL_MS : Math.max(TTL_MIN_MS, Math.round(ttlRaw)),
    glowMs: clamp(intOr(source.glowMs, GLOW_MS), GLOW_MIN_MS, GLOW_MAX_MS),
    held: Boolean(source.held),
    button: stringOr(source.button, 'left') === 'right' ? 'right' : 'left',
    count: Math.max(1, Math.min(3, intOr(source.count, 1))),
  };
}

export function flightDurationMs(distance: number, requestedMs = 0): number {
  if (Number.isFinite(requestedMs) && requestedMs > 0) return Math.round(requestedMs);
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  return Math.round(clamp(distance * FLIGHT_MS_PER_PIXEL, FLIGHT_MIN_MS, FLIGHT_MAX_MS));
}

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
