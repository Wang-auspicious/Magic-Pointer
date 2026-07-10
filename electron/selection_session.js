const crypto = require('crypto');

class SelectionSessionStore {
  constructor({ ttlMs = 2 * 60 * 1000, idFactory = () => crypto.randomUUID() } = {}) {
    this.ttlMs = ttlMs;
    this.idFactory = idFactory;
    this.sessions = new Map();
  }

  prune(now = Date.now()) {
    for (const [token, entry] of this.sessions.entries()) {
      if (!entry || entry.expiresAt <= now || entry.state === 'cancelled') {
        this.sessions.delete(token);
      }
    }
  }

  create({ reason = 'manual', cursor = null } = {}, now = Date.now()) {
    this.prune(now);
    const token = this.idFactory();
    const entry = {
      token,
      reason,
      cursor,
      state: 'capturing',
      snapshot: null,
      summary: null,
      suggestedCommands: [],
      activeRequestId: null,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(token, entry);
    return entry;
  }

  get(token, now = Date.now()) {
    this.prune(now);
    if (typeof token !== 'string' || !token) return null;
    return this.sessions.get(token) || null;
  }

  attachSnapshot(token, payload, now = Date.now()) {
    const entry = this.get(token, now);
    if (!entry) return null;
    entry.snapshot = payload?.selectionSnapshot || null;
    entry.summary = payload?.captureSummary || null;
    entry.suggestedCommands = Array.isArray(payload?.suggestedCommands)
      ? payload.suggestedCommands.slice(0, 4)
      : [];
    entry.state = entry.snapshot ? 'ready' : 'unavailable';
    return entry;
  }

  startRequest(token, now = Date.now()) {
    const entry = this.get(token, now);
    if (!entry || !entry.snapshot) return null;
    const requestId = this.idFactory();
    entry.activeRequestId = requestId;
    entry.state = 'running';
    return requestId;
  }

  finishRequest(token, requestId, now = Date.now()) {
    const entry = this.get(token, now);
    if (!entry || entry.activeRequestId !== requestId) return null;
    entry.state = 'ready';
    return entry;
  }

  isCurrentRequest(token, requestId, now = Date.now()) {
    const entry = this.get(token, now);
    return Boolean(entry && entry.activeRequestId === requestId);
  }

  cancel(token) {
    const entry = this.sessions.get(token);
    if (!entry) return false;
    entry.state = 'cancelled';
    this.sessions.delete(token);
    return true;
  }
}

module.exports = {
  SelectionSessionStore,
};
