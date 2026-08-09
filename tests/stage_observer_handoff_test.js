'use strict';

const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.ts', 'utf8');
const begin = main.slice(
  main.indexOf('function beginSelectionSession('),
  main.indexOf('app.whenReady().then('),
);

assert.match(
  begin,
  /function beginSelectionSession[\s\S]{0,2600}?hideOverlay\(\);/,
  'normal activation must remove any stale observer canvas before capture',
);
assert.doesNotMatch(
  begin,
  /showOverlay\(/,
  'normal target capture must not repaint a full-display observer canvas',
);

console.log('stage_observer_handoff_test: all assertions passed');
