const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'electron', 'renderer', 'dashboard.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'electron', 'renderer', 'dashboard.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');

assert(html.includes('data-view-target="route"'));
assert(html.includes('id="route-view"'));
assert(html.includes('id="route-origin"'));
assert(html.includes('id="route-destination"'));
assert(html.includes('id="route-swap"'));
assert(html.includes('id="route-open"'));
assert(js.includes('applyRouteDraft'));
assert(js.includes("setActiveView('route')"));
assert(js.includes('window.magicPointerDashboard.openRoute'));
assert(preload.includes("ipcRenderer.send('dashboard:route-open'"));
assert(main.includes("parsed?.intentKind === 'route_draft'"));
assert(main.includes('buildGoogleMapsDirectionsUrl(payload)'));
assert(main.includes("ipcMain.on('dashboard:route-open'"));
assert(!js.includes('innerHTML'));

console.log('route dashboard static test ok');
