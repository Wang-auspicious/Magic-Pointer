'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const BUILT_CDS_ICONS = path.resolve('build/electron/renderer/cds_icons.js');
const BUILT_SVG_ICONS = path.resolve('build/electron/renderer/cds_svg_icons.js');
const FONTS_DIR = path.resolve('electron/renderer/assets/fonts');

function requireBuilt(builtPath) {
  const check = spawnSync(
    process.execPath,
    ['-e', 'require(process.argv[1])', builtPath],
    {encoding: 'utf8'}
  );
  assert.strictEqual(
    check.status,
    0,
    `run \`npm run build:electron\` first (${builtPath}): ${check.stderr}`
  );
  return require(builtPath);
}

// 1. Vendored fonts from Claude Desktop 4.23118
const anthropiconsVar = path.join(FONTS_DIR, 'Anthropicons-Variable.woff2');
assert.ok(fs.existsSync(anthropiconsVar), 'Anthropicons-Variable.woff2 must be vendored locally');
assert.strictEqual(
  fs.statSync(anthropiconsVar).size,
  155656,
  'Anthropicons-Variable.woff2 must match Claude Desktop 4.23118 c0f671921 (155,656 B)'
);

const anthropiconsLegacy = path.join(FONTS_DIR, 'Anthropicons-DFbvW9Cm.woff2');
assert.ok(fs.existsSync(anthropiconsLegacy), 'Anthropicons-DFbvW9Cm.woff2 must be preserved untouched');
assert.strictEqual(
  fs.statSync(anthropiconsLegacy).size,
  102292,
  'Anthropicons-DFbvW9Cm.woff2 must remain untouched at 102,292 B'
);

const EXTRACTED_TEXT_MONO_FONTS = [
  'AnthropicSansMicro-Text.woff2',
  'AnthropicSansMicro-Display.woff2',
  'AnthropicMono-Regular.woff2',
  'AnthropicMono-Italic.woff2',
];
for (const file of EXTRACTED_TEXT_MONO_FONTS) {
  const fullPath = path.join(FONTS_DIR, file);
  assert.ok(fs.existsSync(fullPath), `${file} must be extracted statically into assets/fonts`);
  assert.ok(fs.statSync(fullPath).size > 0, `${file} must be non-empty`);
}

// Verify fontTools OpenType metrics for Anthropicons-Variable.woff2 (437 cmap / 1264 glyphs, wght+opsz, no ANIM/ANM2)
const REQUIRED_CDS_CODEPOINTS = {
  Sidebar: 0xe0dd,
  Menu: 0xe0aa,
  CaretLeft: 0xe029,
  CaretRight: 0xe02a,
  Search: 0xe0d3,
  ChatAdd: 0xe032,
  Projects: 0xe0c9,
  Folder: 0xe072,
  FolderPlus: 0xe074,
  DotsHorizontal: 0xe061,
  Add: 0xe001,
  Attachment: 0xe019,
  Microphone: 0xe0ab,
  Voice: 0xe108,
  ArrowUp: 0xe013,
  ArrowReturn: 0xe00f,
  StopFilled: 0xe0ec,
  Eye: 0xe069,
  EyeSlash: 0xe06a,
  GitBranch: 0xe078,
  ArrowSplitRight: 0xe012,
  ArrowClockwise: 0xe11d,
  Copy: 0xe056,
  Check: 0xe03b,
  CaretRightFilled: 0xf011,
  CaretDown: 0xe027,
  CaretDownSmall: 0xf003,
  ExtendedThinking: 0xe068,
  ChatSimple: 0xe037,
  Clock: 0xe043,
  Tasks: 0xe0f1,
  Archive: 0xe008,
  Warning: 0xe109,
  Help: 0xe088,
  X: 0xe10f,
};

