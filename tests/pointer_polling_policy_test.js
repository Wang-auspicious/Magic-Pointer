'use strict';

const assert = require('assert');
const { pointerPollingPolicy } = require('../electron/pointer_polling_policy');

assert.deepStrictEqual(pointerPollingPolicy({
  wakeMode: 'wiggle',
  wiggleEnabled: true,
}), {
  shouldPoll: true,
  detectWiggle: true,
  detectMouseButton: false,
});


assert.deepStrictEqual(pointerPollingPolicy({
  wakeMode: 'hotkey',
  wiggleEnabled: false,
}), {
  shouldPoll: false,
  detectWiggle: false,
  detectMouseButton: false,
});

assert.deepStrictEqual(pointerPollingPolicy({
  wakeMode: 'hotkey',
  mouseShakeOverride: '1',
}), {
  shouldPoll: true,
  detectWiggle: true,
  detectMouseButton: false,
});

assert.deepStrictEqual(pointerPollingPolicy({
  wakeMode: 'wiggle',
  wiggleEnabled: true,
  mouseShakeOverride: '0',
}), {
  shouldPoll: false,
  detectWiggle: false,
  detectMouseButton: false,
});

assert.deepStrictEqual(pointerPollingPolicy({
  wakeMode: 'mouse_button',
}), {
  shouldPoll: true,
  detectWiggle: false,
  detectMouseButton: true,
});

assert.deepStrictEqual(pointerPollingPolicy({
  wakeMode: 'wiggle_hotkey',
  wiggleEnabled: true,
  episodeActive: true,
  mouseSideButton: 'xbutton1',
}), {
  shouldPoll: true,
  detectWiggle: true,
  detectMouseButton: true,
}, 'an active cross-app episode must keep the configured side-button continuation available');

for (const blocked of [{ onboardingRequired: true }, { inputPaused: true }]) {
  assert.deepStrictEqual(pointerPollingPolicy({
    wakeMode: 'wiggle',
    wiggleEnabled: true,
    ...blocked,
  }), {
    shouldPoll: false,
    detectWiggle: false,
    detectMouseButton: false,
  });
}

console.log('pointer polling policy test ok');
