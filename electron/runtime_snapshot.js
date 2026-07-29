'use strict';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function completedSnapshot(raw, { capturedAt, generation, invalidationReason }) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return deepFreeze({
    schemaVersion: 1,
    capturedAt,
    generation,
    invalidationReason,
    readiness: source.readiness || { state: 'unknown' },
    workers: source.workers || {},
    models: source.models || {},
    permissions: source.permissions || {},
    capabilities: source.capabilities || [],
    repairs: source.repairs || [],
    diagnostics: source.diagnostics || {},
    settings: source.settings || null,
    recipes: Array.isArray(source.recipes) ? source.recipes : [],
  });
}

function degradedSnapshot(error, context) {
  const message = error instanceof Error ? error.message : String(error || 'unknown runtime probe failure');
  return completedSnapshot({
    readiness: { state: 'degraded', reason: 'runtime_probe_failed' },
    diagnostics: {
      error: {
        code: 'runtime_probe_failed',
        message,
      },
    },
  }, context);
}

class RuntimeSnapshot {
  constructor({ probe, clock = Date.now, ttlMs = 5000 } = {}) {
    if (typeof probe !== 'function') throw new TypeError('RuntimeSnapshot requires a probe function.');
    if (typeof clock !== 'function') throw new TypeError('RuntimeSnapshot clock must be a function.');
    this.probe = probe;
    this.clock = clock;
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.generation = 0;
    this.invalidationReason = 'startup';
    this.cache = null;
    this.inFlightByGeneration = new Map();
  }

  invalidate(reason = 'unspecified') {
    this.generation += 1;
    this.invalidationReason = String(reason || 'unspecified');
    this.cache = null;
    return this.generation;
  }

  async get({ force = false } = {}) {
    const generation = this.generation;
    const now = Number(this.clock());
    if (
      !force
      && this.cache
      && this.cache.generation === generation
      && Number.isFinite(now)
      && now - this.cache.capturedAt < this.ttlMs
    ) {
      return this.cache;
    }
    const existing = this.inFlightByGeneration.get(generation);
    if (existing) return existing;

    const invalidationReason = this.invalidationReason;
    let request;
    request = Promise.resolve()
      .then(() => this.probe({ generation, invalidationReason }))
      .then((raw) => completedSnapshot(raw, {
        capturedAt: Number(this.clock()),
        generation,
        invalidationReason,
      }))
      .catch((error) => degradedSnapshot(error, {
        capturedAt: Number(this.clock()),
        generation,
        invalidationReason,
      }))
      .then((snapshot) => {
        if (this.generation === generation) this.cache = snapshot;
        return snapshot;
      })
      .finally(() => {
        if (this.inFlightByGeneration.get(generation) === request) {
          this.inFlightByGeneration.delete(generation);
        }
      });
    this.inFlightByGeneration.set(generation, request);
    return request;
  }
}

module.exports = {
  RuntimeSnapshot,
  completedSnapshot,
};
