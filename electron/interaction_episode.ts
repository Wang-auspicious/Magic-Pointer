const crypto = require('crypto');
const TaskSources = require('./task_sources');

type UnknownRecord = Record<string, unknown>;
type SlotAlias = 'this' | 'that' | 'these' | 'here';

interface NormalizedObject extends UnknownRecord {
  bbox?: unknown;
  kind?: string;
  objectId: string;
  referenceLabel?: string;
  source?: UnknownRecord;
}

interface EpisodeSlots {
  here: NormalizedObject | null;
  that: NormalizedObject | null;
  these: NormalizedObject[];
  this: NormalizedObject | null;
}

interface InteractionEpisode {
  createdAt: number;
  events: UnknownRecord[];
  expiresAt: number;
  id: string;
  labels: Map<string, string>;
  objects: Map<string, NormalizedObject>;
  pendingIntent: string | null;
  taskContext: UnknownRecord | null;
  taskId: string | null;
  taskInput: UnknownRecord | null;
  slots: EpisodeSlots;
  state: string;
  updatedAt: number;
  utterances: string[];
}

const ALLOWED_OBJECT_FIELDS = [
  'objectId', 'snapshotId', 'selectionSessionToken', 'app', 'windowTitle',
  'label', 'referenceLabel', 'kind', 'capturedAt', 'expiresAt', 'content', 'frameLeaseId',
];
const ALLOWED_SOURCE_FIELDS = ['app', 'title', 'path', 'annotatedPath', 'url', 'page', 'hwnd', 'processId'];

function clone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizePerceptionTrace(input: UnknownRecord | null): UnknownRecord | null {
  if (!input || typeof input !== 'object' || Number(input.schemaVersion) !== 1) return null;
  const trace: UnknownRecord = { schemaVersion: 1 };
  for (const field of ['selectedLayer', 'selectedAdapter', 'selectedMethod', 'fallbackReason', 'policyMode']) {
    const value = input[field];
    if (typeof value === 'string' && value.trim()) trace[field] = value.trim().slice(0, 120);
  }
  trace.pixelFallbackUsed = input.pixelFallbackUsed === true;
  trace.attempts = (Array.isArray(input.attempts) ? input.attempts : []).slice(0, 12)
    .filter((item: unknown) => item && typeof item === 'object')
    .map((item: unknown) => {
      const attemptInput = item as UnknownRecord;
      const attempt: UnknownRecord = {};
      for (const field of ['layer', 'adapter', 'method', 'status', 'reason']) {
        const value = attemptInput[field];
        if (typeof value === 'string' && value.trim()) attempt[field] = value.trim().slice(0, 120);
      }
      return attempt;
    });
  return trace;
}

function normalizeTerminalEvidence(input: UnknownRecord | null): UnknownRecord | null {
  if (!input || typeof input !== 'object' || Number(input.schemaVersion) !== 1) return null;
  const state = typeof input.state === 'string' && ['resolved', 'partial', 'unavailable'].includes(input.state)
    ? input.state
    : 'unavailable';
  const bounded = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : '';
  const integer = (value: unknown, fallback = 0) => Number.isInteger(Number(value)) ? Number(value) : fallback;
  const anchorInput = input.anchor && typeof input.anchor === 'object' ? input.anchor as UnknownRecord : {};
  const windowInput = input.window && typeof input.window === 'object' ? input.window as UnknownRecord : {};
  const result = {
    schemaVersion: 1,
    state,
    method: bounded(input.method, 120),
    capturedAt: bounded(input.capturedAt, 80),
    timestamp: bounded(input.timestamp, 80),
    command: bounded(input.command, 2000),
    exitCode: input.exitCode == null || !Number.isInteger(Number(input.exitCode)) ? null : Number(input.exitCode),
    anchor: { line: Math.max(0, integer(anchorInput.line)), text: bounded(anchorInput.text, 1000) },
    window: {
      startLine: Math.max(0, integer(windowInput.startLine)),
      endLine: Math.max(0, integer(windowInput.endLine)),
      lineCount: Math.max(0, Math.min(64, integer(windowInput.lineCount))),
      before: bounded(windowInput.before, 4000),
      error: bounded(windowInput.error, 6000),
      after: bounded(windowInput.after, 4000),
      text: bounded(windowInput.text, 8000),
    },
    pixelFallbackUsed: false,
    uncertainty: (Array.isArray(input.uncertainty) ? input.uncertainty : []).slice(0, 12)
      .filter((value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()))
      .map((value: string) => value.trim().slice(0, 160)),
  };
  return result;
}

