const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dashboard = fs.readFileSync(path.join(__dirname, '..', 'electron', 'renderer', 'dashboard.js'), 'utf8');

assert(dashboard.includes("planned?.terminalEvidenceState"), 'activity timeline must render terminal evidence state');
assert(dashboard.includes("'终端',"), 'activity timeline must include a terminal evidence stage');
assert(dashboard.includes('terminalExitCodeObserved'), 'terminal stage must distinguish observed from unknown exit codes');
assert(dashboard.includes('terminalWindowLineCount'), 'terminal stage must show the bounded log window size');
assert(!dashboard.includes('terminalExcerpt}`'), 'activity UI must not render raw terminal excerpts');

console.log('dashboard terminal evidence static test ok');
