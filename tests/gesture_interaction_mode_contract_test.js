'use strict';

const assert = require('assert');
const fs = require('fs');
const { defaultSettings, validate } = require('../electron/settings_store');
const { gestureRuntimeContract } = require('../electron/gesture_runtime_settings');

const defaults = defaultSettings();
assert.strictEqual(
  defaults.activation.gesture_interaction_mode,
  'pass_through',
  'cross-app continuous selection requires the click-through hook path by default',
);
assert.strictEqual(
  gestureRuntimeContract(defaults).interactionMode,
  'pass_through',
);

const exclusive = defaultSettings();
exclusive.activation.gesture_interaction_mode = 'exclusive_overlay';
assert.strictEqual(validate(exclusive).activation.gesture_interaction_mode, 'exclusive_overlay');
assert.strictEqual(gestureRuntimeContract(exclusive).interactionMode, 'exclusive_overlay');

const invalid = defaultSettings();
invalid.activation.gesture_interaction_mode = 'steal_everything';
assert.throws(() => validate(invalid), /gesture_interaction_mode is unsupported/);

const dashboard = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
assert(dashboard.includes('id="gesture-interaction-mode"'));
assert.match(dashboard, /<option value="pass_through">/,
  'pass_through must be selectable now that the native hook path is live');
assert.match(dashboard, /<option value="exclusive_overlay">/,
  'the exclusive overlay must stay available as a compatibility fallback');

const main = fs.readFileSync('electron/main.js', 'utf8');
assert.match(main, /passThroughGestureCapture\.push/,
  'pass-through gesture capture entry point must remain available for the gesture path');

console.log('gesture_interaction_mode_contract_test: all assertions passed');