function normalizeBrowserContext(input: UnknownRecord | null): UnknownRecord | null {
  if (!input || typeof input !== 'object' || Number(input.schemaVersion) !== 1) return null;
  const bounded = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : '';
  const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : null;
  const point = (value: unknown) => {
    const pointValue = value && typeof value === 'object' ? value as UnknownRecord : null;
    return pointValue && number(pointValue.x) != null && number(pointValue.y) != null
    ? { x: number(pointValue.x), y: number(pointValue.y) }
    : null;
  };
  const rect = (value: unknown) => {
    const rectValue = value && typeof value === 'object' ? value as UnknownRecord : null;
    return rectValue && ['x', 'y', 'width', 'height'].every(key => number(rectValue[key]) != null)
      ? Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, number(rectValue[key])]))
      : null;
  };
  const page = input.page && typeof input.page === 'object' ? input.page as UnknownRecord : {};
  const node = input.node && typeof input.node === 'object' ? input.node as UnknownRecord : {};
  const coordinates = input.coordinates && typeof input.coordinates === 'object' ? input.coordinates as UnknownRecord : {};
  const provenance = input.provenance && typeof input.provenance === 'object' ? input.provenance as UnknownRecord : {};
  const allowedAttributes = new Set(['id', 'name', 'type', 'href', 'src', 'alt', 'title', 'role', 'aria-label', 'aria-labelledby', 'data-testid', 'data-test', 'data-qa']);
  const attributes: UnknownRecord = {};
  for (const [key, value] of Object.entries(node.attributes && typeof node.attributes === 'object' ? node.attributes : {}).slice(0, 20)) {
    if (allowedAttributes.has(key) && typeof value === 'string') attributes[key] = value.slice(0, 1000);
  }
  return {
    schemaVersion: 1,
    state: typeof input.state === 'string' && ['resolved', 'partial', 'unavailable'].includes(input.state)
      ? input.state
      : 'unavailable',
    method: bounded(input.method, 120),
    page: { title: bounded(page.title, 1000), url: bounded(page.url, 4000) },
    node: {
      tag: bounded(node.tag, 80), id: bounded(node.id, 300),
      classes: (Array.isArray(node.classes) ? node.classes : []).slice(0, 20).filter(item => typeof item === 'string').map(item => item.slice(0, 160)),
      role: bounded(node.role, 120), accessibleName: bounded(node.accessibleName, 2000),
      text: bounded(node.text, 4000), attributes,
    },
    selector: bounded(input.selector, 2000),
    coordinates: {
      pointerScreenPhysical: point(coordinates.pointerScreenPhysical),
      pointerViewportCss: point(coordinates.pointerViewportCss),
      elementViewportCss: rect(coordinates.elementViewportCss),
      elementScreenPhysical: rect(coordinates.elementScreenPhysical),
      devicePixelRatio: number(coordinates.devicePixelRatio),
      mapping: bounded(coordinates.mapping, 120),
      hitTestVerified: coordinates.hitTestVerified === true,
    },
    networkFailures: (Array.isArray(input.networkFailures) ? input.networkFailures : []).slice(0, 20)
      .filter((item: unknown) => item && typeof item === 'object')
      .map((item: unknown) => {
        const failure = item as UnknownRecord;
        return {
          url: bounded(failure.url, 4000), errorText: bounded(failure.errorText, 300),
          source: bounded(failure.source, 80), timestamp: bounded(failure.timestamp, 80),
          requestId: bounded(failure.requestId, 160), status: number(failure.status),
        };
      }),
    provenance: {
      endpoint: bounded(provenance.endpoint, 1000), targetId: bounded(provenance.targetId, 200),
      structural: provenance.structural === true,
      networkSources: (Array.isArray(provenance.networkSources) ? provenance.networkSources : []).slice(0, 8).filter((item: unknown): item is string => typeof item === 'string').map((item: string) => item.slice(0, 80)),
    },
    uncertainty: (Array.isArray(input.uncertainty) ? input.uncertainty : []).slice(0, 12).filter((item: unknown): item is string => typeof item === 'string').map((item: string) => item.slice(0, 200)),
  };
}

