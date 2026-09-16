'use strict';

/**
 * Coordinate-space conversion for gesture region geometry.
 *
 * The defect this exists for: the gesture payload sent to Python declares
 * `coordinateSpace: 'physical_screen_pixels'`, and every point field on it —
 * `points`, `strokes`, `bbox`, `semanticPoint`, `releasePoint`, `anchorPoint`
 * — was converted to physical before being attached. `geometry` was not. It
 * went out raw, in `dip_window`, as the one field in the object that disagreed
 * with the object's own declared space.
 *
 * Nothing consumed it, which is why it never showed up as a wrong answer — the
 * polygon simply never reached the OCR path at all (see the passthrough in
 * `_normalized_gesture`). That made it latent rather than harmless: the moment
 * anything started reading `geometry`, it would have been wrong by the display
 * scale factor, and on a multi-monitor setup wrong by the wrong display's
 * factor.
 *
 * Pure and dependency-free: `toPhysical` is injected, so this is testable
 * without Electron.
 */

type Point = { x: number; y: number };
type UnknownRecord = Record<string, any>;
type PointMapper = (point: Point) => Point;

/** The space every converted geometry carries afterwards. */
const PHYSICAL_SPACE = 'physical_screen_pixels';

function asPoint(value: unknown): Point | null {
  const record = value as UnknownRecord | null;
  if (!record || typeof record !== 'object') return null;
  const x = Number(record.x);
  const y = Number(record.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function mapPoints(value: unknown, toPhysical: PointMapper): Point[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const mapped: Point[] = [];
  for (const raw of value) {
    const point = asPoint(raw);
    if (!point) return null;   // a single bad vertex would silently deform the ring
    mapped.push(toPhysical(point));
  }
  return mapped;
}

/**
 * Convert a gesture's region geometry into the payload's declared space.
 *
 * ``geometry`` arrives as an **array**, one entry per stroke — the summarizer
 * builds it with ``strokeSummaries.map(stroke => stroke.geometry)``, so even a
 * single-stroke gesture produces `[oneGeometry]`. Array in, array out.
 *
 * Returns `undefined` for anything unrecognised rather than passing it
 * through: a geometry that cannot be converted is worse than no geometry,
 * because a consumer that has one assumes it is in the space it was told. An
 * array is refused whole if any entry is unconvertible — a partially converted
 * region is a region covering the wrong place, which is worse than none.
 */
function toPhysicalGeometry(geometry: unknown, toPhysical: PointMapper): UnknownRecord | UnknownRecord[] | undefined {
  if (typeof toPhysical !== 'function') return undefined;
  if (Array.isArray(geometry)) {
    const converted: UnknownRecord[] = [];
    for (const entry of geometry) {
      const one = toPhysicalSingleGeometry(entry, toPhysical);
      if (!one) return undefined;
      converted.push(one);
    }
    return converted.length ? converted : undefined;
  }
  return toPhysicalSingleGeometry(geometry, toPhysical);
}

function toPhysicalSingleGeometry(geometry: unknown, toPhysical: PointMapper): UnknownRecord | undefined {
  const source = geometry as UnknownRecord | null;
  if (!source || typeof source !== 'object') return undefined;
  const type = String(source.type || '');
  if (type === 'point_target') {
    const point = asPoint(source.point);
    if (!point) return undefined;
    return {
      ...source,
      type,
      point: toPhysical(point),
      coordinateSpace: PHYSICAL_SPACE,
    };
  }
  if (type === 'polygon_region') {
    const ring = mapPoints(source.ring, toPhysical);
    if (!ring) return undefined;
    return { ...source, type, ring, coordinateSpace: PHYSICAL_SPACE };
  }
  if (type === 'band_corridor') {
    const centerline = mapPoints(source.centerline, toPhysical);
    const corridor = mapPoints(source.corridor, toPhysical);
    // `corridor` is optional in principle; a corridor without its centreline
    // is not, since that is the part grounding follows.
    if (!centerline) return undefined;
    return {
      ...source,
      type,
      centerline,
      ...(corridor ? { corridor } : {}),
      ...(typeof source.widthPx === 'number' ? { widthPx: source.widthPx } : {}),
      coordinateSpace: PHYSICAL_SPACE,
    };
  }
  return undefined;
}

/** True when every point in a geometry is in the physical space. */
function isPhysicalGeometry(geometry: unknown): boolean {
  const source = geometry as UnknownRecord | null;
  if (!source || typeof source !== 'object') return false;
  return String(source.coordinateSpace || '') === PHYSICAL_SPACE;
}

module.exports = { PHYSICAL_SPACE, isPhysicalGeometry, toPhysicalGeometry };
