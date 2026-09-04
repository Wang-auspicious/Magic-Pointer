'use strict';

const assert = require('assert');
const {
  SETTINGS_PAGES,
  modelInfoValue,
  patchForSetting,
  valueForSetting,
} = require('../electron/renderer/settings_model');

assert.deepStrictEqual(SETTINGS_PAGES.map((page: any) => page.id), [
  'general', 'interaction', 'voice', 'models-agents',
  'skills', 'plugins', 'connectors',
  'perception-privacy', 'permissions', 'memory-context', 'storage', 'appearance-accessibility',
  'shortcuts', 'updates', 'diagnostics',
]);
assert.strictEqual(new Set(SETTINGS_PAGES.map((page: any) => page.id)).size, SETTINGS_PAGES.length);

const editable = SETTINGS_PAGES.flatMap((page: any) => page.sections)
  .flatMap((section: any) => section.rows)
  .filter((row: any) => row.control !== 'info');
assert(editable.length >= 30, 'the rebuilt settings surface must cover the real daily controls');
assert(editable.every((row: any) => row.path && !row.path.startsWith('_')),
  'every editable row must map to a real schema path');
for (const deadPath of [
  'notifications.completion',
  'notifications.failure',
  'privacy.anonymous_usage',
  'privacy.retain_audit_days',
  'agents.image_policy',
  'accessibility.reduce_motion',
  'accessibility.high_contrast_controls',
]) {
  assert(!editable.some((row: any) => row.path === deadPath),
    `${deadPath} has no live product behavior and must not appear as a setting`);
}
assert(SETTINGS_PAGES.some((page: any) => page.id === 'skills' && page.title === 'Skills'));
assert(SETTINGS_PAGES.some((page: any) => page.id === 'plugins' && page.title === 'Plugins'));
assert(SETTINGS_PAGES.some((page: any) => page.id === 'connectors' && page.title === 'MCP & connectors'));
assert(SETTINGS_PAGES.some((page: any) => page.id === 'diagnostics' && page.title === 'Diagnostics & about'));
const memoryRows = SETTINGS_PAGES.find((page: any) => page.id === 'memory-context')
  .sections.flatMap((section: any) => section.rows);
assert(memoryRows.some((row: any) => row.path === 'privacy.screen_memory_enabled'),
  'recent screen context must live in the dedicated memory page');
assert(memoryRows.some((row: any) => row.path === 'privacy.background_learning_enabled'),
  'background learning proposals must live in the dedicated memory page');
assert.deepStrictEqual([...new Set(SETTINGS_PAGES.map((page: any) => page.group))], ['Settings', 'Agent', 'Customize']);
assert.strictEqual(SETTINGS_PAGES.find((page: any) => page.id === 'models-agents').title, 'Models & runtime');
const modelRows = SETTINGS_PAGES.find((page: any) => page.id === 'models-agents')
  .sections.find((section: any) => section.title === 'Model').rows;
assert.deepStrictEqual(modelRows.map((row: any) => row.infoKey), [
  'active-model', 'credential', 'terminal',
]);
assert.strictEqual(modelInfoValue('active-model', {
  configured: true, displayName: 'Groq · GPT OSS 120B', provider: 'groq', model: 'openai/gpt-oss-120b',
}), 'Groq · GPT OSS 120B');
assert.strictEqual(modelInfoValue('credential', {
  configured: true, credentialPresent: false, credentialBackendAvailable: true,
}), 'Not configured');
assert.strictEqual(modelInfoValue('terminal', {}), 'npm run model:groq');
assert.strictEqual(modelInfoValue('runtime', {}), 'MPAgentRuntime');
assert.strictEqual(modelInfoValue('thinking', {}), 'Stored reasoning');
const externalClientSection = SETTINGS_PAGES.find((page: any) => page.id === 'models-agents')
  .sections.find((section: any) => section.title === 'External clients');
assert(externalClientSection.rows.some((row: any) => row.label === 'Preferred delivery client'));
assert(externalClientSection.rows.every((row: any) => !/Runtime route/i.test(row.description || '')),
  'external clients are prompt-delivery channels, never MP execution backends');

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
