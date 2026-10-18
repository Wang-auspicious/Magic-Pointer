import assert from 'node:assert/strict';

const {summarize} = require('../electron/renderer/desktop_perception');

const available = {
  paused: false,
  onboardingRequired: false,
  wakeMode: 'wiggle_hotkey',
  detectWiggle: true,
  detectMouseButton: false,
  polling: true,
  hotkeys: [{name: 'selection', accelerator: 'Alt+S', registered: true}],
};

assert.equal(summarize(null, 'en').state, 'unknown');
assert.equal(summarize(available, 'en').state, 'ready');
assert.equal(
  summarize({...available, polling: false, hotkeys: []}, 'en').state,
  'unavailable',
);
assert.equal(summarize({...available, paused: true}, 'en').state, 'paused');
assert.equal(
  summarize({...available, onboardingRequired: true}, 'en').state,
  'setup',
);
assert.equal(
  summarize({...available, detectWiggle: false}, 'en').wiggle,
  'Off',
);
assert.equal(
  summarize({...available, polling: false}, 'en').wiggle,
  'Not listening',
);
assert.equal(
  summarize({...available, pointerStateFresh: false, hotkeys: []}, 'en').state,
  'unavailable',
);
assert.equal(
  summarize({...available, pointerStateFresh: false}, 'en').wiggle,
  'Pointer input unavailable',
);
assert.equal(summarize(available, 'zh-CN').wiggle, '正在监听');
assert.equal(
  summarize(
    {
      ...available,
      hotkeys: [{name: 'selection', accelerator: 'Alt+S', registered: false}],
    },
    'en',
  ).hotkeys[0].ready,
  false,
);
console.log(
  'desktop perception: real availability, pause, setup and registration states passed',
);
