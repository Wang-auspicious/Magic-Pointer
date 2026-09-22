'use strict';

(() => {
  type UnknownRecord = Record<string, unknown>;

  interface CaptureMouseInput {
    dragStartedAt?: unknown;
    dragging?: boolean;
    hasInteractiveSurface?: boolean;
    interactiveRegions?: unknown;
    now?: unknown;
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

  const DRAG_LEASE_MAX_MS = 8000;

  function dragLeaseExpired({
    dragStartedAt,
    now,
    maxMs = DRAG_LEASE_MAX_MS,
  }: { dragStartedAt?: unknown; maxMs?: unknown; now?: unknown } = {}): boolean {
    const startedAt = Number(dragStartedAt);
    const current = Number(now);
    if (!Number.isFinite(startedAt) || !Number.isFinite(current)) return false;
    return current - startedAt > Math.max(1, Number(maxMs) || DRAG_LEASE_MAX_MS);
  }

  function shouldCaptureMouse({
    hasInteractiveSurface,
    pointer,
    interactiveRegions,
    dragging = false,
    dragStartedAt,
    now,
  }: CaptureMouseInput = {}): boolean {
    if (dragging === true && !dragLeaseExpired({ dragStartedAt, now })) return true;
    return hasInteractiveSurface === true && pointInRegions(pointer, interactiveRegions);
  }

  const api = { DRAG_LEASE_MAX_MS, dragLeaseExpired, pointInRegions, shouldCaptureMouse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') {
    (globalThis as typeof globalThis & { MagicPointerStageHitPolicy?: typeof api })
      .MagicPointerStageHitPolicy = api;
  }
})();
