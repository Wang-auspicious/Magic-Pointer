const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
const js = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');
const css = fs.readFileSync('electron/renderer/dashboard.css', 'utf8');

for (const id of [
  'model-list', 'model-id', 'model-display-name', 'model-provider', 'model-base-url',
  'model-name', 'model-api-mode', 'model-vision-override', 'model-credential-value',
  'model-save', 'model-credential-save', 'model-test', 'model-set-default', 'model-delete', 'model-status',
]) assert(html.includes(`id="${id}"`), id);
assert(html.includes('type="password"'));
assert(js.includes("fabricRequest('models.list')"));
assert(js.includes("fabricRequest('models.save', { profile })"));
assert(js.includes("fabricRequest('models.credentials.set', { profileId, credentialValue })"));
assert(js.includes("fabricRequest('models.test', { profileId })"));
assert(html.includes('测试连接与视觉'));
assert(js.includes("profile.resolved?.checkedAt"));
assert(js.includes('modelCapabilityEvidence'));
assert(js.includes("explicit_probe: '显式测试'"));
assert(js.includes("applyModelToForm(models.find((profile) => profile.id === defaultModelProfileId) || models[0])"));
assert(js.includes("fabricRequest('models.set_default', { profileId })"));
assert(js.includes("fabricRequest('models.delete', { profileId })"));
assert(js.includes("credentialRef: `credential:model:${id}`"));
assert(js.includes("setValue('model-credential-value', '')"));
assert(css.includes('.model-form-grid'));
assert(css.includes('.model-row'));
assert(css.includes('.model-capability.is-yes'));
assert(!css.includes('.model-capability {\n  display: none;'));

console.log('dashboard model profiles static test ok');
