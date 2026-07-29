const assert = require('assert');
const { WiggleReliabilityRun } = require('../electron/wiggle_reliability');

function expectThrows(action, message) {
  assert.throws(action, TypeError, message);
}

{
  const run = new WiggleReliabilityRun({ runId: 'full-pass' });
  for (let index = 0; index < 100; index += 1) {
    run.recordIntent({ detected: true, latencyMs: index + 1 });
    run.recordBackground({ triggered: false });
  }
  const result = run.finalize();
  assert.deepStrictEqual(result, {
    runId: 'full-pass',
    expected: 100,
    intentsCompleted: 100,
    backgroundTrials: 100,
    hits: 100,
    misses: 0,
    falseTriggers: 0,
    hitRate: 1,
    falseTriggerRate: 0,
    p50: 50.5,
    p95: 95.05,
    complete: true,
    pass: true,
  });
  assert.doesNotThrow(() => JSON.stringify(result));
}

{
  const run = new WiggleReliabilityRun({ runId: 'miss', expectedTrials: 2 });
  run.recordIntent({ detected: true, latencyMs: 12 });
  run.recordIntent({ detected: false });
  run.recordBackground({ triggered: false });
  run.recordBackground({ triggered: false });
  const result = run.finalize();
  assert.strictEqual(result.hits, 1);
  assert.strictEqual(result.misses, 1);
  assert.strictEqual(result.hitRate, 0.5);
  assert.strictEqual(result.complete, true);
  assert.strictEqual(result.pass, false);
}

{
  const run = new WiggleReliabilityRun({ runId: 'false-trigger', expectedTrials: 2 });
  for (let index = 0; index < 2; index += 1) {
    run.recordIntent({ detected: true, latencyMs: 10 });
    run.recordBackground({ triggered: index === 0 });
  }
  const result = run.finalize();
  assert.strictEqual(result.falseTriggers, 1);
  assert.strictEqual(result.falseTriggerRate, 0.5);
  assert.strictEqual(result.pass, false);
}

{
  const run = new WiggleReliabilityRun({ runId: 'incomplete', expectedTrials: 2 });
  run.recordIntent({ detected: true, latencyMs: 10 });
  const result = run.finalize();
  assert.strictEqual(result.complete, false);
  assert.strictEqual(result.pass, false);
}

{
  const run = new WiggleReliabilityRun({ runId: 'percentiles', expectedTrials: 4 });
  for (const latencyMs of [10, 20, 30, 40]) {
    run.recordIntent({ detected: true, latencyMs });
    run.recordBackground({ triggered: false });
  }
  const result = run.finalize();
  assert.strictEqual(result.p50, 25);
  assert.strictEqual(result.p95, 38.5);
}

{
  expectThrows(() => new WiggleReliabilityRun(), 'runId is required');
  expectThrows(() => new WiggleReliabilityRun({ runId: 'contains spaces' }), 'runId is bounded');
  expectThrows(() => new WiggleReliabilityRun({ runId: 'bad', expectedTrials: 0 }), 'expectedTrials must be positive');
  const run = new WiggleReliabilityRun({ runId: 'boundary', expectedTrials: 1 });
  expectThrows(() => run.recordIntent({ detected: 'yes', latencyMs: 1 }), 'detected must be boolean');
  expectThrows(() => run.recordIntent({ detected: true }), 'latencyMs is required');
  expectThrows(() => run.recordIntent({ detected: true, latencyMs: -1 }), 'latencyMs must be non-negative');
  expectThrows(() => run.recordBackground({ triggered: 1 }), 'triggered must be boolean');
  run.recordIntent({ detected: true, latencyMs: 0 });
  run.recordBackground({ triggered: false });
  expectThrows(() => run.recordIntent({ detected: true, latencyMs: 1 }), 'intent trial limit reached');
  expectThrows(() => run.recordBackground({ triggered: false }), 'background trial limit reached');
  run.finalize();
  expectThrows(() => run.recordIntent({ detected: false }), 'run is finalized');
  expectThrows(() => run.recordBackground({ triggered: false }), 'run is finalized');
}

{
  const run = new WiggleReliabilityRun({ runId: 'missing-background', expectedTrials: 1 });
  run.recordIntent({ detected: true, latencyMs: 1 });
  const result = run.finalize();
  assert.strictEqual(result.intentsCompleted, 1);
  assert.strictEqual(result.backgroundTrials, 0);
  assert.strictEqual(result.complete, false);
  assert.strictEqual(result.pass, false);
}

console.log('wiggle reliability test ok');
