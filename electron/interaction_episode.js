const crypto = require('crypto');

const ALLOWED_OBJECT_FIELDS = [
  'objectId', 'snapshotId', 'selectionSessionToken', 'app', 'windowTitle',
  'label', 'referenceLabel', 'kind', 'capturedAt', 'expiresAt', 'content',
];
const ALLOWED_SOURCE_FIELDS = ['app', 'title', 'path', 'annotatedPath', 'url', 'page', 'hwnd', 'processId'];

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizePerceptionTrace(input) {
  if (!input || typeof input !== 'object' || Number(input.schemaVersion) !== 1) return null;
  const trace = { schemaVersion: 1 };
  for (const field of ['selectedLayer', 'selectedAdapter', 'selectedMethod', 'fallbackReason', 'policyMode']) {
    const value = input[field];
    if (typeof value === 'string' && value.trim()) trace[field] = value.trim().slice(0, 120);
  }
  trace.pixelFallbackUsed = input.pixelFallbackUsed === true;
  trace.attempts = (Array.isArray(input.attempts) ? input.attempts : []).slice(0, 12)
    .filter(item => item && typeof item === 'object')
    .map((item) => {
      const attempt = {};
      for (const field of ['layer', 'adapter', 'method', 'status', 'reason']) {
        const value = item[field];
        if (typeof value === 'string' && value.trim()) attempt[field] = value.trim().slice(0, 120);
      }
      return attempt;
    });
  return trace;
}

function normalizeTerminalEvidence(input) {
  if (!input || typeof input !== 'object' || Number(input.schemaVersion) !== 1) return null;
  const state = ['resolved', 'partial', 'unavailable'].includes(input.state) ? input.state : 'unavailable';
  const bounded = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
  const integer = (value, fallback = 0) => Number.isInteger(Number(value)) ? Number(value) : fallback;
  const anchorInput = input.anchor && typeof input.anchor === 'object' ? input.anchor : {};
  const windowInput = input.window && typeof input.window === 'object' ? input.window : {};
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
      .filter(value => typeof value === 'string' && value.trim())
      .map(value => value.trim().slice(0, 160)),
  };
  return result;
}

function normalizeBrowserContext(input) {
  if (!input || typeof input !== 'object' || Number(input.schemaVersion) !== 1) return null;
  const bounded = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
  const number = value => Number.isFinite(Number(value)) ? Number(value) : null;
  const point = (value) => value && typeof value === 'object' && number(value.x) != null && number(value.y) != null
    ? { x: number(value.x), y: number(value.y) }
    : null;
  const rect = (value) => value && typeof value === 'object'
    && ['x', 'y', 'width', 'height'].every(key => number(value[key]) != null)
    ? Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, number(value[key])]))
    : null;
  const page = input.page && typeof input.page === 'object' ? input.page : {};
  const node = input.node && typeof input.node === 'object' ? input.node : {};
  const coordinates = input.coordinates && typeof input.coordinates === 'object' ? input.coordinates : {};
  const provenance = input.provenance && typeof input.provenance === 'object' ? input.provenance : {};
  const allowedAttributes = new Set(['id', 'name', 'type', 'href', 'src', 'alt', 'title', 'role', 'aria-label', 'aria-labelledby', 'data-testid', 'data-test', 'data-qa']);
  const attributes = {};
  for (const [key, value] of Object.entries(node.attributes && typeof node.attributes === 'object' ? node.attributes : {}).slice(0, 20)) {
    if (allowedAttributes.has(key) && typeof value === 'string') attributes[key] = value.slice(0, 1000);
  }
  return {
    schemaVersion: 1,
    state: ['resolved', 'partial', 'unavailable'].includes(input.state) ? input.state : 'unavailable',
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
      .filter(item => item && typeof item === 'object')
      .map(item => ({
        url: bounded(item.url, 4000), errorText: bounded(item.errorText, 300),
        source: bounded(item.source, 80), timestamp: bounded(item.timestamp, 80),
        requestId: bounded(item.requestId, 160), status: number(item.status),
      })),
    provenance: {
      endpoint: bounded(provenance.endpoint, 1000), targetId: bounded(provenance.targetId, 200),
      structural: provenance.structural === true,
      networkSources: (Array.isArray(provenance.networkSources) ? provenance.networkSources : []).slice(0, 8).filter(item => typeof item === 'string').map(item => item.slice(0, 80)),
    },
    uncertainty: (Array.isArray(input.uncertainty) ? input.uncertainty : []).slice(0, 12).filter(item => typeof item === 'string').map(item => item.slice(0, 200)),
  };
}

