const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dashboard = fs.readFileSync(path.join(__dirname, '..', 'electron', 'renderer', 'dashboard.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'electron', 'renderer', 'dashboard.html'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

assert(dashboard.includes("entry.raw.type === 'browser.evidence'"), 'activity must recognize safe browser evidence events');
assert(dashboard.includes("planned?.browserEvidenceState"), 'plan timeline must render browser evidence state');
assert(dashboard.includes("'浏览器',"), 'plan timeline must include a browser stage');
assert(dashboard.includes('browserNetworkFailureCount'), 'browser stage must show observed network failure count');
assert(dashboard.includes('browserCoordinatesObserved'), 'browser stage must distinguish mapped coordinates');
assert(!dashboard.includes('browserContext.selector'), 'activity must not render raw selectors from audit data');
assert(html.includes('id="browser-devtools-enabled"'), 'connections page needs a persisted browser toggle');
assert(html.includes('id="browser-cdp-endpoints"'), 'connections page needs explicit loopback endpoints');
assert(html.includes('id="browser-bridge-state"'), 'browser state must have a live target');
assert(html.includes('id="browser-status-refresh"'), 'browser status must be refreshable');
assert(dashboard.includes("fabricRequest('browser.status')"), 'connections page must request real browser status');
assert(dashboard.includes("operation === 'browser.status'"), 'dashboard must render browser status results');
assert(main.includes("'browser.status'"), 'desktop bridge must allow the bounded status operation');
assert(!html.includes('<b>Browser Bridge</b><small>DOM、网络错误和下载审批</small></span><em class="state state-ready">本机</em>'), 'browser bridge cannot be hard-coded online');

console.log('dashboard browser evidence static test ok');
