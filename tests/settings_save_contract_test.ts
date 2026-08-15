'use strict';

const assert = require('assert');
const fs = require('fs');
const { defaultSettings } = require('../electron/settings_store');
const { settingsSaveImpact } = require('../electron/settings_save_policy');

const base = defaultSettings();
const voice = structuredClone(base);
voice.interaction.voice_enabled = true;
voice.interaction.voice_resident_enabled = true;
assert.deepStrictEqual(settingsSaveImpact(base, voice), {
  voice: true, hotkeys: false, gesture: false, appearance: false, login: false, update: false, stash: false,
});

const hotkey = structuredClone(base);
hotkey.shortcuts.text_mode = 'Control+Shift+T';
assert.strictEqual(settingsSaveImpact(base, hotkey).hotkeys, true);
assert.strictEqual(settingsSaveImpact(base, hotkey).voice, false);

const gesture = structuredClone(base);
gesture.activation.sensitivity = 0.8;
assert.strictEqual(settingsSaveImpact(base, gesture).gesture, true);

const cosmetic = structuredClone(base);
cosmetic.appearance.theme = 'dark';
assert.strictEqual(settingsSaveImpact(base, cosmetic).appearance, true);
assert.strictEqual(settingsSaveImpact(base, cosmetic).voice, false);

const stash = structuredClone(base);
stash.stash.text = true;
assert.strictEqual(settingsSaveImpact(base, stash).stash, true,
  'clipboard collection changes must apply immediately, not after restart');

const preload = fs.readFileSync('electron/preload.ts', 'utf8');
const main = fs.readFileSync('electron/main.ts', 'utf8');
assert.match(preload, /saveFabricSettings:\s*\(settings:[^)]*\)\s*=>\s*ipcRenderer\.invoke\('dashboard:settings:save'/,
  'settings UI must await a canonical save result');
assert.match(main, /ipcMain\.handle\('dashboard:settings:save'/,
  'main must expose an acknowledged settings save handler');
assert.match(main, /modelStatus:\s*activeModelRuntimeStatus\(fabricSettings, credentialStore\)/,
  'settings hydration must include non-secret active model and credential status');
assert.match(main, /if \(impact\.stash\) reconfigureStashRuntime\(nextSettings\)/,
  'an acknowledged storage save must reconfigure the live stash runtime');

console.log('settings save contract test ok');
