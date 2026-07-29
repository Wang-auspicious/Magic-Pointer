const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
const js = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');
const css = fs.readFileSync('electron/renderer/dashboard.css', 'utf8');

assert(html.includes('id="first-run-notice"'), 'first-run notice is present');
assert(html.includes('尚未启用全局唤醒'), 'global wake stays visibly disabled');
assert(html.includes('运行全部检查后启用'), 'the enablement path is explicit');
assert(html.includes('可从托盘退出'), 'the exit path is explicit');

assert(js.includes('payload.onboardingRequired === true'), 'main-process onboarding state is consumed');
assert(js.includes('function setFirstRunState'), 'first-run state has a dedicated renderer');
assert(js.includes("setActiveView('diagnostics')"), 'first run is routed to diagnostics');
assert(js.indexOf("setActiveView('activation');") < js.indexOf('api.onShow((payload = {}) =>'),
  'default view initialization must not overwrite a first-run show event');
assert(css.includes('.first-run-notice'), 'first-run notice has dedicated restrained styling');

const typographyIndex = html.indexOf('typography.css');
const dashboardCssIndex = html.indexOf('dashboard.css');
assert(typographyIndex > dashboardCssIndex, 'shared typography remains the final font authority');

console.log('first-run onboarding test ok');
