'use strict';

const assert = require('assert');
const path = require('path');
const { projectRoot } = require('../electron/runtime_paths');

const root = path.resolve(__dirname, '..');
assert.strictEqual(projectRoot(path.join(root, 'electron')), root);
assert.strictEqual(projectRoot(path.join(root, 'build', 'electron')), root);

console.log('runtime paths test ok');
