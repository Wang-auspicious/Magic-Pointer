'use strict';

const assert = require('assert');
const { runDeterministicWiggleEvidence } = require('../electron/wiggle_reliability');

const evidence = runDeterministicWiggleEvidence({ expectedTrials: 100 });
assert.strictEqual(evidence.evidenceClass, 'deterministic_detector_regression');
assert.strictEqual(evidence.intentsCompleted, 100);
assert.strictEqual(evidence.backgroundTrials, 100);
assert.strictEqual(evidence.hits, 100);
assert.strictEqual(evidence.misses, 0);
assert.strictEqual(evidence.falseTriggers, 0);
assert.strictEqual(evidence.pass, true);
assert.strictEqual(evidence.physicalInputValidated, false);
assert.strictEqual(evidence.releaseGatePass, false);
assert.strictEqual('points' in evidence, false);
assert.strictEqual('trajectory' in evidence, false);

console.log('wiggle reliability integration test ok');
