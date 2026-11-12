const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const builder = read('electron-builder.yml'), smoke = read('scripts/verify_windows_package.ps1'), runtime = read('electron/runtime/package_smoke.ts');
const icon = fs.readFileSync(path.join(root, 'assets/app/icon.ico'));
assert.equal(icon.readUInt16LE(0), 0); assert.equal(icon.readUInt16LE(2), 1);
const sizes = new Set(); for (let i = 0; i < icon.readUInt16LE(4); i++) { const offset = 6 + i * 16; assert.equal(icon.readUInt16LE(offset + 4), 1); sizes.add(icon[offset] || 256); }
for (const size of [16, 24, 32, 48, 64, 128, 256]) assert.ok(sizes.has(size));
assert.match(builder, /win:[\s\S]*?icon:\s*assets\/app\/icon\.ico/);
assert.ok(builder.includes('- build/electron/**'));
assert.ok(builder.includes('- build/figma/**'));
assert.ok(!builder.includes('- electron/**'));
assert.ok(!builder.includes('- scripts/**'));
assert.ok(!/python-runtime|\.py\s*$/m.test(builder));
for (const file of ['scripts/pointer_input_state.ps1', 'scripts/uia_selection_probe.cs', 'scripts/desktop_host.cs', 'scripts/desktop_ocr.ps1']) assert.ok(builder.includes(`- ${file}`), `missing native helper:${file}`);
for (const field of ['installerIcon', 'uninstallerIcon']) assert.match(builder, new RegExp(`${field}:\\s*assets/app/icon\\.ico`));
assert.match(builder, /createDesktopShortcut:\s*true/); assert.match(builder, /createStartMenuShortcut:\s*true/);
assert.match(builder, /include:\s*packaging\/installer\.nsh/);
assert.ok(JSON.parse(read('package.json')).dependencies['electron-updater']);
assert.match(smoke, /ConvertTo-Json/); assert.match(smoke, /Add-Type\s+-AssemblyName\s+System\.Drawing/);
assert.ok(!/taskkill\.exe/i.test(smoke)); assert.match(smoke, /Get-Process\s+-Id\s+\$process\.Id/);
assert.match(smoke, /chromiumProfileIsolated/); assert.match(smoke, /\$cleanupErrors\.Count\s+-gt\s+0/);
assert.match(smoke, /StartsWith\([\s\S]*?smokeRoot/); assert.match(smoke, /Remove-Item -LiteralPath \$runtimeDir -Recurse/);
assert.ok(smoke.includes('ELECTRON_RUN_AS_NODE')); assert.ok(smoke.includes('package_smoke.js'));
assert.ok(smoke.includes('Obsolete Python runtime leaked')); assert.ok(smoke.includes('Obsolete Python source leaked'));
assert.ok(smoke.includes('development workspace provenance'));
for (const file of ['onboarding.html', 'onboarding.css', 'onboarding.js', 'desktop_capture.js', 'worker.js']) assert.ok(smoke.includes(file));
assert.ok(runtime.includes('createOfficeFile')); assert.ok(runtime.includes('PDFDocument.create'));
assert.ok(runtime.includes('reader.read')); assert.ok(runtime.includes('sharp(')); assert.ok(runtime.includes("nativeRequest('ping')"));
assert.ok(runtime.includes('dispatchRuntime')); assert.ok(runtime.includes('MAGIC_POINTER_USER_DATA_DIR'));
assert.ok(!fs.existsSync(path.join(root, 'scripts/prepare_python_runtime.ps1')));

// Package slimming contract: restrict locales, strip sourcemaps/types and duplicate browser bundles.
assert.match(builder, /electronLanguages:\s*\r?\n\s*-\s*zh-CN\s*\r?\n\s*-\s*en-US/);
assert.match(builder, /afterPack:\s*packaging\/after_pack\.js/);
for (const exclusion of [
  '!**/*.map',
  '!**/*.d.ts',
  '!node_modules/pdf-lib/dist/**',
  '!node_modules/exceljs/dist/**',
  '!node_modules/pdfjs-dist/build/**',
]) {
  assert.ok(builder.includes(exclusion), `missing builder exclusion: ${exclusion}`);
}
assert.ok(fs.existsSync(path.join(root, 'packaging/after_pack.js')), 'missing packaging/after_pack.js hook');
const os = require('node:os');
const afterPack = require('../packaging/after_pack.js').default;
const tempPackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-after-pack-'));
try {
  fs.mkdirSync(path.join(tempPackDir, 'locales'), { recursive: true });
  fs.writeFileSync(path.join(tempPackDir, 'locales', 'zh-CN.pak'), 'zh');
  fs.writeFileSync(path.join(tempPackDir, 'locales', 'en-US.pak'), 'en');
  fs.writeFileSync(path.join(tempPackDir, 'locales', 'fr.pak'), 'fr');
  fs.writeFileSync(path.join(tempPackDir, 'LICENSES.chromium.html'), 'licenses');
  afterPack({ appOutDir: tempPackDir });
  assert.deepEqual(fs.readdirSync(path.join(tempPackDir, 'locales')).sort(), ['en-US.pak', 'zh-CN.pak']);
  assert.equal(fs.existsSync(path.join(tempPackDir, 'LICENSES.chromium.html')), false);
} finally {
  fs.rmSync(tempPackDir, { recursive: true, force: true });
}

// DirectUI desktop interaction contract: global anti-drag-selection + explicit text selection allowlist.
const themeTokens = read('electron/renderer/theme_tokens.css');
const oreoCss = read('electron/renderer/oreo.css');
const onboardingCss = read('electron/renderer/onboarding.css');
const inputComposition = read('electron/renderer/input_composition.ts');
assert.match(themeTokens, /html,\s*\r?\nbody\s*\{[\s\S]*?user-select:\s*none;/);
assert.match(themeTokens, /\.mp-chat-markdown[\s\S]*?\{[\s\S]*?user-select:\s*text;/);
assert.match(oreoCss, /html,\s*body\s*\{[\s\S]*?user-select:\s*none;/);
assert.match(onboardingCss, /html,\s*\r?\nbody\s*\{[\s\S]*?user-select:\s*none;/);
assert.match(inputComposition, /dragstart/);

console.log('windows package contracts passed');
