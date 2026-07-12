class ActivationGate {
  constructor({ debounceMs = 600, repeatQuietMs = 300 } = {}) {
    this.debounceMs = debounceMs;
    this.repeatQuietMs = repeatQuietMs;
    this.lastAcceptedAt = Number.NEGATIVE_INFINITY;
    this.lastEventAt = Number.NEGATIVE_INFINITY;
  }

  decide({ now = Date.now(), hasVisibleSurface = false, isActivationBusy = false } = {}) {
    const quietFor = now - this.lastEventAt;
    this.lastEventAt = now;
    if (isActivationBusy) {
      if (now - this.lastAcceptedAt < this.debounceMs || quietFor < this.repeatQuietMs) return 'ignore';
      this.lastAcceptedAt = now;
      return 'dismiss';
    }
    if (now - this.lastAcceptedAt < this.debounceMs) return 'ignore';
    this.lastAcceptedAt = now;
    return hasVisibleSurface ? 'dismiss' : 'activate';
  }
}

module.exports = { ActivationGate };
