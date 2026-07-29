const assert = require('assert');
const fs = require('fs');
const { defaultSettings, validate } = require('../electron/settings_store');

const html = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
const dashboard = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');
const storeSource = fs.readFileSync('electron/settings_store.js', 'utf8');
const main = fs.readFileSync('electron/main.js', 'utf8');
const bridge = fs.readFileSync('scripts/local_voice_bridge.py', 'utf8');

const fields = [
  { id: 'voice-punctuation', key: 'voice_punctuation', defaultValue: 'verbatim', value: 'smart_zh', invalid: 'smart_en' },
  { id: 'voice-script', key: 'voice_script', defaultValue: 'unchanged', value: 'traditional', invalid: 'opencc' },
  { id: 'voice-mixed-spacing', key: 'voice_mixed_spacing', defaultValue: 'preserve', value: 'compact_cjk', invalid: 'wide' },
];

const configured = defaultSettings();
for (const field of fields) {
  assert.strictEqual(configured.interaction[field.key], field.defaultValue, `${field.key} default drifted`);
  configured.interaction[field.key] = field.value;

  assert(html.includes(`id="${field.id}"`), `Dashboard is missing ${field.id}`);
  assert(dashboard.includes(`setValue('${field.id}', interaction.${field.key} || '${field.defaultValue}')`),
    `Dashboard must render saved ${field.key}`);
  assert(dashboard.includes(`next.interaction.${field.key} = document.getElementById('${field.id}').value || '${field.defaultValue}'`),
    `Dashboard must collect ${field.key}`);
  assert(storeSource.includes(`interaction.${field.key} = String(interaction.${field.key} || '').trim().toLowerCase()`),
    `settings store must normalize ${field.key}`);
  assert(bridge.includes(`interaction.get("${field.key}")`), `voice bridge must read ${field.key}`);
}
const persisted = validate(configured).interaction;
assert.strictEqual(persisted.voice_punctuation, 'smart_zh');
assert.strictEqual(persisted.voice_script, 'traditional');
assert.strictEqual(persisted.voice_mixed_spacing, 'compact_cjk');

for (const field of fields) {
  const invalid = defaultSettings();
  invalid.interaction[field.key] = field.invalid;
  assert.throws(() => validate(invalid), new RegExp(field.key), `settings store must reject ${field.invalid}`);
}

assert(main.includes('MAGIC_POINTER_VOICE_SETTINGS_FILE: fabricSettingsStore?.path || \'\''),
  'main process must pass persisted settings path to the Python bridge');
assert(bridge.includes('punctuation=punctuation,'), 'bridge must pass punctuation into normalization');
assert(bridge.includes('script=script,'), 'bridge must pass script into normalization');
assert(bridge.includes('mixed_spacing=mixed_spacing,'), 'bridge must pass mixed spacing into normalization');

console.log('voice text settings static test ok');
