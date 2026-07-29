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

function pointAtHalfLength(points, pathLength) {
  const target = pathLength / 2;
  let travelled = 0;
  for (let index = 1; index < points.length; index += 1) {
    const segment = distance(points[index - 1], points[index]);
    if (travelled + segment >= target && segment > 0) {
      const ratio = (target - travelled) / segment;
      return {
        x: points[index - 1].x + (points[index].x - points[index - 1].x) * ratio,
        y: points[index - 1].y + (points[index].y - points[index - 1].y) * ratio,
      };
    }
    travelled += segment;
  }
  return { x: points.at(-1).x, y: points.at(-1).y };
}

function roundedPoint(point) {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

function summarizeGesture(rawPoints, { minDistance = 12, minDurationMs = 40 } = {}) {
  const points = Array.from(rawPoints || [])
    .map(finitePoint)
    .filter(Boolean);
  if (points.length < 2) {
    return { valid: false, reason: 'insufficient_points', points };
  }
  let pathLength = 0;
  for (let index = 1; index < points.length; index += 1) {
    pathLength += distance(points[index - 1], points[index]);
  }
  const durationMs = Math.max(0, points.at(-1).t - points[0].t);
  const releasePoint = roundedPoint(points.at(-1));
  if (pathLength < minDistance || durationMs < minDurationMs) {
    return {
      valid: false,
      reason: 'gesture_too_short',
      points,
      pathLength,
      durationMs,
      releasePoint,
    };
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const bbox = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
  const diagonal = Math.hypot(bbox.width, bbox.height);
  const chord = distance(points[0], points.at(-1));
  const closure = chord / Math.max(diagonal, 1);
  const circuit = pathLength / Math.max(diagonal, 1);
  const isCircle = points.length >= 6
    && bbox.width >= 16
    && bbox.height >= 16
    && closure <= 0.36
    && circuit >= 1.65;
  const straightness = chord / Math.max(pathLength, 1);
  const kind = isCircle ? 'circle' : straightness >= 0.80 ? 'line' : 'freeform';
  const semanticPoint = kind === 'circle'
    ? { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 }
    : pointAtHalfLength(points, pathLength);

  return {
    valid: true,
    reason: null,
    kind,
    points,
    bbox: {
      x: Math.round(bbox.x),
      y: Math.round(bbox.y),
      width: Math.round(bbox.width),
      height: Math.round(bbox.height),
    },
    pathLength,
    durationMs,
    straightness,
    releasePoint,
    semanticPoint: roundedPoint(semanticPoint),
  };
}

const GestureCapture = { summarizeGesture };
if (typeof module !== 'undefined' && module.exports) module.exports = GestureCapture;
if (typeof globalThis !== 'undefined') globalThis.GestureCapture = GestureCapture;
