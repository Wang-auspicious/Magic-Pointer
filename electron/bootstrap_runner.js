const fs = require('fs');
const path = require('path');

const STATES = new Set(['pending', 'running', 'pass', 'warn', 'fail', 'skipped', 'needs_user']);

class PreflightError extends Error {}

function validateManifest(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.stages) || value.stages.length === 0 || value.stages.length > 16) {
    throw new PreflightError('preflight_manifest_invalid');
  }
  const seen = new Set();
  const stages = value.stages.map((raw) => {
    const id = String(raw?.id || '').trim();
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(id) || seen.has(id)) throw new PreflightError('preflight_stage_id_invalid');
    seen.add(id);
    const title = String(raw?.title || '').trim();
    if (!title || typeof raw.blocking !== 'boolean' || typeof raw.retryable !== 'boolean' || typeof raw.skippable !== 'boolean') {
      throw new PreflightError('preflight_stage_invalid');
    }
    return { id, title, blocking: raw.blocking, retryable: raw.retryable, skippable: raw.skippable };
  });
  return { schemaVersion: 1, stages };
}

function normalizedStage(stage, value, durationMs) {
  const state = String(value?.state || 'fail');
  if (!STATES.has(state) || state === 'pending' || state === 'running') throw new PreflightError('preflight_stage_state_invalid');
  return {
    id: stage.id,
    title: stage.title,
    state,
    blocking: stage.blocking,
    evidence: String(value?.evidence || '').slice(0, 2000),
    fixAction: String(value?.fixAction || '').slice(0, 120),
    retryable: stage.retryable,
    durationMs: Math.max(0, Math.round(durationMs)),
  };
}

class PreflightRunner {
  constructor({ manifest, markerPath, checks = {}, emit = () => {}, now = () => Date.now() }) {
    this.manifest = validateManifest(manifest);
    this.markerPath = path.resolve(markerPath);
    this.checks = checks;
    this.emit = emit;
    this.now = now;
  }

  run({ stageIds = null, userSkips = [] } = {}) {
    const wanted = stageIds == null ? this.manifest.stages : this.manifest.stages.filter((stage) => stageIds.includes(stage.id));
    if (stageIds != null && wanted.length !== new Set(stageIds).size) throw new PreflightError('preflight_retry_stage_unknown');
    const skips = new Set(userSkips.map((item) => String(item || '').trim()));
    this.emit({ type: 'manifest', stages: this.manifest.stages });
    const results = wanted.map((stage) => this._runStage(stage, skips));
    const fullRun = wanted.length === this.manifest.stages.length;
    const ready = fullRun && results.every((result) => !result.blocking || result.state === 'pass' || result.state === 'skipped');
    if (ready) this._writeMarker(results);
    const output = { schemaVersion: 1, ready, stages: results, markerPath: ready ? this.markerPath : null };
    this.emit({ type: 'complete', ...output });
    return output;
  }

  _runStage(stage, skips) {
    if (skips.has(stage.id)) {
      if (!stage.skippable) throw new PreflightError('preflight_stage_not_skippable');
      const skipped = normalizedStage(stage, { state: 'skipped', evidence: 'user_skipped' }, 0);
      this.emit({ type: 'stage', ...skipped });
      return skipped;
    }
    this.emit({ type: 'stage', id: stage.id, state: 'running' });
    const started = this.now();
    let value;
    try {
      const check = this.checks[stage.id];
      value = typeof check === 'function'
        ? check(stage)
        : { state: stage.blocking ? 'fail' : 'skipped', evidence: 'check_not_configured' };
    } catch (error) {
      value = { state: 'fail', evidence: `check_error:${error.name}` };
    }
    const result = normalizedStage(stage, value, this.now() - started);
    this.emit({ type: 'stage', ...result });
    return result;
  }

  _writeMarker(stages) {
    const marker = {
      schemaVersion: 1,
      status: 'ready',
      completedAt: new Date(this.now()).toISOString(),
      stages,
    };
    fs.mkdirSync(path.dirname(this.markerPath), { recursive: true });
    const temporary = `${this.markerPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.markerPath);
  }
}

module.exports = { PreflightError, PreflightRunner, STATES, validateManifest };
