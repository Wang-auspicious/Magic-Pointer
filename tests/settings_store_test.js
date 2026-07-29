const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ElectronSettingsStore, defaultSettings, validate } = require('../electron/settings_store');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-pointer-settings-'));
const settingsPath = path.join(root, 'fabric-settings.json');
const store = new ElectronSettingsStore(settingsPath);

const defaults = store.load();
assert.strictEqual(defaults.schema_version, 1);
assert.strictEqual(defaults.activation.wiggle_enabled, true);
assert.strictEqual(defaults.activation.fallback_hotkey_enabled, true);
assert.strictEqual(defaults.interaction.default_input_mode, 'voice');
assert.strictEqual(defaults.interaction.voice_auto_submit, true);
assert.strictEqual(defaults.interaction.voice_language, 'auto');
assert.strictEqual(defaults.interaction.voice_output_mode, 'verbatim');
assert.strictEqual(defaults.interaction.voice_hallucination_guard, true);
assert.deepStrictEqual(defaults.interaction.voice_glossaries, {});
assert(defaults.activation.disabled_apps.includes('blender'));
assert.strictEqual(defaults.privacy.default_capture_mode, 'follow_global');
assert.deepStrictEqual(defaults.privacy.app_capture_modes, {});
assert.strictEqual(defaults.privacy.retain_artifacts_days, 30);
assert.deepStrictEqual(defaults.permissions.scoped_grants, []);
assert.strictEqual(defaults.connections.browser_devtools_enabled, true);
assert.deepStrictEqual(defaults.connections.browser_devtools_endpoints, ['http://127.0.0.1:9222']);
assert.strictEqual(defaults.appearance.gesture_line_style, 'demo6_band');
assert.strictEqual(defaults.appearance.gesture_line_width_dip, 22);

defaults.activation.sensitivity = 0.72;
defaults.activation.disabled_apps.push('原神');
defaults.interaction.default_input_mode = 'text';
defaults.interaction.voice_language = 'zh';
defaults.interaction.voice_output_mode = 'clean_spacing';
defaults.interaction.voice_resident_enabled = false;
defaults.interaction.voice_memory_limit_mb = 2048;
defaults.interaction.voice_idle_unload_ms = 60000;
defaults.interaction.voice_glossaries = {
  '*': ['Magic Pointer', 'Context Packet', 'Magic Pointer'],
  'D:\\work\\repo': ['TargetLease'],
};
defaults.privacy.default_capture_mode = 'local_ocr';
defaults.privacy.app_capture_modes = { '1password': 'deny', edge: 'local_screenshot' };
defaults.permissions.scoped_grants = [{
  decision: 'allow',
  recipe: 'agent.handoff',
  app: 'code.exe',
  project: 'D:\\work\\magic-pointer',
  risk: 'external_send',
  expires_at: '',
}];
defaults.connections.browser_devtools_endpoints = ['http://localhost:9333'];
store.save(defaults);
const loaded = store.load();
assert.strictEqual(loaded.activation.sensitivity, 0.72);
assert(loaded.activation.disabled_apps.includes('原神'));
assert.strictEqual(loaded.interaction.default_input_mode, 'text');
assert.strictEqual(loaded.interaction.voice_language, 'zh');
assert.strictEqual(loaded.interaction.voice_output_mode, 'clean_spacing');
assert.strictEqual(loaded.interaction.voice_resident_enabled, false);
assert.strictEqual(loaded.interaction.voice_memory_limit_mb, 2048);
assert.strictEqual(loaded.interaction.voice_idle_unload_ms, 60000);
assert.deepStrictEqual(loaded.interaction.voice_glossaries['*'], ['Magic Pointer', 'Context Packet']);
assert.strictEqual(loaded.privacy.default_capture_mode, 'local_ocr');
assert.deepStrictEqual(loaded.privacy.app_capture_modes, { '1password': 'deny', edge: 'local_screenshot' });
assert.strictEqual(loaded.permissions.scoped_grants[0].project, 'D:\\work\\magic-pointer');
assert.deepStrictEqual(loaded.connections.browser_devtools_endpoints, ['http://localhost:9333']);

const remoteDevTools = defaultSettings();
remoteDevTools.connections.browser_devtools_endpoints = ['https://remote.example.test:9222'];
assert.throws(() => validate(remoteDevTools), /loopback/);

