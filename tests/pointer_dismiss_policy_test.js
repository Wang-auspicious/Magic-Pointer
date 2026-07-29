'use strict';

const assert = require('assert');
const { shouldDismissFromGlobalPointer } = require('../electron/pointer_dismiss_policy');

const base = {
  currentButtons: 2,
  previousButtons: 0,
  hasVisibleTemporarySurface: true,
};

assert.strictEqual(
  shouldDismissFromGlobalPointer({ ...base, interactiveOverlayOwnsPointer: true }),
  false,
  'the global polling stream must not race the interactive drawing overlay',
);
assert.strictEqual(
  shouldDismissFromGlobalPointer({ ...base, interactiveOverlayOwnsPointer: false }),
  true,
  'passive/click-through temporary surfaces still need a global right-click escape',
);
assert.strictEqual(
  shouldDismissFromGlobalPointer({
    ...base,
    previousButtons: 2,
    interactiveOverlayOwnsPointer: false,
  }),
  false,
  'holding right-click must dismiss only once',
);
assert.strictEqual(
  shouldDismissFromGlobalPointer({
    ...base,
    hasVisibleTemporarySurface: false,
    interactiveOverlayOwnsPointer: false,
  }),
  false,
  'global pointer input cannot dismiss a surface that is not visible',
);
assert.strictEqual(
  shouldDismissFromGlobalPointer({
    ...base,
    currentButtons: 1,
    interactiveOverlayOwnsPointer: false,
  }),
  false,
  'left-button drawing is never a dismiss gesture',
);

console.log('pointer dismiss policy test ok');
