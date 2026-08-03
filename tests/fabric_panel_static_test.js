const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/panel.html', 'utf8');
const css = fs.readFileSync('electron/renderer/panel.css', 'utf8');
const js = fs.readFileSync('electron/renderer/panel.js', 'utf8');
const main = fs.readFileSync('electron/main.js', 'utf8');

for (const id of ['inline-action-rail', 'voice-glyph', 'command', 'result']) {
  assert(html.includes(`id="${id}"`), id);
}

assert(!html.includes('suggestion-row'));
assert(!html.includes('panel-close'));
assert(!html.includes('dictation'));
assert(css.includes('.command-capsule'));
assert(!css.includes('.suggestion-chip'));
assert(!css.includes('.rail-icon-button'));
assert(!css.includes('Inter'));
assert(js.includes('defaultInputMode'));
assert(js.includes('voiceAutoSubmit'));
assert(js.includes('measureText'));
assert(main.includes('defaultInputMode: inputModeForReason('));
assert(main.includes("fabricSettings?.interaction?.default_input_mode === 'voice'"),
  'typing is the default; voice is the explicit opt-in');
assert(main.includes("voiceAutoSubmit: fabricSettings.interaction.voice_auto_submit"));
// The panel rail left the hot path with Task 5 (stage capsule replaces it);
// main.js no longer creates or positions the panel window.
assert(!main.includes('PANEL_RAIL_HEIGHT'));
assert(!main.includes('createPanelWindow'));

console.log('fabric panel static test ok');
