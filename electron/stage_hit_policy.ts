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

  // How long one drag may hold the mouse. `dragging` arrives as a boolean the
  // caller derives from its own drag state, and pointer-up delivery on Windows
  // can be lost (electron/gesture_capture.ts:1-2) — if that flag ever latches,
  // `dragging === true` captures forever and the user cannot click anything
  // underneath the stage, with no way back short of quitting. The policy
  // therefore bounds the lease itself instead of trusting the boolean
  // indefinitely. A real drag is gesture-duration; eight seconds is far past
  // any deliberate bubble or panel move, and the lease is renewed by each new
  // press rather than by the passage of time.
  const DRAG_LEASE_MAX_MS = 8000;

  // True when a drag has outlived its lease. An unknown start time cannot be
  // expired, so a caller that has not been updated keeps today's behaviour
  // rather than losing drags outright.
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
