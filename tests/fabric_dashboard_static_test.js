const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
const css = fs.readFileSync('electron/renderer/dashboard.css', 'utf8');
const tokens = fs.readFileSync('electron/renderer/tokens.css', 'utf8');
const js = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');
const preload = fs.readFileSync('electron/preload.js', 'utf8');
const main = fs.readFileSync('electron/main.js', 'utf8');

for (const view of [
  'general', 'activation', 'voice', 'shortcuts', 'models', 'agents', 'capabilities',
  'apps', 'permissions', 'connections', 'storage', 'activity', 'privacy', 'appearance',
  'accessibility', 'diagnostics',
]) {
  assert(html.includes(`data-view-target="${view}"`), view);
  assert(html.includes(`data-fabric-view="${view}"`), view);
}
for (const id of [
  'wiggle-enabled',
  'wiggle-sensitivity',
  'default-input-mode',
  'voice-auto-submit',
  'voice-language',
  'voice-output-mode',
  'voice-hallucination-guard',
  'voice-silence-ms',
  'voice-glossaries',
  'fallback-hotkey-enabled',
  'disabled-apps',
  'provider-list',
  'preferred-agent',
  'recipe-list',
  'activity-list',
  'artifact-list',
  'artifact-cleanup',
  'artifact-cleanup-status',
  'default-capture-mode',
  'app-capture-modes',
  'retain-artifacts-days',
  'permission-scopes',
  'settings-save',
]) assert(html.includes(`id="${id}"`), id);

assert(tokens.includes('--mp-blue:'));
assert(tokens.includes('--mp-canvas:'));
assert(css.includes('@media (prefers-reduced-motion: reduce)'));
assert(!css.includes('purple'));
assert(!css.includes('Inter'));
assert(!css.includes('Consolas'));
assert(!css.includes('repeating-linear-gradient'));

assert(js.includes('requestFabricState'));
assert(js.includes("fabricRequest('catalog'"));
assert(js.includes("fabricRequest('providers'"));
assert(js.includes("fabricRequest('settings.get'"));
assert(js.includes("fabricRequest('audit.tail'"));
assert(js.includes("fabricRequest('artifacts.list'"));
assert(js.includes("fabricRequest('artifacts.cleanup'"));
assert(js.includes("fabricRequest('artifacts.restore'"));
assert(js.includes('saveFabricSettings'));
assert(js.includes('renderProviders'));
assert(js.includes('renderRecipes'));
assert(js.includes('renderArtifacts'));
assert(js.includes('dataset.recipeEnabled'));
assert(js.includes('next.recipe_enabled'));
assert(js.includes('privacy.default_capture_mode'));
assert(js.includes('privacy.app_capture_modes'));
assert(js.includes('parseCaptureModeRules'));
assert(js.includes('formatCaptureModeRules'));
assert(js.includes('parsePermissionScopes'));
assert(js.includes('formatPermissionScopes'));
assert(js.includes('parseVoiceGlossaries'));
assert(js.includes('formatVoiceGlossaries'));
assert(js.includes("fabricRequest('calibration.start')"));
assert(!js.includes('innerHTML'));

assert(preload.includes('fabricRequest'));
assert(preload.includes('saveFabricSettings'));
assert(preload.includes('onFabricState'));
assert(main.includes("'scripts/fabric_bridge.py'"));
assert(main.includes("'dashboard:fabric-request'"));
assert(main.includes("'dashboard:fabric-state'"));
assert(main.includes("operation === 'calibration.start'"));
assert(main.includes('wiggleDetector.startCalibration'));
assert(main.includes('wiggleDetector.finishCalibration'));

const timelineStart = js.indexOf('function buildActivityTimeline');
const timelineEnd = js.indexOf('function activityTimestamp');
assert(timelineStart >= 0, 'buildActivityTimeline not found');
assert(timelineEnd > timelineStart, 'buildActivityTimeline block end not found');
const timelineContext = {};
vm.runInNewContext([
  js.slice(timelineStart, timelineEnd),
  `globalThis.timeline = buildActivityTimeline([
    { type: 'recipe.planned', data: { planId: 'plan-a', recipeId: 'agent.handoff', provider: 'agent.task' } },
    { type: 'recipe.planned', data: { planId: 'plan-b', recipeId: 'agent.handoff', provider: 'agent.task' } },
    { type: 'recipe.executed', data: { planId: 'plan-a', receiptId: 'receipt-a', recipeId: 'agent.handoff', provider: 'agent.task' } },
  ]);`,
].join('\n'), timelineContext, { filename: 'fabric_dashboard_timeline_test.vm.js' });
assert.strictEqual(timelineContext.timeline[0].executed.data.receiptId, 'receipt-a');
assert.strictEqual(timelineContext.timeline[1].executed, null);

console.log('fabric dashboard static test ok');
