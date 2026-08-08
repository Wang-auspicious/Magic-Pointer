const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const runner = fs.readFileSync('scripts/run-node-tests.js', 'utf8');

assert(main.includes('safeStorage'));
assert(
  main.includes(
    "new CredentialStore(path.join(FABRIC_DATA_DIR, 'credentials.v1.json'), safeStorage)",
  ),
);
assert(main.includes("operation.startsWith('models.credentials.')"));
assert(main.includes("'models.credentials.set'"));
assert(main.includes('withoutRawCredential'));
assert(
  main.includes(
    "for (const key of ['credential', 'credentialValue', 'apiKey', 'token', 'secret', 'authorization']) delete clean[key]",
  ),
);
assert(main.includes("if (operation === 'models.test')"));
assert(
  main.includes(
    "['models.save', 'models.delete', 'models.set_default', 'models.test'].includes(operation)",
  ),
);
assert(!main.includes('console.log(payload)'));
assert(pkg.scripts.test.includes('scripts/run-node-tests.js'));
assert(runner.includes("walkCode('electron')"));
assert(runner.includes("require.resolve('tsx/cjs')"));
assert(runner.includes("entry.name.endsWith('_test.js')"));

console.log('credential main static test ok');
