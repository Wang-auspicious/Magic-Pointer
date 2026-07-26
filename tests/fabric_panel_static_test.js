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
assert(main.includes("defaultInputMode: fabricSettings.interaction.default_input_mode"));
assert(main.includes("voiceAutoSubmit: fabricSettings.interaction.voice_auto_submit"));
assert(main.includes('const PANEL_RAIL_HEIGHT = 72'));
assert(main.includes('const PANEL_RAIL_MIN_WIDTH = 72'));

console.log('fabric panel static test ok');
