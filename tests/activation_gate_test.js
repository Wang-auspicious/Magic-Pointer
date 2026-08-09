const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ActivationGate } = require('../electron/activation_gate');

const gate = new ActivationGate({ debounceMs: 600 });
assert.strictEqual(gate.decide({ now: 1000, hasVisibleSurface: false }), 'activate');
for (const now of [1050, 1100, 1250, 1599]) {
  assert.strictEqual(gate.decide({ now, hasVisibleSurface: true }), 'ignore');
}
assert.strictEqual(gate.decide({ now: 1600, hasVisibleSurface: true }), 'dismiss');
assert.strictEqual(gate.decide({ now: 2200, hasVisibleSurface: false }), 'activate');

const busyGate = new ActivationGate({ debounceMs: 600, repeatQuietMs: 300 });
assert.strictEqual(busyGate.decide({ now: 1000, hasVisibleSurface: false, isActivationBusy: false }), 'activate');
for (const now of [1500, 1570, 1640, 1710]) {
  assert.strictEqual(busyGate.decide({ now, hasVisibleSurface: false, isActivationBusy: true }), 'ignore');
}
assert.strictEqual(busyGate.decide({ now: 2050, hasVisibleSurface: false, isActivationBusy: true }), 'dismiss');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.ts'), 'utf8');
assert(mainSource.includes("const { ActivationGate } = require('./activation_gate');"));
assert(mainSource.includes('function hasVisibleTemporarySurface()'));
assert(mainSource.includes('function dismissTemporarySurfaces('));
assert(mainSource.includes('function requestActivation(reason)'));
for (const reason of ['wiggle', 'shortcut-wake', 'shortcut-text', 'shortcut-voice', 'runtime-delivery', 'legacy-native-selection']) {
  assert(mainSource.includes(`requestActivation('${reason}')`), reason);
}
assert(mainSource.includes("decision === 'dismiss'"));
assert(mainSource.includes("decision === 'activate'"));
assert(mainSource.includes('isActivationBusy: hasActiveSelectionCapture()'));
// The stage is the only temporary surface left after Task 5.
assert(mainSource.includes('stageWindow.isVisible()'));
assert(!mainSource.includes('resultWindow'));

console.log('activation gate test ok');
