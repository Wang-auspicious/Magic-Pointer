function finitePoint(value, index = 0) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  const t = Number(value?.t);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, t: Number.isFinite(t) ? t : index };
}

function distance(left, right) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function roundedPoint(point) {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

// Geometry helpers: the stroke becomes a selectable region, not just a point.
// - circle   -> closed polygon ring (ellipse fitted to the stroke bbox)
// - line     -> bandwidth corridor (closed polygon around the centerline)
// - freeform -> same corridor treatment so the drawn path stays usable
function corridorWidthFor(pathLength) {
  return Math.max(10, Math.min(36, pathLength * 0.05));
}

function buildCorridor(points, width) {
  const left = [];
  const right = [];
  for (let index = 0; index < points.length; index += 1) {
    const prev = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    let dx = next.x - prev.x;
    let dy = next.y - prev.y;
    const length = Math.hypot(dx, dy) || 1;
    dx /= length;
    dy /= length;
    const half = width / 2;
    left.push({ x: points[index].x - dy * half, y: points[index].y + dx * half });
    right.push({ x: points[index].x + dy * half, y: points[index].y - dx * half });
  }
  return [...left, ...right.reverse()];
}

function buildCircleRing(bbox, sampleCount = 32) {
  const centerX = bbox.x + bbox.width / 2;
  const centerY = bbox.y + bbox.height / 2;
  const radiusX = Math.max(8, bbox.width / 2);
  const radiusY = Math.max(8, bbox.height / 2);
  const ring = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const angle = (2 * Math.PI * index) / sampleCount;
    ring.push({ x: centerX + radiusX * Math.cos(angle), y: centerY + radiusY * Math.sin(angle) });
  }
  const closing = { x: centerX + radiusX, y: centerY };
  ring.push(closing);
  return ring;
}

function directionOf(points) {
  const first = points[0];
  const last = points.at(-1);
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

function summarizeStroke(points, { minDistance = 12, minDurationMs = 40 } = {}) {
  if (points.length < 2) {
    return null;
  }
  let pathLength = 0;
  for (let index = 1; index < points.length; index += 1) {
    pathLength += distance(points[index - 1], points[index]);
  }
  const durationMs = Math.max(0, points.at(-1).t - points[0].t);
  const releasePoint = roundedPoint(points.at(-1));
  if (pathLength < minDistance || durationMs < minDurationMs) {
    return null;
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const bbox = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
  const chord = distance(points[0], points.at(-1));
  const straightness = chord / Math.max(pathLength, 1);
  const diagonal = Math.hypot(bbox.width, bbox.height) || 1;
  const closure = chord / diagonal;
  const circuit = pathLength / diagonal;
  const isCircle = points.length >= 6
    && bbox.width >= 16 && bbox.height >= 16
    && closure <= 0.36 && circuit >= 1.65;
  const kind = isCircle ? 'circle' : straightness >= 0.80 ? 'line' : 'freeform';
  const raw = kind === 'circle'
    ? { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 }
    : kind === 'freeform'
      ? {
        x: xs.reduce((sum, value) => sum + value, 0) / points.length,
        y: ys.reduce((sum, value) => sum + value, 0) / points.length,
      }
      : { x: (points[0].x + points.at(-1).x) / 2, y: (points[0].y + points.at(-1).y) / 2 };

  return {
    schemaVersion: 2,
    kind,
    points,
    bbox: {
      x: Math.round(bbox.x),
      y: Math.round(bbox.y),
      width: Math.round(bbox.width),
      height: Math.round(bbox.height),
    },
    semanticPoint: Number.isFinite(raw.x) && Number.isFinite(raw.y)
      ? roundedPoint(raw)
      : roundedPoint({ x: (points[0].x + points.at(-1).x) / 2, y: (points[0].y + points.at(-1).y) / 2 }),
    geometry: kind === 'circle'
      ? { type: 'polygon_region', ring: buildCircleRing(bbox), coordinateSpace: 'logical_dips' }
      : {
        type: 'band_corridor',
        centerline: points.map((point) => ({ x: point.x, y: point.y })),
        corridor: buildCorridor(points, corridorWidthFor(pathLength)),
        widthPx: Math.round(corridorWidthFor(pathLength)),
        coordinateSpace: 'logical_dips',
      },
    direction: kind === 'circle' ? undefined : directionOf(points),
    pathLength,
    durationMs,
    straightness,
    releasePoint,
  };
}

// One unified gesture summarizer for both single and multi stroke sessions:
// the overlay may commit several strokes before the user finishes ("circle
// this, and this, then run the command"), and every stroke keeps its own
// region so grounding can rank targets per stroke.  The aggregate fields the
// bridges rely on (bbox / semanticPoint / releasePoint) are derived from the
// first stroke (stable capsule anchor) plus the last release point.
function summarizeGesture(rawPoints, rawStrokes, { minDistance = 12, minDurationMs = 40 } = {}) {
  const strokeInputs = (Array.isArray(rawStrokes) && rawStrokes.length)
    ? rawStrokes
      .map((stroke) => Array.from(stroke?.points || []).map(finitePoint).filter(Boolean))
      .filter((strokePoints) => strokePoints.length >= 2)
    : [Array.from(rawPoints || []).map(finitePoint).filter(Boolean)];
  const strokeSummaries = strokeInputs
    .map((strokePoints) => summarizeStroke(strokePoints, { minDistance, minDurationMs }))
    .filter(Boolean);
  if (!strokeSummaries.length) {
    const reason = strokeInputs.some((strokePoints) => strokePoints.length >= 2)
      ? 'gesture_too_short'
      : 'insufficient_points';
    return { valid: false, reason, points: [] };
  }
  const points = strokeSummaries.flatMap((stroke) => stroke.points);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const first = strokeSummaries[0];
  const last = strokeSummaries[strokeSummaries.length - 1];
  return {
    schemaVersion: 2,
    valid: true,
    reason: null,
    kind: strokeSummaries.length === 1 ? first.kind : 'multi',
    points,
    strokes: strokeSummaries,
    bbox: {
      x: Math.round(Math.min(...xs)),
      y: Math.round(Math.min(...ys)),
      width: Math.round(Math.max(...xs) - Math.min(...xs)),
      height: Math.round(Math.max(...ys) - Math.min(...ys)),
    },
    semanticPoint: first.semanticPoint,
    anchorPoint: first.releasePoint,
    releasePoint: last.releasePoint,
    geometry: strokeSummaries.map((stroke) => stroke.geometry),
    direction: strokeSummaries.length === 1 ? first.direction : undefined,
    pathLength: strokeSummaries.reduce((sum, stroke) => sum + stroke.pathLength, 0),
    durationMs: strokeSummaries.reduce((sum, stroke) => sum + stroke.durationMs, 0),
    straightness: first.straightness,
  };
}

const GestureCapture = { summarizeGesture };
if (typeof module !== 'undefined' && module.exports) module.exports = GestureCapture;
if (typeof globalThis !== 'undefined') globalThis.GestureCapture = GestureCapture;
