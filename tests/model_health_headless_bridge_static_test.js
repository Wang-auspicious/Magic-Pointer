'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

assert(main.includes("if (!options.allowWithoutSurface && !resultTargetWindow(target)) return;"));
assert(main.includes('allowWithoutSurface: true,'));

console.log('model_health_headless_bridge_static_test: OK');