function normalizeObject(input) {
  if (!input || typeof input !== 'object') return null;
  const snapshotId = typeof input.snapshotId === 'string' ? input.snapshotId.trim() : '';
  const suppliedObjectId = typeof input.objectId === 'string' ? input.objectId.trim() : '';
  const objectId = suppliedObjectId || (snapshotId ? `selection:${snapshotId}` : '');
  if (!objectId) return null;
  const normalized = { objectId };
  for (const field of ALLOWED_OBJECT_FIELDS.slice(1)) {
    if (typeof input[field] === 'string' && input[field].trim()) {
      normalized[field] = input[field].trim().slice(0, field === 'content' ? 12000 : 500);
    }
  }
  if (Array.isArray(input.bbox) && input.bbox.length === 4 && input.bbox.every(Number.isFinite)) {
    normalized.bbox = input.bbox.slice();
  } else if (input.bbox && typeof input.bbox === 'object') {
    const bbox = {
      x: Number(input.bbox.x),
      y: Number(input.bbox.y),
      width: Number(input.bbox.width),
      height: Number(input.bbox.height),
    };
    if (Object.values(bbox).every(Number.isFinite)) normalized.bbox = bbox;
  }
  if (input.source && typeof input.source === 'object') {
    const source = {};
    for (const field of ALLOWED_SOURCE_FIELDS) {
      const value = input.source[field];
      if (typeof value === 'string' && value.trim()) source[field] = value.trim().slice(0, 2000);
      else if (typeof value === 'number' && Number.isFinite(value)) source[field] = value;
    }
    const attestation = input.source.captureAttestation;
    if (attestation && typeof attestation === 'object') {
      const expectedInput = attestation.expected && typeof attestation.expected === 'object'
        ? attestation.expected
        : {};
      const expected = {};
      for (const field of ['hwnd', 'processId', 'processName', 'title', 'desktopId']) {
        const value = expectedInput[field];
        if (typeof value === 'string' && value.trim()) expected[field] = value.trim().slice(0, 2000);
        else if (typeof value === 'number' && Number.isFinite(value)) expected[field] = value;
      }
      const normalizedAttestation = {};
      if (typeof attestation.status === 'string' && attestation.status.trim()) {
        normalizedAttestation.status = attestation.status.trim().slice(0, 80);
      }
      if (typeof attestation.phase === 'string' && attestation.phase.trim()) {
        normalizedAttestation.phase = attestation.phase.trim().slice(0, 80);
      }
      if (Object.keys(expected).length) normalizedAttestation.expected = expected;
      if (Object.keys(normalizedAttestation).length) source.captureAttestation = normalizedAttestation;
    }
    const perceptionTrace = normalizePerceptionTrace(input.source.perceptionTrace);
    if (perceptionTrace) source.perceptionTrace = perceptionTrace;
    const terminalEvidence = normalizeTerminalEvidence(input.source.terminalEvidence);
    if (terminalEvidence) source.terminalEvidence = terminalEvidence;
    const browserContext = normalizeBrowserContext(input.source.browserContext);
    if (browserContext) source.browserContext = browserContext;
    if (Object.keys(source).length) normalized.source = source;
  }
  normalized.kind = normalized.kind || 'native_selection';
  return normalized;
}

function bboxMetrics(value) {
  if (Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)) {
    const [left, top, right, bottom] = value.map(Number);
    return { cx: (left + right) / 2, cy: (top + bottom) / 2 };
  }
  if (value && typeof value === 'object') {
    const x = Number(value.x);
    const y = Number(value.y);
    const width = Number(value.width);
    const height = Number(value.height);
    if ([x, y, width, height].every(Number.isFinite)) return { cx: x + width / 2, cy: y + height / 2 };
  }
  return null;
}

