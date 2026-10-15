'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const env = {...process.env};
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require('electron'), [path.resolve('scripts/probe_reference_interactions.cjs')], {
  env, encoding: 'utf8', timeout: 45000,
});
assert.equal(result.status, 0, result.stdout + result.stderr);
assert.match(result.stdout, /Reference interactions passed:/);
console.log(result.stdout.trim());
