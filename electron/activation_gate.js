class ActivationGate {
  constructor({ debounceMs = 600 } = {}) {
    this.debounceMs = debounceMs;
    this.lastAcceptedAt = Number.NEGATIVE_INFINITY;
  }

  decide({ now = Date.now(), hasVisibleSurface = false } = {}) {
    if (now - this.lastAcceptedAt < this.debounceMs) return 'ignore';
    this.lastAcceptedAt = now;
    return hasVisibleSurface ? 'dismiss' : 'activate';
  }
}

module.exports = { ActivationGate };
