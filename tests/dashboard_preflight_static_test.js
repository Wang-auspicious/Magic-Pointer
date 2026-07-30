const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
const js = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');
const css = fs.readFileSync('electron/renderer/dashboard.css', 'utf8');

for (const id of [
  'preflight-run',
  'preflight-status',
  'preflight-list',
  'preflight-progress',
  'preflight-progress-fill',
  'preflight-progress-value',
  'preflight-current-step',
]) assert(html.includes(`id="${id}"`), id);
assert(js.includes("fabricRequest('preflight.run')"));
assert(js.includes('function renderPreflight'));
assert(js.includes('api.onPreflightEvent'));
assert(js.includes('function renderPreflightEvent'));
assert(!js.includes('payload.autoRunPreflight === true'),
  'dashboard diagnostics must not impersonate first-run onboarding');
assert(css.includes('.preflight-row'));
assert(css.includes('.preflight-progress'));

console.log('dashboard preflight static test ok');
