'use strict';

const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
for (const id of ['voice-resident-enabled', 'voice-memory-limit-mb', 'voice-idle-unload-seconds']) {
  assert(!new RegExp(`<input[^>]+id="${id}"[^>]+disabled`).test(html), `${id} must be enabled by the resident runtime`);
}
assert(html.includes('id="voice-resident-status"'));
assert(html.includes('状态由本地运行时回传'));

console.log('voice_residency_dashboard_truth_test: all assertions passed');
