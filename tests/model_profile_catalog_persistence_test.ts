import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { ElectronSettingsStore, defaultSettings } = require('../electron/settings_store');
const { resolveActiveModelRuntimeConfig } = require('../electron/model_runtime_config');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-profile-catalog-'));
const settingsPath = path.join(directory, 'fabric-settings.json');
const catalog = [{ id: 'local-audit', name: 'Audit', contextWindow: 8192, vision: false }];
const settings = defaultSettings();
settings.models = {
  schemaVersion: 1,
  defaultProfileId: 'local-audit',
  profiles: [{
    schemaVersion: 1, id: 'local-audit', displayName: 'Local', provider: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-audit', apiMode: 'local',
    credentialRef: '', enabled: true, models: catalog,
  }],
};
fs.writeFileSync(settingsPath, JSON.stringify(settings));
const store = new ElectronSettingsStore(settingsPath);
try {
  const loaded = store.load();
  assert.deepEqual(loaded.models.profiles[0].models, catalog);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).models.profiles[0].models, catalog);
  assert.deepEqual(resolveActiveModelRuntimeConfig(loaded, null).models, catalog);
  store.save(loaded);
  assert.deepEqual(store.load().models.profiles[0].models, catalog);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('model profile catalog persistence test ok');
