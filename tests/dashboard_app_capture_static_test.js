const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
const css = fs.readFileSync('electron/renderer/dashboard.css', 'utf8');
const js = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');

for (const id of ['default-capture-mode', 'upload-screenshots', 'app-policy-add', 'app-policy-list', 'app-capture-modes']) {
  assert(html.includes(`id="${id}"`), id);
}
for (const label of ['只读结构 · UIA / AX / DOM', '允许本机 OCR', '允许本地截图', '允许截图外发', '永不捕获']) {
  assert(js.includes(label), label);
}
for (const contract of [
  'function createAppPolicyRow',
  'function renderCaptureModeRules',
  'function serializedCaptureModeRules',
  'renderCaptureModeRules(privacy.app_capture_modes)',
  'parseCaptureModeRules(serializedCaptureModeRules())',
]) assert(js.includes(contract), contract);

assert(css.includes('.app-policy-row'));
assert(css.includes('.app-policy-footnote'));
assert(!html.includes('placeholder="1password=deny'));

console.log('dashboard app capture static test ok');
