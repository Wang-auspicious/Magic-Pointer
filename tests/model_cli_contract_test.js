const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const cli = fs.readFileSync(path.join(root, 'scripts', 'model_cli.js'), 'utf8');
const configure = fs.readFileSync(path.join(root, 'scripts', 'configure_groq.ps1'), 'utf8');

assert.match(pkg.scripts['model:groq'], /configure_groq\.ps1/);
assert.match(pkg.scripts['model:status'], /model_cli\.js status/);
assert.match(pkg.scripts['model:test'], /model_cli\.js test/);
assert.match(configure, /Read-Host.+AsSecureString/);
assert.match(cli, /safeStorage/);
assert.match(cli, /CredentialStore/);
assert.match(cli, /upsertGroqProfile/);
assert.match(cli, /if \(result\?\.ok !== true\) process\.exitCode = 1/,
  'model:test must return a failing shell exit code when the gateway check fails');
assert.match(cli, /app\.exit\(process\.exitCode \|\| 0\)/,
  'Electron CLI shutdown must preserve the shell exit code');
assert.match(cli, /process\.env\.MAGIC_POINTER_USER_DATA_DIR\s*\|\|\s*path\.join\(ROOT, 'data', 'runtime'\)/,
  'developer model commands must target the same data/runtime directory as npm run overlay');
assert.doesNotMatch(cli, /process\.env\.LOCALAPPDATA/,
  'the developer command must not silently configure the old installed app directory');
assert.doesNotMatch(cli, /gsk_[A-Za-z0-9]{10,}/);

console.log('model cli contract test ok');
