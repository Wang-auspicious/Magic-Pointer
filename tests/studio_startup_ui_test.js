'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require('electron'), [path.resolve('scripts/probe_studio_startup.cjs')], {
  cwd: path.resolve('.'), env, encoding: 'utf8', timeout: 35000,
});
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
const witness = JSON.parse(result.stdout.split(/\r?\n/).find(line => line.startsWith('{"model":')) || '{}');
assert.deepEqual(witness.failures, []);
console.log('Studio startup model race, Work/Design navigation and canvas/list Chromium layout passed');
