'use strict';

type UnknownRecord = Record<string, unknown>;
type SnapshotContext = { capturedAt: number; generation: number; invalidationReason: string };
type CompletedSnapshot = Readonly<
  SnapshotContext & {
    schemaVersion: 1;
    readiness: unknown;
    workers: unknown;
    models: unknown;
    permissions: unknown;
    capabilities: unknown;
    repairs: unknown;
    diagnostics: unknown;
    settings: unknown;
    recipes: unknown[];
  }
>;

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach((entry) => deepFreeze(entry));
  return Object.freeze(value);
}

function completedSnapshot(
  raw: unknown,
  { capturedAt, generation, invalidationReason }: SnapshotContext,
): CompletedSnapshot {
  const source = raw && typeof raw === 'object' ? (raw as UnknownRecord) : {};
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

function degradedSnapshot(error: unknown, context: SnapshotContext): CompletedSnapshot {
  const message =
    error instanceof Error ? error.message : String(error || 'unknown runtime probe failure');
  return completedSnapshot(
    {
      readiness: { state: 'degraded', reason: 'runtime_probe_failed' },
      diagnostics: {
        error: {
          code: 'runtime_probe_failed',
          message,
        },
      },
    },
    context,
  );
}

class RuntimeSnapshot {
  probe: (
    context: Pick<SnapshotContext, 'generation' | 'invalidationReason'>,
  ) => unknown | Promise<unknown>;
  clock: () => number;
  ttlMs: number;
  generation: number;
  invalidationReason: string;
  cache: CompletedSnapshot | null;
  inFlightByGeneration: Map<number, Promise<CompletedSnapshot>>;

  constructor({
    probe,
    clock = Date.now,
    ttlMs = 5000,
  }: {
    probe?: (
      context: Pick<SnapshotContext, 'generation' | 'invalidationReason'>,
    ) => unknown | Promise<unknown>;
    clock?: () => number;
    ttlMs?: number;
  } = {}) {
    if (typeof probe !== 'function')
      throw new TypeError('RuntimeSnapshot requires a probe function.');
    if (typeof clock !== 'function')
      throw new TypeError('RuntimeSnapshot clock must be a function.');
    this.probe = probe as (
      context: Pick<SnapshotContext, 'generation' | 'invalidationReason'>,
    ) => unknown | Promise<unknown>;
    this.clock = clock as () => number;
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.generation = 0;
    this.invalidationReason = 'startup';
    this.cache = null;
    this.inFlightByGeneration = new Map();
  }

  invalidate(reason: unknown = 'unspecified'): number {
    this.generation += 1;
    this.invalidationReason = String(reason || 'unspecified');
    this.cache = null;
    return this.generation;
  }

  async get({ force = false }: { force?: boolean } = {}): Promise<CompletedSnapshot> {
    const generation = this.generation;
    const now = Number(this.clock());
    if (
      !force &&
      this.cache &&
      this.cache.generation === generation &&
      Number.isFinite(now) &&
      now - this.cache.capturedAt < this.ttlMs
    ) {
      return this.cache;
    }
    const existing = this.inFlightByGeneration.get(generation);
    if (existing) return existing;

    const invalidationReason = this.invalidationReason;
    let request: Promise<CompletedSnapshot>;
    request = Promise.resolve()
      .then(() => this.probe({ generation, invalidationReason }))
      .then((raw) =>
        completedSnapshot(raw, {
          capturedAt: Number(this.clock()),
          generation,
          invalidationReason,
        }),
      )
      .catch((error) =>
        degradedSnapshot(error, {
          capturedAt: Number(this.clock()),
          generation,
          invalidationReason,
        }),
      )
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
