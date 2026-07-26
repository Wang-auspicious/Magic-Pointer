const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
const css = fs.readFileSync('electron/renderer/dashboard.css', 'utf8');
const js = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');
const preload = fs.readFileSync('electron/preload.js', 'utf8');
const main = fs.readFileSync('electron/main.js', 'utf8');

for (const view of ['activation', 'agents', 'recipes', 'connections', 'privacy', 'activity', 'diagnostics']) {
  assert(html.includes(`data-view-target="${view}"`), view);
  assert(html.includes(`data-fabric-view="${view}"`), view);
}
for (const id of [
  'wiggle-enabled',
  'wiggle-sensitivity',
  'default-input-mode',
  'fallback-hotkey-enabled',
  'disabled-apps',
  'provider-list',
  'preferred-agent',
  'recipe-list',
  'activity-list',
  'settings-save',
]) assert(html.includes(`id="${id}"`), id);

assert(css.includes('--electric: #2f7cff'));
assert(css.includes('--graphite: #111318'));
assert(css.includes('@media (prefers-reduced-motion: reduce)'));
assert(!css.includes('purple'));
assert(!css.includes('Inter'));

assert(js.includes('requestFabricState'));
assert(js.includes("fabricRequest('catalog'"));
assert(js.includes("fabricRequest('providers'"));
assert(js.includes("fabricRequest('settings.get'"));
assert(js.includes("fabricRequest('audit.tail'"));
assert(js.includes('saveFabricSettings'));
assert(js.includes('renderProviders'));
assert(js.includes('renderRecipes'));
assert(js.includes('dataset.recipeEnabled'));
assert(js.includes('next.recipe_enabled'));
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

console.log('fabric dashboard static test ok');
