const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'scripts', 'sync_install.ps1'), 'utf8');

assert.strictEqual(
  (script.match(/npm run verify/g) || []).length,
  1,
  'sync must enter the full verification pipeline exactly once',
);
assert.doesNotMatch(script, /npm run typecheck|run-node-tests\.ts|python -m pytest/,
  'sync must not duplicate checks already owned by npm run verify');

assert.match(
  script,
  /release\\sync-\$\(\$packageVersion\)-\$syncStamp-\$PID/,
  'sync packaging must use a run-specific output directory so a locked prior win-unpacked cannot be reused',
);
assert.match(
  script,
  /--win nsis "-c\.directories\.output=\$syncOutput"/,
  'electron-builder must receive the run-specific output directory',
);
assert.match(
  script,
  /\$unpackedDir = Join-Path \$syncOutput 'win-unpacked'/,
  'the local install must copy from the same verified staging build',
);
assert.match(
  script,
  /robocopy\.exe \$unpackedDir \$installedDir \/E/,
  'the installed app must use a long-path-capable copy from the staging win-unpacked tree',
);
assert.match(
  script,
  /if \(\$copyExitCode -ge 8\) \{ throw/,
  'robocopy failure exit codes must fail the sync instead of being accepted as a successful install',
);

const stopIndex = script.indexOf('Stop-Process -Force');
const copyIndex = script.indexOf('robocopy.exe');
assert.ok(stopIndex >= 0 && copyIndex > stopIndex, 'sync must stop the installed app before copying');
const beforeCopy = script.slice(stopIndex, copyIndex);
assert.match(beforeCopy, /while\s*\(Get-Process\s+["']Magic Pointer["']/,
  'sync must wait for the installed app to exit before copying its executable');
assert.match(beforeCopy, /if\s*\(\(Get-Date\)\s*-ge\s*\$stopDeadline\)\s*\{\s*throw/,
  'sync must fail after a bounded wait instead of copying over a running executable');

console.log('sync install contract test ok');
