'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const modulePath = path.resolve(__dirname, '..', 'electron', 'renderer', 'sweep_visual.ts');
const {
  SWEEP_STYLE,
  FRAGMENT_SHADER_SOURCE,
  buildSdfPath,
  sweepProfile,
} = require(modulePath);

assert(Array.isArray(SWEEP_STYLE.color) && SWEEP_STYLE.color.length === 3,
  'the sweep must use one RGB color');
assert(!Object.prototype.hasOwnProperty.call(SWEEP_STYLE, 'coreColor'),
  'the approved visual has no light core layer');
assert(!Object.prototype.hasOwnProperty.call(SWEEP_STYLE, 'haloColor'),
  'the approved visual has no independent halo layer');
assert(SWEEP_STYLE.edgeFeatherDip >= 3 && SWEEP_STYLE.edgeFeatherDip <= 6,
  'the edge feather must stay narrow');
assert(SWEEP_STYLE.tailFloorOpacity >= 0.18,
  'the oldest held tail must remain visible');

assert.strictEqual(typeof buildSdfPath, 'function');
assert.strictEqual(typeof sweepProfile, 'function');

const raw = [
  { x: 20, y: 100 },
  { x: 80, y: 30 },
  { x: 125, y: 135 },
  { x: 175, y: 45 },
  { x: 230, y: 110 },
];
const untouched = JSON.stringify(raw);
const sdf = buildSdfPath(raw, 22);
assert(sdf, 'a real gesture must produce an SDF path');
assert.strictEqual(JSON.stringify(raw), untouched, 'visual preparation cannot mutate gesture points');
assert.strictEqual(sdf.mode, 'screen-space-path-sdf');
assert(sdf.samples.length > raw.length, 'the visible path must interpolate the raw gesture');
assert.strictEqual(sdf.samples[0].progress, 0);
assert.strictEqual(sdf.samples[sdf.samples.length - 1].progress, 1);
assert(Math.max(...sdf.samples.map((point) => point.y))
  - Math.min(...sdf.samples.map((point) => point.y)) >= 80,
'large freehand bends must remain curved');
for (let index = 1; index < sdf.samples.length; index += 1) {
  assert(sdf.samples[index].progress >= sdf.samples[index - 1].progress,
    'arc-length progress must be monotonic toward the pointer');
}

const tail = sweepProfile(0);
const middle = sweepProfile(0.5);
const head = sweepProfile(1);
assert(tail.opacity >= SWEEP_STYLE.tailFloorOpacity);
assert(tail.opacity < middle.opacity && middle.opacity < head.opacity,
  'the old trail must brighten continuously toward the pointer');
assert(tail.edgeFeather > head.edgeFeather,
  'the old trail must be slightly softer than the pointer-side line');
assert.strictEqual(tail.color, head.color,
  'tail fading may change alpha and softness, never hue');

for (const token of [
  'distanceToSegment',
  'flatTopAlpha',
  'tailRamp',
  'edgeFeather',
  'currentProgress',
  'smoothstep',
]) {
  assert(FRAGMENT_SHADER_SOURCE.includes(token), 'shader must implement ' + token);
}
const source = fs.readFileSync(modulePath, 'utf8');
assert(source.includes('gl.TRIANGLES'), 'the SDF must render one bounding quad');
assert(!source.includes('gl.TRIANGLE_STRIP'),
  'no expanded ribbon geometry may exist at turns');
assert(!source.includes('miter'), 'miter geometry is the source of corner spikes');
assert(!source.includes('aCross'), 'the cross-section must come from distance, not mesh interpolation');

console.log('sweep_visual_test: all assertions passed');

