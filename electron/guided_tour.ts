'use strict';

/**
 * Clicky-inspired guided screen tour parser, marker stripper, and coordinate
 * snapping helpers for Magic Pointer's Coach <-> Autopilot learning paradigm.
 *
 * Design & tag grammar adapted from MIT-licensed local references:
 * - external/clacky/clacky/shell/tour.py (inline [POINT]/[CIRCLE]/[ARROW]/[LABEL]
 *   tags paired with sentences, <=30px small-control center snapping)
 * - external/clicky-windows/ai/hybrid_pointer.py (0-1000 normalized screen space)
 */

export interface GuidedTourStep {
  index: number;
  x: number;
  y: number;
  screen: number;
  label: string;
  sentence: string;
  normalized: boolean;
}

export interface GuidedTourControlRect {
  name: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface GuidedTourDisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const POINT_TAG_RE =
  /\[POINT:\s*(\d{1,5})\s*,\s*(\d{1,5})(?:\s*:\s*([^:\]]+?))?(?:\s*:\s*screen(\d+))?\s*\]/gi;
const ANY_TOUR_TAG_RE =
  /\[(?:POINT:\s*\d{1,5}\s*,\s*\d{1,5}(?:\s*:\s*[^:\]]+?)?(?:\s*:\s*screen\d+)?|CIRCLE:\s*\d{1,5}\s*,\s*\d{1,5}\s*,\s*\d{1,5}(?:\s*:\s*[^\]]+)?|ARROW:\s*\d{1,5}\s*,\s*\d{1,5}\s*->\s*\d{1,5}\s*,\s*\d{1,5}|LABEL:\s*\d{1,5}\s*,\s*\d{1,5}\s*:\s*[^\]]+)\]/gi;

export function stripTourMarkers(text: string): string {
  return String(text || '')
    .replace(ANY_TOUR_TAG_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+/gm, line => line)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractTourSteps(text: string): GuidedTourStep[] {
  const source = String(text || '');
  const matches = Array.from(source.matchAll(POINT_TAG_RE));
  if (!matches.length) {
    return [];
  }
  const steps: GuidedTourStep[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const x = Number(match[1]);
    const y = Number(match[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    const label = (match[3] || '').trim() || `Step ${steps.length + 1}`;
    const screenRaw = match[4] ? Number(match[4]) : 1;
    const screen =
      Number.isFinite(screenRaw) && screenRaw >= 1 ? Math.floor(screenRaw) : 1;
    const startAfter = (match.index ?? 0) + match[0].length;
    const nextStart =
      i + 1 < matches.length ? (matches[i + 1].index ?? source.length) : source.length;
    const rawSlice = source.slice(startAfter, nextStart);
    const sentence = stripTourMarkers(rawSlice)
      .split(/\r?\n/)[0]
      .trim()
      .slice(0, 180);
    const normalized = x <= 1000 && y <= 1000;
    steps.push({
      index: steps.length,
      x,
      y,
      screen,
      label,
      sentence,
      normalized,
    });
  }
  return steps;
}

export function snapPointToControl(
  point: {x: number; y: number},
  controls: readonly GuidedTourControlRect[],
  maxSnapPx = 30,
): {x: number; y: number; snapped: boolean; name?: string} {
  let bestDist = Infinity;
  let best: {x: number; y: number; name: string} | null = null;
  for (const ctrl of controls) {
    const w = ctrl.right - ctrl.left;
    const h = ctrl.bottom - ctrl.top;
    // Guard against snapping into big containers/panels (clacky/tour.py rule).
    if (w <= 1 || h <= 1 || w > 600 || h > 360) {
      continue;
    }
    const cx = Math.round(ctrl.left + w / 2);
    const cy = Math.round(ctrl.top + h / 2);
    const dist = Math.hypot(cx - point.x, cy - point.y);
    if (dist <= maxSnapPx && dist < bestDist) {
      bestDist = dist;
      best = {x: cx, y: cy, name: ctrl.name};
    }
  }
  if (!best) {
    return {x: Math.round(point.x), y: Math.round(point.y), snapped: false};
  }
  return {x: best.x, y: best.y, snapped: true, name: best.name};
}

export function denormalizeTourPoint(
  step: {x: number; y: number; screen?: number; normalized?: boolean},
  displays: readonly GuidedTourDisplayBounds[],
): {x: number; y: number} | null {
  if (!displays.length || !Number.isFinite(step.x) || !Number.isFinite(step.y)) {
    return null;
  }
  const idx = Math.max(0, Math.min(displays.length - 1, (step.screen ?? 1) - 1));
  const display = displays[idx];
  if (display.width <= 0 || display.height <= 0) {
    return null;
  }
  if (step.normalized === false) {
    return {
      x: Math.round(Math.max(display.x, Math.min(display.x + display.width - 1, step.x))),
      y: Math.round(Math.max(display.y, Math.min(display.y + display.height - 1, step.y))),
    };
  }
  const nx = Math.max(0, Math.min(1000, step.x)) / 1000;
  const ny = Math.max(0, Math.min(1000, step.y)) / 1000;
  return {
    x: Math.round(display.x + nx * display.width),
    y: Math.round(display.y + ny * display.height),
  };
}

export function formatCursorCaption(raw: string, maxChars = 18): string {
  const cleaned = String(raw || '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    return '';
  }
  const firstClause = cleaned.split(/[：:。；;！!\n]/)[0].trim() || cleaned;
  const limit = Math.max(4, Math.floor(maxChars));
  return firstClause.length > limit
    ? `${firstClause.slice(0, limit)}…`
    : firstClause;
}

export function shouldAutoLaunchTourCursor(
  steps: ReadonlyArray<{x?: number; y?: number; screen?: number; label?: string}>,
  context: {studioForeground?: boolean} = {},
): boolean {
  if (!Array.isArray(steps) || steps.length === 0) {
    return false;
  }
  if (context.studioForeground === true) {
    return false;
  }
  return true;
}

module.exports = {
  denormalizeTourPoint,
  extractTourSteps,
  formatCursorCaption,
  shouldAutoLaunchTourCursor,
  snapPointToControl,
  stripTourMarkers,
};
