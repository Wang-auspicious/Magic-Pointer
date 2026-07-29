function physicalScreenPoint(screenApi, dipPoint) {
  if (!screenApi || typeof screenApi.dipToScreenPoint !== 'function') return null;
  const x = Number(dipPoint?.x);
  const y = Number(dipPoint?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  try {
    const point = screenApi.dipToScreenPoint({ x, y });
    const px = Number(point?.x);
    const py = Number(point?.y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    return { x: Math.round(px), y: Math.round(py) };
  } catch (_) {
    return null;
  }
}

function finitePoint(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function finiteRect(value, format = 'xywh') {
  if (!['xywh', 'ltrb'].includes(format)) return null;
  const source = Array.isArray(value)
    ? value
    : format === 'ltrb'
      ? [value?.left, value?.top, value?.right, value?.bottom]
      : [value?.x, value?.y, value?.width, value?.height];
  if (!Array.isArray(source) || source.length !== 4) return null;
  const numbers = source.map(Number);
  if (!numbers.every(Number.isFinite)) return null;
  const [first, second, third, fourth] = numbers;
  const rect = format === 'ltrb'
    ? { x: first, y: second, width: third - first, height: fourth - second }
    : { x: first, y: second, width: third, height: fourth };
  if (rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

function physicalRectToDip(screenApi, rect) {
  if (!screenApi || typeof screenApi.screenToDipRect !== 'function') return null;
  try {
    return finiteRect(screenApi.screenToDipRect(null, rect));
  } catch (_) {
    return null;
  }
}

function physicalPointToDip(screenApi, point) {
  if (!screenApi) return null;
  try {
    if (typeof screenApi.screenToDipPoint === 'function') {
      return finitePoint(screenApi.screenToDipPoint(point));
    }
    const rect = physicalRectToDip(screenApi, { x: point.x, y: point.y, width: 1, height: 1 });
    return rect ? { x: rect.x, y: rect.y } : null;
  } catch (_) {
    return null;
  }
}

function relativeRect(rect, stageBounds) {
  const normalizedRect = finiteRect(rect);
  const normalizedStage = finiteRect(stageBounds);
  if (!normalizedRect || !normalizedStage) return null;
  return {
    x: Math.round(normalizedRect.x - normalizedStage.x),
    y: Math.round(normalizedRect.y - normalizedStage.y),
    width: Math.round(normalizedRect.width),
    height: Math.round(normalizedRect.height),
  };
}

function distancePointToRect(point, rect) {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const dx = Math.max(rect.x - point.x, point.x - right, 0);
  const dy = Math.max(rect.y - point.y, point.y - bottom, 0);
  return Math.hypot(dx, dy);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function invalidGeometry(reason) {
  return deepFreeze({ state: 'invalid', reason });
}

function normalizeGroundingGeometry({
  pointer,
  pointerSpace,
  targetRects = [],
  targetSpace = null,
  targetFormat = null,
  targetKind = null,
  captureRect = null,
  captureSpace = null,
  captureFormat = null,
  stageBounds,
  screenApi,
} = {}) {
  if (pointerSpace !== 'physical_screen_pixels') return invalidGeometry('invalid_pointer_space');
  const pointerPhysical = finitePoint(pointer);
  const stageDipBounds = finiteRect(stageBounds);
  if (!pointerPhysical) return invalidGeometry('invalid_pointer');
  if (!stageDipBounds) return invalidGeometry('invalid_stage_bounds');
  if (!Array.isArray(targetRects)) return invalidGeometry('invalid_target_rectangles');
  if (targetKind !== null && !['resolved', 'pointer_anchor'].includes(targetKind)) {
    return invalidGeometry('invalid_target_kind');
  }

  const hasTargets = targetRects.length > 0;
  if (hasTargets && targetSpace !== 'physical_screen_pixels') {
    return invalidGeometry('invalid_target_space');
  }
  if (hasTargets && targetFormat !== 'xywh') return invalidGeometry('invalid_target_format');
  const targetPhysicalRects = targetRects.map((rect) => finiteRect(rect, targetFormat || 'xywh'));
  if (targetPhysicalRects.some((rect) => rect === null)) {
    return invalidGeometry('invalid_target_rectangle');
  }

  let capturePhysicalRect = null;
  let captureDipRect = null;
  if (captureRect !== null && captureRect !== undefined) {
    if (captureSpace !== 'physical_screen_pixels') return invalidGeometry('invalid_capture_space');
    if (!['xywh', 'ltrb'].includes(captureFormat)) return invalidGeometry('invalid_capture_format');
    capturePhysicalRect = finiteRect(captureRect, captureFormat);
    if (!capturePhysicalRect) return invalidGeometry('invalid_capture_rectangle');
    captureDipRect = physicalRectToDip(screenApi, capturePhysicalRect);
    if (!captureDipRect) return invalidGeometry('capture_conversion_failed');
  }

  const pointerDip = physicalPointToDip(screenApi, pointerPhysical);
  if (!pointerDip) return invalidGeometry('pointer_conversion_failed');
  const targetDipRects = targetPhysicalRects.map((rect) => physicalRectToDip(screenApi, rect));
  if (targetDipRects.some((rect) => rect === null)) {
    return invalidGeometry('target_conversion_failed');
  }

  const pointerOnly = targetKind === 'pointer_anchor' || targetDipRects.length === 0;
  const targetDipRect = pointerOnly
    ? { x: pointerDip.x - 8, y: pointerDip.y - 8, width: 16, height: 16 }
    : targetDipRects.reduce((nearest, rect) => (
      !nearest || distancePointToRect(pointerDip, rect) < distancePointToRect(pointerDip, nearest)
        ? rect
        : nearest
    ), null);
  const stageTarget = relativeRect(targetDipRect, stageDipBounds);
  if (!stageTarget || stageTarget.width <= 0 || stageTarget.height <= 0) {
    return invalidGeometry('invalid_stage_target');
  }

  return deepFreeze({
    state: pointerOnly ? 'pointer_only' : 'resolved',
    pointerPhysical,
    pointerDip,
    targetPhysicalRects,
    targetDipRects,
    capturePhysicalRect,
    captureDipRect,
    stageBounds: stageDipBounds,
    stageTarget,
  });
}

module.exports = {
  finiteRect,
  normalizeGroundingGeometry,
  physicalRectToDip,
  physicalScreenPoint,
  relativeRect,
};
