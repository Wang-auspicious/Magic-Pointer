const assert = require('assert');
const fs = require('fs');

const dashboard = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');

assert(dashboard.includes("'组件源码',"), 'activity timeline must include component source candidates');
assert(dashboard.includes('componentCandidateCount'), 'activity must show bounded candidate count');
assert(dashboard.includes('componentTopConfidence'), 'activity must show top confidence');
assert(dashboard.includes('componentAutoModificationAllowed'), 'activity must expose the edit gate');
assert(dashboard.includes('低置信度仅作线索'), 'activity must warn against automatic low-confidence edits');
assert(!dashboard.includes('componentLink.candidates'), 'activity must not render candidate file paths from audit data');

console.log('dashboard component source static test ok');
