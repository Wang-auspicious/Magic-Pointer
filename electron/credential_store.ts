import type { PathLike } from 'node:fs';

const fs = require('fs');
const path = require('path');

class CredentialStoreError extends Error {}

type CryptoStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

type CredentialData = {
  schemaVersion: 1;
  entries: Record<string, string>;
};

function validRef(value: unknown): boolean {
  return /^[a-z][a-z0-9:._-]{2,160}$/i.test(String(value || '').trim());
}

class CredentialStore {
  path: string;
  cryptoStorage: CryptoStorage;

  constructor(credentialsPath: PathLike, cryptoStorage: CryptoStorage) {
    this.path = path.resolve(credentialsPath);
    this.cryptoStorage = cryptoStorage;
  }

  _available(): boolean {
    return Boolean(this.cryptoStorage && this.cryptoStorage.isEncryptionAvailable());
  }

  _ref(ref: unknown): string {
    const clean = String(ref || '').trim();
    if (!validRef(clean)) throw new CredentialStoreError('credential_ref_invalid');
    return clean;
  }

  _load(): CredentialData {
    if (!fs.existsSync(this.path)) return { schemaVersion: 1, entries: {} };
    let value;
    try {
      value = JSON.parse(fs.readFileSync(this.path, 'utf8'));
    } catch (_) {
      throw new CredentialStoreError('credential_store_corrupt');
    }
    if (
      !value ||
      value.schemaVersion !== 1 ||
      !value.entries ||
      typeof value.entries !== 'object' ||
      Array.isArray(value.entries)
    ) {
      throw new CredentialStoreError('credential_store_corrupt');
    }
    for (const [ref, blob] of Object.entries(value.entries)) {
      if (!validRef(ref) || typeof blob !== 'string' || !blob)
        throw new CredentialStoreError('credential_store_corrupt');
    }
    return value as CredentialData;
  }

  _save(value: CredentialData): void {
    const directory = path.dirname(this.path);
    fs.mkdirSync(directory, { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temp, this.path);
  }

  status(ref: unknown) {
    const clean = this._ref(ref);
    const value = this._load();
    return {
      ref: clean,
      present: typeof value.entries[clean] === 'string',
      backend: 'electron.safeStorage',
      available: this._available(),
    };
  }

  set(ref: unknown, credential: unknown) {
    const clean = this._ref(ref);
    const secret = String(credential || '');
    if (!secret) throw new CredentialStoreError('credential_empty');
    if (!this._available()) throw new CredentialStoreError('credential_encryption_unavailable');
    let encrypted;
    try {
      encrypted = this.cryptoStorage.encryptString(secret);
    } catch (_) {
      throw new CredentialStoreError('credential_encryption_failed');
    }
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0)
      throw new CredentialStoreError('credential_encryption_failed');
    const value = this._load();
    value.entries[clean] = encrypted.toString('base64');
    this._save(value);
    return this.status(clean);
  }

  get(ref: unknown): string | null {
    const clean = this._ref(ref);
    if (!this._available()) throw new CredentialStoreError('credential_encryption_unavailable');
    const blob = this._load().entries[clean];
    if (typeof blob !== 'string') return null;
    try {
      const secret = this.cryptoStorage.decryptString(Buffer.from(blob, 'base64'));
      if (!secret) throw new Error('empty');
      return secret;
    } catch (_) {
      throw new CredentialStoreError('credential_decryption_failed');
    }
  }

  delete(ref: unknown): { ref: string; deleted: boolean } {
    const clean = this._ref(ref);
    const value = this._load();
    const deleted = Object.prototype.hasOwnProperty.call(value.entries, clean);
    if (deleted) {
      delete value.entries[clean];
      this._save(value);
    }
    return { ref: clean, deleted };
  }
}

module.exports = { CredentialStore, CredentialStoreError };