function spatialRelations(objects) {
  const results = [];
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

class InteractionEpisodeStore {
  constructor({ ttlMs = 30 * 60 * 1000, idFactory = () => crypto.randomUUID() } = {}) {
    this.ttlMs = ttlMs;
    this.idFactory = idFactory;
    this.current = null;
  }

  start(now = Date.now()) {
    this.current = {
      id: this.idFactory(),
      state: 'active',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.ttlMs,
      objects: new Map(),
      labels: new Map(),
      slots: { this: null, that: null, these: [], here: null },
      events: [],
    };
    return this.current;
  }

  active(now = Date.now()) {
    if (!this.current || this.current.state !== 'active' || this.current.expiresAt <= now) {
      this.current = null;
      return null;
    }
    return this.current;
  }

  ensureActive(now = Date.now()) {
    return this.active(now) || this.start(now);
  }

  touch(episode, now) {
    episode.updatedAt = now;
    episode.expiresAt = now + this.ttlMs;
  }

  remember(episode, input) {
    const object = normalizeObject(input);
    if (!object) return null;
    const previous = episode.objects.get(object.objectId);
    if (previous?.referenceLabel && !object.referenceLabel) object.referenceLabel = previous.referenceLabel;
    episode.objects.set(object.objectId, object);
    return object;
  }

  recordEvent(episode, type, payload, now) {
    episode.events.push({ type, ...payload, at: now });
    if (episode.events.length > 40) episode.events.splice(0, episode.events.length - 40);
    this.touch(episode, now);
  }

  bindPointedObject(input, now = Date.now()) {
    const episode = this.ensureActive(now);
    const object = this.remember(episode, input);
    if (!object) return null;
    const previous = episode.slots.this;
    if (previous && previous.objectId !== object.objectId) episode.slots.that = previous;
    episode.slots.this = object;
    this.recordEvent(episode, 'bind', { alias: 'this', objectIds: [object.objectId] }, now);
    return this.snapshot(episode);
  }

  bindThese(objectIds = null, now = Date.now()) {
    const episode = this.active(now);
    if (!episode) return null;
    const requested = Array.isArray(objectIds) && objectIds.length
      ? objectIds
      : episode.labels.size
        ? Array.from(episode.labels.values())
        : [episode.slots.that?.objectId, episode.slots.this?.objectId];
    const seen = new Set();
    episode.slots.these = requested
      .map((objectId) => episode.objects.get(objectId))
      .filter((object) => object && !seen.has(object.objectId) && seen.add(object.objectId));
    if (!episode.slots.these.length) return null;
    this.recordEvent(episode, 'bind', { alias: 'these', objectIds: episode.slots.these.map((item) => item.objectId) }, now);
    return this.snapshot(episode);
  }

  labelCurrent(label, now = Date.now()) {
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

  bindHere(input, now = Date.now()) {
    const episode = this.ensureActive(now);
    const object = this.remember(episode, input);
    if (!object) return null;
    episode.slots.here = object;
    this.recordEvent(episode, 'bind', { alias: 'here', objectIds: [object.objectId] }, now);
    return this.snapshot(episode);
  }

  correctReference(alias, value, now = Date.now()) {
    const episode = this.active(now);
    if (!episode || !['this', 'that', 'these', 'here'].includes(alias)) return null;
    if (alias === 'these') return this.bindThese(Array.isArray(value) ? value : [value], now);
    const object = episode.objects.get(value);
    if (!object) return null;
    episode.slots[alias] = object;
    this.recordEvent(episode, 'correct', { alias, objectIds: [object.objectId] }, now);
    return this.snapshot(episode);
  }

  snapshot(episode = this.current) {
    if (!episode) return null;
    return {
      id: episode.id,
      state: episode.state,
      createdAt: episode.createdAt,
      updatedAt: episode.updatedAt,
      expiresAt: episode.expiresAt,
      slots: clone(episode.slots),
      labels: Object.fromEntries(episode.labels),
      spatialRelations: spatialRelations(episode.slots.these || []),
    };
  }

  contextPayload(now = Date.now()) {
    const episode = this.active(now);
    if (!episode) return null;
    return {
      version: 1,
      episodeId: episode.id,
      expiresAt: episode.expiresAt,
      slots: clone(episode.slots),
      objects: clone(Array.from(episode.objects.values())),
      labels: Object.fromEntries(episode.labels),
      spatialRelations: spatialRelations(episode.slots.these || []),
      recentEvents: clone(episode.events.slice(-12)),
    };
  }
}

function inferReferenceMode(command) {
  const value = String(command || '').trim().toLowerCase();
  if (/\b(here|there)\b|这里|那里|这儿|那儿|此处|放到|写到|插入到/.test(value)) return 'here';
  if (/\b(these|those|them|both)\b|这些|那些|它们|两个|一起|合并这些|比较这些|对比这些/.test(value)) return 'these';
  if (/\b(here|there)\b|这里|那里|这儿|那儿|此处|放到|写到|插入到/.test(value)) return 'here';
  if (/\b(these|those|them|both)\b|这些|那些|它们|两者|一起|合并/.test(value)) return 'these';
  return 'this';
}

function inferReferenceLabel(command) {
  const value = String(command || '').trim();
  const patterns = [
    /(?:这是|这个是|标记为|标为|叫做)\s*([A-Z])(?:\b|$)/i,
    /\b(?:label|mark(?:\s+this)?\s+as|this\s+is)\s+([A-Z])\b/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

module.exports = { InteractionEpisodeStore, inferReferenceLabel, inferReferenceMode, normalizeBrowserContext, normalizeObject, normalizeTerminalEvidence, spatialRelations };
