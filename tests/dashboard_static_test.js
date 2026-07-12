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
assert(preload.includes("contextBridge.exposeInMainWorld('magicPointerDashboard'"));
assert(main.includes("globalShortcut.register('Control+Alt+D'"));
assert(main.includes("'dashboard:show'"));
assert(main.includes('showDashboard({ highlightItemId'));

console.log('dashboard static test ok');