function normalizeObject(input: UnknownRecord | null): NormalizedObject | null {
  if (!input || typeof input !== 'object') return null;
  const snapshotId = typeof input.snapshotId === 'string' ? input.snapshotId.trim() : '';
  const suppliedObjectId = typeof input.objectId === 'string' ? input.objectId.trim() : '';
  const objectId = suppliedObjectId || (snapshotId ? `selection:${snapshotId}` : '');
  if (!objectId) return null;
  const normalized: NormalizedObject = { objectId };
  for (const field of ALLOWED_OBJECT_FIELDS.slice(1)) {
    if (typeof input[field] === 'string' && input[field].trim()) {
      normalized[field] = input[field].trim().slice(0, field === 'content' ? 12000 : 500);
    }
  }
  if (Array.isArray(input.bbox) && input.bbox.length === 4 && input.bbox.every(Number.isFinite)) {
    normalized.bbox = input.bbox.slice();
  } else if (input.bbox && typeof input.bbox === 'object') {
    const bboxInput = input.bbox as UnknownRecord;
    const bbox = {
      x: Number(bboxInput.x),
      y: Number(bboxInput.y),
      width: Number(bboxInput.width),
      height: Number(bboxInput.height),
    };
    if (Object.values(bbox).every(Number.isFinite)) normalized.bbox = bbox;
  }
  if (input.source && typeof input.source === 'object') {
    const sourceInput = input.source as UnknownRecord;
    const source: UnknownRecord = {};
    for (const field of ALLOWED_SOURCE_FIELDS) {
      const value = sourceInput[field];
      if (typeof value === 'string' && value.trim()) source[field] = value.trim().slice(0, 2000);
      else if (typeof value === 'number' && Number.isFinite(value)) source[field] = value;
    }
    const attestation = sourceInput.captureAttestation;
    if (attestation && typeof attestation === 'object') {
      const attestationInput = attestation as UnknownRecord;
      const expectedInput = attestationInput.expected && typeof attestationInput.expected === 'object'
        ? attestationInput.expected as UnknownRecord
        : {};
      const expected: UnknownRecord = {};
      for (const field of ['hwnd', 'processId', 'processName', 'title', 'desktopId']) {
        const value = expectedInput[field];
        if (typeof value === 'string' && value.trim()) expected[field] = value.trim().slice(0, 2000);
        else if (typeof value === 'number' && Number.isFinite(value)) expected[field] = value;
      }
      const normalizedAttestation: UnknownRecord = {};
      if (typeof attestationInput.status === 'string' && attestationInput.status.trim()) {
        normalizedAttestation.status = attestationInput.status.trim().slice(0, 80);
      }
      if (typeof attestationInput.phase === 'string' && attestationInput.phase.trim()) {
        normalizedAttestation.phase = attestationInput.phase.trim().slice(0, 80);
      }
      if (Object.keys(expected).length) normalizedAttestation.expected = expected;
      if (Object.keys(normalizedAttestation).length) source.captureAttestation = normalizedAttestation;
    }
    const perceptionTrace = normalizePerceptionTrace(sourceInput.perceptionTrace as UnknownRecord | null);
    if (perceptionTrace) source.perceptionTrace = perceptionTrace;
    const terminalEvidence = normalizeTerminalEvidence(sourceInput.terminalEvidence as UnknownRecord | null);
    if (terminalEvidence) source.terminalEvidence = terminalEvidence;
    const browserContext = normalizeBrowserContext(sourceInput.browserContext as UnknownRecord | null);
    if (browserContext) source.browserContext = browserContext;
    if (Object.keys(source).length) normalized.source = source;
  }
  normalized.kind = normalized.kind || 'native_selection';
  return normalized;
}

