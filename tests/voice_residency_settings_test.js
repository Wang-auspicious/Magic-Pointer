'use strict';

const assert = require('assert');
const fs = require('fs');
const { defaultSettings, validate } = require('../electron/settings_store');

const html = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
const dashboard = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');
const defaults = defaultSettings();

assert.strictEqual(defaults.interaction.voice_resident_enabled, true);
assert.strictEqual(defaults.interaction.voice_memory_limit_mb, 1024);
assert.strictEqual(defaults.interaction.voice_idle_unload_ms, 0);
for (const id of ['voice-resident-enabled', 'voice-memory-limit-mb', 'voice-idle-unload-seconds']) {
  assert(html.includes(`id="${id}"`), `Dashboard missing ${id}`);
  assert(dashboard.includes(`'${id}'`), `Dashboard does not bind ${id}`);
}

const configured = defaultSettings();
configured.interaction.voice_resident_enabled = false;
configured.interaction.voice_memory_limit_mb = 2048;
configured.interaction.voice_idle_unload_ms = 60000;
const persisted = validate(configured).interaction;
assert.strictEqual(persisted.voice_resident_enabled, false);
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
