'use strict';

// Pick mode: point at something, see the whole thing light up.
//
// Everywhere's X-post effect — hover a post, its entire card outlines — is the
// interaction being copied here (idea only; that project is BSL, none of its
// code is). The difference from drawing a line is granularity, and both are
// worth having:
//
//   pick   = the whole element under the cursor (a post, a cell, a card)
//   stroke = exactly what the line crossed (these three words, that one row)
//
// The stage already owns element rectangles (the UIA probe returns them) and the
// sweep-band highlight. What was missing was the entry point and the rule for
// which rectangle to trust, which is what this decides.
//
// Pure: rectangles and a pointer position in, one highlight target out.

// A box this close to the window's own size is "the window", not a thing inside
// it. Highlighting the whole window teaches the user nothing about what got
// picked.
const WINDOW_COVERAGE_LIMIT = 0.92;

// Smaller than this and there is nothing to aim at — a 4px spacer is not a pick
// target, and outlining it looks like a rendering bug.
const MIN_PICK_EDGE_PX = 10;

// How far outside a rectangle the pointer may sit and still count as over it.
// Hit-testing on the exact border makes the highlight flicker along edges.
const HIT_TOLERANCE_PX = 2;

function area(rect) {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function isUsableRect(rect) {
  return Boolean(rect)
    && Number.isFinite(rect.x) && Number.isFinite(rect.y)
    && Number.isFinite(rect.width) && Number.isFinite(rect.height)
    && rect.width >= MIN_PICK_EDGE_PX
    && rect.height >= MIN_PICK_EDGE_PX;
}

function containsPoint(rect, x, y) {
  return x >= rect.x - HIT_TOLERANCE_PX
    && x <= rect.x + rect.width + HIT_TOLERANCE_PX
    && y >= rect.y - HIT_TOLERANCE_PX
    && y <= rect.y + rect.height + HIT_TOLERANCE_PX;
}

function coversWindow(rect, windowRect) {
  if (!windowRect || area(windowRect) <= 0) return false;
  return area(rect) / area(windowRect) >= WINDOW_COVERAGE_LIMIT;
}

/**
 * Which rectangle should light up for a pointer at (x, y)?
 *
 * The smallest candidate that still contains the point: nesting is the norm
 * (a link inside a paragraph inside a post), and the tightest box is the thing
 * the user is actually pointing at.
 *
 * @param {object} input
 * @param {Array<{x:number,y:number,width:number,height:number,label?:string}>} input.rectangles
 * @param {number} input.x
 * @param {number} input.y
 * @param {{x:number,y:number,width:number,height:number}} [input.windowRect]
 * @returns {{rect: object, label: string, reason: string}|null}
 */
function pickTarget(input) {
  const x = Number(input?.x);
  const y = Number(input?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const rectangles = Array.isArray(input?.rectangles) ? input.rectangles : [];
  const windowRect = input?.windowRect || null;

  let best = null;
  for (const candidate of rectangles) {
    if (!isUsableRect(candidate)) continue;
    if (!containsPoint(candidate, x, y)) continue;
    if (coversWindow(candidate, windowRect)) continue;
    if (best === null || area(candidate) < area(best)) best = candidate;
  }
  if (best === null) return null;
  return {
    rect: { x: best.x, y: best.y, width: best.width, height: best.height },
    label: String(best.label || ''),
    reason: 'smallest_containing_element',
  };
}

// Has the highlight target actually changed? Repainting an unchanged rectangle
// restarts its animation, which reads as flicker while the user moves within one
// element — the single most noticeable way to get this effect wrong.
function isSameTarget(a, b) {
  if (!a || !b) return a === b;
  return Math.round(a.rect.x) === Math.round(b.rect.x)
    && Math.round(a.rect.y) === Math.round(b.rect.y)
    && Math.round(a.rect.width) === Math.round(b.rect.width)
    && Math.round(a.rect.height) === Math.round(b.rect.height);
}

const StagePickPolicy = {
  HIT_TOLERANCE_PX,
  MIN_PICK_EDGE_PX,
  WINDOW_COVERAGE_LIMIT,
  isSameTarget,
  pickTarget,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = StagePickPolicy;
}
if (typeof globalThis !== 'undefined') {
  globalThis.StagePickPolicy = StagePickPolicy;
}
