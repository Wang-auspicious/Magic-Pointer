'use strict';


const assert = require('assert');
const path = require('path');

const modulePath = path.resolve(__dirname, '..', 'electron', 'renderer', 'sweep_visual.ts');
const sweep = require(modulePath);

const MAX_POINTS = 64;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}


function refCatmullRomPoint(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t
      + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
      + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t
      + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2
      + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

function refSmoothPath(points) {
  if (points.length <= 2) return points.map((point) => ({ x: point.x, y: point.y }));
  const result = [{ x: points[0].x, y: points[0].y }];
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(points.length - 1, index + 2)];
    const steps = Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 6));
    for (let step = 1; step <= steps; step += 1) {
      const point = refCatmullRomPoint(p0, p1, p2, p3, step / steps);
      const previous = result[result.length - 1];
      if (Math.hypot(point.x - previous.x, point.y - previous.y) > 0.1) result.push(point);
    }
  }
  return result;
}

function refResamplePath(points, count) {
  if (points.length <= count) return points.map((point) => ({ x: point.x, y: point.y }));
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(cumulative[index - 1] + Math.hypot(
      points[index].x - points[index - 1].x,
      points[index].y - points[index - 1].y,
    ));
  }
  const total = cumulative[cumulative.length - 1];
  const result = [];
  let segmentIndex = 1;
  for (let sampleIndex = 0; sampleIndex < count; sampleIndex += 1) {
    const target = total * sampleIndex / (count - 1);
    while (segmentIndex < cumulative.length - 1 && cumulative[segmentIndex] < target) {
      segmentIndex += 1;
    }
    const beforeDistance = cumulative[segmentIndex - 1];
    const afterDistance = cumulative[segmentIndex];
    const span = Math.max(afterDistance - beforeDistance, 0.0001);
    const ratio = clamp((target - beforeDistance) / span, 0, 1);
    const before = points[segmentIndex - 1];
    const after = points[segmentIndex];
    result.push({
      x: before.x + (after.x - before.x) * ratio,
      y: before.y + (after.y - before.y) * ratio,
    });
  }
  return result;
}

function refPathLength(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return total;
}

function refAddArcProgress(points) {
  const total = Math.max(refPathLength(points), 0.0001);
  let travelled = 0;
  return points.map((point, index) => {
    if (index > 0) {
      travelled += Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y);
    }
    return {
      x: point.x,
      y: point.y,
      progress: index === points.length - 1 ? 1 : clamp(travelled / total, 0, 1),
    };
  });
}

function referenceBuildSdfPath(points, requestedWidth) {
  const usable = Array.isArray(points)
    ? points.filter((point) => Number.isFinite(point && point.x) && Number.isFinite(point && point.y))
    : [];
  if (usable.length < 2 || refPathLength(usable) <= 0.1) return null;
  const samples = refAddArcProgress(refResamplePath(refSmoothPath(usable), MAX_POINTS));
  const width = clamp(Number(requestedWidth) || 22, 8, 40);
  const bodyHalfWidth = clamp(width * sweep.SWEEP_STYLE.bodyHalfWidthRatio, 4.5, 8.5);
  const maximumRadius = bodyHalfWidth
    + sweep.SWEEP_STYLE.edgeFeatherDip
    + sweep.SWEEP_STYLE.tailSoftnessBoostDip
    + 2;
  const xs = samples.map((point) => point.x);
  const ys = samples.map((point) => point.y);
  return {
    mode: 'screen-space-path-sdf',
    samples,
    bodyHalfWidth,
    edgeFeather: sweep.SWEEP_STYLE.edgeFeatherDip,
    tailSoftnessBoost: sweep.SWEEP_STYLE.tailSoftnessBoostDip,
    tailFloorOpacity: sweep.SWEEP_STYLE.tailFloorOpacity,
    bounds: {
      left: Math.min(...xs) - maximumRadius,
      right: Math.max(...xs) + maximumRadius,
      top: Math.min(...ys) - maximumRadius,
      bottom: Math.max(...ys) + maximumRadius,
    },
  };
}


assert.strictEqual(typeof sweep.createSweepPathCache, 'function',
  'the module must expose an independent cache handle so two canvases cannot thrash');

const shapes = {
  straight: (i) => ({ x: 100 + i * 4.2, y: 300 }),
  sine: (i) => ({ x: 300 + Math.sin(i / 20) * 250 + i * 0.3, y: 400 + Math.cos(i / 17) * 120 }),
  jitter: (i) => ({ x: 200 + i * 4.21, y: 200 + ((i * 37) % 11) - 5 }),
  subPixel: (i) => ({ x: 50 + i * 0.04, y: 50 + (i % 3) * 0.03 }),
  loop: (i) => ({ x: 500 + Math.sin(i / 9) * 180, y: 500 + Math.sin(i / 4.5) * 90 }),
};

