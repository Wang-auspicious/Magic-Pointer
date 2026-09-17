'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ClaudeMarks = require('../electron/renderer/claude_marks');

const ICON_DIR = path.join('参考claude设计', 'scraped', 'icons');
const FILES = {
  spark: 'spark.svg',
  voiceActivity: 'voice-activity.svg',
  incognito: 'incognito.svg',
  reflectBroadcast: 'reflect-broadcast.svg',
};
const KEBAB = {
  spark: 'spark',
  voiceActivity: 'voice-activity',
  incognito: 'incognito',
  reflectBroadcast: 'reflect-broadcast',
};

// Rebuilds what the module is supposed to hold, from the scraped file itself:
// the module's only edit is the fixed root width/height pair becoming 100%.
// Comparing against the real file is what makes this a fidelity check — a
// second hardcoded copy of the path data could drift with the mark and still
// pass.
function scrapedMark(file) {
  const raw = fs.readFileSync(path.join(ICON_DIR, file), 'utf8');
  assert.match(raw, /^<svg [^>]*viewBox="/, `${file} was expected to carry a viewBox`);
  const tagEnd = raw.indexOf('>') + 1;
  const tag = raw
    .slice(0, tagEnd)
    .replace(/\bwidth="[^"]*"/, 'width="100%"')
    .replace(/\bheight="[^"]*"/, 'height="100%"');
  return tag + raw.slice(tagEnd);
}

// Removes exactly what svg() injected: the token it merged into the scraped
// class attribute, or the whole attribute it added when the file had none.
function stripInjectedClass(markup, kebab) {
  return markup
    .replace(`class="${kebab}"`, 'class=""')
    .replace(` ${kebab}"`, '"')
    .replace(/ class=""(?=>)/, '');
}

assert.deepStrictEqual(ClaudeMarks.names(), [
  'incognito',
  'reflectBroadcast',
  'spark',
  'voiceActivity',
]);

for (const [key, file] of Object.entries(FILES)) {
  const kebab = KEBAB[key];
  const markup = ClaudeMarks.svg(key);
  assert.ok(markup.length > 0, `${key} must render`);
  assert.ok(ClaudeMarks.names().includes(key), `${key} must be listed by names()`);
  assert.ok(
    markup.includes(`class="${kebab}"`) || markup.includes(` ${kebab}"`),
    `${key} must carry its own file name as a class`,
  );

  // Verbatim: everything but the injected class token must match the scraped
  // file byte for byte.
  assert.strictEqual(
    stripInjectedClass(markup, kebab),
    scrapedMark(file),
    `${file} must survive verbatim — no redrawing, no re-serialising`,
  );
}

// The Claude star's clay fill: the scraped file states it as var(--cds-clay,
// #d97757), so the literal token is the one that has to survive.
assert.match(
  ClaudeMarks.svg('spark'),
  /fill="[^"]*var\(--cds-clay/,
  'the star must keep the clay fill token, not a flattened hex',
);

assert.strictEqual(
  (ClaudeMarks.svg('voiceActivity').match(/<line\b/g) || []).length,
  6,
  'the voice waveform is exactly six bars',
);

assert.strictEqual(ClaudeMarks.svg('nope'), '', 'an unknown mark must render as nothing');
assert.ok(ClaudeMarks.svg('spark').length > 0);

assert.ok(
  ClaudeMarks.svg('spark', { className: 'x' }).includes('class="spark x"'),
  "a caller class name lands after the mark's own",
);
assert.ok(
  ClaudeMarks.svg('incognito', { className: 'x' }).includes('class="group incognito x"'),
  'a caller class name lands after the scraped class too',
);
assert.ok(
  ClaudeMarks.svg('spark', { className: '' }).includes('class="spark"'),
  'an empty class name changes nothing',
);

console.log('claude marks contract ok');
