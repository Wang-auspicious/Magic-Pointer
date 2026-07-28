const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
const css = fs.readFileSync('electron/renderer/dashboard.css', 'utf8');
const js = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');
const main = fs.readFileSync('electron/main.js', 'utf8');

const primaryViews = [
  'general', 'activation', 'voice', 'shortcuts', 'models', 'agents', 'capabilities',
  'apps', 'permissions', 'connections', 'storage', 'activity', 'privacy', 'appearance',
  'accessibility', 'diagnostics',
];
for (const view of primaryViews) {
  assert(html.includes(`data-view-target="${view}"`), `missing nav destination: ${view}`);
  assert(html.includes(`data-fabric-view="${view}"`), `missing page surface: ${view}`);
}

for (const contract of [
  'data-app-shell',
  'class="app-titlebar"',
  'id="sidebar-search"',
  'id="theme-select"',
  'id="models-master-list"',
  'class="settings-list"',
]) assert(html.includes(contract), contract);

assert(html.includes('<option value="system">跟随系统</option>'));
assert(html.includes('<option value="light">浅色</option>'));
assert(html.includes('<option value="dark">深色</option>'));

for (const rejected of ['CONTROL PLANE', 'SYSTEM INPUT LAYER', 'WIGGLE FIRST', 'MODEL PROFILES']) {
  assert(!html.includes(rejected), `legacy console copy remains: ${rejected}`);
}
assert(!/data-view-target="[^"]+"><span>0[1-9]<\/span>/.test(html), 'numbered navigation remains');
assert(!css.includes('Consolas'), 'console typography remains');
assert(!css.includes('repeating-linear-gradient'), 'grid background remains');
assert(css.includes('@media (prefers-reduced-motion: reduce)'));
assert(css.includes('@media (prefers-reduced-transparency: reduce)'));
assert(css.includes('env(titlebar-area-height'));

assert(js.includes("let activeView = 'activation'"));
assert(js.includes("general: ['通用'"));
assert(js.includes("models: ['模型'"));
assert(js.includes("capabilities: ['能力与模板'"));
assert(js.includes('applyTheme'));
assert(js.includes('filterSidebar'));
assert(js.includes('pageScroll.scrollLeft = 0'), 'view changes must clear stale horizontal scroll');
assert(css.includes('overflow-x: clip'), 'desktop shell must not expose document-level horizontal scroll');
const referencedIds = [...js.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
const missingIds = [...new Set(referencedIds)].filter(id => !html.includes(`id="${id}"`));
assert.deepStrictEqual(missingIds, [], `dashboard.js references missing DOM ids: ${missingIds.join(', ')}`);

assert(main.includes("titleBarStyle: 'hidden'"));
assert(main.includes('titleBarOverlay'));
assert(main.includes("backgroundMaterial: process.platform === 'win32' ? dashboardMaterial() : undefined"));

console.log('dashboard shell static test ok');
require('./typography_contract_test.js');