function bboxMetrics(value: unknown): { cx: number; cy: number } | null {
  if (Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)) {
    const [left, top, right, bottom] = value.map(Number);
    return { cx: (left + right) / 2, cy: (top + bottom) / 2 };
  }
  if (value && typeof value === 'object') {
    const bbox = value as UnknownRecord;
    const x = Number(bbox.x);
    const y = Number(bbox.y);
    const width = Number(bbox.width);
    const height = Number(bbox.height);
    if ([x, y, width, height].every(Number.isFinite)) return { cx: x + width / 2, cy: y + height / 2 };
  }
  return null;
}

function spatialRelations(objects: NormalizedObject[]): UnknownRecord[] {
  const results: UnknownRecord[] = [];
  for (let leftIndex = 0; leftIndex < objects.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < objects.length; rightIndex += 1) {
      const left = objects[leftIndex];
      const right = objects[rightIndex];
      const a = bboxMetrics(left?.bbox);
      const b = bboxMetrics(right?.bbox);
      if (!a || !b) continue;
      const dx = Number((b.cx - a.cx).toFixed(1));
      const dy = Number((b.cy - a.cy).toFixed(1));
      results.push({
        from: left.referenceLabel || left.objectId,
        to: right.referenceLabel || right.objectId,
        horizontal: Math.abs(dx) <= 2 ? 'aligned' : dx > 0 ? 'left_of' : 'right_of',
        vertical: Math.abs(dy) <= 2 ? 'aligned' : dy > 0 ? 'above' : 'below',
        delta: [dx, dy],
      });
    }
  }
  return results;
}

type ExplicitBindingOptions = {
  intent?: 'add' | 'move' | null;
  role?: 'target' | 'source' | 'reference' | 'exclude' | 'unresolved';
  slot?: SlotAlias;
  taskId: string;
};

function stableSelectionPart(object: NormalizedObject): string {
  const value = String(object.snapshotId || object.objectId || '').trim();
  if (!value) throw new Error('a pointed task reference requires a snapshot identity');
  return value.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
}

function sourceKind(object: NormalizedObject): 'file' | 'document' | 'web' | 'figma' | 'capture' {
  const source = object.source || {};
  const app = String(object.app || source.app || '').toLowerCase();
  const path = String(source.path || '').toLowerCase();
  if (app.includes('figma')) return 'figma';
  if (String(source.url || '').trim()) return 'web';
  if (/\.(?:pdf|docx?|pptx?|xlsx?|xlsm|odt|ods|odp)$/i.test(path)) return 'document';
  if (path) return 'file';
  return 'capture';
}

function locatorForObject(object: NormalizedObject): UnknownRecord {
  const source = object.source || {};
  const browser = source.browserContext && typeof source.browserContext === 'object'
    ? source.browserContext as UnknownRecord
    : null;
  if (browser && String(browser.selector || '').trim()) {
    return {
      kind: 'dom-node',
      value: {
        selector: String(browser.selector),
        url: String((browser.page as UnknownRecord | undefined)?.url || source.url || ''),
      },
    };
  }
  if (Number.isInteger(source.page) && Number(source.page) >= 0) {
    return {
      kind: 'pdf-region',
      value: { pageIndex: Number(source.page), bbox: clone(object.bbox || null) },
    };
  }
  return {
    kind: 'visual-region',
    value: {
      snapshotId: String(object.snapshotId || ''),
      bbox: clone(object.bbox || null),
      coordinateSpace: 'physical-screen-pixels',
    },
  };
}

