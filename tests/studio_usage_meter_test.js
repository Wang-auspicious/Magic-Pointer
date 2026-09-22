'use strict';


const assert = require('node:assert');
const fs = require('node:fs');
const { transpileModule } = require('typescript');

const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const tokens = fs.readFileSync('electron/renderer/theme_tokens.css', 'utf8');
const chatCss = fs.readFileSync('electron/renderer/chat_styles.css', 'utf8');

const start = source.indexOf('const USAGE_CATEGORIES = [');
const end = source.indexOf('function renderUsageMeter(');
assert(start > 0, 'missing USAGE_CATEGORIES');
assert(end > start, 'missing renderUsageMeter');
const snippet = source.slice(start, end);
const compiled = transpileModule(
  `${snippet}\nreturn { USAGE_CATEGORIES, usageCategoryRows, usageSegmentShare };`,
  { compilerOptions: { target: 'ES2022', module: 'None' } },
).outputText;
const { USAGE_CATEGORIES, usageCategoryRows, usageSegmentShare } = new Function(compiled)();

const KINDS = ['cache-read', 'cache-write', 'input', 'output'];
assert.deepStrictEqual(
  USAGE_CATEGORIES.map((category) => category.kind),
  KINDS,
  'the bar reads cache hit → cache write → new input → output, in that order',
);
assert.deepStrictEqual(
  USAGE_CATEGORIES.map((category) => category.label),
  ['缓存命中', '缓存写入', '新输入', '输出'],
);

assert.deepStrictEqual(
  usageCategoryRows({ inputTokens: 1000, cacheReadTokens: 600, cacheWriteTokens: 100, outputTokens: 50 }),
  [
    { kind: 'cache-read', label: '缓存命中', value: 600 },
    { kind: 'cache-write', label: '缓存写入', value: 100 },
    { kind: 'input', label: '新输入', value: 300 },
    { kind: 'output', label: '输出', value: 50 },
  ],
  'new input is the part of the prompt that was neither read from nor written to the cache',
);

assert.deepStrictEqual(
  usageCategoryRows({ inputTokens: 1842, outputTokens: 286, totalTokens: 2128 }),
  [
    { kind: 'input', label: '新输入', value: 1842 },
    { kind: 'output', label: '输出', value: 286 },
  ],
  'without cache numbers the card falls back to the two categories that did arrive',
);

assert.deepStrictEqual(
  usageCategoryRows({ cacheReadTokens: 500, outputTokens: 10 }).map((row) => row.kind),
  ['cache-read', 'output'],
);
assert.deepStrictEqual(
  usageCategoryRows({ cacheReadTokens: 500, outputTokens: 10 }).map((row) => row.value),
  [500, 10],
);

assert.deepStrictEqual(usageCategoryRows({ inputTokens: 100, cacheReadTokens: 0, outputTokens: 0 }), [
  { kind: 'input', label: '新输入', value: 100 },
]);
assert.deepStrictEqual(usageCategoryRows({ cacheReadTokens: 0 }), []);

assert.deepStrictEqual(
  usageCategoryRows({ inputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 50, outputTokens: 5 }),
  [
    { kind: 'cache-read', label: '缓存命中', value: 400 },
    { kind: 'cache-write', label: '缓存写入', value: 50 },
    { kind: 'output', label: '输出', value: 5 },
  ],
  'a fresh-input count cannot go negative',
);

assert.deepStrictEqual(usageCategoryRows(undefined), []);
assert.deepStrictEqual(usageCategoryRows({}), []);
assert.deepStrictEqual(usageCategoryRows({ totalTokens: 20 }), [], 'a total alone is not a category');

assert.deepStrictEqual(usageCategoryRows({ inputTokens: '100', outputTokens: null }), []);
assert.deepStrictEqual(usageCategoryRows({ inputTokens: NaN, outputTokens: Infinity }), []);

const width = (value, window_) => Number.parseFloat(usageSegmentShare(value, window_));
const rows = usageCategoryRows({ inputTokens: 1000, cacheReadTokens: 600, cacheWriteTokens: 100, outputTokens: 50 });
const segmentsWidth = rows.reduce((total, row) => total + width(row.value, 4000), 0);
assert.strictEqual(
  segmentsWidth,
  (600 + 100 + 300 + 50) / 4000 * 100,
  'the segments sum to the used share of the window — nothing is double counted or dropped',
);
assert.strictEqual(
  width(600, 4000) + width(100, 4000) + width(300, 4000),
  width(1000, 4000),
  'the three input-side categories add back up to the header figure',
);
assert.strictEqual(width(0, 4000), 0, 'a zero category contributes no width');
assert.strictEqual(width(5000, 4000), 100, 'a segment longer than the window is clamped to the whole bar');
assert.strictEqual(usageSegmentShare(10, 0), '0%', 'no window means no proportional bar');

for (const kind of KINDS) {
  assert.match(
    chatCss,
    new RegExp(`\\.mp-usage-seg\\.is-${kind}\\s*\\{[^}]*background:\\s*var\\(--mp-usage-${kind}\\)`, 's'),
    `the ${kind} segment paints itself with its own token`,
  );
  assert.match(
    chatCss,
    new RegExp(`\\.mp-usage-row-fill\\[data-kind='${kind}'\\]\\s*\\{[^}]*background:\\s*var\\(--mp-usage-${kind}\\)`, 's'),
    `the ${kind} legend row paints its fill with the same token as its segment`,
  );
}

const tokenValues = (block) => {
  const found = {};
  for (const kind of KINDS) {
    const match = block.match(new RegExp(`--mp-usage-${kind}:\\s*([^;]+);`));
    assert(match, `--mp-usage-${kind} is declared in this theme block`);
    found[kind] = match[1].trim();
  }
  return found;
};
const lightBlock = tokens.slice(tokens.indexOf(':root {'), tokens.indexOf(':root[data-theme="dark"]'));
const darkBlock = tokens.slice(tokens.indexOf(':root[data-theme="dark"]'));
for (const [theme, block] of [['light', lightBlock], ['dark', darkBlock]]) {
  const values = tokenValues(block);
  const distinct = new Set(Object.values(values));
  assert.strictEqual(
    distinct.size,
    KINDS.length,
    `the four ${theme}-theme category colours must be four different colours, got ${JSON.stringify(values)}`,
  );
}

assert(source.includes('mp-usage-seg is-${row.kind}'), 'bar segments are classed per category');
assert(source.includes("segment.setAttribute('data-kind', row.kind)"), 'each segment names its category');
assert(source.includes('usageSegmentShare(row.value, contextWindow)'), 'segment width comes from the shared formula');
assert(source.includes('fill.dataset.kind = row.kind'), 'each legend row names its category');
assert(!source.includes("['input', '读取上下文', inputTokens]"),
  'the two hardcoded rows are gone; the legend follows the categories that arrived');
assert(!source.includes("el('span', 'mp-usage-seg is-input')"),
  'the bar no longer draws a fixed input segment before looking at the numbers');
assert(source.includes('const contextTokens = Number(latestUsage?.contextTokens) || 0;'));
assert(source.includes('const contextProgress = Math.max(0, Math.min(100, Math.round(contextRatio)));'));

console.log('studio usage meter test ok');
