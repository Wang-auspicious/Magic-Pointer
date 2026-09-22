'use strict';


type Point = { x: number; y: number };
type UnknownRecord = Record<string, any>;
type PointMapper = (point: Point) => Point;

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
    if (!point) return null;    
    mapped.push(toPhysical(point));
  }
  return mapped;
}

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

function isPhysicalGeometry(geometry: unknown): boolean {
  const source = geometry as UnknownRecord | null;
  if (!source || typeof source !== 'object') return false;
  return String(source.coordinateSpace || '') === PHYSICAL_SPACE;
}

module.exports = { PHYSICAL_SPACE, isPhysicalGeometry, toPhysicalGeometry };
