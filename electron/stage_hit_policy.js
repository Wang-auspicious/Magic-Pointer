'use strict';

(() => {
  function validPoint(point) {
    return point
      && Number.isFinite(Number(point.x))
      && Number.isFinite(Number(point.y));
  }

  function pointInRegions(point, regions = []) {
    if (!validPoint(point) || !Array.isArray(regions)) return false;
    const x = Number(point.x);
    const y = Number(point.y);
    return regions.some((region) => {
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

  function shouldCaptureMouse({ hasInteractiveSurface, pointer, interactiveRegions } = {}) {
    return hasInteractiveSurface === true && pointInRegions(pointer, interactiveRegions);
  }

  const api = { pointInRegions, shouldCaptureMouse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.MagicPointerStageHitPolicy = api;
})();