function taskSourceForObject(taskId: string, object: NormalizedObject): UnknownRecord {
  const source = object.source || {};
  const part = stableSelectionPart(object);
  const identity: UnknownRecord = {
    snapshotId: String(object.snapshotId || ''),
    selectionSessionToken: String(object.selectionSessionToken || ''),
  };
  for (const field of ['path', 'url', 'hwnd', 'processId']) {
    if (source[field] !== undefined && source[field] !== '' && source[field] !== null) {
      identity[field] = source[field];
    }
  }
  const capabilities = ['read'];
  if (String(source.path || source.url || '').trim()) capabilities.push('search');
  return TaskSources.normalizeSourceRef({
    sourceId: `source:${part}`,
    taskId,
    kind: sourceKind(object),
    title: String(object.windowTitle || object.label || object.app || 'Pointed source'),
    identity,
    revision: {
      capturedAt: String(object.capturedAt || ''),
      snapshotId: String(object.snapshotId || ''),
    },
    capabilities,
    origin: 'user-pointed',
    parentSourceId: null,
  });
}

function taskReferenceForObject(
  state: UnknownRecord,
  source: UnknownRecord,
  object: NormalizedObject,
  role: ExplicitBindingOptions['role'],
  now: number,
): UnknownRecord {
  const next = TaskSources.nextReferenceIdentity(state);
  return TaskSources.normalizeReferenceBinding({
    referenceId: `reference:${stableSelectionPart(object)}`,
    label: next.label,
    sourceId: source.sourceId,
    locator: locatorForObject(object),
    role: role || 'target',
    frameLeaseId: object.frameLeaseId || null,
    capturedAtMs: Number.isFinite(Date.parse(String(object.capturedAt || '')))
      ? Date.parse(String(object.capturedAt))
      : now,
    ordinal: next.ordinal,
    active: true,
  });
}

class InteractionEpisodeStore {
  ttlMs: number;
  idFactory: () => string;
  current: InteractionEpisode | null;

  constructor({ ttlMs = 30 * 60 * 1000, idFactory = () => crypto.randomUUID() }: {
    ttlMs?: number;
    idFactory?: () => string;
  } = {}) {
    this.ttlMs = ttlMs;
    this.idFactory = idFactory;
    this.current = null;
  }

  start(now = Date.now()): InteractionEpisode {
    this.current = {
      id: this.idFactory(),
      state: 'active',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.ttlMs,
      objects: new Map(),
      labels: new Map(),
      slots: { this: null, that: null, these: [], here: null },
      pendingIntent: null,
      taskId: null,
      taskContext: null,
      taskInput: null,
      utterances: [],
      events: [],
    };
    return this.current;
  }

  active(now = Date.now()): InteractionEpisode | null {
    if (!this.current || this.current.state !== 'active' || this.current.expiresAt <= now) {
      this.current = null;
      return null;
    }
    return this.current;
  }

  ensureActive(now = Date.now()): InteractionEpisode {
    return this.active(now) || this.start(now);
  }

  touch(episode: InteractionEpisode, now: number): void {
    episode.updatedAt = now;
    episode.expiresAt = now + this.ttlMs;
  }

  remember(episode: InteractionEpisode, input: UnknownRecord): NormalizedObject | null {
    const object = normalizeObject(input);
    if (!object) return null;
    const previous = episode.objects.get(object.objectId);
    if (previous?.referenceLabel && !object.referenceLabel) object.referenceLabel = previous.referenceLabel;
    episode.objects.set(object.objectId, object);
    return object;
  }

  recordEvent(episode: InteractionEpisode, type: string, payload: UnknownRecord, now: number): void {
    episode.events.push({ type, ...payload, at: now });
    if (episode.events.length > 40) episode.events.splice(0, episode.events.length - 40);
    this.touch(episode, now);
  }

  bindPointedObject(input: UnknownRecord, now = Date.now()) {
    const episode = this.ensureActive(now);
    const object = this.remember(episode, input);
    if (!object) return null;
    const previous = episode.slots.this;
    if (previous && previous.objectId !== object.objectId) episode.slots.that = previous;
    episode.slots.this = object;
    this.recordEvent(episode, 'bind', { alias: 'this', objectIds: [object.objectId] }, now);
    return this.snapshot(episode);
  }

