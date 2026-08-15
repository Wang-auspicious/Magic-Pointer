'use strict';

// Static configuration guard only. This does not install or launch a package.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const exists = (relativePath) => fs.existsSync(path.join(root, relativePath));

const builder = read('electron-builder.yml');
const packageJson = JSON.parse(read('package.json'));
const smoke = read('scripts/verify_windows_package.ps1');
const fabricSmoke = read('scripts/smoke_fabric.py');

assert(exists('assets/app/magic-pointer-icon.svg'), 'brand SVG source must be checked in');
assert(exists('assets/app/icon.ico'), 'Windows ICO must be checked in');
assert(exists('assets/app/generate_icon.py'), 'deterministic icon generator must be checked in');
const ico = fs.readFileSync(path.join(root, 'assets/app/icon.ico'));
assert.strictEqual(ico.readUInt16LE(0), 0, 'ICO header must begin with the reserved zero value');
assert.strictEqual(ico.readUInt16LE(2), 1, 'icon must be a Windows ICO container');
const imageCount = ico.readUInt16LE(4);
const icoSizes = new Set();
for (let index = 0; index < imageCount; index += 1) {
  const offset = 6 + index * 16;
  const width = ico[offset] || 256;
  const height = ico[offset + 1] || 256;
  const planes = ico.readUInt16LE(offset + 4);
  assert.strictEqual(
    planes,
    1,
    `${width}x${height} ICO frame must declare one Windows color plane`,
  );
  icoSizes.add(`${width}x${height}`);
}
for (const size of [16, 24, 32, 48, 64, 128, 256]) {
  assert(icoSizes.has(`${size}x${size}`), `ICO must contain ${size}x${size} frame`);
}
assert(
  /win:\s*[\s\S]*?icon:\s*assets\/app\/icon\.ico/.test(builder),
  'win.icon must point at the shipped Magic Pointer ICO',
);
assert(
  /files:\s*[\s\S]*?-\s*assets\/app\/icon\.ico/.test(builder),
  'the packaged tray runtime must contain the Magic Pointer ICO',
);
assert(
  !builder.includes('- scripts/**'),
  'package files must use a runtime script allowlist instead of shipping development capture and verification tools',
);
assert(builder.includes('- build/electron/**'), 'package must ship the compiled Electron runtime');
assert(!builder.includes('- electron/**'), 'package must not ship the Electron source tree');
for (const runtimeScript of [
  'scripts/conversation_bridge.py',
  'scripts/electron_bridge.py',
  'scripts/selection_bridge.py',
  'scripts/selection_snapshot_bridge.py',
  'scripts/local_voice_bridge.py',
  'scripts/local_voice_worker.py',
  'scripts/pointer_input_state.ps1',
  'scripts/uia_selection_probe.cs',
]) {
  assert(
    builder.includes(`- ${runtimeScript}`),
    `package must include runtime script ${runtimeScript}`,
  );
}
assert(
  !builder.includes('build/scripts/capture_stage.js'),
  'package must not contain the development capture script with local workspace provenance',
);
assert(
  /extraResources:\s*[\s\S]*?from:\s*build\/python-runtime[\s\S]*?to:\s*python-runtime/.test(
    builder,
  ),
  'packaged app must ship build/python-runtime as resources/python-runtime',
);
assert(
  /installerIcon:\s*assets\/app\/icon\.ico/.test(builder),
  'NSIS installer must use the app ICO',
);
assert(
  /uninstallerIcon:\s*assets\/app\/icon\.ico/.test(builder),
  'NSIS uninstaller must use the app ICO',
);
assert(
  /createDesktopShortcut:\s*true/.test(builder),
  'the end-user installer must create a double-click desktop shortcut',
);
assert(
  /createStartMenuShortcut:\s*true/.test(builder),
  'the end-user installer must create a Start Menu shortcut',
);
assert(
  /shortcutName:\s*Magic Pointer/.test(builder),
  'installed shortcuts must use the product name',
);
assert(
  /uninstallDisplayName:\s*Magic Pointer/.test(builder),
  'Windows Apps & Features must show the product name',
);
assert(
  /include:\s*packaging\/installer\.nsh/.test(builder),
  'custom NSIS uninstall cleanup must be packaged from packaging/',
);
assert(
  packageJson.dependencies?.['electron-updater'],
  'the packaged NSIS app must ship its updater runtime as a production dependency',
);
assert(
  /publish:\s*[\s\S]*?provider:\s*github[\s\S]*?owner:\s*Wang-auspicious[\s\S]*?repo:\s*Magic-Pointer/.test(
    builder,
  ),
  'the packaged app must carry a public GitHub release feed for update metadata',
);
assert(
  exists('electron/update_manager.ts'),
  'auto-update behavior must live behind a testable main-process module',
);
assert(smoke.includes('ConvertTo-Json'), 'smoke script must emit structured JSON');
assert(
  /Add-Type\s+-AssemblyName\s+System\.Drawing/.test(smoke),
  'smoke script must load the native Windows icon parser',
);
assert(!/taskkill\.exe/i.test(smoke), 'smoke cleanup must not use taskkill');
assert(
  /Get-Process\s+-Id\s+\$process\.Id/.test(smoke),
  'smoke cleanup must stay scoped to the launched PID',
);
assert(
  /\$children\.Count\s+-gt\s+0/.test(smoke),
  'process-tree traversal must not append a PowerShell null sentinel',
);
assert(
  /icon/i.test(smoke) && /version/i.test(smoke),
  'smoke script must inspect executable icon and version metadata',
);
assert(
  /package-smoke/i.test(smoke) && /Remove-Item/i.test(smoke),
  'smoke script must remove only its package-smoke data directory',
);
assert(
  smoke.includes("'scripts\\local_voice_worker.py'"),
  'packaged smoke must guard the resident voice worker resource',
);
for (const onboardingResource of [
  'build\\electron\\renderer\\onboarding.html',
  'build\\electron\\renderer\\onboarding.css',
  'build\\electron\\renderer\\onboarding.js',
]) {
  assert(
    smoke.includes(`'${onboardingResource}'`),
    `packaged smoke must guard first-run resource ${onboardingResource}`,
  );
}
assert(
  smoke.includes("'build\\scripts\\capture_stage.js'"),
  'packaged smoke must reject development-only capture scripts',
);
assert(
  smoke.includes('development workspace provenance'),
  'packaged smoke must scan shipped source for the local development workspace path',
);
assert(
  smoke.includes('chromiumProfileIsolated'),
  'packaged smoke must prove Chromium shares the isolated smoke profile',
);
assert(
  /\$attempt\s*=\s*0;\s*\$attempt\s*-lt\s*10/.test(smoke),
  'smoke cleanup must retry briefly while Chromium releases profile files',
);
assert(
  /\$cleanupErrors\.Count\s+-gt\s+0/.test(smoke),
  'cleanup failures must fail the package verification',
);
assert(
  smoke.includes("'python-runtime\\python.exe'"),
  'package smoke must target bundled resources/python-runtime/python.exe',
);
assert(
  smoke.includes("'python-runtime\\manifest.json'"),
  'package smoke must require bundled runtime manifest',
);
assert(
  /'-I',\s*'-X',\s*'utf8',\s*'-c'/.test(smoke),
  'package smoke must import dependencies with bundled isolated UTF-8 Python',
);
assert(
  smoke.includes('function Invoke-CapturedNative'),
  'package smoke must capture native stderr without PowerShell 5 aborting early',
);
assert(
  smoke.includes('base64.b64decode(sys.argv[1])'),
  'multiline Python probes must cross the PowerShell boundary as base64',
);
assert(
  smoke.includes('runtime = pathlib.Path(sys.argv[2]).resolve()'),
  'encoded probes must skip their bootstrap payload argument',
);
assert(
  smoke.includes("'scripts\\smoke_fabric.py'"),
  'package smoke must execute the packaged Fabric smoke with bundled Python',
);
assert(
  !/TemporaryDirectory\([^)]*dir\s*=\s*ROOT/.test(fabricSmoke),
  'Fabric smoke must not write its temporary runtime into the packaged read-only app root',
);
assert(
  fabricSmoke.includes('MAGIC_POINTER_USER_DATA_DIR'),
  'Fabric smoke must honor the isolated writable user-data directory',
);

console.log('windows_package_contract_test: static package contracts passed');
