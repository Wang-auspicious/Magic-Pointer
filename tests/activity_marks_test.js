'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const ActivityMarks = require('../electron/renderer/activity_marks');

const KEBAB = {
  spark: 'spark',
  voiceActivity: 'voice-activity',
  incognito: 'incognito',
  reflectBroadcast: 'reflect-broadcast',
};

assert.deepStrictEqual(ActivityMarks.names(), [
  'incognito',
  'reflectBroadcast',
  'spark',
  'voiceActivity',
]);

for (const key of ActivityMarks.names()) {
  const kebab = KEBAB[key];
  const markup = ActivityMarks.svg(key);
  assert.ok(markup.length > 0, `${key} must render`);
  assert.ok(ActivityMarks.names().includes(key), `${key} must be listed by names()`);
  assert.ok(
    markup.includes(`class="${kebab}"`) || markup.includes(` ${kebab}"`),
    `${key} must carry its own file name as a class`,
  );

  assert.match(markup, /^<svg [^>]*viewBox="/, `${key} needs a scalable viewport`);
  assert.match(markup, /width="100%"/);
  assert.match(markup, /height="100%"/);
  assert.match(markup, /<(?:path|line|circle|rect)\b/, `${key} needs visible geometry`);
}

assert.match(
  ActivityMarks.svg('spark'),
  /fill="[^"]*var\(--cds-clay/,
  'the star must keep the clay fill token, not a flattened hex',
);

assert.strictEqual(
  (ActivityMarks.svg('voiceActivity').match(/<line\b/g) || []).length,
  6,
  'the voice waveform is exactly six bars',
);

assert.strictEqual(ActivityMarks.svg('nope'), '', 'an unknown mark must render as nothing');
assert.ok(ActivityMarks.svg('spark').length > 0);

assert.ok(
  ActivityMarks.svg('spark', { className: 'x' }).includes('class="spark x"'),
  "a caller class name lands after the mark's own",
);
assert.ok(
  ActivityMarks.svg('incognito', { className: 'x' }).includes('class="group incognito x"'),
  'a caller class name lands after the scraped class too',
);
assert.ok(
  ActivityMarks.svg('spark', { className: '' }).includes('class="spark"'),
  'an empty class name changes nothing',
);

console.log('activity marks contract ok');

const animation = ActivityMarks.spark('thinking');
assert.match(animation, /data-cds-spark-strip/);
assert.match(animation, /spark-thinking\.svg/);
assert.doesNotMatch(animation, /rotate/);
assert.match(ActivityMarks.spark('idle'), /m19\.6 66\.5/);
const animationCss = fs.readFileSync('electron/renderer/chat_styles.css', 'utf8');
assert.doesNotMatch(animationCss, /mp-thinking-spin|rotate\(360deg\)/, 'the Claude Spark is a frame strip, never a spinner');
