'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'prepare_python_runtime.ps1'), 'utf8');
const lockPath = path.join(__dirname, '..', 'requirements.lock.txt');
assert(fs.existsSync(lockPath), 'bundled Python dependencies must use a committed hash lock');
const lock = fs.readFileSync(lockPath, 'utf8');

assert(script.includes('pr-stage-'), 'runtime must build in a short unique staging directory');
assert(script.includes("Substring(0, 8)"), 'runtime staging nonce must stay short enough for deep dependency paths');
assert(script.includes('python-runtime.previous-'), 'runtime replacement must preserve a rollback directory');
assert(script.includes('Move-Item -LiteralPath $RuntimePath -Destination $BackupPath'), 'previous runtime must move aside before replacement');
assert(script.includes('Move-Item -LiteralPath $StagePath -Destination $RuntimePath'), 'staged runtime must replace only after successful preparation');
assert(script.includes('Move-Item -LiteralPath $BackupPath -Destination $RuntimePath'), 'failed replacement must restore previous runtime');
assert(script.includes("@('site-packages', '__pycache__', 'test', 'tests', 'idlelib', 'tkinter')"), 'base runtime copy must exclude user packages and disposable standard-library trees');
assert(script.includes("Join-Path $StagePath 'Lib\\site-packages'"), 'dependencies must install into staged runtime only');
assert(/'-m',\s*'pip',\s*'install',[\s\S]*?'--target',\s*\$sitePackages,[\s\S]*?'--no-compile'/.test(script),
  'requirements must be installed via build Python pip target');
assert(script.includes("'--ignore-installed'"),
  'target runtime resolution must be isolated from build-machine packages');
assert(/'--timeout',\s*'180',[\s\S]*?'--retries',\s*'10'/.test(script),
  'large bundled wheels must use bounded retry and a practical read timeout');
assert(script.includes("$WheelhousePath = Join-Path $BuildRoot 'python-wheelhouse'"),
  'runtime preparation must retain a durable wheelhouse outside the disposable staging runtime');
assert(script.includes("$LockPath = Join-Path $ProjectRoot 'requirements.lock.txt'"),
  'runtime preparation must use the committed lock instead of ranged requirements');
assert(script.includes("'--require-hashes'"), 'both wheel acquisition and installation must enforce package hashes');
assert(script.includes("'--no-index'"), 'the bundled runtime must install strictly offline from the wheelhouse');
assert(script.includes("'--find-links', $WheelhousePath"), 'offline installation must point only at the project wheelhouse');
assert(script.includes("'--only-binary', ':all:'"), 'normal wheelhouse acquisition must reject source distributions');
assert(script.includes('function Test-Wheelhouse'), 'the wheelhouse must be zip and hash validated before use');
assert(script.includes('function Invoke-CapturedBuildPython'),
  'native stderr must be captured without ErrorActionPreference aborting validation diagnostics');
assert(/Invoke-CapturedBuildPython[\s\S]*?\$ErrorActionPreference = 'Continue'[\s\S]*?\$ErrorActionPreference = \$previousErrorActionPreference/.test(script),
  'native stderr capture must restore the strict PowerShell error policy');
assert(script.includes('root = pathlib.Path(sys.argv[2]).resolve()'),
  'wheelhouse validator must skip the encoded bootstrap argument');
assert(script.includes('lock = pathlib.Path(sys.argv[3]).read_text'),
  'wheelhouse validator must read the lock from the following argument');
assert(script.includes('runtime = pathlib.Path(sys.argv[2]).resolve()'),
  'staged runtime validation must skip the encoded bootstrap argument');
assert(script.includes("'python-wheelhouse.staging-"), 'incomplete downloads must remain outside the reusable wheelhouse');
assert(!script.includes("'--no-cache-dir'"),
  'durable wheelhouse construction must not discard successfully downloaded wheels');
assert(!script.includes("'-r', $RequirementsPath"),
  'runtime construction must not consume the ranged dependency file');
assert(script.includes('$encodedValidation = [Convert]::ToBase64String('),
  'PowerShell must preserve the staged validation source exactly');
assert(/& \$stagePython\s+-I\s+-c\s+'import base64,sys;exec\(base64\.b64decode\(sys\.argv\[1\]\)\)'\s+\$encodedValidation/.test(script),
  'staged interpreter must be independently validated');
assert(script.includes('function Test-RuntimeImports'),
  'runtime preparation and cache reuse must share a real dependency import probe');
for (const moduleName of ['PIL', 'fitz', 'openai', 'onnxruntime', 'rapidocr', 'sounddevice', 'whisper', 'torch', 'opencc']) {
  assert(script.includes(`import ${moduleName}`), `runtime import probe must load ${moduleName}`);
}
assert(/Test-RuntimeCache[\s\S]*?Test-RuntimeImports/.test(script),
  'cache hits must be rejected when bundled dependency imports are incomplete');
assert(/Staged Python dependency imports failed/.test(script),
  'a newly staged runtime must fail before replacement when dependency imports are broken');
assert(script.includes("'pyvenv.cfg'"), 'runtime must reject source virtual-environment linkage');
assert(script.includes('New-Object System.Text.UTF8Encoding($false)'),
  'manifest writing must use no-BOM UTF-8 on Windows PowerShell 5');
assert(!script.includes('-Encoding utf8NoBOM'),
  'Windows PowerShell 5 does not support the utf8NoBOM encoding enum');
assert(!/Copy-Item\s+.*site-packages/i.test(script), 'script must not copy an existing site-packages tree');
assert(!/Copy-Item\s+.*AppData/i.test(script), 'script must not take dependencies from a user profile path');

assert(!/(^|\s)(?:~=|>=|<=|!=|>|<)\s*\d/m.test(lock),
  'lock entries must use exact versions rather than ranges');
const lockedEntries = lock
  .split(/(?=^[A-Za-z0-9][A-Za-z0-9._-]*==)/m)
  .filter((entry) => /^[A-Za-z0-9][A-Za-z0-9._-]*==/m.test(entry));
assert(lockedEntries.length > 0, 'lock must contain package entries');
assert(lockedEntries.every((entry) => entry.includes('--hash=sha256:')),
  'every locked package must carry a sha256 hash');
for (const packageName of ['openai', 'pillow', 'pymupdf', 'pyperclip', 'onnxruntime', 'rapidocr', 'openai-whisper', 'sounddevice', 'opencc', 'torch']) {
  assert(new RegExp(`^${packageName}==`, 'mi').test(lock), `lock must include ${packageName}`);
}

console.log('python runtime prepare contract test ok');