const fontInspect = spawnSync(
  'python',
  [
    '-c',
    [
      'import json, sys',
      'from fontTools.ttLib import TTFont',
      'f = TTFont(sys.argv[1])',
      'cmap = f.getBestCmap() or {}',
      'axes = {a.axisTag: [a.minValue, a.defaultValue, a.maxValue] for a in f["fvar"].axes} if "fvar" in f else {}',
      'print(json.dumps({"upem": f["head"].unitsPerEm, "glyphs": len(f.getGlyphOrder()), "cmap": len(cmap), "axes": axes, "has": {str(cp): (cp in cmap) for cp in map(int, sys.argv[2:])}}))',
    ].join('; '),
    anthropiconsVar,
    ...Object.values(REQUIRED_CDS_CODEPOINTS).map(String),
  ],
  {encoding: 'utf8'}
);
assert.strictEqual(
  fontInspect.status,
  0,
  `python fontTools inspection failed: ${fontInspect.stderr}`
);
const fontMeta = JSON.parse(fontInspect.stdout.trim());
assert.strictEqual(fontMeta.upem, 1000, 'UPEM must be 1000');
assert.strictEqual(fontMeta.glyphs, 1264, 'c0f671921 glyph count must be 1264');
assert.strictEqual(fontMeta.cmap, 437, 'c0f671921 cmap codepoints must be 437');
assert.deepStrictEqual(fontMeta.axes.wght, [400, 400, 700], 'wght axis must be 400..700');
assert.deepStrictEqual(fontMeta.axes.opsz, [12, 20, 32], 'opsz axis must be 12..32 default 20');
assert.strictEqual(fontMeta.axes.ANIM, undefined, 'c0f671921 has no ANIM axis');
assert.strictEqual(fontMeta.axes.ANM2, undefined, 'c0f671921 has no ANM2 axis');
for (const [name, cp] of Object.entries(REQUIRED_CDS_CODEPOINTS)) {
  assert.strictEqual(
    fontMeta.has[String(cp)],
    true,
    `font cmap must contain ${name} (0x${cp.toString(16)})`
  );
}

// 2. CdsIcons runtime module (classic browser global + Node export)
const {GLYPHS, opticalWeight, codepoint, html, names} = requireBuilt(BUILT_CDS_ICONS);

assert.strictEqual(typeof opticalWeight, 'function', 'CdsIcons must expose opticalWeight()');
assert.strictEqual(opticalWeight(12, 1), 577.8);
assert.strictEqual(opticalWeight(16, 1.25), 533.3);
assert.strictEqual(opticalWeight(16, 1.5625), 700);
assert.strictEqual(opticalWeight(20, 1.25), 433.3);
assert.strictEqual(opticalWeight(20, 1.5625), 566.7);
assert.strictEqual(opticalWeight(24, 1.5), 433.3);
assert.strictEqual(opticalWeight(32, 1.875), 400);

for (const [name, expected] of Object.entries(REQUIRED_CDS_CODEPOINTS)) {
  assert.strictEqual(
    GLYPHS[name],
    expected,
    `GLYPHS.${name} must equal 0x${expected.toString(16)}`
  );
  assert.strictEqual(codepoint(name), expected);
}

// Backward-compatible kebab-case keys consumed across studio.ts/settings.ts/tests
for (const legacy of [
  'sidebar-panel',
  'new-chat',
  'projects',
  'artifacts',
  'code',
  'customize',
  'scheduled',
  'design',
  'search',
  'layout-list',
  'check',
  'attach',
  'send',
  'code-send',
  'row-more',
  'folder',
  'copy',
  'eye',
  'arrow-clockwise',
]) {
  assert.ok(
    typeof GLYPHS[legacy] === 'number',
    `legacy alias "${legacy}" must remain in GLYPHS`
  );
}

const nameList = names();
assert.strictEqual(nameList.length, Object.keys(GLYPHS).length);
const sorted = [...nameList].sort();
assert.deepStrictEqual(nameList, sorted, 'names() must return a sorted list');

for (const name of nameList) {
  const cp = GLYPHS[name];
  assert.ok(
    cp >= 0xe000 && cp <= 0xf8ff,
    `GLYPHS[${name}] = 0x${cp.toString(16)} must lie in Private Use Area E000-F8FF`
  );
}

