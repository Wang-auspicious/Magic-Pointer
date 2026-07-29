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

for (const voiceStartStrategy of ['push_to_talk', 'hover']) {
  assert.deepStrictEqual(pointerPollingPolicy({
    wakeMode: 'hotkey',
    wiggleEnabled: false,
    voicePointerConfigured: true,
    voiceStartStrategy,
  }), {
    shouldPoll: true,
    detectWiggle: false,
    detectMouseButton: false,
  }, `${voiceStartStrategy} must retain pointer input without silently enabling wiggle`);
}

assert.deepStrictEqual(pointerPollingPolicy({
  wakeMode: 'hotkey',
  wiggleEnabled: false,
  voicePointerConfigured: true,
  voiceStartStrategy: 'auto',
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
  voicePointerConfigured: true,
  voiceStartStrategy: 'push_to_talk',
}), {
  shouldPoll: true,
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

for (const blocked of [{ onboardingRequired: true }, { inputPaused: true }]) {
  assert.deepStrictEqual(pointerPollingPolicy({
    wakeMode: 'wiggle',
    wiggleEnabled: true,
    voicePointerConfigured: true,
    voiceStartStrategy: 'push_to_talk',
    ...blocked,
  }), {
    shouldPoll: false,
    detectWiggle: false,
    detectMouseButton: false,
  });
}

console.log('pointer polling policy test ok');
