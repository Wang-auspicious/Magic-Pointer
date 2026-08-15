'use strict';

const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const source = fs.readFileSync('electron/renderer/settings.ts', 'utf8');
const css = fs.readFileSync('electron/renderer/studio.css', 'utf8');

assert(html.includes('settings_model.js'), 'Studio must load the canonical settings model');
assert(html.includes('id="settings-save-status"'), 'settings must have a visible save status live region');
assert(source.includes('SettingsModel'), 'renderer must consume the canonical settings model');
assert(!source.includes('const KEYMAP'), 'renderer-local key translation table must be removed');
assert.match(source, /await api\.saveFabricSettings\(patch\)/,
  'control state may settle only after the main process acknowledges the save');
assert(source.includes("dataset.saveState = 'saving'"));
assert(source.includes("dataset.saveState = 'error'"));
assert(source.includes('hydrateCanonical(response.settings)'));
assert(css.includes('.settings-save-status'));
assert(css.includes("[data-save-state='error']"));

console.log('settings surface contract test ok');
