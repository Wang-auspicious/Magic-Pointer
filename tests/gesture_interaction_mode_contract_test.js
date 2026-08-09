'use strict';

const assert = require('assert');
const fs = require('fs');
const { defaultSettings, validate } = require('../electron/settings_store');
const { gestureRuntimeContract } = require('../electron/gesture_runtime_settings');

// The default must stay on the mode that can actually draw. pass_through was
// briefly made the default and shipped broken: the hook swallows
// WM_LBUTTONDOWN, so GetAsyncKeyState never reports the press, so the poller
// never starts a stroke and every gesture expired after 5s without a line.
// Do not flip this default again without drawing a real stroke on a real
// machine first — no unit test in this repo can catch that failure.
const defaults = defaultSettings();
assert.strictEqual(
  defaults.activation.gesture_interaction_mode,
  'exclusive_overlay',
  'the default mode must be the one verified to draw end to end',
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

const main = fs.readFileSync('electron/main.js', 'utf8');
assert.match(main, /passThroughGestureCapture\.push/,
  'pass-through gesture capture entry point must remain available for the gesture path');

console.log('gesture_interaction_mode_contract_test: all assertions passed');
