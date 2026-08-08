'use strict';

class RendererReadiness {
  isReady: boolean;
  waiters: Set<() => void>;

  constructor() {
    this.isReady = false;
    this.waiters = new Set();
  }

  reset(): void {
    this.isReady = false;
  }

  whenReady(callback: unknown): () => boolean | void {
    if (typeof callback !== 'function') return () => {};
    if (this.isReady) {
      callback();
      return () => {};
    }
    const readyCallback = callback as () => void;
    this.waiters.add(readyCallback);
    return () => this.waiters.delete(readyCallback);
  }

  markReady(): void {
    if (this.isReady) return;
    this.isReady = true;
    const pending = [...this.waiters];
    this.waiters.clear();
    for (const callback of pending) callback();
  }
}

module.exports = { RendererReadiness };
