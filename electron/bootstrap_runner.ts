import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATES = new Set(['pending', 'running', 'pass', 'warn', 'fail', 'skipped', 'needs_user']);

class PreflightError extends Error {}

interface RawStage {
  id?: unknown;
  title?: unknown;
  blocking?: unknown;
  retryable?: unknown;
  skippable?: unknown;
  weight?: unknown;
}

interface PreflightStage {
  id: string;
  title: string;
  blocking: boolean;
  retryable: boolean;
  skippable: boolean;
  weight: number;
}

interface PreflightManifest {
  schemaVersion: 1;
  stages: PreflightStage[];
}

interface StageValue {
  state?: unknown;
  evidence?: unknown;
  fixAction?: unknown;
}

interface StageResult {
  id: string;
  title: string;
  state: string;
  blocking: boolean;
  evidence: string;
  fixAction: string;
  retryable: boolean;
  weight: number;
  durationMs: number;
}

type Check = (stage: PreflightStage, context?: { signal: AbortSignal | null }) => unknown;

interface RunnerOptions {
  manifest: unknown;
  markerPath: string;
  checks?: Record<string, Check>;
  emit?: (event: Record<string, unknown>) => void;
  now?: () => number;
  bootstrapVersion?: number;
  productVersion?: string;
  manifestDigest?: string;
}

interface RunOptions {
  stageIds?: string[] | null;
  userSkips?: unknown[];
  signal?: AbortSignal | null;
}

interface RunOutput {
  schemaVersion: 2;
  ready: boolean;
  stages: StageResult[];
  markerPath: string | null;
}

function asStageValue(value: unknown): StageValue {
  return value && typeof value === 'object' ? (value as StageValue) : {};
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

function validateManifest(value: unknown): PreflightManifest {
  const raw =
    value && typeof value === 'object'
      ? (value as { schemaVersion?: unknown; stages?: unknown })
      : {};
  if (
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.stages) ||
    raw.stages.length === 0 ||
    raw.stages.length > 16
  ) {
    throw new PreflightError('preflight_manifest_invalid');
  }
  const seen = new Set<string>();
  const stages = raw.stages.map((item: unknown): PreflightStage => {
    const rawStage: RawStage = item && typeof item === 'object' ? (item as RawStage) : {};
    const id = String(rawStage.id || '').trim();
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(id) || seen.has(id))
      throw new PreflightError('preflight_stage_id_invalid');
    seen.add(id);
    const title = String(rawStage.title || '').trim();
    if (
      !title ||
      typeof rawStage.blocking !== 'boolean' ||
      typeof rawStage.retryable !== 'boolean' ||
      typeof rawStage.skippable !== 'boolean'
    ) {
      throw new PreflightError('preflight_stage_invalid');
    }
    const rawWeight = Number(rawStage.weight);
    const weight = Number.isFinite(rawWeight) && rawWeight > 0 && rawWeight <= 1000 ? rawWeight : 1;
    return {
      id,
      title,
      blocking: rawStage.blocking,
      retryable: rawStage.retryable,
      skippable: rawStage.skippable,
      weight,
    };
  });
  return { schemaVersion: 1, stages };
}

function fingerprintManifest(manifest: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(validateManifest(manifest)))
    .digest('hex');
}

function normalizedStage(stage: PreflightStage, value: unknown, durationMs: number): StageResult {
  const safeValue = asStageValue(value);
  const state = String(safeValue.state || 'fail');
  if (!STATES.has(state) || state === 'pending' || state === 'running')
    throw new PreflightError('preflight_stage_state_invalid');
  return {
    id: stage.id,
    title: stage.title,
    state,
    blocking: stage.blocking,
    evidence: String(safeValue.evidence || '').slice(0, 2000),
    fixAction: String(safeValue.fixAction || '').slice(0, 120),
    retryable: stage.retryable,
    weight: stage.weight,
    durationMs: Math.max(0, Math.round(durationMs)),
  };
}

class PreflightRunner {
  readonly manifest: PreflightManifest;
  readonly markerPath: string;
  readonly checks: Record<string, Check>;
  readonly emit: (event: Record<string, unknown>) => void;
  readonly now: () => number;
  readonly bootstrapVersion: number;
  readonly productVersion: string;
  readonly manifestDigest: string;

  constructor({
    manifest,
    markerPath,
    checks = {},
    emit = () => {},
    now = () => Date.now(),
    bootstrapVersion = 1,
    productVersion = 'unknown',
    manifestDigest = '',
  }: RunnerOptions) {
    this.manifest = validateManifest(manifest);
    this.markerPath = path.resolve(markerPath);
    this.checks = checks;
    this.emit = emit;
    this.now = now;
    this.bootstrapVersion = Number(bootstrapVersion) || 1;
    this.productVersion = String(productVersion || 'unknown');
    this.manifestDigest = String(manifestDigest || fingerprintManifest(manifest));
  }

  run({ stageIds = null, userSkips = [] }: RunOptions = {}): RunOutput {
    const wanted = this._wantedStages(stageIds);
    if (stageIds != null && wanted.length !== new Set(stageIds).size)
      throw new PreflightError('preflight_retry_stage_unknown');
    const skips = new Set(userSkips.map((item) => String(item || '').trim()));
    this.emit({ type: 'manifest', stages: this.manifest.stages });
    const results = wanted.map((stage) => this._runStage(stage, skips));
    const ready = this._ready(wanted, results);
    if (ready) this._writeMarker(results);
    const output: RunOutput = {
      schemaVersion: 2,
      ready,
      stages: results,
      markerPath: ready ? this.markerPath : null,
    };
    this.emit({ type: 'complete', ...output });
    return output;
  }

