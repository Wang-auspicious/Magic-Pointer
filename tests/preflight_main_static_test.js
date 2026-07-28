const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

assert(main.includes("require('./bootstrap_runner')"));
assert(main.includes("require('./preflight_checks')"));
assert(main.includes("path.join(ROOT, 'data', 'preflight_manifest.v1.json')"));
assert(main.includes("markerPath: path.join(FABRIC_DATA_DIR, 'onboarding.json')"));
assert(main.includes("if (operation === 'preflight.run')"));
assert(main.includes('microphonePermissionStatus'));
assert(pkg.scripts.test.includes('preflight_checks_test.js'));

console.log('preflight main static test ok');