for (const [name, make] of Object.entries(shapes)) {
  const cache = sweep.createSweepPathCache();
  const growing = [];
  const steps = 600;
  let incremental = null;
  for (let i = 0; i < steps; i += 1) {
    growing.push(make(i));
    const untouched = JSON.stringify(growing);
    incremental = sweep.buildSdfPath(growing, 22, cache);
    assert.strictEqual(JSON.stringify(growing), untouched,
      `${name}: buildSdfPath must not mutate the caller's point array`);
    assert.deepStrictEqual(incremental, referenceBuildSdfPath(growing, 22),
      `${name}: incremental geometry diverged at point ${i} (length ${growing.length})`);
  }
  assert(incremental && incremental.samples.length === MAX_POINTS,
    `${name}: a long stroke must resample to exactly MAX_POINTS`);
}

{
  const cache = sweep.createSweepPathCache();
  const growing = [];
  for (let i = 0; i < 4096; i += 1) {
    growing.push(shapes.sine(i));
    if (i % 97 === 0 || i > 4080) {
      assert.deepStrictEqual(sweep.buildSdfPath(growing, 22, cache), referenceBuildSdfPath(growing, 22),
        `4096-point stroke diverged at point ${i}`);
    }
  }
}


{
  const cache = sweep.createSweepPathCache();
  assert.strictEqual(sweep.buildSdfPath([], 22, cache), null);
  assert.strictEqual(sweep.buildSdfPath([{ x: 1, y: 1 }], 22, cache), null);
  assert.strictEqual(sweep.buildSdfPath([{ x: 1, y: 1 }, { x: 1, y: 1 }], 22, cache), null);
  assert.strictEqual(sweep.buildSdfPath(null, 22, cache), null);
  assert.strictEqual(sweep.buildSdfPath('nonsense', 22, cache), null);
  const dirty = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 80, y: 30 }, { x: NaN, y: 30 }, { x: 120, y: 80 }];
  assert.deepStrictEqual(sweep.buildSdfPath(dirty, 22, cache), referenceBuildSdfPath(dirty, 22),
    'a stroke containing a non-finite point must fall back to the stateless implementation');
  const clean = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 80, y: 30 }, { x: 120, y: 80 }];
  const cleanCache = sweep.createSweepPathCache();
  assert.deepStrictEqual(sweep.buildSdfPath(clean, 22, cleanCache), referenceBuildSdfPath(clean, 22));
  clean.push({ x: 160, y: 140 });
  assert.deepStrictEqual(sweep.buildSdfPath(clean, 22, cleanCache), referenceBuildSdfPath(clean, 22),
    'the cache must recover after a fallback');
}


{
  const cache = sweep.createSweepPathCache();
  const a = [{ x: 0, y: 0 }, { x: 30, y: 20 }, { x: 70, y: 10 }, { x: 110, y: 60 }];
  const first = sweep.buildSdfPath(a, 22, cache);
  assert.deepStrictEqual(sweep.buildSdfPath(a.slice(), 22, cache), first,
    'a new array with the same content must produce the same geometry');
  const short = a.slice(0, 2);
  assert.deepStrictEqual(sweep.buildSdfPath(short, 22, cache), referenceBuildSdfPath(short, 22));
  assert.deepStrictEqual(sweep.buildSdfPath(a.slice(), 22, cache), first,
    'geometry must be reproducible after the array shrinks and is rebuilt');
  assert.deepStrictEqual(sweep.buildSdfPath(a, 22), first);
}


{
  const cache = sweep.createSweepPathCache();
  const pts = Array.from({ length: 200 }, (_unused, i) => shapes.sine(i));
  for (const width of [8, 12, 22, 40, 400, 0, NaN]) {
    const path = sweep.buildSdfPath(pts, width, cache);
    const reference = referenceBuildSdfPath(pts, width);
    assert.deepStrictEqual(path, reference, `width ${width} diverged`);
  }
  assert.deepStrictEqual(sweep.buildSdfPath(pts, 12, cache), referenceBuildSdfPath(pts, 12));
  assert.deepStrictEqual(sweep.buildSdfPath(pts, 40, cache), referenceBuildSdfPath(pts, 40));
}


{
  const points = 1024;
  const growth = [];
  const incrementalStart = process.hrtime.bigint();
  {
    const cache = sweep.createSweepPathCache();
    for (let i = 0; i < points; i += 1) {
      growth.push(shapes.sine(i));
      sweep.buildSdfPath(growth, 22, cache);
    }
  }
  const incrementalUs = Number(process.hrtime.bigint() - incrementalStart) / 1000;

  const fullStart = process.hrtime.bigint();
  {
    const replay = [];
    for (let i = 0; i < points; i += 1) {
      replay.push(shapes.sine(i));
      referenceBuildSdfPath(replay, 22);
    }
  }
  const fullUs = Number(process.hrtime.bigint() - fullStart) / 1000;

  console.log(`sweep_visual_incremental_test: 1024-step growth rebuild `
    + `incremental=${incrementalUs.toFixed(0)}us full=${fullUs.toFixed(0)}us `
    + `(${(fullUs / incrementalUs).toFixed(1)}x)`);
}

console.log('sweep_visual_incremental_test: all assertions passed');
