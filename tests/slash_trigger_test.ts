const assert = require('node:assert');
const { detectSlashToken } = require('../electron/slash_trigger');

assert.strictEqual(detectSlashToken('/'), '', 'bare slash triggers with empty token');
assert.strictEqual(detectSlashToken('查一下 /perm'), 'perm');
assert.strictEqual(detectSlashToken('\n/model'), 'model');
assert.strictEqual(detectSlashToken('/Model-X'), 'model-x', 'case-insensitive, dash kept');
assert.strictEqual(detectSlashToken('plain text'), null);
assert.strictEqual(detectSlashToken('a/b'), null, 'slash must follow start or whitespace');
assert.strictEqual(detectSlashToken('/perm '), null, 'token ended by a space = already submitted shape');
assert.strictEqual(detectSlashToken('/perm rest'), null);
assert.strictEqual(detectSlashToken('邮箱是 a@b.com/c'), null, 'path-like text must not trigger');
assert.strictEqual(detectSlashToken(''), null);

console.log('slash trigger test ok');
