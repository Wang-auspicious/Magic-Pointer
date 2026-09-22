'use strict';

const assert = require('assert');

const { PHYSICAL_SPACE, isPhysicalGeometry, toPhysicalGeometry } = require('../electron/geometry_space');


const toPhysical = (p: { x: number; y: number }) => ({ x: (p.x + 100) * 2, y: (p.y + 50) * 2 });


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
  const ring = [{ x: 1, y: 2 }];
  const source = { type: 'polygon_region', ring, coordinateSpace: 'dip_window' };
  toPhysicalGeometry(source, toPhysical);
  assert.deepStrictEqual(ring, [{ x: 1, y: 2 }]);
  assert.strictEqual(source.coordinateSpace, 'dip_window');
  console.log('geometry_space_test: the source geometry is not mutated');
}


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


{
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


{
  assert.strictEqual(isPhysicalGeometry({ coordinateSpace: PHYSICAL_SPACE }), true);
  assert.strictEqual(isPhysicalGeometry({ coordinateSpace: 'dip_window' }), false);
  assert.strictEqual(isPhysicalGeometry({}), false);
  assert.strictEqual(isPhysicalGeometry(null), false);
  console.log('geometry_space_test: space predicate');
}

console.log('geometry_space_test: all assertions passed');


{
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
