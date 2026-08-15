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

app.setPath('userData', USER_DATA_DIR);

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
  const profileId = String(settings?.models?.defaultProfileId || '');
  const profile = (settings?.models?.profiles || []).find((item) => item?.id === profileId) || null;
  if (!profile) return { ok: false, error: 'model_profile_not_found' };
  const credential = credentialStore.get(profile.credentialRef);
  if (!credential) return { ok: false, error: 'credential_missing', profileId };
  const response = await fetch(`${String(profile.baseUrl || '').replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${credential}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: profile.model,
      messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
      max_tokens: 8,
    }),
  });
  return {
    ok: response.ok,
    status: response.status,
    profileId,
    provider: profile.provider,
    model: profile.model,
    error: response.ok ? null : `runtime_http_${response.status}`,
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