  async runAsync({
    stageIds = null,
    userSkips = [],
    signal = null,
  }: RunOptions = {}): Promise<RunOutput> {
    const wanted = this._wantedStages(stageIds);
    if (stageIds != null && wanted.length !== new Set(stageIds).size)
      throw new PreflightError('preflight_retry_stage_unknown');
    this._throwIfCancelled(signal);
    const skips = new Set(userSkips.map((item) => String(item || '').trim()));
    const totalWeight = wanted.reduce((total, stage) => total + stage.weight, 0);
    let completedWeight = 0;
    const results: StageResult[] = [];
    this.emit({ type: 'manifest', stages: this.manifest.stages });
    this.emit({ type: 'progress', percent: 0, completedWeight, totalWeight });
    for (const stage of wanted) {
      this._throwIfCancelled(signal);
      const result = await this._runStageAsync(stage, skips, signal);
      this._throwIfCancelled(signal);
      results.push(result);
      completedWeight += stage.weight;
      this.emit({
        type: 'progress',
        percent: totalWeight > 0 ? Math.round((completedWeight / totalWeight) * 100) : 100,
        completedWeight,
        totalWeight,
        completedStageId: stage.id,
      });
    }
    const ready = this._ready(wanted, results);
    if (ready) this._writeMarker(results);
    const output: RunOutput = {
      schemaVersion: 2,
      ready,
      stages: results,
      markerPath: ready ? this.markerPath : null,
    };
    this.emit({ type: 'complete', ...output });
    return output;
  }

  private _throwIfCancelled(signal: AbortSignal | null): void {
    if (signal?.aborted === true) throw new PreflightError('preflight_cancelled');
  }

  private _wantedStages(stageIds: string[] | null): PreflightStage[] {
    return stageIds == null
      ? this.manifest.stages
      : this.manifest.stages.filter((stage) => stageIds.includes(stage.id));
  }

  private _ready(wanted: PreflightStage[], results: StageResult[]): boolean {
    const fullRun = wanted.length === this.manifest.stages.length;
    return (
      fullRun &&
      results.every(
        (result) => !result.blocking || result.state === 'pass' || result.state === 'skipped',
      )
    );
  }

  private _runStage(stage: PreflightStage, skips: Set<string>): StageResult {
    if (skips.has(stage.id)) {
      if (!stage.skippable) throw new PreflightError('preflight_stage_not_skippable');
      const skipped = normalizedStage(stage, { state: 'skipped', evidence: 'user_skipped' }, 0);
      this.emit({ type: 'stage', ...skipped });
      return skipped;
    }
    this.emit({ type: 'stage', id: stage.id, state: 'running' });
    const started = this.now();
    let value: unknown;
    try {
      const check = this.checks[stage.id];
      value =
        typeof check === 'function'
          ? check(stage)
          : { state: stage.blocking ? 'fail' : 'skipped', evidence: 'check_not_configured' };
    } catch (error) {
      value = { state: 'fail', evidence: `check_error:${errorName(error)}` };
    }
    const result = normalizedStage(stage, value, this.now() - started);
    this.emit({ type: 'stage', ...result });
    return result;
  }

  private async _runStageAsync(
    stage: PreflightStage,
    skips: Set<string>,
    signal: AbortSignal | null = null,
  ): Promise<StageResult> {
    this._throwIfCancelled(signal);
    if (skips.has(stage.id)) {
      if (!stage.skippable) throw new PreflightError('preflight_stage_not_skippable');
      const skipped = normalizedStage(stage, { state: 'skipped', evidence: 'user_skipped' }, 0);
      this.emit({ type: 'stage', ...skipped });
      return skipped;
    }
    this.emit({
      type: 'stage',
      id: stage.id,
      title: stage.title,
      state: 'running',
      weight: stage.weight,
    });
    const started = this.now();
    let value: unknown;
    try {
      const check = this.checks[stage.id];
      value =
        typeof check === 'function'
          ? await check(stage, { signal })
          : { state: stage.blocking ? 'fail' : 'skipped', evidence: 'check_not_configured' };
    } catch (error) {
      if (
        signal?.aborted === true ||
        (error instanceof Error && error.message === 'preflight_cancelled')
      ) {
        throw new PreflightError('preflight_cancelled');
      }
      value = { state: 'fail', evidence: `check_error:${errorName(error)}` };
    }
    const result = normalizedStage(stage, value, this.now() - started);
    this.emit({ type: 'stage', ...result });
    return result;
  }

  private _writeMarker(stages: StageResult[]): void {
    const marker = {
      schemaVersion: 2,
      status: 'ready',
      bootstrapVersion: this.bootstrapVersion,
      productVersion: this.productVersion,
      manifestDigest: this.manifestDigest,
      completedAt: new Date(this.now()).toISOString(),
      completedStageIds: stages.map((stage) => stage.id),
      stages,
    };
    fs.mkdirSync(path.dirname(this.markerPath), { recursive: true });
    const temporary = `${this.markerPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporary, this.markerPath);
  }
}

export { fingerprintManifest, PreflightError, PreflightRunner, STATES, validateManifest };
