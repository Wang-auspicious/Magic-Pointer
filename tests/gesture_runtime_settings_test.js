'use strict';

const assert = require('assert');
const fs = require('fs');
const {
  gestureRuntimeContract,
  gestureRuntimeSettingsChanged,
} = require('../electron/gesture_runtime_settings');
const { defaultSettings } = require('../electron/settings_store');

const defaults = defaultSettings();
assert.deepStrictEqual(gestureRuntimeContract(defaults), {
  armDelayMs: 180,
  timeoutMs: 5000,
  chainGapMs: 10000,
  interactionMode: 'exclusive_overlay',
  lineStyle: 'demo6_band',
  lineWidthDip: 40,
});

const lineChanged = structuredClone(defaults);
lineChanged.appearance.gesture_line_style = 'thin';
lineChanged.appearance.gesture_line_width_dip = 7;
assert.strictEqual(gestureRuntimeSettingsChanged(defaults, lineChanged), true);

const modeChanged = structuredClone(defaults);
modeChanged.activation.gesture_interaction_mode = 'pass_through';
assert.strictEqual(gestureRuntimeSettingsChanged(defaults, modeChanged), true);

const unrelated = structuredClone(defaults);
unrelated.general.language = 'en';
assert.strictEqual(gestureRuntimeSettingsChanged(defaults, unrelated), false);

const main = fs.readFileSync('electron/main.js', 'utf8');
assert.match(main, /gestureRuntimeContract\(fabricSettings\)/,
  'each arm must snapshot one immutable gesture runtime contract');
assert.match(main, /gestureRuntimeSettingsChanged\(previousSettings,\s*parsed\.settings\)/,
  'settings save must detect gesture-contract changes');
assert.match(main, /cancelSelectionGesture\('settings_changed'\)/,
  'settings changes must terminate the previous input lease before the next wake');
assert.match(main, /gestureLineStyle:\s*arm\.runtime\.lineStyle/);
assert.match(main, /gestureLineWidth:\s*arm\.runtime\.lineWidthDip/);
assert.match(main, /gestureChainGapMs:\s*arm\.runtime\.chainGapMs/);
assert.match(main, /markSelectionGestureDrawing\(arm\.token,\s*\{[\s\S]*?timeoutMs:\s*arm\.runtime\.chainGapMs\s*\+\s*1000/,
  'the main-process lease must outlive the renderer multi-stroke inactivity timer');

console.log('gesture runtime settings test ok');
