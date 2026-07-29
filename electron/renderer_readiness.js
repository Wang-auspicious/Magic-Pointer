'use strict';

class RendererReadiness {
  constructor() {
    this.isReady = false;
    this.waiters = new Set();
  }

  reset() {
    this.isReady = false;
  }

  whenReady(callback) {
    if (typeof callback !== 'function') return () => {};
    if (this.isReady) {
      callback();
      return () => {};
    }
    this.waiters.add(callback);
    return () => this.waiters.delete(callback);
  }

  markReady() {
    if (this.isReady) return;
    this.isReady = true;
    const pending = [...this.waiters];
    this.waiters.clear();
    for (const callback of pending) callback();
  }
}

module.exports = { RendererReadiness };
