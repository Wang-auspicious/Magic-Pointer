import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import type {ModelConfig} from './runtime/model';

export interface ModelConnectionInput {
  profileId?: string;
  displayName: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiMode: NonNullable<ModelConfig['apiMode']>;
  credential?: string;
  useLocalOpenCode?: boolean;
  makeDefault?: boolean;
}

export interface ModelConnectionResponse {
  ok: boolean;
  error?: string;
  profile?: ConnectedModelProfile;
  settings?: Record<string, unknown>;
  modelStatus?: Record<string, unknown>;
  latencyMs?: number;
  usedBackend?: string;
}

export interface ConnectedModelProfile {
  schemaVersion: number;
  id: string;
  displayName: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiMode: NonNullable<ModelConfig['apiMode']>;
  credentialRef: string;
  enabled: boolean;
  headers?: Record<string, string>;
  models?: Array<Record<string, unknown>>;
  overrides: Record<string, string>;
  resolved: Record<string, string>;
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
  transport?: string;
}

interface ConnectionSettings {
  models: {
    schemaVersion: number;
    defaultProfileId: string | null;
    profiles: ConnectedModelProfile[];
  };
  [key: string]: unknown;
}

interface ConnectionStores {
  settings: {
    load(): ConnectionSettings;
    save(settings: ConnectionSettings): unknown;
  };
  credentials: {
    get(ref: string): string | null;
    set(ref: string, value: string): unknown;
    delete(ref: string): unknown;
  };
  readOpenCodeGo?: () => string;
}

export function readLocalOpenCodeGoCredential(): string {
  const dataHome =
    process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
  try {
    const auth = JSON.parse(
      readFileSync(path.join(dataHome, 'opencode', 'auth.json'), 'utf8'),
    );
    const entry = auth?.['opencode-go'];
    if (
      entry?.type === 'api' &&
      typeof entry.key === 'string' &&
      entry.key.trim()
    ) {
      return entry.key.trim();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        'The local OpenCode account could not be read. Enter its API key instead.',
      );
    }
  }
  throw new Error(
    'No local OpenCode Go account was found. Enter your OpenCode Go API key.',
  );
}

export function prepareModelConnection(
  input: ModelConnectionInput,
  stores: ConnectionStores,
) {
  const settings = stores.settings.load();
  const previous = input.profileId
    ? settings.models.profiles.find(profile => profile.id === input.profileId)
    : undefined;
  if (input.profileId && !previous) {
    throw new Error('This model connection no longer exists.');
  }
  const displayName = String(input.displayName || '').trim();
  const model = String(input.model || '').trim();
  const provider = String(input.provider || '')
    .trim()
    .toLowerCase();
  if (!displayName || !model || model.length > 120 || /[\r\n\\]/.test(model)) {
    throw new Error('Enter a connection name and a valid model ID.');
  }
  if (!/^[a-z][a-z0-9._-]*$/.test(provider)) {
    throw new Error('Enter a valid provider name.');
  }
  if (
    !['chat-completions', 'messages', 'responses', 'local'].includes(
      input.apiMode,
    )
  ) {
    throw new Error('Choose a supported API protocol.');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(String(input.baseUrl || '').trim());
  } catch {
    throw new Error('Enter the provider API base URL.');
  }
  if (
    !['https:', 'http:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      'Use an HTTP or HTTPS API base URL without credentials, query or fragment.',
    );
  }
  const baseUrl = endpoint.href.replace(/\/+$/, '');
  const local = input.apiMode === 'local';
  const id = previous?.id || `model-${randomUUID()}`;
  const replacingCredential =
    input.useLocalOpenCode || Boolean(input.credential?.trim());
  const credentialRef = local
    ? ''
    : !replacingCredential && previous?.credentialRef
      ? previous.credentialRef
      : `credential:model:${id}:${randomUUID()}`;
  let credential = String(input.credential || '').trim();
  if (input.useLocalOpenCode) {
    if (
      endpoint.hostname !== 'opencode.ai' ||
      !/^\/zen\/go\/v1\/?$/.test(endpoint.pathname)
    ) {
      throw new Error(
        'The local OpenCode Go account can only connect to the OpenCode Go endpoint.',
      );
    }
    credential = (stores.readOpenCodeGo || readLocalOpenCodeGoCredential)();
  }
  if (
    !local &&
    !credential &&
    previous?.baseUrl.replace(/\/+$/, '') === baseUrl
  ) {
    credential = stores.credentials.get(credentialRef) || '';
  }
  if (!local && !credential) {
    throw new Error(
      'Enter an API key, or import your local OpenCode Go account.',
    );
  }
  const sameRoute =
    previous?.baseUrl === baseUrl && previous.apiMode === input.apiMode;
  const profile: ConnectedModelProfile = {
    ...(previous || {}),
    schemaVersion: 1,
    id,
    displayName,
    provider,
    baseUrl,
    model,
    apiMode: input.apiMode,
    credentialRef,
    enabled: true,
    headers: sameRoute ? previous.headers || {} : {},
    models: sameRoute ? previous.models || [] : [],
    overrides: previous?.overrides || {audioInput: 'auto', toolCalls: 'auto'},
    resolved: {
      audioInput: 'unknown',
      toolCalls: 'unknown',
      source: 'unknown',
      evidence: '',
      checkedAt: '',
    },
  };
  const config: ModelConfig = {...profile, credential: local ? '' : credential};
  return {settings, profile, config, previous};
}

export function saveModelConnection(
  input: ModelConnectionInput,
  stores: ConnectionStores,
) {
  const {settings, profile, config, previous} = prepareModelConnection(
    input,
    stores,
  );
  const ref = profile.credentialRef;
  const newCredential = Boolean(ref && ref !== previous?.credentialRef);
  if (newCredential) {
    stores.credentials.set(ref, config.credential || '');
  }
  try {
    stores.settings.save({
      ...settings,
      models: {
        ...settings.models,
        defaultProfileId:
          input.makeDefault || !settings.models.defaultProfileId
            ? profile.id
            : settings.models.defaultProfileId,
        profiles: [
          ...settings.models.profiles.filter(item => item.id !== profile.id),
          profile,
        ],
      },
    });
  } catch (error) {
    if (newCredential) {
      stores.credentials.delete(ref);
    }
    throw error;
  }
  const oldRef = previous?.credentialRef;
  if (
    oldRef &&
    oldRef !== ref &&
    !settings.models.profiles.some(
      item => item.id !== profile.id && item.credentialRef === oldRef,
    )
  ) {
    try {
      stores.credentials.delete(oldRef);
    } catch {
      // The saved connection already points to its new credential.
    }
  }
  return {profile, settings: stores.settings.load()};
}
