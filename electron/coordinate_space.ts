type UnknownRecord = Record<string, unknown>;

interface Point {
  x: number;
  y: number;
}

interface TimedPoint extends Point {
  t: number;
}

interface Rect extends Point {
  height: number;
  width: number;
}

interface ScreenApi {
  dipToScreenPoint?(point: Point): unknown;
  screenToDipPoint?(point: Point): unknown;
  screenToDipRect?(window: null, rect: Rect): unknown;
}

interface GestureInput {
  coordinateSpace?: unknown;
  points?: unknown;
  releasePoint?: unknown;
  scaleFactor?: unknown;
  strokes?: unknown;
}

interface GeometryInput {
  captureFormat?: unknown;
  captureRect?: unknown;
  captureSpace?: unknown;
  pointer?: unknown;
  pointerSpace?: unknown;
  screenApi?: ScreenApi | null;
  stageBounds?: unknown;
  targetFormat?: unknown;
  targetKind?: unknown;
  targetRects?: unknown;
  targetSpace?: unknown;
}

function recordOf(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' ? (value as UnknownRecord) : null;
}

function physicalScreenPoint(screenApi: ScreenApi | null | undefined, dipPoint: unknown): Point | null {
  if (!screenApi || typeof screenApi.dipToScreenPoint !== 'function') return null;
  const dip = recordOf(dipPoint);
  const x = Number(dip?.x);
  const y = Number(dip?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  try {
    const point = screenApi.dipToScreenPoint({ x, y });
    const converted = recordOf(point);
    const px = Number(converted?.x);
    const py = Number(converted?.y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    return { x: Math.round(px), y: Math.round(py) };
  } catch (_) {
    return null;
  }
}

function physicalGestureBoundingBox(points: unknown, minimumThickness: unknown = 8): Rect {
  const finitePoints = (Array.isArray(points) ? points : []).map((point) => {
    const x = Number(point?.x);
    const y = Number(point?.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }).filter((point: Point | null): point is Point => point !== null);
  if (!finitePoints.length) return { x: 0, y: 0, width: 0, height: 0 };

  const thickness = Math.max(1, Math.round(Number(minimumThickness) || 8));
  let left = Math.min(...finitePoints.map((point) => point.x));
  let top = Math.min(...finitePoints.map((point) => point.y));
  let right = Math.max(...finitePoints.map((point) => point.x));
  let bottom = Math.max(...finitePoints.map((point) => point.y));
  if (right - left < thickness) {
    const center = (left + right) / 2;
    left = Math.round(center - thickness / 2);
    right = left + thickness;
  }
  if (bottom - top < thickness) {
    const center = (top + bottom) / 2;
    top = Math.round(center - thickness / 2);
    bottom = top + thickness;
  }
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  };
}

function physicalGestureTrace(
  screenApi: ScreenApi | null | undefined,
  gesture: GestureInput | null | undefined,
) {
  if (!gesture || typeof gesture !== 'object') return null;
  if (gesture.coordinateSpace === 'physical_screen_pixels') {
    // Already physical (completeSelectionGesture output): normalize the
    // shape without a second DIP -> physical conversion.
    const rawStrokes = Array.isArray(gesture.strokes) && gesture.strokes.length
      ? gesture.strokes
      : [{ points: Array.isArray(gesture.points) ? gesture.points : [] }];
    const strokes = rawStrokes.slice(0, 8).map((value) => {
      const stroke = recordOf(value);
      return {
      points: (Array.isArray(stroke?.points) ? stroke.points : []).slice(0, 512).map((point) => {
        const x = Number(point?.x);
        const y = Number(point?.y);
        const t = Number(point?.t);
        return Number.isFinite(x) && Number.isFinite(y)
          ? { x: Math.round(x), y: Math.round(y), t: Number.isFinite(t) ? t : 0 }
          : null;
      }).filter((point: TimedPoint | null): point is TimedPoint => point !== null),
    };
    }).filter((stroke) => stroke.points.length >= 2);
    const points = strokes.flatMap((stroke) => stroke.points);
    if (points.length < 2) return null;
    const releasePoint = recordOf(gesture.releasePoint || points.at(-1));
    return {
      schemaVersion: 2,
      coordinateSpace: 'physical_screen_pixels',
      strokes,
      releasePoint: {
        x: Math.round(Number(releasePoint?.x) || 0),
        y: Math.round(Number(releasePoint?.y) || 0),
      },
      bbox: physicalGestureBoundingBox(
        points,
        8 * Math.max(1, Number(gesture.scaleFactor) || 1),
      ),
    };
  }
  const rawStrokes = Array.isArray(gesture.strokes) && gesture.strokes.length
    ? gesture.strokes
    : [{ points: Array.isArray(gesture.points) ? gesture.points : [] }];
  const strokes = rawStrokes.slice(0, 8).map((value) => {
    const stroke = recordOf(value);
    return {
    points: (Array.isArray(stroke?.points) ? stroke.points : []).slice(0, 512).map((point) => {
      const physical = physicalScreenPoint(screenApi, point);
      const t = Number(point?.t);
      return physical ? { ...physical, t: Number.isFinite(t) ? t : 0 } : null;
    }).filter((point: TimedPoint | null): point is TimedPoint => point !== null),
  };
  }).filter((stroke) => stroke.points.length >= 2);
  const points = strokes.flatMap((stroke) => stroke.points);
  if (points.length < 2) return null;
  const releasePoint = physicalScreenPoint(screenApi, gesture.releasePoint) || {
    x: points.at(-1)!.x,
    y: points.at(-1)!.y,
  };
  return {
    schemaVersion: 2,
    coordinateSpace: 'physical_screen_pixels',
    strokes,
    releasePoint,
    bbox: physicalGestureBoundingBox(points),
  };
}

function physicalDisplayBounds({
  bounds,
  scaleFactor,
}: {
  bounds: Rect;
  scaleFactor: number;
}): [number, number, number, number] {
  // Round origin and size separately. A DIP width is never a physical width:
  // on a 150% display a 1707 DIP-wide monitor is 2561 physical pixels wide.
  const scale = Number(scaleFactor);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new TypeError('scaleFactor must be a finite positive number');
  }
  const x = Number(bounds?.x);
  const y = Number(bounds?.y);
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  if (![x, y, width, height].every(Number.isFinite)) {
    throw new TypeError('bounds must contain finite numbers');
  }
  const left = Math.round(x * scale);
  const top = Math.round(y * scale);
  const physicalWidth = Math.round(width * scale);
  const physicalHeight = Math.round(height * scale);
  return [left, top, left + physicalWidth, top + physicalHeight];
}

function finitePoint(value: unknown): Point | null {
  const candidate = recordOf(value);
  const x = Number(candidate?.x);
  const y = Number(candidate?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function finiteRect(value: unknown, format: string = 'xywh'): Rect | null {
  if (!['xywh', 'ltrb'].includes(format)) return null;
  const candidate = recordOf(value);
  const source = Array.isArray(value)
    ? value
    : format === 'ltrb'
      ? [candidate?.left, candidate?.top, candidate?.right, candidate?.bottom]
      : [candidate?.x, candidate?.y, candidate?.width, candidate?.height];
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

function physicalRectToDip(screenApi: ScreenApi | null | undefined, rect: Rect): Rect | null {
  if (!screenApi || typeof screenApi.screenToDipRect !== 'function') return null;
  try {
    return finiteRect(screenApi.screenToDipRect(null, rect));
  } catch (_) {
    return null;
  }
}

function physicalPointToDip(screenApi: ScreenApi | null | undefined, point: Point): Point | null {
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

function relativeRect(rect: unknown, stageBounds: unknown): Rect | null {
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

function distancePointToRect(point: Point, rect: Rect): number {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const dx = Math.max(rect.x - point.x, point.x - right, 0);
  const dy = Math.max(rect.y - point.y, point.y - bottom, 0);
  return Math.hypot(dx, dy);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value as UnknownRecord).forEach((entry) => deepFreeze(entry));
  return Object.freeze(value);
}

function invalidGeometry(reason: string) {
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
}: GeometryInput = {}) {
  if (pointerSpace !== 'physical_screen_pixels') return invalidGeometry('invalid_pointer_space');
  const pointerPhysical = finitePoint(pointer);
  const stageDipBounds = finiteRect(stageBounds);
  if (!pointerPhysical) return invalidGeometry('invalid_pointer');
  if (!stageDipBounds) return invalidGeometry('invalid_stage_bounds');
  if (!Array.isArray(targetRects)) return invalidGeometry('invalid_target_rectangles');
  if (targetKind !== null
    && (typeof targetKind !== 'string' || !['resolved', 'pointer_anchor'].includes(targetKind))) {
    return invalidGeometry('invalid_target_kind');
  }

  const hasTargets = targetRects.length > 0;
  if (hasTargets && targetSpace !== 'physical_screen_pixels') {
    return invalidGeometry('invalid_target_space');
  }
  if (hasTargets && targetFormat !== 'xywh') return invalidGeometry('invalid_target_format');
  const targetPhysicalRects = targetRects.map((rect) => finiteRect(rect, String(targetFormat || 'xywh')));
  if (targetPhysicalRects.some((rect) => rect === null)) {
    return invalidGeometry('invalid_target_rectangle');
  }

  const validTargetPhysicalRects = targetPhysicalRects as Rect[];

  let capturePhysicalRect: Rect | null = null;
  let captureDipRect: Rect | null = null;
  if (captureRect !== null && captureRect !== undefined) {
    if (captureSpace !== 'physical_screen_pixels') return invalidGeometry('invalid_capture_space');
    if (typeof captureFormat !== 'string' || !['xywh', 'ltrb'].includes(captureFormat)) {
      return invalidGeometry('invalid_capture_format');
    }
    capturePhysicalRect = finiteRect(captureRect, String(captureFormat));
    if (!capturePhysicalRect) return invalidGeometry('invalid_capture_rectangle');
    captureDipRect = physicalRectToDip(screenApi, capturePhysicalRect);
    if (!captureDipRect) return invalidGeometry('capture_conversion_failed');
  }

  const pointerDip = physicalPointToDip(screenApi, pointerPhysical);
  if (!pointerDip) return invalidGeometry('pointer_conversion_failed');
  const targetDipRects = validTargetPhysicalRects.map((rect) => physicalRectToDip(screenApi, rect));
  if (targetDipRects.some((rect) => rect === null)) {
    return invalidGeometry('target_conversion_failed');
  }

  const validTargetDipRects = targetDipRects as Rect[];
  const pointerOnly = targetKind === 'pointer_anchor' || validTargetDipRects.length === 0;
  const targetDipRect = pointerOnly
    ? { x: pointerDip.x - 8, y: pointerDip.y - 8, width: 16, height: 16 }
    : validTargetDipRects.reduce<Rect | null>((nearest, rect) => (
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
    targetPhysicalRects: validTargetPhysicalRects,
    targetDipRects: validTargetDipRects,
    capturePhysicalRect,
    captureDipRect,
    stageBounds: stageDipBounds,
    stageTarget,
  });
}

module.exports = {
  finiteRect,
  normalizeGroundingGeometry,
  physicalDisplayBounds,
  physicalGestureBoundingBox,
  physicalGestureTrace,
  physicalRectToDip,
  physicalScreenPoint,
  relativeRect,
};
