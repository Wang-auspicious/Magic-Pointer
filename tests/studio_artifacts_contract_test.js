'use strict';

/*
 * 产物页的契约。照 claude.ai 的 Artifacts 页搭的是骨架（衬线标题 → tab 行 +
 * 工具条 → 按日期分组的一行一条），但每一件都必须有真数据撑着：
 *   - 参考里的 `Shared with you` 和账户推广没有对应数据，不许冒充可用；
 *     模板可进入真实可编辑的创建需求，不得生成假产物；
 *   - 删除产物没有 IPC，菜单只提供真实打开产物和来源会话的操作；
 *   - 类型筛选只列数据里真有的 kind，不预先编一串类型出来。
 * 另外钉住一个真 bug：产物名是落盘内容的第一行，模型常写成
 * `**验证结果：已通过。**`，旧代码原样打印，页面上就是一串 Markdown 记号。
 */

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const css = fs.readFileSync('electron/renderer/studio_artifacts.css', 'utf8');

/* 只在本节范围内断言：studio.html / studio.ts 的其余部分不是这一页的地盘。 */
const viewStart = html.indexOf('id="view-artifacts"');
assert(viewStart > 0, 'the artifacts view exists');
const view = html.slice(viewStart, html.indexOf('<section', viewStart));
assert(view.length > 200, 'the artifacts view slice actually captured the section');

/* ---- 样式表接线 ---- */
assert.match(html, /href="studio_artifacts\.css\?v=1"/, 'the artifacts stylesheet is linked with a cache-buster');
assert(
  html.indexOf('claude_chat.css') < html.indexOf('studio_artifacts.css'),
  'the artifacts sheet loads after the shared sheets so its rules win',
);

/* ---- 标题：参考里 Artifacts 是页面的衬线大标题 ---- */
assert.match(
  css,
  /\.mp-shell\[data-view="artifacts"\] \.workspace-header h1\s*\{[^}]*font-family:\s*var\(--mp-font-serif\)/s,
  'the page title uses the existing serif token',
);

/* ---- tab 行：只有真能筛的两个 ---- */
assert.strictEqual((view.match(/data-artifact-scope=/g) || []).length, 2, 'exactly two scope tabs');
assert.match(view, /data-artifact-scope="all"[\s\S]*?data-artifact-scope="mine"/);
assert(!/Shared with you|共享/.test(view), 'the reference tab with no data behind it is not built');
assert(!/收藏/.test(view), 'there is no favourite field on an artifact, so no favourite tab');
assert.match(css, /\.mp-artifact-tab\.is-on[\s\S]*?background:\s*var\(--mp-active\)/, 'the selected tab is a filled pill');

/* ---- 工具条 ---- */
assert.match(view, /id="artifact-search-toggle"[^>]*aria-label="搜索产物"/);
assert(view.includes('href="#ic-search"'), 'the search button reuses the existing sprite icon');
assert.match(view, /id="artifact-layout-toggle"[^>]*aria-label="切换为网格布局"/);
assert(view.includes('href="#ic-layout-grid"'));
assert.match(view, /id="artifact-kind-trigger"[\s\S]*?id="artifact-kind-label">全部类型</, 'the type control reads 全部类型');
assert(view.includes('href="#ic-chev"'), 'the type control carries a chevron');
assert.match(view, /id="artifact-kind-trigger"[^>]*aria-haspopup="menu"/);
assert(view.includes('id="artifact-kind-menu"'));

/* ---- 工具条不是摆设：四个状态都落到同一份缓存上 ---- */
assert(source.includes("artifactScope = scope.dataset.artifactScope === 'mine' ? 'mine' : 'all'"));
assert(source.includes("artifactLayout = artifactLayout === 'grid' ? 'list' : 'grid'"));
assert(source.includes('searchInput.addEventListener(\'input\''), 'the search field filters as you type');
assert(
  /const kinds = Array\.from\(new Set\(list\.map\(\(entry\) => String\(entry\.kind \|\| ''\)\)\.filter\(Boolean\)\)\)/.test(source),
  'the type menu is built from the kinds the data actually has',
);
assert(source.includes("const label = kind ? artifactKindLabel(kind) : '全部类型'"));
assert(
  source.includes('function artifactKindLabel(kind: string)') && source.includes('return ARTIFACT_KIND_LABELS[kind] || kind;'),
  'an unknown kind keeps its own name instead of being mapped to an invented one',
);
assert(source.includes('function bindArtifactView()') && source.includes('if (artifactViewBound) return;'),
  'the view binds its handlers once, not once per render');

