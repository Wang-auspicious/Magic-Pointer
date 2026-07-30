'use strict';

const assert = require('assert');
const fs = require('fs');
const { defaultSettings, validate } = require('../electron/settings_store');
const { gestureRuntimeContract } = require('../electron/gesture_runtime_settings');

const defaults = defaultSettings();
assert.strictEqual(
  defaults.activation.gesture_interaction_mode,
  'exclusive_overlay',
  'wiggle must default to exclusive overlay for reliable drawing',
);
assert.strictEqual(
  gestureRuntimeContract(defaults).interactionMode,
  'exclusive_overlay',
);

const passThrough = defaultSettings();
passThrough.activation.gesture_interaction_mode = 'pass_through';
assert.strictEqual(validate(passThrough).activation.gesture_interaction_mode, 'pass_through');
assert.strictEqual(gestureRuntimeContract(passThrough).interactionMode, 'pass_through');

const invalid = defaultSettings();
invalid.activation.gesture_interaction_mode = 'steal_everything';
assert.throws(() => validate(invalid), /gesture_interaction_mode is unsupported/);

const dashboard = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
assert(dashboard.includes('id="gesture-interaction-mode"'));
assert.match(dashboard, /value="pass_through"\s+disabled/,
  'pass_through option must be disabled and marked 待开发');

const main = fs.readFileSync('electron/main.js', 'utf8');
assert.match(main, /passThroughGestureCapture\.push/,
  'pass-through gesture capture entry point must remain available for the gesture path');

console.log('gesture_interaction_mode_contract_test: all assertions passed');
