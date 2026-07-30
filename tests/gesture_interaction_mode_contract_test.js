'use strict';

const assert = require('assert');
const fs = require('fs');
const { defaultSettings, validate } = require('../electron/settings_store');
const { gestureRuntimeContract } = require('../electron/gesture_runtime_settings');

const defaults = defaultSettings();
assert.strictEqual(
  defaults.activation.gesture_interaction_mode,
  'pass_through',
  'normal desktop mouse use must remain available by default',
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
const dashboardJs = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');
assert(dashboard.includes('id="gesture-interaction-mode"'));
assert.match(dashboardJs, /setValue\('gesture-interaction-mode'/);
assert.match(dashboardJs, /next\.activation\.gesture_interaction_mode/);

const main = fs.readFileSync('electron/main.js', 'utf8');
assert.match(
  main,
  /interactionMode\s*===\s*'pass_through'[\s\S]*?setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/,
  'pass-through drawing must keep the full-screen visual window click-through',
);
assert.match(main, /passThroughGestureCapture\.push/);

console.log('gesture_interaction_mode_contract_test: all assertions passed');
