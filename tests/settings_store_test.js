const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ElectronSettingsStore } = require('../electron/settings_store');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-pointer-settings-'));
const settingsPath = path.join(root, 'fabric-settings.json');
const store = new ElectronSettingsStore(settingsPath);

const defaults = store.load();
assert.strictEqual(defaults.schema_version, 1);
assert.strictEqual(defaults.activation.wiggle_enabled, true);
assert.strictEqual(defaults.activation.fallback_hotkey_enabled, true);
assert.strictEqual(defaults.interaction.default_input_mode, 'voice');
assert.strictEqual(defaults.interaction.voice_auto_submit, true);
assert(defaults.activation.disabled_apps.includes('blender'));

defaults.activation.sensitivity = 0.72;
defaults.activation.disabled_apps.push('原神');
defaults.interaction.default_input_mode = 'text';
store.save(defaults);
const loaded = store.load();
assert.strictEqual(loaded.activation.sensitivity, 0.72);
assert(loaded.activation.disabled_apps.includes('原神'));
assert.strictEqual(loaded.interaction.default_input_mode, 'text');

fs.writeFileSync(settingsPath, '{broken', 'utf8');
assert.throws(() => store.load(), /settings JSON is invalid/);
assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), '{broken');

console.log('settings store test ok');
