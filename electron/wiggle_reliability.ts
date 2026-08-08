interface DetectorSample {
  t: number;
  x: number;
  y: number;
}

interface DetectorResult {
  triggered: boolean;
  metrics: { durationMs: number };
}

interface DetectorInstance {
  push(sample: DetectorSample): DetectorResult;
}

interface DetectorConstructor {
  new (options?: Record<string, unknown>): DetectorInstance;
}

const { WiggleDetector } = require('./wiggle_detector') as {
  WiggleDetector: DetectorConstructor;
};

interface ReliabilityOptions {
  runId?: string;
  expectedTrials?: number;
}

interface IntentTrial {
  detected?: boolean;
  latencyMs?: number | null;
}

interface BackgroundTrial {
  triggered?: boolean;
}

interface ReliabilitySummary {
  runId: string;
  expected: number;
  intentsCompleted: number;
  backgroundTrials: number;
  hits: number;
  misses: number;
  falseTriggers: number;
  hitRate: number;
  falseTriggerRate: number;
  p50: number | null;
  p95: number | null;
  complete: boolean;
  pass: boolean;
}

class WiggleReliabilityRun {
  readonly runId: string;
  readonly expectedTrials: number;
  intentsCompleted = 0;
  hits = 0;
  falseTriggers = 0;
  backgroundTrials = 0;
  readonly latencies: number[] = [];
  finalized = false;
  summary: ReliabilitySummary | null = null;

  constructor({ runId, expectedTrials = 100 }: ReliabilityOptions = {}) {
    if (typeof runId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runId)) {
      throw new TypeError('runId must be a bounded semantic identifier');
    }
    if (!Number.isSafeInteger(expectedTrials) || expectedTrials <= 0) {
      throw new TypeError('expectedTrials must be positive');
    }

    this.runId = runId;
    this.expectedTrials = expectedTrials;
  }

  private assertOpen(): void {
    if (this.finalized) throw new TypeError('run is finalized');
  }

  recordIntent({ detected, latencyMs }: IntentTrial = {}): void {
    this.assertOpen();
    if (this.intentsCompleted >= this.expectedTrials) {
      throw new TypeError('intent trial limit reached');
    }
    if (typeof detected !== 'boolean') throw new TypeError('detected must be boolean');
    if (detected && latencyMs === undefined) throw new TypeError('latencyMs is required');
    if (
      latencyMs !== undefined &&
      latencyMs !== null &&
      (!Number.isFinite(latencyMs) || latencyMs < 0)
    ) {
      throw new TypeError('latencyMs must be non-negative');
    }

    this.intentsCompleted += 1;
    if (detected) {
      this.hits += 1;
      this.latencies.push(latencyMs as number);
    }
  }

  recordBackground({ triggered }: BackgroundTrial = {}): void {
    this.assertOpen();
    if (this.backgroundTrials >= this.expectedTrials) {
      throw new TypeError('background trial limit reached');
    }
    if (typeof triggered !== 'boolean') throw new TypeError('triggered must be boolean');

    this.backgroundTrials += 1;
    if (triggered) this.falseTriggers += 1;
  }

  private percentile(percentile: number): number | null {
    if (this.latencies.length === 0) return null;
    const values = [...this.latencies].sort((left, right) => left - right);
    const rank = (values.length - 1) * percentile;
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    const lowerValue = values[lower];
    const upperValue = values[upper];
    if (lowerValue === undefined || upperValue === undefined) return null;
    if (lower === upper) return lowerValue;
    return lowerValue + (upperValue - lowerValue) * (rank - lower);
  }

  finalize(): ReliabilitySummary {
    if (this.summary) return { ...this.summary };

    const misses = this.intentsCompleted - this.hits;
    const complete =
      this.intentsCompleted === this.expectedTrials &&
      this.backgroundTrials === this.expectedTrials;
    const summary: ReliabilitySummary = {
      runId: this.runId,
      expected: this.expectedTrials,
      intentsCompleted: this.intentsCompleted,
      backgroundTrials: this.backgroundTrials,
      hits: this.hits,
      misses,
      falseTriggers: this.falseTriggers,
      hitRate: this.intentsCompleted === 0 ? 0 : this.hits / this.intentsCompleted,
      falseTriggerRate:
        this.backgroundTrials === 0 ? 0 : this.falseTriggers / this.backgroundTrials,
      p50: this.percentile(0.5),
      p95: this.percentile(0.95),
      complete,
      pass: complete && misses === 0 && this.falseTriggers === 0,
    };

    this.finalized = true;
    this.summary = summary;
    return { ...summary };
  }
}

interface DeterministicEvidenceOptions extends ReliabilityOptions {
  detectorOptions?: Record<string, unknown>;
}

function runDeterministicWiggleEvidence({
  runId = 'n18-detector-regression',
  expectedTrials = 100,
  detectorOptions = {},
}: DeterministicEvidenceOptions = {}): ReliabilitySummary & {
  schemaVersion: 1;
  evidenceClass: 'deterministic_detector_regression';
  physicalInputValidated: false;
  releaseGatePass: false;
} {
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
    ] as const;
    let detected = false;
    let latencyMs: number | null = null;
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
  return {
    schemaVersion: 1,
    evidenceClass: 'deterministic_detector_regression',
    physicalInputValidated: false,
    releaseGatePass: false,
    ...run.finalize(),
  };
}

export { WiggleReliabilityRun, runDeterministicWiggleEvidence };
