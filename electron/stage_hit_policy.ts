'use strict';

(() => {
  type UnknownRecord = Record<string, unknown>;

  interface CaptureMouseInput {
    dragging?: boolean;
    hasInteractiveSurface?: boolean;
    interactiveRegions?: unknown;
    pointer?: unknown;
  }

  function recordOf(value: unknown): UnknownRecord | null {
    return value !== null && typeof value === 'object' ? (value as UnknownRecord) : null;
  }

  function validPoint(point: unknown): boolean {
    const candidate = recordOf(point);
    return candidate !== null
      && Number.isFinite(Number(candidate.x))
      && Number.isFinite(Number(candidate.y));
  }

  function pointInRegions(point: unknown, regions: unknown = []): boolean {
    if (!validPoint(point) || !Array.isArray(regions)) return false;
    const candidate = recordOf(point);
    if (candidate === null) return false;
    const x = Number(candidate.x);
    const y = Number(candidate.y);
    return regions.some((value: unknown) => {
      const region = recordOf(value);
      const left = Number(region?.x);
      const top = Number(region?.y);
      const width = Number(region?.width);
      const height = Number(region?.height);
      if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
        return false;
      }
      return x >= left && x < left + width && y >= top && y < top + height;
    });
  }

  // `dragging` is pointer capture: between press and release the surface must
  // hold the mouse no matter where the pointer has travelled. Without it a
  // drag that leaves the tracked region for even one frame hands the events to
  // whatever is underneath, which shows up as the cursor flickering between
  // the two shapes and as text getting selected in the app below.
  function shouldCaptureMouse({
    hasInteractiveSurface,
    pointer,
    interactiveRegions,
    dragging = false,
  }: CaptureMouseInput = {}): boolean {
    if (dragging === true) return true;
    return hasInteractiveSurface === true && pointInRegions(pointer, interactiveRegions);
  }

  const api = { pointInRegions, shouldCaptureMouse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') {
    (globalThis as typeof globalThis & { MagicPointerStageHitPolicy?: typeof api })
      .MagicPointerStageHitPolicy = api;
  }
})();