assert.strictEqual(codepoint('nonexistent-icon'), null);
assert.strictEqual(codepoint(null), null);
assert.strictEqual(codepoint(undefined), null);
assert.strictEqual(codepoint(42), null);

const largeSidebar = html('Sidebar');
assert.ok(largeSidebar.includes('&#xE0DD;'), 'html(Sidebar) must emit 0xE0DD entity');
assert.ok(largeSidebar.includes('data-size="large"'), 'default html size must emit data-size="large"');
const smSearch = html('Search', 'sm');
assert.ok(smSearch.includes('&#xE0D3;'), 'html(Search, sm) must emit 0xE0D3 entity');
assert.ok(smSearch.includes('data-size="sm"'), 'CDS size preset must emit data-size="sm"');
assert.strictEqual(html('nonexistent-icon'), '');
assert.strictEqual(html(null), '');

// 3. CdsSvgIcons 20x20 vector paths & master definitions
const svgIcons = requireBuilt(BUILT_SVG_ICONS);
assert.ok(
  svgIcons.GLYPH_PATHS_20 && typeof svgIcons.GLYPH_PATHS_20 === 'object',
  'CdsSvgIcons must expose GLYPH_PATHS_20 20x20 vector paths'
);
assert.strictEqual(
  typeof svgIcons.generate20,
  'function',
  'CdsSvgIcons must expose generate20()'
);

const REQUIRED_VECTOR_20 = [
  'Menu',
  'Sidebar',
  'CaretLeft',
  'CaretRight',
  'Search',
  'ChatAdd',
  'Projects',
  'Folder',
  'FolderPlus',
  'DotsHorizontal',
  'Add',
  'Attachment',
  'Microphone',
  'Voice',
  'ArrowUp',
  'ArrowReturn',
  'StopFilled',
  'Eye',
  'EyeSlash',
  'GitBranch',
  'ArrowSplitRight',
  'ArrowClockwise',
  'Copy',
  'Check',
];
for (const iconName of REQUIRED_VECTOR_20) {
  const pathData = svgIcons.GLYPH_PATHS_20[iconName];
  assert.ok(
    typeof pathData === 'string' && pathData.length > 0,
    `GLYPH_PATHS_20.${iconName} must have 20x20 path data`
  );
  const markup = svgIcons.generate20(iconName);
  assert.ok(
    markup.includes('viewBox="0 0 20 20"') && markup.includes(pathData),
    `generate20(${iconName}) must render a 20x20 SVG with the exact glyph path`
  );
}

for (const masterName of ['Menu', 'Voice', 'Spinner', 'Wrench', 'Tasks', 'ArrowUpRight']) {
  const def = svgIcons.definitionFor(masterName);
  assert.ok(def, `ICONS must include ${masterName} definition`);
}

// 4. CSS contracts (fonts, no double-dot sidebar, REA session row & composer alignment)
const cdsIconsCss = fs.readFileSync(path.resolve('electron/renderer/cds_icons.css'), 'utf8');
assert.match(cdsIconsCss, /font-family:\s*['"]?Anthropicons-Variable['"]?/);
assert.match(cdsIconsCss, /font-weight:\s*400\s+700/);
assert.match(cdsIconsCss, /prefers-reduced-motion/);
assert.match(cdsIconsCss, /\[data-reduce-motion="true"\]/);

const studioLayoutCss = fs.readFileSync(path.resolve('electron/renderer/studio_layout.css'), 'utf8');
assert.strictEqual(
  /\.side-dot\b/.test(studioLayoutCss),
  false,
  'studio_layout.css must completely remove .side-dot left mode-dot CSS'
);
assert.match(studioLayoutCss, /\.df-session-list|\.side-item/);
assert.match(studioLayoutCss, /height:\s*(?:var\(--df-row-h,\s*)?26px/);
assert.match(studioLayoutCss, /right:\s*3px/);
assert.match(studioLayoutCss, /:hover[^}]*:focus-within|focus-within[^}]*data-menu-open/s);
