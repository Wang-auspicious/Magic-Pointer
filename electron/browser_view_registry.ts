'use strict';

interface BrowserViewEntry<TView> {
  key: string;
  view: TView;
  projectRoot: string;
  relativePath: string;
  url: string;
  active: boolean;
  lastActivatedAt: number;
}

interface BrowserViewRegistryOptions {
  now?: () => number;
}

class BrowserViewRegistry<TView> {
  private readonly entries = new Map<string, BrowserViewEntry<TView>>();

  private readonly now: () => number;

  private activeKey = '';

  constructor(options: BrowserViewRegistryOptions = {}) {
    this.now = options.now || Date.now;
  }

  get active(): BrowserViewEntry<TView> | undefined {
    return this.activeKey ? this.entries.get(this.activeKey) : undefined;
  }

  open(
    request: {
      key: string;
      projectRoot: string;
      relativePath: string;
      url: string;
    },
    create: () => TView,
  ): {entry: BrowserViewEntry<TView>; reused: boolean} {
    const existing = this.entries.get(request.key);
    if (existing) {
      existing.projectRoot = request.projectRoot;
      existing.relativePath = request.relativePath;
      existing.url = request.url;
      this.activate(request.key);
      return {entry: existing, reused: true};
    }
    const entry: BrowserViewEntry<TView> = {
      ...request,
      view: create(),
      active: true,
      lastActivatedAt: this.now(),
    };
    this.entries.forEach(item => {
      item.active = false;
    });
    this.entries.set(request.key, entry);
    this.activeKey = request.key;
    return {entry, reused: false};
  }

  activate(key: string): BrowserViewEntry<TView> | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    this.entries.forEach(item => {
      item.active = item.key === key;
    });
    entry.lastActivatedAt = this.now();
    this.activeKey = key;
    return entry;
  }

  close(
    key: string,
    destroy: (view: TView) => void,
  ): BrowserViewEntry<TView> | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    this.entries.delete(key);
    destroy(entry.view);
    if (this.activeKey === key) {
      const next = [...this.entries.values()].sort(
        (left, right) => right.lastActivatedAt - left.lastActivatedAt,
      )[0];
      this.activeKey = next?.key || '';
      if (next) {
        this.activate(next.key);
      }
    }
    return entry;
  }

  closeAll(destroy: (view: TView) => void): void {
    for (const entry of this.entries.values()) {
      destroy(entry.view);
    }
    this.entries.clear();
    this.activeKey = '';
  }

  snapshot(): Array<BrowserViewEntry<TView>> {
    return [...this.entries.values()].map(entry => ({...entry}));
  }
}

export {BrowserViewRegistry};
export type {BrowserViewEntry};
