'use strict';

const assert = require('assert');
const fs = require('fs');

const scriptPath = 'scripts/verify_windows_installer.ps1';
assert(fs.existsSync(scriptPath), 'installer verification script must exist');
const script = fs.readFileSync(scriptPath, 'utf8');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const workflow = fs.readFileSync('.github/workflows/release.yml', 'utf8');

assert.strictEqual(
  packageJson.scripts?.['verify:installer'],
  'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify_windows_installer.ps1',
);
assert.match(script, /existing_installation_detected/,
  'installer verification must refuse to replace a user installation');
assert.match(script, /Magic Pointer\.lnk/,
  'desktop and Start Menu shortcuts must be verified');
assert.match(script, /CreateShortcut\([\s\S]*?TargetPath/,
  'shortcut verification must resolve the actual target');
assert.match(script, /MAGIC_POINTER_USER_DATA_DIR/,
  'installed-app smoke must use isolated user data');
assert.match(script, /--background/,
  'installed-app smoke must exercise tray/background startup');
assert.match(script, /capsule[\s\S]*?startup/i,
  'installed startup must assert that no capsule appears');
assert.match(script, /Uninstall Magic Pointer\.exe/,
  'the installation created by the test must be uninstalled');
assert.match(script, /\[int\]\$CleanupTimeoutSeconds\s*=\s*90/,
  'large NSIS uninstalls need a bounded asynchronous cleanup window');
assert.match(script, /install-smoke/,
  'cleanup must stay inside the dedicated install-smoke root');
assert.match(script, /Remove-Item\s+-LiteralPath\s+\$runtimeDir\s+-Recurse/,
  'isolated smoke data must be removed by literal scoped path');
assert.match(workflow, /npm run verify:package[\s\S]*?npm run verify:installer/,
  'release workflow must verify both unpacked and installed products');

console.log('windows installer contract test ok');
