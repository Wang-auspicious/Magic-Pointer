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
    : { x: (points[0].x + points.at(-1).x) / 2, y: (points[0].y + points.at(-1).y) / 2 };

  return {
    schemaVersion: 2,
    valid: true,
    reason: null,
    kind,
    points,
    strokes: [{ points }],
    bbox: {
      x: Math.round(bbox.x),
      y: Math.round(bbox.y),
      width: Math.round(bbox.width),
      height: Math.round(bbox.height),
    },
    semanticPoint: Number.isFinite(raw.x) && Number.isFinite(raw.y)
      ? roundedPoint(raw)
      : roundedPoint({ x: (points[0].x + points.at(-1).x) / 2, y: (points[0].y + points.at(-1).y) / 2 }),
    pathLength,
    durationMs,
    straightness,
    releasePoint,
  };
}

const GestureCapture = { summarizeGesture };
if (typeof module !== 'undefined' && module.exports) module.exports = GestureCapture;
if (typeof globalThis !== 'undefined') globalThis.GestureCapture = GestureCapture;
