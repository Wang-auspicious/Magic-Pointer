'use strict';

type UnknownRecord = Record<string, any>;

type CredentialReader = {
  get(reference: string): string | null;
};

type CredentialStatusReader = {
  status(reference: string): { present?: boolean; available?: boolean };
};

const GROQ_PROFILE_ID = 'groq-main';
const GROQ_CREDENTIAL_REF = 'credential:model:groq-main';

function groqProfile(): UnknownRecord {
  return {
    schemaVersion: 1,
    id: GROQ_PROFILE_ID,
    displayName: 'Groq · GPT OSS 120B',
    provider: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    apiMode: 'chat-completions',
    credentialRef: GROQ_CREDENTIAL_REF,
    enabled: true,
    overrides: { visionInput: 'no', audioInput: 'no', toolCalls: 'auto' },
    resolved: {
      visionInput: 'no',
      audioInput: 'no',
      toolCalls: 'unknown',
      source: 'groq_production_catalog',
      evidence: 'Groq production text model; no image or audio file input.',
      checkedAt: '',
    },
  };
}

function upsertGroqProfile(settings: UnknownRecord): UnknownRecord {
  const currentModels = settings?.models && typeof settings.models === 'object'
    ? settings.models
    : {};
  const profiles = Array.isArray(currentModels.profiles)
    ? currentModels.profiles.filter((profile: UnknownRecord) => profile?.id !== GROQ_PROFILE_ID)
    : [];
  profiles.push(groqProfile());
  return {
    ...settings,
    models: {
      ...currentModels,
      schemaVersion: 1,
      defaultProfileId: GROQ_PROFILE_ID,
      profiles,
    },
  };
}

function activeProfile(settings: UnknownRecord | null): UnknownRecord | null {
  const models = settings?.models;
  const profiles: UnknownRecord[] = Array.isArray(models?.profiles) ? models.profiles : [];
  const defaultId = String(models?.defaultProfileId || '').trim().toLowerCase();
  return profiles.find((item) => String(item?.id || '').trim().toLowerCase() === defaultId)
    || profiles.find((item) => item?.enabled !== false)
    || null;
}

function activeModelRuntimeStatus(
  settings: UnknownRecord | null,
  credentialStore: CredentialStatusReader | null,
): UnknownRecord {
  const profile = activeProfile(settings);
  if (!profile || profile.enabled === false) {
    return {
      configured: false,
      profileId: null,
      displayName: null,
      provider: null,
      model: null,
      apiMode: null,
      credentialPresent: false,
      credentialBackendAvailable: false,
    };
  }
  const apiMode = String(profile.apiMode || '');
  const credentialRef = String(profile.credentialRef || '').trim();
  let credential = { present: apiMode === 'local', available: apiMode === 'local' };
  if (credentialRef && credentialStore) {
    try {
      const status = credentialStore.status(credentialRef);
      credential = { present: status.present === true, available: status.available === true };
    } catch (_) {
      credential = { present: false, available: false };
    }
  }
  return {
    configured: true,
    profileId: String(profile.id || '') || null,
    displayName: String(profile.displayName || '') || null,
    provider: String(profile.provider || '') || null,
    model: String(profile.model || '') || null,
    apiMode: apiMode || null,
    credentialPresent: credential.present,
    credentialBackendAvailable: credential.available,
  };
}

function resolveActiveModelRuntimeConfig(
  settings: UnknownRecord | null,
  credentialStore: CredentialReader | null,
): UnknownRecord | null {
  const profile = activeProfile(settings);
  if (!profile || profile.enabled === false) return null;
  const credentialRef = String(profile.credentialRef || '').trim();
  let credential: string | null = null;
  if (String(profile.apiMode || '') === 'local') credential = '';
  else if (credentialRef && credentialStore) {
    try {
      credential = credentialStore.get(credentialRef);
    } catch (_) {
      credential = null;
    }
  }
  return {
    profileId: String(profile.id || ''),
    provider: String(profile.provider || ''),
    baseUrl: String(profile.baseUrl || ''),
    model: String(profile.model || ''),
    apiMode: String(profile.apiMode || ''),
    credential,
  };
}

module.exports = {
  activeModelRuntimeStatus,
  GROQ_CREDENTIAL_REF,
  GROQ_PROFILE_ID,
  resolveActiveModelRuntimeConfig,
  upsertGroqProfile,
};
