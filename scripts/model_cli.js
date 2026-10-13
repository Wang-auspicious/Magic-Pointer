'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const USER_DATA_DIR = path.resolve(
  process.env.MAGIC_POINTER_USER_DATA_DIR
  || path.join(ROOT, 'data', 'runtime'),
);
const SETTINGS_PATH = path.join(USER_DATA_DIR, 'fabric-settings.json');
const CREDENTIALS_PATH = path.join(USER_DATA_DIR, 'credentials.v1.json');
const COMMAND = String(process.argv[2] || 'status').trim().toLowerCase();

app.setPath('userData', process.env.MAGIC_POINTER_USER_DATA_DIR
  ? USER_DATA_DIR
  : path.join(app.getPath('appData'), 'magic-pointer'));

function builtModule(name) {
  const file = path.join(ROOT, 'build', 'electron', `${name}.js`);
  if (!fs.existsSync(file)) throw new Error(`build_missing:${name}`);
  return require(file);
}

async function stdinText() {
  let value = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) value += chunk;
  return value.trim();
}

function publicStatus(settings, credentialStore) {
  const profileId = String(settings?.models?.defaultProfileId || '');
  const profile = (settings?.models?.profiles || []).find((item) => item?.id === profileId) || null;
  const credential = profile?.credentialRef
    ? credentialStore.status(profile.credentialRef)
    : { present: false, available: safeStorage.isEncryptionAvailable() };
  return {
    ok: true,
    profileId: profile?.id || null,
    provider: profile?.provider || null,
    baseUrl: profile?.baseUrl || null,
    model: profile?.model || null,
    apiMode: profile?.apiMode || null,
    credentialPresent: credential.present === true,
    credentialBackendAvailable: credential.available === true,
  };
}

async function testProfile(settings, credentialStore) {
  const {resolveActiveModelRuntimeConfig} = builtModule('model_runtime_config');
  const {requestText} = builtModule('runtime/model');
  const {installEnvironmentProxy} = builtModule('runtime/proxy');
  const config = resolveActiveModelRuntimeConfig(settings, credentialStore);
  if (!config) return {ok: false, error: 'model_profile_not_found'};
  installEnvironmentProxy();
  const response = await requestText(config, {
    prompt: 'Reply with exactly OK.',
    maxTokens: 512,
    timeoutMs: 25_000,
    attempts: 1,
  });
  return {
    ok: true,
    profileId: config.profileId,
    provider: config.provider,
    model: config.model,
    apiMode: config.apiMode,
    usedBackend: response.usedBackend,
    latencyMs: response.latencyMs,
  };
}

async function main() {
  const { ElectronSettingsStore } = builtModule('settings_store');
  const { CredentialStore } = builtModule('credential_store');
  const { GROQ_CREDENTIAL_REF, upsertGroqProfile } = builtModule('model_runtime_config');
  const settingsStore = new ElectronSettingsStore(SETTINGS_PATH);
  const credentialStore = new CredentialStore(CREDENTIALS_PATH, safeStorage);

  if (COMMAND === 'configure-groq') {
    const credential = await stdinText();
    if (!credential) throw new Error('credential_empty');
    credentialStore.set(GROQ_CREDENTIAL_REF, credential);
    const settings = settingsStore.save(upsertGroqProfile(settingsStore.load()));
    const stored = settingsStore.load();
    return { ...publicStatus(stored, credentialStore), settingsPath: settings || SETTINGS_PATH };
  }
  const settings = settingsStore.load();
  if (COMMAND === 'status') return publicStatus(settings, credentialStore);
  if (COMMAND === 'test') return testProfile(settings, credentialStore);
  throw new Error(`unknown_command:${COMMAND}`);
}

app.whenReady().then(async () => {
  try {
    const result = await main();
    console.log(JSON.stringify(result));
    if (result?.ok !== true) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  } finally {
    app.exit(process.exitCode || 0);
  }
});