const badMode = defaultSettings();
badMode.privacy.default_capture_mode = 'send_everything';
assert.throws(() => validate(badMode), /capture mode/);

const badRules = defaultSettings();
badRules.privacy.app_capture_modes = ['edge=upload_screenshot'];
assert.throws(() => validate(badRules), /app_capture_modes/);

const badPermissionScope = defaultSettings();
badPermissionScope.permissions.scoped_grants = [{ decision: 'always', recipe: 'agent.handoff' }];
assert.throws(() => validate(badPermissionScope), /scoped permission/);

const badVoiceMode = defaultSettings();
badVoiceMode.interaction.voice_output_mode = 'rewrite_everything';
assert.throws(() => validate(badVoiceMode), /voice_output_mode/);

const duplicateShortcut = defaultSettings();
duplicateShortcut.shortcuts.text_mode = duplicateShortcut.shortcuts.wake;
assert.throws(() => validate(duplicateShortcut), /duplicate shortcut/);

const reservedShortcut = defaultSettings();
reservedShortcut.shortcuts.pause = 'Control+Alt+D';
assert.throws(() => validate(reservedShortcut), /reserved shortcut/);

const modifierOnlyShortcut = defaultSettings();
modifierOnlyShortcut.shortcuts.pause = 'Control+Alt';
assert.throws(() => validate(modifierOnlyShortcut), /shortcut pause is invalid/);

const unboundMouseWake = defaultSettings();
unboundMouseWake.activation.wake_mode = 'mouse_button';
unboundMouseWake.activation.mouse_side_button = 'none';
assert.throws(() => validate(unboundMouseWake), /mouse_side_button must be bound/);

const legacy = defaultSettings();
delete legacy.activation.wake_mode;
delete legacy.shortcuts;
legacy.activation.wiggle_enabled = false;
legacy.activation.fallback_hotkey_enabled = true;
legacy.activation.fallback_hotkey = 'Control+Shift+Space';
const migratedLegacy = validate(legacy);
assert.strictEqual(migratedLegacy.activation.wake_mode, 'hotkey');
assert.strictEqual(migratedLegacy.activation.wiggle_enabled, false);
assert.strictEqual(migratedLegacy.shortcuts.wake, 'Control+Shift+Space');

const legacyGestureAppearance = defaultSettings();
delete legacyGestureAppearance.appearance.gesture_line_style;
legacyGestureAppearance.appearance.gesture_line_width_dip = 8;
const migratedGestureAppearance = validate(legacyGestureAppearance);
assert.strictEqual(migratedGestureAppearance.appearance.gesture_line_style, 'demo6_band');
assert.strictEqual(migratedGestureAppearance.appearance.gesture_line_width_dip, 22);

const legacyDiskPath = path.join(root, 'legacy-fabric-settings.json');
fs.writeFileSync(legacyDiskPath, `${JSON.stringify({
  schema_version: 1,
  activation: {
    wiggle_enabled: true,
    sensitivity: 0.55,
    fallback_hotkey_enabled: true,
    fallback_hotkey: 'Control+Alt+M',
    disabled_apps: [],
    cooldown_ms: 1100,
  },
  interaction: {
    default_input_mode: 'voice',
    voice_auto_submit: true,
    voice_silence_ms: 1600,
  },
}, null, 2)}\n`, 'utf8');
const legacyDiskStore = new ElectronSettingsStore(legacyDiskPath);
const normalizedLegacyDisk = legacyDiskStore.load();
assert.strictEqual(normalizedLegacyDisk.appearance.gesture_line_style, 'demo6_band');
assert.strictEqual(normalizedLegacyDisk.appearance.gesture_line_width_dip, 22);
const persistedLegacyDisk = JSON.parse(fs.readFileSync(legacyDiskPath, 'utf8'));
assert.strictEqual(persistedLegacyDisk.appearance.gesture_line_style, 'demo6_band',
  'load must persist the canonical visual contract instead of leaving stale disk truth');
assert.strictEqual(persistedLegacyDisk.appearance.gesture_line_width_dip, 22,
  'load must persist the canonical default band width');
assert.strictEqual(persistedLegacyDisk.activation.wake_mode, 'wiggle_hotkey',
  'load must persist migrated activation settings');

fs.writeFileSync(settingsPath, '{broken', 'utf8');
assert.throws(() => store.load(), /settings JSON is invalid/);
assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), '{broken');

console.log('settings store test ok');