  bindThese(objectIds: string[] | null = null, now = Date.now()) {
    const episode = this.active(now);
    if (!episode) return null;
    const requested = Array.isArray(objectIds) && objectIds.length
      ? objectIds
      : episode.labels.size
        ? Array.from(episode.labels.values())
        : [episode.slots.that?.objectId, episode.slots.this?.objectId];
    const seen = new Set<string>();
    episode.slots.these = requested
      .filter((objectId): objectId is string => typeof objectId === 'string')
      .map((objectId) => episode.objects.get(objectId))
      .filter((object): object is NormalizedObject => Boolean(object && !seen.has(object.objectId) && seen.add(object.objectId)));
    if (!episode.slots.these.length) return null;
    this.recordEvent(episode, 'bind', { alias: 'these', objectIds: episode.slots.these.map((item) => item.objectId) }, now);
    return this.snapshot(episode);
  }

  appendToThese(input: UnknownRecord, now = Date.now()) {
    const episode = this.ensureActive(now);
    const object = this.remember(episode, input);
    if (!object) return null;
    const ordered = episode.slots.these.slice();
    if (!ordered.length && episode.slots.this) ordered.push(episode.slots.this);
    if (!ordered.some((item) => item.objectId === object.objectId)) ordered.push(object);
    const previous = episode.slots.this;
    if (previous && previous.objectId !== object.objectId) episode.slots.that = previous;
    episode.slots.this = object;
    episode.slots.these = ordered;
    this.recordEvent(episode, 'bind', { alias: 'these', objectIds: ordered.map((item) => item.objectId) }, now);
    return this.snapshot(episode);
  }

