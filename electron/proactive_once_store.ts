'use strict';


type OnceEntry = {
  shown?: boolean;
  shownAt?: number;
  blockedForever?: boolean;
  blockedAt?: number;
};

type OnceItems = Record<string, OnceEntry>;

function createProactiveOnceStore({
  load = () => ({}),
  persist = () => {},
}: {
  load?: () => OnceItems;
  persist?: () => void;
} = {}) {
  let items = load();

  function shouldShow(triggerId: string): boolean {
    const entry = items[triggerId];
    if (!entry) return true;
    if (entry.blockedForever) return false;
    return !entry.shown;
  }

  function markShown(triggerId: string, now = Date.now()): void {
    items[triggerId] = { ...(items[triggerId] || {}), shown: true, shownAt: now };
    persist();
  }

  function blockForever(triggerId: string, now = Date.now()): void {
    items[triggerId] = { ...(items[triggerId] || {}), blockedForever: true, blockedAt: now };
    persist();
  }

  function clear(): void {
    items = {};
    persist();
  }

  function _items(): OnceItems {
    return items;
  }

  return { shouldShow, markShown, blockForever, clear, _items };
}

module.exports = { createProactiveOnceStore };
