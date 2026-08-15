'use strict';

const assert = require('assert');
const {
  SETTINGS_PAGES,
  patchForSetting,
  valueForSetting,
} = require('../electron/renderer/settings_model');

assert.deepStrictEqual(SETTINGS_PAGES.map((page: any) => page.id), [
  'general', 'interaction', 'voice', 'models-agents',
  'perception-privacy', 'permissions', 'storage', 'appearance-accessibility',
]);
assert.strictEqual(new Set(SETTINGS_PAGES.map((page: any) => page.id)).size, SETTINGS_PAGES.length);

const editable = SETTINGS_PAGES.flatMap((page: any) => page.sections)
  .flatMap((section: any) => section.rows)
  .filter((row: any) => row.control !== 'info');
assert(editable.length >= 30, 'the rebuilt settings surface must cover the real daily controls');
assert(editable.every((row: any) => row.path && !row.path.startsWith('_')),
  'every editable row must map to a real schema path');
assert(!SETTINGS_PAGES.some((page: any) => /能力|诊断/.test(page.title)),
  'capability catalogs and diagnostics are not settings');

assert.deepStrictEqual(patchForSetting('interaction.voice_enabled', false), {
  interaction: { voice_enabled: false, default_input_mode: 'text', voice_resident_enabled: false },
});
assert.deepStrictEqual(patchForSetting('interaction.default_input_mode', 'voice'), {
  interaction: { default_input_mode: 'voice', voice_enabled: true },
});
assert.deepStrictEqual(patchForSetting('privacy.retain_captures_days', 7), {
  privacy: { retain_captures_days: 7 },
});
assert.strictEqual(valueForSetting('interaction.default_input_mode', {
  interaction: { default_input_mode: 'text' },
}), 'text');

console.log('settings UI model test ok');
