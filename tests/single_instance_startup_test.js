const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('electron/main.ts', 'utf8');

assert.match(source, /const gotLock = app\.requestSingleInstanceLock\(\)/);
assert.match(source, /if \(!gotLock\)\s*\{\s*app\.quit\(\)/);
assert.match(source, /app\.on\('second-instance'/);
assert.match(
  source,
  /if \(gotLock\) app\.whenReady\(\)\.then\(/,
  'the losing instance must never enter readiness initialization',
);

console.log('single-instance startup contract passed');
