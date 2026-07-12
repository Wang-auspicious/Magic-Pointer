const crypto = require('crypto');

const ALLOWED_OBJECT_FIELDS = [
  'objectId', 'snapshotId', 'selectionSessionToken', 'app', 'windowTitle',
  'label', 'kind', 'capturedAt', 'expiresAt', 'content',
];

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
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
  normalized.kind = normalized.kind || 'native_selection';
  return normalized;
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
      : [episode.slots.that?.objectId, episode.slots.this?.objectId];
    const seen = new Set();
    episode.slots.these = requested
      .map((objectId) => episode.objects.get(objectId))
      .filter((object) => object && !seen.has(object.objectId) && seen.add(object.objectId));
    if (!episode.slots.these.length) return null;
    this.recordEvent(episode, 'bind', { alias: 'these', objectIds: episode.slots.these.map((item) => item.objectId) }, now);
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
      recentEvents: clone(episode.events.slice(-12)),
    };
  }
}

function inferReferenceMode(command) {
  const value = String(command || '').trim().toLowerCase();
  if (/\b(here|there)\b|这里|那里|这儿|那儿|此处|放到|写到|插入到/.test(value)) return 'here';
  if (/\b(these|those|them|both)\b|这些|那些|它们|两者|一起|合并/.test(value)) return 'these';
  return 'this';
}

module.exports = { InteractionEpisodeStore, inferReferenceMode, normalizeObject };
