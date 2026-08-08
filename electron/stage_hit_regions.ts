'use strict';

type ShapeRegion = { x: number; y: number; width: number; height: number };

function cleanRegions(regions: unknown): ShapeRegion[] {
  return (Array.isArray(regions) ? regions : [])
    .map((region) => ({
      x: Number(region?.x),
      y: Number(region?.y),
      width: Number(region?.width),
      height: Number(region?.height),
    }))
    .filter(
      (region) =>
        [region.x, region.y, region.width, region.height].every(Number.isFinite) &&
        region.width > 0 &&
        region.height > 0,
    );
}

function nativeShapeRegions({ regions }: { regions?: unknown } = {}): ShapeRegion[] {
  // BrowserWindow.setShape consumes the same window-local pixel coordinates
  // reported by getBoundingClientRect in Electron 43 on Windows. Converting
  // those rectangles through dipToScreenPoint doubled them at 200% scaling:
  // UIA placed the input at x=1038 while GetWindowRgn started at x=1988.
  return cleanRegions(regions);
}

module.exports = { nativeShapeRegions };
