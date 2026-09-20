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
})().catch((error: Error) => { console.error(error); process.exitCode = 1; });
