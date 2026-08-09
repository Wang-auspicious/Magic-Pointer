const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.ts', 'utf8');
const pointerState = fs.readFileSync('scripts/pointer_input_state.ps1', 'utf8');

assert(main.includes("const { WiggleDetector } = require('./wiggle_detector');"));
assert(main.includes("const { MouseActivationDetector } = require('./mouse_activation');"));
assert(main.includes("const { ElectronSettingsStore"));
assert(main.includes('wiggleDetector.push({'));
assert(main.includes("requestActivation('wiggle')"));
assert(main.includes('mouseActivationDetector.push({'));
assert(main.includes("fabricSettings?.activation?.mouse_side_button || 'none'"));
assert(main.includes('requestActivation(mouseActivationReason)'));
assert(main.includes('pointerPolicy.detectMouseButton'),
  'mouse-button wake remains explicitly enabled by the shared polling policy');
assert(pointerState.includes('IsDown(5)'));
assert(pointerState.includes('$buttons -bor 8'));
assert(pointerState.includes('IsDown(6)'));
assert(pointerState.includes('$buttons -bor 16'));
assert(!main.includes("showOverlay('mouse-shake'"));
assert(!main.includes("const ENABLE_MOUSE_SHAKE = process.env.MAGIC_POINTER_ENABLE_MOUSE_SHAKE === '1';"));
assert(main.includes('applyConfiguredWakeState'));
assert(main.includes('activation?.wiggle_enabled'));
assert(main.includes('activation?.wake_mode'));
assert(main.includes('persistCurrentObjectEpisode('));
assert(main.includes('current-object.json'));
assert(main.includes('const FABRIC_DATA_DIR'));
assert(main.includes('MAGIC_POINTER_USER_DATA_DIR: FABRIC_DATA_DIR'));
assert(main.includes('interactionEpisodes.bindPointedObject(episodeObjectForSession(attached))'));
assert(main.includes('slots: episode.slots'));

console.log('wiggle activation integration test ok');
