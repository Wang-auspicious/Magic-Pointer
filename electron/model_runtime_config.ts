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
const LEGACY_PROFILE_ID = 'legacy-default';
const LEGACY_CREDENTIAL_REF = 'credential:model:legacy-default';

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
    overrides: { audioInput: 'no', toolCalls: 'auto' },
    resolved: {
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
    headers: profile.headers && typeof profile.headers === 'object' ? profile.headers : {},
    defaultContextWindow: Number(profile.defaultContextWindow || 262144),
    defaultMaxTokens: Number(profile.defaultMaxTokens || 32768),
    transport: String(profile.transport || 'auto'),
    models: Array.isArray(profile.models) ? profile.models : [],
  };
}

function promoteLegacyProfile(settings: UnknownRecord, legacy: UnknownRecord): UnknownRecord {
  const currentModels = settings?.models && typeof settings.models === 'object' ? settings.models : {};
  const profiles = Array.isArray(currentModels.profiles) ? currentModels.profiles : [];
  if (profiles.length || !String(legacy.model || '').trim()) return settings;
  const mode = String(legacy.apiMode || 'chat-completions').trim().toLowerCase();
  const profile = {
    schemaVersion: 1,
    id: LEGACY_PROFILE_ID,
    displayName: `Legacy · ${String(legacy.model).trim()}`,
    provider: String(legacy.provider || 'openai').trim().toLowerCase() || 'openai',
    baseUrl: String(legacy.baseUrl || '').trim(),
    model: String(legacy.model).trim(),
    apiMode: mode,
    credentialRef: mode === 'local' ? '' : LEGACY_CREDENTIAL_REF,
    enabled: true,
    headers: {},
    defaultContextWindow: 262144,
    defaultMaxTokens: 32768,
    transport: 'auto',
    overrides: { audioInput: 'auto', toolCalls: 'auto' },
    resolved: { audioInput: 'unknown', toolCalls: 'unknown', source: 'legacy_migration', evidence: '', checkedAt: '' },
  };
  return { ...settings, models: { ...currentModels, schemaVersion: 1, defaultProfileId: LEGACY_PROFILE_ID, profiles: [profile] } };
}

function selectActiveProfileModel(settings: UnknownRecord | null, model: unknown, requestedProfileId?: unknown): UnknownRecord | null {
  const name = String(model || '').trim();
  if (!name) return null;
  const models = settings?.models;
  const profiles: UnknownRecord[] = Array.isArray(models?.profiles) ? models.profiles : [];
  const requested = String(requestedProfileId || '').trim().toLowerCase();
  const profile = requested
    ? profiles.find(item => String(item.id || '').trim().toLowerCase() === requested)
    : activeProfile(settings);
  if (!profile || profile.enabled === false) return null;
  const profileId = String(profile.id || '').trim().toLowerCase();
  const nextProfiles = profiles.map((item) => (
    String(item?.id || '').trim().toLowerCase() === profileId
      ? {
          ...item,
          model: name,
          ...(String(item?.model || '').trim() !== name
            && String(item?.resolved?.source || '').trim().toLowerCase() === 'explicit_probe'
            ? {
                resolved: {
                  audioInput: 'unknown',
                  toolCalls: 'unknown',
                  source: 'unknown',
                  evidence: '',
                  checkedAt: '',
                },
              }
            : {}),
        }
      : item
  ));
  return {
    ...(settings || {}),
    models: {
      ...(models || {}),
      defaultProfileId: profile.id,
      profiles: nextProfiles,
    },
  };
}

async function collectModelCatalog(
  settings: UnknownRecord | null,
  credentialStore: CredentialReader | null,
  query: (runtime: UnknownRecord | null) => Promise<UnknownRecord>,
): Promise<UnknownRecord> {
  const profiles: UnknownRecord[] = (settings?.models?.profiles || []).filter((item: UnknownRecord) => item.enabled !== false);
  if (!profiles.length) return query(null);
  const active = activeProfile(settings);
  const catalogs = await Promise.all(profiles.map(async profile => {
    const runtime = resolveActiveModelRuntimeConfig({ ...settings, models: { ...settings?.models, defaultProfileId: profile.id } }, credentialStore);
    let catalog: UnknownRecord;
    try {
      catalog = await query(runtime);
    } catch (error) {
      catalog = { source: 'config', error: error instanceof Error ? error.message : String(error),
        groups: [{ models: [{ id: profile.model }] }] };
    }
    return { profile, catalog };
  }));
  return {
    current: active?.model || '', currentProfileId: active?.id || '',
    provider: active?.provider || '', source: 'profiles',
    groups: catalogs.flatMap(({ profile, catalog }) => (catalog.groups || []).map((group: UnknownRecord) => ({
      id: `${profile.id}:${group.id || 'models'}`, profileId: profile.id,
      name: profile.displayName || profile.provider || profile.id,
      provider: catalog.provider || profile.provider || profile.id,
      source: catalog.source, error: catalog.error || '',
      models: (group.models || []).map((entry: UnknownRecord) => ({ ...entry, profileId: profile.id })),
    }))),
  };
}

module.exports = {
  collectModelCatalog,
  activeModelRuntimeStatus,
  GROQ_CREDENTIAL_REF,
  GROQ_PROFILE_ID,
  LEGACY_PROFILE_ID,
  LEGACY_CREDENTIAL_REF,
  promoteLegacyProfile,
  resolveActiveModelRuntimeConfig,
  selectActiveProfileModel,
  upsertGroqProfile,
};
