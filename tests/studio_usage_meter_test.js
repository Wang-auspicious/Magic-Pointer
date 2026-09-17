'use strict';

/* 上下文卡的类别拆分：条上几段相邻、一段一个颜色，图例一行一个类别。
   这里钉三件事——
     1. 四个类别各自的段类和行填充类都在，且用的是四个不同的色 token；
     2. 缺键的类别不产生段、也不产生行（不是零宽的彩色小条）；
     3. 拆分和宽度的算术真能跑对（新输入 = 输入 − 命中 − 写入，负数按 0）。
   彩色的那层光看源码看不出来，所以算术直接从 studio.ts 里抠出来执行。 */

const assert = require('node:assert');
const fs = require('node:fs');
const { transpileModule } = require('typescript');

const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const tokens = fs.readFileSync('electron/renderer/claude_tokens.css', 'utf8');
const chatCss = fs.readFileSync('electron/renderer/claude_chat.css', 'utf8');

/* ---- 把类别定义和两个纯函数从 classic script 里抠出来执行 ---- */
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

/* ---- 算术：四个类别怎么拆 ---- */
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

/* 常见路径：provider 不报缓存。两条类别，不是四条，也不是四条里两条为零。 */
assert.deepStrictEqual(
  usageCategoryRows({ inputTokens: 1842, outputTokens: 286, totalTokens: 2128 }),
  [
    { kind: 'input', label: '新输入', value: 1842 },
    { kind: 'output', label: '输出', value: 286 },
  ],
  'without cache numbers the card falls back to the two categories that did arrive',
);

/* 只报了缓存命中、没报输入总量：命中就是命中，新输入那行不该凭空出现。 */
assert.deepStrictEqual(
  usageCategoryRows({ cacheReadTokens: 500, outputTokens: 10 }).map((row) => row.kind),
  ['cache-read', 'output'],
);
assert.deepStrictEqual(
  usageCategoryRows({ cacheReadTokens: 500, outputTokens: 10 }).map((row) => row.value),
  [500, 10],
);

/* 报了但为零：不画。零宽的彩色段读起来像「这里有东西」。 */
assert.deepStrictEqual(usageCategoryRows({ inputTokens: 100, cacheReadTokens: 0, outputTokens: 0 }), [
  { kind: 'input', label: '新输入', value: 100 },
]);
assert.deepStrictEqual(usageCategoryRows({ cacheReadTokens: 0 }), []);

/* 缓存比输入总量还大（provider 口径不同）：新输入按 0，不为负，也不出段。 */
assert.deepStrictEqual(
  usageCategoryRows({ inputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 50, outputTokens: 5 }),
  [
    { kind: 'cache-read', label: '缓存命中', value: 400 },
    { kind: 'cache-write', label: '缓存写入', value: 50 },
    { kind: 'output', label: '输出', value: 5 },
  ],
  'a fresh-input count cannot go negative',
);

/* 什么都没有：整卡没有类别，而不是四条零。 */
assert.deepStrictEqual(usageCategoryRows(undefined), []);
assert.deepStrictEqual(usageCategoryRows({}), []);
assert.deepStrictEqual(usageCategoryRows({ totalTokens: 20 }), [], 'a total alone is not a category');

/* 非数、NaN、Infinity 都不算数——那和缺键是同一回事。 */
assert.deepStrictEqual(usageCategoryRows({ inputTokens: '100', outputTokens: null }), []);
assert.deepStrictEqual(usageCategoryRows({ inputTokens: NaN, outputTokens: Infinity }), []);

/* ---- 宽度算术：几段之和就是已用的那部分，零类别贡献零 ---- */
const width = (value, window_) => Number.parseFloat(usageSegmentShare(value, window_));
const rows = usageCategoryRows({ inputTokens: 1000, cacheReadTokens: 600, cacheWriteTokens: 100, outputTokens: 50 });
const segmentsWidth = rows.reduce((total, row) => total + width(row.value, 4000), 0);
assert.strictEqual(
  segmentsWidth,
  (600 + 100 + 300 + 50) / 4000 * 100,
  'the segments sum to the used share of the window — nothing is double counted or dropped',
);
/* 命中 + 写入 + 新输入 = 输入总量，正是标头那个百分比数的东西。 */
assert.strictEqual(
  width(600, 4000) + width(100, 4000) + width(300, 4000),
  width(1000, 4000),
  'the three input-side categories add back up to the header figure',
);
assert.strictEqual(width(0, 4000), 0, 'a zero category contributes no width');
assert.strictEqual(width(5000, 4000), 100, 'a segment longer than the window is clamped to the whole bar');
assert.strictEqual(usageSegmentShare(10, 0), '0%', 'no window means no proportional bar');

/* ---- 样式：一段一个颜色，不是一条一个色 ---- */
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

/* 四个 token 在明暗两套里都要在，且四个值两两不同——这正是之前坏掉的地方：
   两行都读 --mp-focus，扫过去像同一件事的两半。 */
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

/* ---- 渲染：段和图例都由类别行驱动 ---- */
assert(source.includes('mp-usage-seg is-${row.kind}'), 'bar segments are classed per category');
assert(source.includes("segment.setAttribute('data-kind', row.kind)"), 'each segment names its category');
assert(source.includes('usageSegmentShare(row.value, contextWindow)'), 'segment width comes from the shared formula');
assert(source.includes("fill.setAttribute('data-kind', row.kind)"), 'each legend row names its category');
assert(!source.includes("['input', '读取上下文', inputTokens]"),
  'the two hardcoded rows are gone; the legend follows the categories that arrived');
assert(!source.includes("el('span', 'mp-usage-seg is-input')"),
  'the bar no longer draws a fixed input segment before looking at the numbers');
/* 标头的百分比和夹取没动：最新一轮的输入，比例不夹、只有宽度夹。 */
assert(source.includes('const contextTokens = Number(latestUsage?.inputTokens) || 0;'));
assert(source.includes('const contextProgress = Math.max(0, Math.min(100, Math.round(contextRatio)));'));

console.log('studio usage meter test ok');
