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

console.log('studio inspector state test ok');