/* ---- 行：图标块 + 名字 + 右侧灰字；删除路径不存在，所以没有 ⋮ ---- */
assert.match(css, /\.mp-artifact-row\s*\{[^}]*min-height:\s*56px/s, 'rows keep the reference height');
assert.match(
  css,
  /\.mp-artifact-row\s*\{[^}]*grid-template-columns:\s*32px minmax\(120px,\s*1fr\) minmax\(0,\s*auto\)/s,
  'the name column has a floor so a long source line cannot squeeze the title away',
);
assert.match(css, /\.mp-artifact-tile\s*\{[^}]*width:\s*32px[^}]*height:\s*32px/s, 'the icon tile is the reference size');
assert.match(css, /\.mp-artifact-meta\s*\{[^}]*color:\s*var\(--mp-text-muted\)/s, 'the meta column stays muted');
assert.match(css, /\.mp-artifact-group-label\s*\{[^}]*color:\s*var\(--mp-text-muted\)/s, 'group labels are small and muted');
assert(!view.includes('data-artifact-more'), 'no overflow button without a delete path behind it');
assert(!source.includes('data-artifact-delete'), 'nothing wires a delete that does not exist');

/* ---- 日期分组：今天 / 昨天 / 9月13日 ---- */
assert(source.includes('function artifactDayKey(at: number)'));
assert(source.includes("? artifactDayKey(at) : '更早'"), 'a timestamp-less entry still lands in a group');
assert(source.includes('按「第一次出现的日期」排序') || source.includes('groups.push({ label, items: bucket })'),
  'groups keep the newest-first order of the cache');

/* ---- 空态：参考里只有一行灰字 ---- */
assert(source.includes('function artifactEmptyMarkup(message: string)'));
assert.match(source, /host\.innerHTML = artifactEmptyMarkup\('还没有产物/);
assert(!source.includes("emptyStateMarkup('ic-docs'"), 'the empty state no longer draws the giant pictogram');

/* ---- 真 bug：行标题不再原样打印 Markdown ---- */
function extractFunction(name, nextMarker) {
  const start = source.indexOf(`function ${name}(`);
  assert(start > 0, `missing ${name}`);
  const end = source.indexOf(nextMarker, start);
  assert(end > start, `missing the marker that follows ${name}`);
  return source.slice(start, end).trim();
}

const plainLineSource = extractFunction('artifactPlainLine', 'function artifactDayKey(')
  .replace('value: unknown', 'value');
const plainLine = new Function(`${plainLineSource}; return artifactPlainLine;`)();
assert.strictEqual(plainLine('**验证结果：已通过。**'), '验证结果：已通过。', 'the bold wrapper never reaches the row');
assert.strictEqual(plainLine('## 交付说明'), '交付说明');
assert.strictEqual(plainLine('- 一条要点'), '一条要点');
assert.strictEqual(plainLine('1. 第一步'), '第一步');
assert.strictEqual(plainLine('~~作废~~'), '作废');
assert.strictEqual(plainLine('`code` 与 [链接](https://example.test)'), 'code 与 链接');
assert.strictEqual(plainLine(undefined), '');
assert(plainLine('-').length <= 1, 'a lone bullet does not throw');

assert(source.includes('const name = artifactPlainLine(entry.name)'), 'the row title goes through the stripper');
assert(!source.includes('${esc(a.name)}'), 'the old raw-name interpolation is gone');

/* ---- 页头状态栏里的旧标记整块消失 ---- */
assert(!source.includes('class="card artifact enter"'), 'the unstyled card markup is gone');
assert(!source.includes("icon('ic-code')}</span>"), 'the tile no longer hardcodes the code pictogram for every kind');

console.log('studio artifacts contract test ok');
