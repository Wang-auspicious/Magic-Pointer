const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'electron', 'renderer', 'dashboard.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'electron', 'renderer', 'dashboard.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'electron', 'renderer', 'dashboard.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');

assert(html.includes('data-view="shopping-list"'));
assert(html.includes('id="shopping-items"'));
assert(html.includes('id="dashboard-close"'));
assert(css.includes('.shopping-item.is-highlighted'));
assert(css.includes('@media (prefers-reduced-motion: reduce)'));
assert(js.includes("window.magicPointerDashboard.requestState"));
assert(js.includes("window.magicPointerDashboard.setChecked"));
assert(js.includes("window.magicPointerDashboard.undoAdd"));
assert(js.includes('textContent'));
assert(!js.includes('innerHTML'));
// Activity timeline contract: per-action stages, honest queued state, verbatim statuses.
assert(html.includes('id="activity-list"'));
assert(html.includes('activity-timeline'));
assert(html.includes('尚未完成'));
for (const stage of ["'意图'", "'计划'", "'状态'", "'验证'", "'撤销'"]) assert(js.includes(stage), stage);
assert(js.includes('buildActivityTimeline'));
assert(js.includes("timelineStage('状态', 'is-accepted'"));
assert(js.includes("accepted: '已受理 · 排队中 · 尚未完成'"));
// Verbatim principle: raw status token rendered directly, never re-mapped.
assert(js.includes('statusCode.textContent = rawStatus'));
assert(!/accepted['"]?\s*[:=]\s*['"](?:succeeded|done|完成|已完成)/.test(js), 'accepted must never be remapped to a terminal state');
assert(!html.includes('<progress'), 'no fake progress element in the dashboard');
assert(!/progress\s*[:=(]/.test(js), 'no fake progress computation in the activity timeline');
for (const cls of ['.timeline-entry', '.timeline-stage.is-accepted', '.timeline-status[data-status="accepted"]', '.timeline-stage.is-failed']) {
  assert(css.includes(cls), cls);
}
assert(preload.includes("contextBridge.exposeInMainWorld('magicPointerDashboard'"));
assert(main.includes("globalShortcut.register('Control+Alt+D'"));
assert(main.includes("'dashboard:show'"));
assert(main.includes('showDashboard({ highlightItemId'));

console.log('dashboard static test ok');
