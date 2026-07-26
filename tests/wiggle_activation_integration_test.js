const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');

assert(main.includes("const { WiggleDetector } = require('./wiggle_detector');"));
assert(main.includes("const { ElectronSettingsStore"));
assert(main.includes('wiggleDetector.push({'));
assert(main.includes("beginSelectionSession('wiggle')"));
assert(!main.includes("showOverlay('mouse-shake'"));
assert(!main.includes("const ENABLE_MOUSE_SHAKE = process.env.MAGIC_POINTER_ENABLE_MOUSE_SHAKE === '1';"));
assert(main.includes('activation.wiggle_enabled'));
assert(main.includes('persistCurrentObjectEpisode('));
assert(main.includes('current-object.json'));
assert(main.includes('const FABRIC_DATA_DIR'));
assert(main.includes('MAGIC_POINTER_USER_DATA_DIR: FABRIC_DATA_DIR'));
assert(main.includes('interactionEpisodes.bindPointedObject(episodeObjectForSession(attached))'));
assert(main.includes('slots: episode.slots'));

console.log('wiggle activation integration test ok');
