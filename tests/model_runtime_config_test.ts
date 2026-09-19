const assert = require('assert');
const {
  activeModelRuntimeStatus,
  resolveActiveModelRuntimeConfig,
  selectActiveProfileModel,
  upsertGroqProfile,
  promoteLegacyProfile,
} = require('../electron/model_runtime_config');

const settings = {
  models: {
    schemaVersion: 1,
    defaultProfileId: 'groq-main',
    profiles: [{
      schemaVersion: 1,
      id: 'groq-main',
      displayName: 'Groq',
      provider: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'openai/gpt-oss-120b',
      apiMode: 'chat-completions',
      credentialRef: 'credential:model:groq-main',
      enabled: true,
      overrides: { audioInput: 'no', toolCalls: 'auto' },
      resolved: { audioInput: 'no', toolCalls: 'unknown' },
    }],
  },
};

const runtime = resolveActiveModelRuntimeConfig(settings, {
  get: (ref: string) => ref === 'credential:model:groq-main' ? 'decrypted-request-secret' : null,
});
assert.deepStrictEqual(runtime, {
  profileId: 'groq-main',
  provider: 'groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  model: 'openai/gpt-oss-120b',
  apiMode: 'chat-completions',
  credential: 'decrypted-request-secret',
  headers: {},
  defaultContextWindow: 262144,
  defaultMaxTokens: 32768,
  transport: 'auto',
  models: [],
});
assert.deepStrictEqual(activeModelRuntimeStatus(settings, {
  status: (ref: string) => ({
    ref,
    present: true,
    available: true,
    backend: 'electron.safeStorage',
  }),
}), {
  configured: true,
  profileId: 'groq-main',
  displayName: 'Groq',
  provider: 'groq',
  model: 'openai/gpt-oss-120b',
  apiMode: 'chat-completions',
  credentialPresent: true,
  credentialBackendAvailable: true,
});
assert.deepStrictEqual(activeModelRuntimeStatus({ models: { defaultProfileId: null, profiles: [] } }, null), {
  configured: false,
  profileId: null,
  displayName: null,
  provider: null,
  model: null,
  apiMode: null,
  credentialPresent: false,
  credentialBackendAvailable: false,
});

const updated = upsertGroqProfile({
  models: { schemaVersion: 1, defaultProfileId: null, profiles: [] },
});
assert.strictEqual(updated.models.defaultProfileId, 'groq-main');
assert.strictEqual(updated.models.profiles.length, 1);
assert.strictEqual(updated.models.profiles[0].baseUrl, 'https://api.groq.com/openai/v1');
assert.strictEqual(updated.models.profiles[0].model, 'openai/gpt-oss-120b');
assert.strictEqual(updated.models.profiles[0].credentialRef, 'credential:model:groq-main');

const selected = selectActiveProfileModel(settings, 'kimi-k3');
assert.strictEqual(selected.models.profiles[0].model, 'kimi-k3');
assert.strictEqual(selected.models.profiles[0].credentialRef, 'credential:model:groq-main');
assert.strictEqual(selected.models.defaultProfileId, 'groq-main');
assert.strictEqual(settings.models.profiles[0].model, 'openai/gpt-oss-120b');
assert.strictEqual(selectActiveProfileModel({ models: { profiles: [] } }, 'kimi-k3'), null);
assert.strictEqual(selectActiveProfileModel(settings, '   '), null);
const migrated = promoteLegacyProfile({ models: { schemaVersion: 1, defaultProfileId: null, profiles: [] } }, {
  provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', model: 'mimo-v2.5', apiMode: 'messages',
});
assert.strictEqual(migrated.models.defaultProfileId, 'legacy-default');
assert.strictEqual(migrated.models.profiles[0].credentialRef, 'credential:model:legacy-default');
assert.strictEqual(promoteLegacyProfile(migrated, { model: 'other' }), migrated);
const probedSettings = {
  models: {
    defaultProfileId: 'groq-main',
    profiles: [{ ...settings.models.profiles[0], resolved: {
      audioInput: 'no', toolCalls: 'yes', source: 'explicit_probe',
      evidence: 'probe for old model', checkedAt: '2026-09-12T00:00:00Z',
    } }],
  },
};
const reprobed = selectActiveProfileModel(probedSettings, 'new-model');
assert.deepStrictEqual(reprobed.models.profiles[0].resolved, {
  audioInput: 'unknown', toolCalls: 'unknown',
  source: 'unknown', evidence: '', checkedAt: '',
});

console.log('model runtime config test ok');
