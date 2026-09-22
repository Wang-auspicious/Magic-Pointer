'use strict';


const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const css = fs.readFileSync('electron/renderer/studio_artifacts.css', 'utf8');

const viewStart = html.indexOf('id="view-artifacts"');
assert(viewStart > 0, 'the artifacts view exists');
const view = html.slice(viewStart, html.indexOf('<section', viewStart));
assert(view.length > 200, 'the artifacts view slice actually captured the section');

assert.match(html, /href="studio_artifacts\.css\?v=1"/, 'the artifacts stylesheet is linked with a cache-buster');
assert(
  html.indexOf('chat_styles.css') < html.indexOf('studio_artifacts.css'),
  'the artifacts sheet loads after the shared sheets so its rules win',
);

assert.match(
  css,
  /\.mp-shell\[data-view="artifacts"\] \.workspace-header h1\s*\{[^}]*font-family:\s*var\(--mp-font-serif\)/s,
  'the page title uses the existing serif token',
);

assert.strictEqual((view.match(/data-artifact-scope=/g) || []).length, 2, 'exactly two scope tabs');
assert.match(view, /data-artifact-scope="all"[\s\S]*?data-artifact-scope="mine"/);
assert(!/Shared with you|共享/.test(view), 'the reference tab with no data behind it is not built');
assert(!/收藏/.test(view), 'there is no favourite field on an artifact, so no favourite tab');
assert.match(css, /\.mp-artifact-tab\.is-on[\s\S]*?background:\s*var\(--mp-active\)/, 'the selected tab is a filled pill');

assert.match(view, /id="artifact-search-toggle"[^>]*aria-label="搜索产物"/);
assert(view.includes('href="#ic-search"'), 'the search button reuses the existing sprite icon');
assert.match(view, /id="artifact-layout-toggle"[^>]*aria-label="切换为网格布局"/);
assert(view.includes('href="#ic-layout-grid"'));
assert.match(view, /id="artifact-kind-trigger"[\s\S]*?id="artifact-kind-label">全部类型</, 'the type control reads 全部类型');
assert(view.includes('href="#ic-chev"'), 'the type control carries a chevron');
assert.match(view, /id="artifact-kind-trigger"[^>]*aria-haspopup="menu"/);
assert(view.includes('id="artifact-kind-menu"'));

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

assert(source.includes('function artifactDayKey(at: number)'));
assert(source.includes("? artifactDayKey(at) : '更早'"), 'a timestamp-less entry still lands in a group');
assert(source.includes('按「第一次出现的日期」排序') || source.includes('groups.push({ label, items: bucket })'),
  'groups keep the newest-first order of the cache');

assert(source.includes('function artifactEmptyMarkup(message: string)'));
assert.match(source, /host\.innerHTML = artifactEmptyMarkup\('还没有产物/);
assert(!source.includes("emptyStateMarkup('ic-docs'"), 'the empty state no longer draws the giant pictogram');

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

assert(!source.includes('class="card artifact enter"'), 'the unstyled card markup is gone');
assert(!source.includes("icon('ic-code')}</span>"), 'the tile no longer hardcodes the code pictogram for every kind');

console.log('studio artifacts contract test ok');
