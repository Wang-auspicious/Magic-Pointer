'use strict';

const assert = require('assert');

const { PHYSICAL_SPACE, isPhysicalGeometry, toPhysicalGeometry } = require('../electron/geometry_space');

/**
 * The defect: the gesture payload declares `coordinateSpace:
 * 'physical_screen_pixels'` and converts every point field to physical except
 * `geometry`, which went out raw in `dip_window` — the one field in the object
 * that disagreed with the object's own declared space.
 */

// A stand-in for main.ts's toPhysical: +100/+50 then ×2, so a converted point
// is distinguishable from an unconverted one in every component.
const toPhysical = (p: { x: number; y: number }) => ({ x: (p.x + 100) * 2, y: (p.y + 50) * 2 });

// --- polygon_region --------------------------------------------------------

{
  const ring = [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }];
  const out = toPhysicalGeometry({ type: 'polygon_region', ring, coordinateSpace: 'dip_window' }, toPhysical);
  assert(out, 'a polygon must convert');
  assert.strictEqual(out.type, 'polygon_region');
  assert.deepStrictEqual(out.ring, [{ x: 202, y: 104 }, { x: 206, y: 108 }, { x: 210, y: 112 }]);
  assert.strictEqual(out.coordinateSpace, PHYSICAL_SPACE, 'the geometry must declare the space it is now in');
  console.log('geometry_space_test: polygon ring converts and re-declares its space');
}

{
  // The input must not be mutated: the caller still holds the summary.
  const ring = [{ x: 1, y: 2 }];
  const source = { type: 'polygon_region', ring, coordinateSpace: 'dip_window' };
  toPhysicalGeometry(source, toPhysical);
  assert.deepStrictEqual(ring, [{ x: 1, y: 2 }]);
  assert.strictEqual(source.coordinateSpace, 'dip_window');
  console.log('geometry_space_test: the source geometry is not mutated');
}

// --- band_corridor ---------------------------------------------------------

{
  const out = toPhysicalGeometry({
    type: 'band_corridor',
    centerline: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    corridor: [{ x: 0, y: -4 }, { x: 10, y: -4 }],
    widthPx: 8,
  }, toPhysical);
  assert(out, 'a corridor must convert');
  assert.deepStrictEqual(out.centerline, [{ x: 200, y: 100 }, { x: 220, y: 100 }]);
  assert.deepStrictEqual(out.corridor, [{ x: 200, y: 92 }, { x: 220, y: 92 }]);
  assert.strictEqual(out.widthPx, 8, 'widthPx is a DIP width and must survive unchanged');
  assert.strictEqual(out.coordinateSpace, PHYSICAL_SPACE);
  console.log('geometry_space_test: corridor converts both arrays');
}

{
  const out = toPhysicalGeometry({
    type: 'band_corridor',
    centerline: [{ x: 0, y: 0 }],
  }, toPhysical);
  assert(out, 'a corridor without an explicit corridor array is still usable');
  assert.strictEqual(out.corridor, undefined);
  console.log('geometry_space_test: a missing corridor array is tolerated');
}

// --- point_target ----------------------------------------------------------

{
  const out = toPhysicalGeometry({
    type: 'point_target',
    point: { x: 7, y: 9 },
    radiusPx: 24,
  }, toPhysical);
  assert.deepStrictEqual(out.point, { x: 214, y: 118 });
  assert.strictEqual(out.radiusPx, 24, 'radiusPx is a DIP radius and must survive unchanged');
  assert.strictEqual(out.coordinateSpace, PHYSICAL_SPACE);
  console.log('geometry_space_test: point target converts');
}

// --- refusal ---------------------------------------------------------------

{
  // A geometry that cannot be converted is worse than none: a consumer that
  // has one assumes it is in the space it was told.
  assert.strictEqual(toPhysicalGeometry(null, toPhysical), undefined);
  assert.strictEqual(toPhysicalGeometry(undefined, toPhysical), undefined);
  assert.strictEqual(toPhysicalGeometry('nonsense', toPhysical), undefined);
  assert.strictEqual(toPhysicalGeometry({ type: 'unknown_shape' }, toPhysical), undefined);
  assert.strictEqual(
    toPhysicalGeometry({ type: 'polygon_region', ring: [] }, toPhysical),
    undefined,
    'an empty ring is not a region',
  );
  console.log('geometry_space_test: unrecognised geometry is refused, not passed through');
}

{
  // One bad vertex must not silently deform the ring by dropping just it.
  const out = toPhysicalGeometry({
    type: 'polygon_region',
    ring: [{ x: 1, y: 1 }, { x: 'nope', y: 2 }, { x: 3, y: 3 }],
  }, toPhysical);
  assert.strictEqual(out, undefined, 'a partially convertible ring must be refused whole');
  console.log('geometry_space_test: a bad vertex refuses the whole geometry');
}

{
  assert.strictEqual(
    toPhysicalGeometry({ type: 'polygon_region', ring: [{ x: 1, y: 1 }] }, null as any),
    undefined,
    'a missing mapper must not produce a half-converted geometry',
  );
  console.log('geometry_space_test: a missing mapper refuses rather than half-converts');
}

// --- isPhysicalGeometry ----------------------------------------------------

{
  assert.strictEqual(isPhysicalGeometry({ coordinateSpace: PHYSICAL_SPACE }), true);
  assert.strictEqual(isPhysicalGeometry({ coordinateSpace: 'dip_window' }), false);
  assert.strictEqual(isPhysicalGeometry({}), false);
  assert.strictEqual(isPhysicalGeometry(null), false);
  console.log('geometry_space_test: space predicate');
}

console.log('geometry_space_test: all assertions passed');

// --- array shape (the real payload) ---------------------------------------

{
  // `summary.geometry` is `strokeSummaries.map(s => s.geometry)` — an array,
  // even for a single-stroke gesture. A converter that only understood a bare
  // object would drop the whole thing silently.
  const out = toPhysicalGeometry([
    { type: 'polygon_region', ring: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 1 }] },
  ], toPhysical);
  assert(Array.isArray(out), 'array in, array out');
  assert.strictEqual((out as any[]).length, 1);
  assert.strictEqual((out as any[])[0].coordinateSpace, PHYSICAL_SPACE);
  console.log('geometry_space_test: a one-element array is converted, not dropped');
}

{
  const out = toPhysicalGeometry([
    { type: 'polygon_region', ring: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 1 }] },
    { type: 'band_corridor', centerline: [{ x: 0, y: 0 }, { x: 5, y: 5 }] },
  ], toPhysical);
  assert.strictEqual((out as any[]).length, 2, 'every stroke keeps its geometry');
  assert.strictEqual((out as any[])[1].type, 'band_corridor');
  console.log('geometry_space_test: multi-stroke arrays convert entry by entry');
}

{
  // One unconvertible entry refuses the batch rather than shipping a region
  // that covers the wrong place.
  const out = toPhysicalGeometry([
    { type: 'polygon_region', ring: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
    { type: 'unknown_shape' },
  ], toPhysical);
  assert.strictEqual(out, undefined, 'a partly convertible array must be refused whole');
  console.log('geometry_space_test: a bad array entry refuses the whole array');
}

{
  assert.strictEqual(toPhysicalGeometry([], toPhysical), undefined, 'an empty array is not a region');
  console.log('geometry_space_test: an empty array is refused');
}
