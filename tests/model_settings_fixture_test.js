const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validate } = require('../electron/settings_store');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'model-profile-settings-v1.json'), 'utf8'));
const settings = validate(fixture);

assert.deepStrictEqual(settings.models, fixture.models);
assert.throws(
  () => validate({
    ...fixture,
    models: {
      ...fixture.models,
      profiles: [{ ...fixture.models.profiles[0], apiKey: 'sk-do-not-store' }],
    },
  }),
  /credential/i,
);
assert.throws(
  () => validate({
    ...fixture,
    models: {
      ...fixture.models,
      profiles: [{ ...fixture.models.profiles[0], openai_api_key: 'sk-do-not-store' }],
    },
  }),
  /credential/i,
);

console.log('model settings fixture test ok');
