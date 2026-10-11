declare global {
  type StudioSidebarLayout = 'docked' | 'hidden' | 'overlay';

  interface StudioSidebarController {
    layout(): StudioSidebarLayout;
    isNarrow(): boolean;
    resize(width: number): void;
    toggle(): void;
    peek(): void;
    dismiss(): void;
    groupExpanded(key: string): boolean;
    toggleGroup(key: string): boolean;
  }

  var StudioSidebarState: {
    create(storage: Storage, width: number): StudioSidebarController;
  };
}

(() => {
  // Claude Desktop's bootFrameLayout uses 288px and collapses at <= 700px.
  const NARROW_VIEWPORT_WIDTH = 700;
  const COLLAPSE_KEY = 'mp:studio-sidebar-collapsed';
  const GROUPS_KEY = 'mp:studio-sidebar-collapsed-groups';

  function create(storage: Storage, width: number): StudioSidebarController {
    let userCollapsed = false;
    let narrow = width <= NARROW_VIEWPORT_WIDTH;
    let temporaryOpen = false;
    const collapsedGroups = new Set<string>();
    try {
      userCollapsed = storage.getItem(COLLAPSE_KEY) === '1';
      const groups: unknown = JSON.parse(storage.getItem(GROUPS_KEY) || '[]');
      if (Array.isArray(groups)) {
        for (const key of groups) {
          if (typeof key === 'string') {
            collapsedGroups.add(key);
          }
        }
      }
    } catch {
      // The current window remains usable when browser storage is unavailable.
    }

    function save(key: string, value: string): void {
      try {
        storage.setItem(key, value);
      } catch {
        // Keep the current preference in memory for this window.
      }
    }

    return {
      isNarrow() {
        return narrow;
      },
      layout() {
        if (!narrow && !userCollapsed) {
          return 'docked';
        }
        return temporaryOpen ? 'overlay' : 'hidden';
      },
      resize(nextWidth) {
        const nextNarrow = nextWidth <= NARROW_VIEWPORT_WIDTH;
        if (narrow !== nextNarrow) {
          narrow = nextNarrow;
          temporaryOpen = false;
        }
      },
      toggle() {
        if (narrow) {
          temporaryOpen = !temporaryOpen;
          return;
        }
        userCollapsed = !userCollapsed;
        temporaryOpen = false;
        save(COLLAPSE_KEY, userCollapsed ? '1' : '0');
      },
      peek() {
        if (!narrow && userCollapsed) {
          temporaryOpen = true;
        }
      },
      dismiss() {
        temporaryOpen = false;
      },
      groupExpanded(key) {
        return !collapsedGroups.has(key);
      },
      toggleGroup(key) {
        const expanded = collapsedGroups.delete(key);
        if (!expanded) {
          collapsedGroups.add(key);
        }
        save(GROUPS_KEY, JSON.stringify([...collapsedGroups]));
        return expanded;
      },
    };
  }

  const api = {create};
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalThis.StudioSidebarState = api;
})();
