const assert = require('assert');
const {
  activeModelRuntimeStatus,
  resolveActiveModelRuntimeConfig,
  upsertGroqProfile,
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
      overrides: { visionInput: 'no', audioInput: 'no', toolCalls: 'auto' },
      resolved: { visionInput: 'no', audioInput: 'no', toolCalls: 'unknown' },
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

console.log('model runtime config test ok');
