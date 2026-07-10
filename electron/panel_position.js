const DEFAULT_MARGIN = 18;
const DEFAULT_GAP = 14;
const DEFAULT_AVOIDANCE_PADDING = 10;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizePoint(point, fallback = { x: 0, y: 0 }) {
  return {
    x: finiteNumber(point?.x, finiteNumber(fallback?.x)),
    y: finiteNumber(point?.y, finiteNumber(fallback?.y)),
  };
}

function normalizeRect(value) {
  const source = Array.isArray(value)
    ? { x: value[0], y: value[1], width: value[2], height: value[3] }
    : value;
  if (!source || typeof source !== 'object') return null;
  const rect = {
    x: finiteNumber(source.x, NaN),
    y: finiteNumber(source.y, NaN),
    width: finiteNumber(source.width, NaN),
    height: finiteNumber(source.height, NaN),
  };
  if (!Object.values(rect).every(Number.isFinite)) return null;
  if (rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

function normalizeNativeSelectionRectangles(rawRectangles, convertRect = (rect) => rect) {
  if (!Array.isArray(rawRectangles)) return [];
  const normalized = [];
  for (const raw of rawRectangles.slice(0, 32)) {
    const source = normalizeRect(raw);
    if (!source) continue;
    try {
      const converted = normalizeRect(convertRect(source));
      if (converted) normalized.push(converted);
    } catch (_) {
      // A bad native rectangle must not break panel reveal.
    }
  }
  return normalized;
}

function rectRight(rect) {
  return rect.x + rect.width;
}

function rectBottom(rect) {
  return rect.y + rect.height;
}

function expandRect(rect, padding) {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + (padding * 2),
    height: rect.height + (padding * 2),
  };
}

function unionRects(rectangles) {
  if (!rectangles.length) return null;
  const left = Math.min(...rectangles.map((rect) => rect.x));
  const top = Math.min(...rectangles.map((rect) => rect.y));
  const right = Math.max(...rectangles.map(rectRight));
  const bottom = Math.max(...rectangles.map(rectBottom));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function intersectionArea(left, right) {
  const width = Math.max(0, Math.min(rectRight(left), rectRight(right)) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(rectBottom(left), rectBottom(right)) - Math.max(left.y, right.y));
  return width * height;
}

function distancePointToRect(point, rect) {
  const dx = Math.max(rect.x - point.x, point.x - rectRight(rect), 0);
  const dy = Math.max(rect.y - point.y, point.y - rectBottom(rect), 0);
  return Math.hypot(dx, dy);
}

function distanceRectToRect(left, right) {
  const dx = Math.max(left.x - rectRight(right), right.x - rectRight(left), 0);
  const dy = Math.max(left.y - rectBottom(right), right.y - rectBottom(left), 0);
  return Math.hypot(dx, dy);
}

function pointInsideRect(point, rect) {
  return (
    point.x >= rect.x
    && point.x <= rectRight(rect)
    && point.y >= rect.y
    && point.y <= rectBottom(rect)
  );
}

function chooseAnchorRect(rectangles, cursor) {
  let chosen = null;
  let chosenDistance = Infinity;
  rectangles.forEach((rect, index) => {
    const distance = distancePointToRect(cursor, rect);
    if (distance < chosenDistance || (distance === chosenDistance && index > chosen.index)) {
      chosen = { rect, index };
      chosenDistance = distance;
    }
  });
  return chosen?.rect || null;
}

function clamp(value, minimum, maximum) {
  if (maximum < minimum) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function clampPanelBounds(candidate, workArea, panelSize, margin) {
  const minX = workArea.x + margin;
  const minY = workArea.y + margin;
  const maxX = rectRight(workArea) - panelSize.width - margin;
  const maxY = rectBottom(workArea) - panelSize.height - margin;
  return {
    x: clamp(candidate.x, minX, maxX),
    y: clamp(candidate.y, minY, maxY),
    width: panelSize.width,
    height: panelSize.height,
  };
}

function candidatePositions({ cursor, selectionRects, panelSize, gap }) {
  const candidates = [];
  const add = (mode, x, y, rank) => candidates.push({ mode, x, y, rank });
  const anchor = chooseAnchorRect(selectionRects, cursor);
  const selectionBounds = unionRects(selectionRects);

  if (anchor && selectionBounds) {
    const cursorAlignedY = cursor.y - Math.min(48, panelSize.height * 0.22);
    add('right-anchor', rectRight(anchor) + gap, cursorAlignedY, 0);
    add('right-selection', rectRight(selectionBounds) + gap, anchor.y, 1);
    add('below-selection', cursor.x - 36, rectBottom(selectionBounds) + gap, 2);
    add('above-selection', cursor.x - 36, selectionBounds.y - panelSize.height - gap, 3);
    add('left-anchor', anchor.x - panelSize.width - gap, cursorAlignedY, 4);
    add('below-left', selectionBounds.x, rectBottom(selectionBounds) + gap, 5);
    add('above-left', selectionBounds.x, selectionBounds.y - panelSize.height - gap, 6);
    add('left-selection', selectionBounds.x - panelSize.width - gap, anchor.y, 7);
  }

  add('cursor-right-below', cursor.x + 28, cursor.y + 30, 8);
  add('cursor-right-above', cursor.x + 28, cursor.y - panelSize.height - gap, 9);
  add('cursor-left-below', cursor.x - panelSize.width - 28, cursor.y + 30, 10);
  add('cursor-left-above', cursor.x - panelSize.width - 28, cursor.y - panelSize.height - gap, 11);
  return { candidates, anchor };
}

function computePanelPlacement({
  workArea,
  panelSize,
  cursor,
  selectionRects = [],
  preferredMode = null,
  margin = DEFAULT_MARGIN,
  gap = DEFAULT_GAP,
  avoidancePadding = DEFAULT_AVOIDANCE_PADDING,
}) {
  const safeWorkArea = normalizeRect(workArea);
  const safePanelSize = {
    width: Math.max(1, finiteNumber(panelSize?.width, 420)),
    height: Math.max(1, finiteNumber(panelSize?.height, 188)),
  };
  if (!safeWorkArea) throw new Error('A valid workArea is required.');

  const safeCursor = normalizePoint(cursor, {
    x: safeWorkArea.x + (safeWorkArea.width / 2),
    y: safeWorkArea.y + (safeWorkArea.height / 2),
  });
  const safeSelectionRects = selectionRects.map(normalizeRect).filter(Boolean).slice(0, 32);
  const paddedSelectionRects = safeSelectionRects.map((rect) => expandRect(rect, avoidancePadding));
  const { candidates, anchor } = candidatePositions({
    cursor: safeCursor,
    selectionRects: safeSelectionRects,
    panelSize: safePanelSize,
    gap,
  });

  const scored = candidates.map((candidate) => {
    const bounds = clampPanelBounds(candidate, safeWorkArea, safePanelSize, margin);
    const overlaps = paddedSelectionRects
      .map((rect) => intersectionArea(bounds, rect))
      .filter((area) => area > 0);
    const overlapArea = overlaps.reduce((sum, area) => sum + area, 0);
    const cursorCovered = pointInsideRect(safeCursor, expandRect(bounds, 10));
    const distanceToCursor = distancePointToRect(safeCursor, bounds);
    const distanceToSelection = anchor ? distanceRectToRect(anchor, bounds) : 0;
    const modeChangePenalty = preferredMode && preferredMode !== candidate.mode ? 120 : 0;

    // Selection visibility dominates; cursor proximity and stable resize direction break ties.
    const score = (
      (overlaps.length * 1_000_000_000)
      + (overlapArea * 100_000)
      + (cursorCovered ? 500_000_000 : 0)
      + modeChangePenalty
      + (distanceToCursor * 2)
      + distanceToSelection
      + (candidate.rank * 28)
    );
    return {
      bounds,
      mode: candidate.mode,
      score,
      overlapArea,
      overlapCount: overlaps.length,
      distanceToCursor,
    };
  });

  scored.sort((left, right) => left.score - right.score);
  const best = scored[0];
  return {
    ...best,
    bounds: {
      x: Math.round(best.bounds.x),
      y: Math.round(best.bounds.y),
      width: Math.round(best.bounds.width),
      height: Math.round(best.bounds.height),
    },
  };
}

module.exports = {
  chooseAnchorRect,
  computePanelPlacement,
  intersectionArea,
  normalizeNativeSelectionRectangles,
  normalizeRect,
  unionRects,
};
