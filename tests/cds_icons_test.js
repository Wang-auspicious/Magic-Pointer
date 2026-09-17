'use strict';

/*
 * The codepoint table is transcribed by hand from a scraped manifest, so what
 * needs guarding is the transcription itself: the exact set of names, and the
 * two names that deliberately share one codepoint. A silent typo here renders
 * a tofu box in the UI and nothing crashes, which is the kind of failure that
 * ships.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const built = path.resolve('build/electron/renderer/cds_icons.js');
const builtCheck = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', built], { encoding: 'utf8' });
assert.strictEqual(builtCheck.status, 0,
  `run \`npm run build:electron\` first: ${builtCheck.stderr}`);

const { GLYPHS, codepoint, html, names } = require(built);

const vendored = path.resolve('electron/renderer/assets/fonts/Anthropicons-Variable.woff2');
assert.ok(fs.existsSync(vendored), 'the woff2 must be vendored locally, not hotlinked from the CDN');
assert.strictEqual(fs.statSync(vendored).size, 94528,
  'the vendored woff2 must be the byte-for-byte scraped copy');

const GLYPH_COUNT = 38;
const SPOT_CHECKS = {
  send: 0xe013,
  check: 0xe03b,
  search: 0xe0d3,
  artifacts: 0xe017,
  code: 0xe048,
  customize: 0xe100,
  attach: 0xe001,
  'new-chat': 0xe001,
  dictate: 0xe0ab,
  'sidebar-panel': 0xe0dd,
};

const known = names();
assert.deepStrictEqual(known, [...known].sort(), 'names() must be sorted');
assert.strictEqual(new Set(known).size, known.length, 'names() must not contain duplicates');
assert.strictEqual(known.length, GLYPH_COUNT, `expected ${GLYPH_COUNT} transcribed names`);
assert.strictEqual(Object.keys(GLYPHS).length, GLYPH_COUNT);

for (const [name, expected] of Object.entries(SPOT_CHECKS)) {
  assert.strictEqual(codepoint(name), expected,
    `${name} must map to 0x${expected.toString(16).toUpperCase()}`);
}

for (const [name, value] of Object.entries(GLYPHS)) {
  assert.ok(Number.isInteger(value) && value >= 0xe000 && value <= 0xe137,
    `${name} is outside the icon font's own range: ${value}`);
}

assert.strictEqual(codepoint('nope'), null, 'an unknown name must resolve to null');
assert.strictEqual(codepoint(42), null, 'a non-string name must resolve to null');
assert.strictEqual(codepoint('toString'), null, 'inherited object keys must not count as glyphs');

const send = html('send');
assert.ok(send.includes('class="cds-icon"'), send);
assert.ok(send.includes('data-size="large"'), send);
assert.ok(send.includes('data-glyph="&#xE013;"'), send);
assert.ok(send.includes('aria-hidden="true"'), send);
assert.ok(!send.includes(String.fromCharCode(0xe013)),
  'the codepoint must be an entity, never a raw PUA character');
/* 字形不能是元素的内容：内容会进 textContent，带图标的菜单行读出来就会多一个
   私有区字符。CSS 从 data-glyph 取出来画，元素本身必须是空的。 */
const sendContent = send.slice(send.indexOf('>') + 1, send.lastIndexOf('<'));
assert.strictEqual(sendContent, '',
  'the span must carry no text content; the glyph is drawn from data-glyph');

assert.ok(html('send', 'bogus').includes('data-size="large"'), 'an unknown size must fall back to large');
assert.ok(html('send', 'micro').includes('data-size="micro"'));

assert.strictEqual(html('nope'), '', 'an unknown name must render nothing rather than a placeholder');

console.log('cds icon contract ok');
