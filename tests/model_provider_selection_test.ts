const assert = require('node:assert/strict');
const { selectActiveProfileModel, resolveActiveModelRuntimeConfig } = require('../electron/model_runtime_config');

const settings = { models: { defaultProfileId: 'first', profiles: [
  { id: 'first', enabled: true, provider: 'compatible-a', model: 'same-id', apiMode: 'messages', baseUrl: 'https://first.example', credentialRef: 'key-a' },
  { id: 'second', enabled: true, provider: 'compatible-b', model: 'same-id', apiMode: 'responses', baseUrl: 'https://second.example', credentialRef: 'key-b', models: [{ id: 'same-id', contextWindow: 1000000 }] },
] } };
const selected = selectActiveProfileModel(settings, 'same-id', 'second');
assert.equal(selected.models.defaultProfileId, 'second', 'same model id on a different provider must select that profile');
const runtime = resolveActiveModelRuntimeConfig(selected, { get: (ref: string) => ref });
assert.equal(runtime.baseUrl, 'https://second.example');
assert.equal(runtime.credential, 'key-b');
assert.equal(runtime.apiMode, 'responses');
assert.equal(settings.models.defaultProfileId, 'first');
assert.equal(selectActiveProfileModel(settings, 'same-id', 'missing'), null);
console.log('Provider-qualified model selection preserves endpoint, credential and protocol');

const { collectModelCatalog } = require('../electron/model_runtime_config');
void (async () => {
  const catalog = await collectModelCatalog(settings, { get: (ref: string) => ref }, async (runtime: any) => ({
    current: runtime.model, provider: runtime.provider, source: 'gateway', groups: [{
      id: runtime.provider, name: runtime.provider,
      models: [{ id: 'same-id', contextWindow: runtime.profileId === 'first' ? 128000 : 1000000 }],
    }],
  }));
  assert.equal(catalog.currentProfileId, 'first');
  assert.equal(catalog.groups.length, 2);
  assert.deepEqual(catalog.groups.map((group: any) => group.profileId), ['first', 'second']);
  assert.deepEqual(catalog.groups.map((group: any) => group.models[0].contextWindow), [128000, 1000000]);
  assert(!JSON.stringify(catalog).includes('key-a'), 'credentials never enter the renderer catalog');
  const partial = await collectModelCatalog(settings, null, async (runtime: any) => {
    if (runtime.profileId === 'second') throw new Error('offline');
    return { groups: [{ models: [{ id: 'same-id', contextWindow: 128000 }] }] };
  });
  assert.equal(partial.groups.length, 2, 'a failing provider must not erase other providers');
  assert.match(partial.groups[1].error, /offline/);
  console.log('Model catalog keeps provider identity, per-model metadata and partial failures');
  const {saveModelConnection, prepareModelConnection} = require('../electron/model_connection');
  let stored: any = {models: {schemaVersion: 1, defaultProfileId: null, profiles: []}};
  const secrets = new Map<string, string>();
  const stores = {
    settings: {load: () => structuredClone(stored), save: (next: any) => {stored = next;}},
    credentials: {
      get: (ref: string) => secrets.get(ref) || null,
      set: (ref: string, value: string) => secrets.set(ref, value),
      delete: (ref: string) => secrets.delete(ref),
    },
    readOpenCodeGo: () => 'local-go-key',
  };
  const input = {
    displayName: 'OpenCode Go', provider: 'opencode-go',
    baseUrl: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4.1-flash',
    apiMode: 'chat-completions', useLocalOpenCode: true, makeDefault: true,
  };
  const connected = saveModelConnection(input, stores);
  assert.equal(stored.models.defaultProfileId, connected.profile.id);
  assert.equal(secrets.get(connected.profile.credentialRef), 'local-go-key');
  assert(!JSON.stringify(connected).includes('local-go-key'));
  const edited = saveModelConnection({...input, profileId: connected.profile.id, useLocalOpenCode: false, model: 'mimo-v2.5'}, stores);
  assert.equal(edited.profile.id, connected.profile.id);
  assert.equal(stored.models.profiles.length, 1);
  assert.equal(prepareModelConnection({...input, profileId: connected.profile.id, useLocalOpenCode: false}, stores).config.credential, 'local-go-key');
  assert.throws(() => prepareModelConnection({...input, baseUrl: 'https://example.com/v1'}, stores), /OpenCode Go/);
  const before = structuredClone(stored);
  assert.throws(() => saveModelConnection({...input, profileId: connected.profile.id, credential: 'replacement', useLocalOpenCode: false}, {
    ...stores, settings: {...stores.settings, save() {throw new Error('disk full');}},
  }), /disk full/);
  assert.deepEqual(stored, before);
  assert.equal(secrets.get(connected.profile.credentialRef), 'local-go-key');
  console.log('Model connections save, edit, import and roll back without exposing credentials');
  const repaired = saveModelConnection({...input, profileId: connected.profile.id}, {
    ...stores,
    credentials: {...stores.credentials, get() {throw new Error('credential_decryption_failed');}},
  });
  assert.equal(secrets.get(repaired.profile.credentialRef), 'local-go-key', 'explicit replacement repairs an unreadable old key');
  const {listModels} = require('../electron/runtime/model');
  const goCatalog = await listModels({...input, models: [{id: input.model}]});
  assert.equal(goCatalog.provider, 'opencode-go', 'the Go endpoint must not be labeled as Zen');
})().catch((error: Error) => { console.error(error); process.exitCode = 1; });
