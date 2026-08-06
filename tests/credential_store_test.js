const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CredentialStore, CredentialStoreError } = require('../electron/credential_store');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-pointer-credentials-'));
const credentialsPath = path.join(root, 'credentials.v1.json');
const cryptoStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
  decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, ''),
};
const store = new CredentialStore(credentialsPath, cryptoStorage);

assert.deepStrictEqual(store.status('credential:model:primary'), {
  ref: 'credential:model:primary',
  present: false,
  backend: 'electron.safeStorage',
  available: true,
});
store.set('credential:model:primary', 'sk-never-in-settings-or-log');
assert.strictEqual(store.get('credential:model:primary'), 'sk-never-in-settings-or-log');
assert.strictEqual(store.status('credential:model:primary').present, true);
const raw = fs.readFileSync(credentialsPath, 'utf8');
assert(!raw.includes('sk-never-in-settings-or-log'));
assert(!raw.includes('credential:model:primary":"sk-'));
assert.deepStrictEqual(store.delete('credential:model:primary'), {
  ref: 'credential:model:primary',
  deleted: true,
});
assert.strictEqual(store.status('credential:model:primary').present, false);
assert.throws(() => store.set('bad ref', 'value'), CredentialStoreError);
assert.throws(() => store.set('credential:model:primary', ''), /empty/);

const unavailable = new CredentialStore(path.join(root, 'unavailable.json'), {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('must not run'); },
  decryptString: () => { throw new Error('must not run'); },
});
assert.deepStrictEqual(unavailable.status('credential:model:primary'), {
  ref: 'credential:model:primary',
  present: false,
  backend: 'electron.safeStorage',
  available: false,
});
assert.throws(() => unavailable.set('credential:model:primary', 'x'), /credential_encryption_unavailable/);

console.log('credential store test ok');