  bindCommandTarget(
    input: UnknownRecord,
    command: unknown,
    options: ExplicitBindingOptions,
    now = Date.now(),
  ) {
    const taskId = String(options?.taskId || '').trim();
    if (!taskId) throw new Error('bindCommandTarget requires an authoritative taskId');
    let episode = this.ensureActive(now);
    // A submitted command creates a new Runtime task unless main explicitly
    // passes the same taskId (the W02 continuation path). Preview objects from
    // an earlier task must never leak merely because its UI episode TTL lives.
    if (episode.taskId && episode.taskId !== taskId) episode = this.start(now);
    episode.taskId = taskId;
    const taskContext: UnknownRecord = episode.taskContext || TaskSources.emptyTaskContext(taskId);
    episode.taskContext = taskContext;
    const mode: SlotAlias = options?.slot || 'this';
    if (options?.intent !== undefined) episode.pendingIntent = options.intent;
    const utterance = String(command || '').trim();
    if (utterance) episode.utterances.push(utterance.slice(0, 500));
    if (episode.utterances.length > 20) episode.utterances.splice(0, episode.utterances.length - 20);

    let result;
    if (mode === 'here') result = this.bindHere(input, now);
    else if (mode === 'these') result = this.appendToThese(input, now);
    else if (mode === 'that') {
      result = this.bindPointedObject(input, now);
      if (episode.slots.this) {
        episode.slots.that = episode.slots.this;
        episode.slots.this = null;
      }
    }
    else result = this.bindPointedObject(input, now);

    const object = normalizeObject(input);
    if (!object) return null;
    const source: any = taskSourceForObject(taskId, object);
    const rawRegions = Array.isArray(input.regions)
      ? input.regions.filter((item) => item && typeof item === 'object').slice(0, 12)
      : [];
    const regions = rawRegions.length > 1 ? rawRegions : [null];
    const basePart = stableSelectionPart(object);
    const currentReferences = taskContext.references as UnknownRecord;
    const nextOrdinal = Math.max(
      0,
      ...Object.values(currentReferences).map((item: any) => Number(item?.ordinal) || 0),
    ) + 1;
    const updates: any[] = regions.map((rawRegion: any, index: number) => {
      const referenceId = `reference:${basePart}${regions.length > 1 ? `:${index}` : ''}`;
      const existing: any = currentReferences[referenceId];
      const ordinal = existing?.ordinal || nextOrdinal + index;
      const binding = TaskSources.normalizeReferenceBinding({
        referenceId,
        label: existing?.label || TaskSources.referenceLabel(ordinal),
        sourceId: source.sourceId,
        locator: rawRegion ? {
          kind: 'visual-region',
          value: {
            snapshotId: String(object.snapshotId || ''),
            strokeIndex: Number(rawRegion.strokeIndex) || 0,
            bbox: clone(rawRegion.bbox || null),
            coordinateSpace: 'physical-screen-pixels',
          },
        } : locatorForObject(object),
        role: options?.role || existing?.role || 'target',
        frameLeaseId: object.frameLeaseId || existing?.frameLeaseId || null,
        capturedAtMs: existing?.capturedAtMs || (
          Number.isFinite(Date.parse(String(object.capturedAt || '')))
            ? Date.parse(String(object.capturedAt))
            : now
        ),
        ordinal,
        active: true,
      });
      return { operation: existing ? 'correct' : 'add', binding };
    });
    const revision = Number(taskContext.referenceRevision || 0) + 1;
    episode.taskContext = TaskSources.reduceTaskContext(taskContext, {
      type: 'context/updated',
      data: { taskId, sources: [source], referenceUpdates: updates, referenceRevision: revision },
    });
    const timeline: UnknownRecord[] = [];
    if (utterance) timeline.push({
      eventId: `utterance:${episode.id}:${now}`,
      kind: 'utterance',
      startMs: now,
      endMs: now,
      text: utterance.slice(0, 500),
    });
    for (const update of updates) timeline.push({
      eventId: `point:${update.binding.referenceId}:${now}`,
      kind: 'point', startMs: now, endMs: now,
      referenceId: update.binding.referenceId,
    });
    episode.taskInput = TaskSources.normalizeTaskInput({
      inputId: `input:${updates[0].binding.referenceId}:${revision}`,
      taskId,
      target: 'next-step',
      instruction: utterance,
      referenceUpdates: updates,
      sourceIds: [source.sourceId],
      timeline,
      capturedAtMs: now,
    });
    this.recordEvent(episode, 'utterance', {
      mode,
      intent: episode.pendingIntent,
      text: utterance.slice(0, 500),
      referenceIds: updates.map((update) => update.binding.referenceId),
    }, now);
    return result ? this.snapshot(episode) : null;
  }

  removeTaskReference(referenceId: unknown, now = Date.now()) {
    const episode = this.active(now);
    const id = String(referenceId || '').trim();
    const context = episode?.taskContext;
    if (!episode || !context || !episode.taskId || !id) return null;
    const current = (context.references as UnknownRecord)[id] as UnknownRecord | undefined;
    if (!current || current.active === false) return this.snapshot(episode);
    const update = { operation: 'remove', binding: { ...clone(current), active: false } };
    const revision = Number(context.referenceRevision || 0) + 1;
    episode.taskContext = TaskSources.reduceTaskContext(context, {
      type: 'context/updated',
      data: {
        taskId: episode.taskId,
        sources: [],
        referenceUpdates: [update],
        referenceRevision: revision,
      },
    });
    episode.taskInput = TaskSources.normalizeTaskInput({
      inputId: `input:${id}:${revision}`,
      taskId: episode.taskId,
      target: 'next-step',
      instruction: '',
      referenceUpdates: [update],
      sourceIds: [],
      timeline: [{
        eventId: `point:${id}:${now}`,
        kind: 'point',
        startMs: now,
        endMs: now,
        referenceId: id,
      }],
      capturedAtMs: now,
    });
    this.recordEvent(episode, 'remove', { referenceIds: [id] }, now);
    return this.snapshot(episode);
  }

