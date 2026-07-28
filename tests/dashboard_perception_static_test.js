const assert = require('assert');
const fs = require('fs');

const js = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');
const css = fs.readFileSync('electron/renderer/dashboard.css', 'utf8');
const capture = fs.readFileSync('scripts/capture_dashboard.js', 'utf8');

assert(js.includes("entry.raw.type === 'perception.resolved'"));
assert(js.includes("感知层"));
assert(js.includes("未使用截图"));
assert(js.includes("局部截图兜底"));
assert(css.includes('.perception-event'));
assert(capture.includes("type: 'perception.resolved'"));
assert(capture.includes("selectedLayer: 'uia'"));

console.log('dashboard perception static test ok');
