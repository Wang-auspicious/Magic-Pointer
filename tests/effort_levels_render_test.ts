const assert = require('node:assert');
const { EFFORT_LEVELS, normalizeEffort, effortOption } = require('../electron/renderer/effort_levels');

assert.deepStrictEqual(
  EFFORT_LEVELS.map((row: { value: string }) => row.value),
  ['low', 'medium', 'high', 'xhigh', 'max'],
);
assert.deepStrictEqual(
  EFFORT_LEVELS.map((row: { label: string }) => row.label),
  ['Low', 'Medium', 'High', 'Extra', 'Max'],
);
assert.deepStrictEqual(
  EFFORT_LEVELS.map((row: { description: string }) => row.description),
  [
    'Quick replies to simple questions',
    'Light, casual tasks',
    'Balanced for everyday work',
    'Complex, detailed work',
    'The hardest problems. Takes longest.',
  ],
);
assert.strictEqual(normalizeEffort('xhigh'), 'xhigh');
assert.strictEqual(normalizeEffort(' MAX '), 'max');
assert.strictEqual(normalizeEffort('bogus'), 'high');
assert.strictEqual(effortOption('xhigh').label, 'Extra');
assert.strictEqual(effortOption('bogus').value, 'high');

console.log('effort levels render contract ok');
