'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const context = vm.createContext({ globalThis: {} });
for (const relativePath of [
  'electron/stage_state.js',
  'electron/stage_anchor.js',
  'electron/stage_chips_policy.js',
  'electron/stage_hit_policy.js',
  'electron/voice_trigger_policy.js',
]) {
  assert.doesNotThrow(
    () => vm.runInContext(fs.readFileSync(relativePath, 'utf8'), context, { filename: relativePath }),
    `${relativePath} must coexist with the other plain Stage scripts in one browser global scope`,
  );
}
assert(context.globalThis.StageState, 'StageState browser API must exist');
assert(context.globalThis.StageAnchor, 'StageAnchor browser API must exist');
assert(context.globalThis.StageChipsPolicy, 'StageChipsPolicy browser API must exist');
assert(context.globalThis.MagicPointerStageHitPolicy, 'Stage hit-test policy browser API must exist');
assert(context.globalThis.MagicPointerVoiceTrigger, 'voice trigger browser API must exist');

console.log('stage_browser_script_namespace_test: all assertions passed');
