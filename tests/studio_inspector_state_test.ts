const assert = require('node:assert');
const {
  clampInspectorWidth,
  reduceInspectorState,
} = require('../electron/renderer/studio_inspector_state');

assert.strictEqual(clampInspectorWidth(300, 1200), 420);
assert.strictEqual(clampInspectorWidth(900, 1600), 760);
assert.strictEqual(clampInspectorWidth(700, 1000), 572, 'leave a 420px primary pane plus 8px gap');

let state = {
  open: false,
  maximized: false,
  width: 560,
  previousWidth: 560,
  tab: 'files',
};
state = reduceInspectorState(state, { type: 'open', tab: 'terminal' });
state = reduceInspectorState(state, { type: 'maximize' });
state = reduceInspectorState(state, { type: 'restore' });
assert.deepStrictEqual(state, {
  open: true,
  maximized: false,
  width: 560,
  previousWidth: 560,
  tab: 'terminal',
});
assert.strictEqual(reduceInspectorState(state, { type: 'close' }).open, false);

const narrowOpen = reduceInspectorState({
  open: false,
  maximized: false,
  width: 747,
  previousWidth: 747,
  tab: 'tasks',
}, { type: 'open', tab: 'tasks', availableWidth: 911 });
assert.strictEqual(narrowOpen.width, 483,
  'opening a persisted wide Inspector must leave the 420px primary pane intact');
assert.strictEqual(narrowOpen.previousWidth, 747,
  'temporary viewport clamping must preserve the user\'s preferred Inspector width');

const viewportClamped = reduceInspectorState({
  ...narrowOpen,
  width: 747,
}, { type: 'viewport', availableWidth: 911 });
assert.strictEqual(viewportClamped.width, 483);
assert.strictEqual(viewportClamped.previousWidth, 747);

const narrowRestore = reduceInspectorState({
  ...narrowOpen,
  maximized: true,
  width: 747,
}, { type: 'restore', availableWidth: 911 });
assert.strictEqual(narrowRestore.width, 483,
  'restoring from maximized must revalidate against the current viewport');
assert.strictEqual(narrowRestore.previousWidth, 747);

console.log('studio inspector state test ok');