  labelCurrent(label: unknown, now = Date.now()) {
    const episode = this.active(now);
    const normalized = String(label || '').trim().toUpperCase();
    const object = episode?.slots?.this;
    if (!episode || !object || !/^[A-Z]$/.test(normalized)) return null;
    const previousObjectId = episode.labels.get(normalized);
    if (previousObjectId && previousObjectId !== object.objectId) {
      const previous = episode.objects.get(previousObjectId);
      if (previous) delete previous.referenceLabel;
    }
    if (object.referenceLabel && object.referenceLabel !== normalized) episode.labels.delete(object.referenceLabel);
    object.referenceLabel = normalized;
    episode.objects.set(object.objectId, object);
    episode.labels.set(normalized, object.objectId);
    this.recordEvent(episode, 'label', { alias: normalized, objectIds: [object.objectId] }, now);
    return this.snapshot(episode);
  }

  bindHere(input: UnknownRecord, now = Date.now()) {
    const episode = this.ensureActive(now);
    const object = this.remember(episode, input);
    if (!object) return null;
    episode.slots.here = object;
    this.recordEvent(episode, 'bind', { alias: 'here', objectIds: [object.objectId] }, now);
    return this.snapshot(episode);
  }

  correctReference(alias: string, value: string | string[], now = Date.now()) {
    const episode = this.active(now);
    if (!episode || !['this', 'that', 'these', 'here'].includes(alias)) return null;
    if (alias === 'these') return this.bindThese(Array.isArray(value) ? value : [value], now);
    const slotAlias = alias as Exclude<SlotAlias, 'these'>;
    if (Array.isArray(value)) return null;
    const object = episode.objects.get(value);
    if (!object) return null;
    episode.slots[slotAlias] = object;
    this.recordEvent(episode, 'correct', { alias, objectIds: [object.objectId] }, now);
    return this.snapshot(episode);
  }

  snapshot(episode: InteractionEpisode | null = this.current) {
    if (!episode) return null;
    return {
      id: episode.id,
      state: episode.state,
      createdAt: episode.createdAt,
      updatedAt: episode.updatedAt,
      expiresAt: episode.expiresAt,
      slots: clone(episode.slots),
      pendingIntent: episode.pendingIntent,
      taskId: episode.taskId,
      sources: clone((episode.taskContext?.sources as unknown[]) || []),
      references: clone(Object.values((episode.taskContext?.references as UnknownRecord) || {})),
      referenceRevision: Number(episode.taskContext?.referenceRevision || 0),
      taskInput: clone(episode.taskInput),
      utterances: clone(episode.utterances),
      labels: Object.fromEntries(episode.labels),
      spatialRelations: spatialRelations(episode.slots.these || []),
    };
  }

  contextPayload(now = Date.now()) {
    const episode = this.active(now);
    if (!episode) return null;
    return {
      version: 3,
      episodeId: episode.id,
      expiresAt: episode.expiresAt,
      pendingIntent: episode.pendingIntent,
      utterances: clone(episode.utterances),
      slots: clone(episode.slots),
      objects: clone(Array.from(episode.objects.values())),
      labels: Object.fromEntries(episode.labels),
      spatialRelations: spatialRelations(episode.slots.these || []),
      taskId: episode.taskId,
      sources: clone((episode.taskContext?.sources as unknown[]) || []),
      references: clone(Object.values((episode.taskContext?.references as UnknownRecord) || {})),
      referenceRevision: Number(episode.taskContext?.referenceRevision || 0),
      taskInput: clone(episode.taskInput),
      recentEvents: clone(episode.events.slice(-12)),
    };
  }
}

function inferReferenceLabel(command: unknown): string | null {
  const value = String(command || '').trim();
  const patterns = [
    /(?:这是|这个是|标记为|标为|叫做)\s*([A-Z])(?:\b|$)/i,
    /\b(?:label|mark(?:\s+this)?\s+as|this\s+is)\s+([A-Z])\b/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) return match[1].toUpperCase();
  }
  return null;
}

module.exports = {
  InteractionEpisodeStore,
  inferReferenceLabel,
  normalizeBrowserContext,
  normalizeObject,
  normalizeTerminalEvidence,
  spatialRelations,
  taskReferenceForObject,
  taskSourceForObject,
};
