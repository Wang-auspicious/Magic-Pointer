class WiggleReliabilityRun {
  constructor({ runId, expectedTrials = 100 } = {}) {
    if (typeof runId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runId)) {
      throw new TypeError('runId must be a bounded semantic identifier');
    }
    if (!Number.isSafeInteger(expectedTrials) || expectedTrials <= 0) {
      throw new TypeError('expectedTrials must be positive');
    }

    this.runId = runId;
    this.expectedTrials = expectedTrials;
    this.intentsCompleted = 0;
    this.hits = 0;
    this.falseTriggers = 0;
    this.backgroundTrials = 0;
    this.latencies = [];
    this.finalized = false;
    this.summary = null;
  }

  _assertOpen() {
    if (this.finalized) throw new TypeError('run is finalized');
  }

  recordIntent({ detected, latencyMs } = {}) {
    this._assertOpen();
    if (this.intentsCompleted >= this.expectedTrials) {
      throw new TypeError('intent trial limit reached');
    }
    if (typeof detected !== 'boolean') throw new TypeError('detected must be boolean');
    if (detected && latencyMs === undefined) throw new TypeError('latencyMs is required');
    if (latencyMs !== undefined && (!Number.isFinite(latencyMs) || latencyMs < 0)) {
      throw new TypeError('latencyMs must be non-negative');
    }

    this.intentsCompleted += 1;
    if (detected) {
      this.hits += 1;
      this.latencies.push(latencyMs);
    }
  }

  recordBackground({ triggered } = {}) {
    this._assertOpen();
    if (this.backgroundTrials >= this.expectedTrials) {
      throw new TypeError('background trial limit reached');
    }
    if (typeof triggered !== 'boolean') throw new TypeError('triggered must be boolean');

    this.backgroundTrials += 1;
    if (triggered) this.falseTriggers += 1;
  }

  _percentile(percentile) {
    if (this.latencies.length === 0) return null;
    const values = [...this.latencies].sort((left, right) => left - right);
    const rank = (values.length - 1) * percentile;
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    if (lower === upper) return values[lower];
    return values[lower] + (values[upper] - values[lower]) * (rank - lower);
  }

  finalize() {
    if (this.summary) return { ...this.summary };

    const misses = this.intentsCompleted - this.hits;
    const complete = (
      this.intentsCompleted === this.expectedTrials
      && this.backgroundTrials === this.expectedTrials
    );
    const summary = {
      runId: this.runId,
      expected: this.expectedTrials,
      intentsCompleted: this.intentsCompleted,
      backgroundTrials: this.backgroundTrials,
      hits: this.hits,
      misses,
      falseTriggers: this.falseTriggers,
      hitRate: this.intentsCompleted === 0 ? 0 : this.hits / this.intentsCompleted,
      falseTriggerRate: this.backgroundTrials === 0 ? 0 : this.falseTriggers / this.backgroundTrials,
      p50: this._percentile(0.5),
      p95: this._percentile(0.95),
      complete,
      pass: complete && misses === 0 && this.falseTriggers === 0,
    };

    this.finalized = true;
    this.summary = summary;
    return { ...summary };
  }
}

function runDeterministicWiggleEvidence({
  runId = 'n18-detector-regression',
  expectedTrials = 100,
  detectorOptions = {},
} = {}) {
  const run = new WiggleReliabilityRun({ runId, expectedTrials });
  for (let trial = 0; trial < expectedTrials; trial += 1) {
    const detector = new WiggleDetector(detectorOptions);
    const base = trial * 20;
    const intentional = [
      [0, 500 + base, 400],
      [70, 526 + base, 402],
      [140, 478 + base, 399],
      [220, 528 + base, 401],
      [310, 493 + base, 400],
    ];
    let detected = false;
    let latencyMs = null;
    for (const [t, x, y] of intentional) {
      const result = detector.push({ t, x, y });
      if (result.triggered) {
        detected = true;
        latencyMs = Number(result.metrics.durationMs);
        break;
      }
    }
    run.recordIntent({ detected, ...(detected ? { latencyMs } : {}) });

    const backgroundDetector = new WiggleDetector(detectorOptions);
    const background = Array.from({ length: 10 }, (_item, index) => ({
      t: index * 45,
      x: 100 + base + index * 18,
      y: 200 + (trial % 2),
    }));
    let triggered = false;
    for (const sample of background) {
      if (backgroundDetector.push(sample).triggered) triggered = true;
    }
    run.recordBackground({ triggered });
  }
  const summary = run.finalize();
  return {
    schemaVersion: 1,
    evidenceClass: 'deterministic_detector_regression',
    physicalInputValidated: false,
    releaseGatePass: false,
    ...summary,
  };
}

module.exports = { WiggleReliabilityRun, runDeterministicWiggleEvidence };
'use strict';

const { WiggleDetector } = require('./wiggle_detector');
