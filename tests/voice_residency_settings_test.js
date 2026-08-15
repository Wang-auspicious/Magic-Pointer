'use strict';

const assert = require('assert');
const { defaultSettings, validate } = require('../electron/settings_store');

const defaults = defaultSettings();

assert.strictEqual(defaults.interaction.voice_enabled, false);
assert.strictEqual(defaults.interaction.voice_resident_enabled, false);
assert.strictEqual(defaults.interaction.voice_memory_limit_mb, 1024);
assert.strictEqual(defaults.interaction.voice_idle_unload_ms, 0);

const configured = defaultSettings();
configured.interaction.voice_enabled = true;
configured.interaction.voice_resident_enabled = true;
configured.interaction.voice_memory_limit_mb = 2048;
configured.interaction.voice_idle_unload_ms = 60000;
const persisted = validate(configured).interaction;
assert.strictEqual(persisted.voice_enabled, true);
assert.strictEqual(persisted.voice_resident_enabled, true);
assert.strictEqual(persisted.voice_memory_limit_mb, 2048);
assert.strictEqual(persisted.voice_idle_unload_ms, 60000);

for (const [field, value] of [
  ['voice_memory_limit_mb', 127],
  ['voice_memory_limit_mb', 16385],
  ['voice_idle_unload_ms', -1],
  ['voice_idle_unload_ms', 3600001],
]) {
  const invalid = defaultSettings();
  invalid.interaction[field] = value;
  assert.throws(() => validate(invalid), new RegExp(field));
}

console.log('voice_residency_settings_test: all assertions passed');
