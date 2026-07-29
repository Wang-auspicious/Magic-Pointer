'use strict';

const assert = require('assert');
const fs = require('fs');

const typography = fs.readFileSync('electron/renderer/typography.css', 'utf8');
const tokens = fs.readFileSync('electron/renderer/tokens.css', 'utf8');
const combined = `${typography}\n${tokens}`;

assert.match(combined, /Segoe UI Variable Text/,
  'Windows UI typography should match the Codex system-sans stack');
assert.match(combined, /Microsoft YaHei UI/,
  'Chinese UI must use the native Windows Chinese UI face');
assert.doesNotMatch(combined, /Times New Roman|KaiTi|Kaiti SC|STKaiti|(?<!sans-)serif/,
  'the global UI stack must not fall back to the previous editorial serif style');
assert.match(typography, /html,\s*\nbody,\s*\nhtml \*/);

console.log('typography system font test ok');
