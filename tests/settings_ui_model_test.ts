'use strict';

const assert = require('assert');
const {
  SETTINGS_PAGES,
  modelInfoValue,
  patchForSetting,
} = require('../electron/renderer/settings_model');

/* Claude Desktop settings-nav shape (static REA evidence,
 * docs/research/claude-settings-page-rea-20261024.md): grouped nav with
 * Customize / This computer headers and the section vocabulary
 * General, Appearance, Account, Privacy, Capabilities, Memory,
 * Connectors, Extensions(Plugins/Skills), Developer. Pages Claude has
 * but MP has no real data for (Billing, Usage, System prompt, Claude
 * Code, Cowork, Import, Claude in Chrome, System) are omitted rather
 * than invented. */
assert.deepStrictEqual(SETTINGS_PAGES.map((page: any) => page.id), [
  'general', 'appearance', 'account', 'privacy', 'capabilities',
  'memory', 'connectors', 'plugins', 'skills', 'developer',
]);
assert.strictEqual(new Set(SETTINGS_PAGES.map((page: any) => page.id)).size, SETTINGS_PAGES.length);
assert.deepStrictEqual([...new Set(SETTINGS_PAGES.map((page: any) => page.group))], [
  'Customize', 'This computer',
]);
const titles = Object.fromEntries(SETTINGS_PAGES.map((page: any) => [page.id, page.title]));
assert.deepStrictEqual(titles, {
  general: 'General',
  appearance: 'Appearance',
  account: 'Account',
  privacy: 'Privacy',
  capabilities: 'Capabilities',
  memory: 'Memory',
  connectors: 'Connectors',
  plugins: 'Plugins',
  skills: 'Skills',
  developer: 'Developer',
});

const rowsOf = (pageId: string) =>
  SETTINGS_PAGES.find((page: any) => page.id === pageId)
    .sections.flatMap((section: any) => section.rows);

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

const generalPaths = rowsOf('general').map((row: any) => row.path || row.infoKey);
for (const path of [
  'general.launch_at_login',
  'shortcuts.wake',
  'shortcuts.text_mode',
  'shortcuts.pause',
  'general.update_channel',
]) {
  assert(generalPaths.includes(path), `${path} must live on the General page`);
}
assert(rowsOf('general').some((row: any) => row.label === 'Run on startup'),
  'startup row keeps the reference wording "Run on startup"');
for (const path of [
  'privacy.default_capture_mode',
  'privacy.sensitive_apps',
  'stash.dir',
  'privacy.retain_captures_days',
]) {
  assert(rowsOf('privacy').some((row: any) => row.path === path),
    `${path} must live on the Privacy page`);
}
for (const path of [
  'permissions.default_read',
  'permissions.default_write',
  'permissions.default_send',
  'permissions.default_destructive',
  'permissions.default_purchase',
]) {
  assert(rowsOf('capabilities').some((row: any) => row.path === path),
    `${path} must live on the Capabilities page`);
}
const memoryRows = rowsOf('memory');
assert(memoryRows.some((row: any) => row.path === 'privacy.screen_memory_enabled'),
  'recent screen context must live in the dedicated memory page');
assert(memoryRows.some((row: any) => row.path === 'privacy.background_learning_enabled'),
  'background learning proposals must live in the dedicated memory page');
const modelRows = SETTINGS_PAGES.find((page: any) => page.id === 'account')
  .sections.find((section: any) => section.title === 'Model').rows;
assert.deepStrictEqual(modelRows.map((row: any) => row.infoKey), [
  'active-model', 'credential',
]);
assert.strictEqual(modelInfoValue('active-model', {
  configured: true, displayName: 'Groq · GPT OSS 120B', provider: 'groq', model: 'openai/gpt-oss-120b',
}), 'Groq · GPT OSS 120B');
assert.strictEqual(modelInfoValue('credential', {
  configured: true, credentialPresent: false, credentialBackendAvailable: true,
}), 'Not configured');
assert.strictEqual(modelInfoValue('runtime', {}), 'MPAgentRuntime');
assert.strictEqual(modelInfoValue('thinking', {}), 'Stored reasoning');
const externalClientSection = SETTINGS_PAGES.find((page: any) => page.id === 'account')
  .sections.find((section: any) => section.title === 'External clients');
assert(externalClientSection.rows.some((row: any) => row.label === 'Preferred delivery client'));
assert(externalClientSection.rows.every((row: any) => !/Runtime route/i.test(row.description || '')),
  'external clients are prompt-delivery channels, never MP execution backends');

assert.deepStrictEqual(patchForSetting('privacy.retain_captures_days', 7), {
  privacy: { retain_captures_days: 7 },
});

console.log('settings UI model test ok');
