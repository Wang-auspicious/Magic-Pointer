'use strict';

/**
 * Claude's session-pane contract, recovered from the shipped web bundle.
 *
 * Two independent pieces of state drive the right-hand side in Claude:
 *
 * 1. The **pane grid** (`epitaxy.sidePaneStore.v1`): an N-column tiled layout
 *    whose column count is derived from the container width and whose per-mode
 *    column weights are discarded whenever the column count changes.
 * 2. The **agent sidebar** (`agent-sidebar-store`): one collapsible session
 *    pane with a per-session override, a global persisted collapse flag, and
 *    two mutually exclusive "you cannot have a column" modes — a narrow
 *    viewport (the pane becomes an overlay) and a docked computer-use surface
 *    (the pane does not toggle at all).
 *
 * The constants below are the values Claude actually uses, not round numbers
 * chosen here:
 *
 *   SIDEBAR_WIDTH              288   default app-sidebar width
 *   SIDEBAR_COLLAPSE_WIDTH     700   app sidebar collapses at or below this
 *   PANE_OVERLAY_WIDTH         768   the pane's own container width that turns
 *                                    the column into an overlay
 *   COLUMN_BUDGET_PX           360   one column's width budget
 *   MAX_COLUMNS                  5   hard cap on columns
 *   COLUMN_MIN_FRACTION       0.15   a column may shrink to 15% of the row
 *   COLUMN_MAX_FRACTION       0.85   a column may grow to 85%
 *   DEFAULT_SPLIT              0.5   initial and default column split
 *   COLUMN_MIN_PX              320   absolute minimum column width
 *
 * Only `userCollapsed` is persisted on the agent sidebar; per-session state is
 * deliberately volatile so switching conversations re-derives from the global
 * flag.
 */
(() => {
  const SIDEBAR_WIDTH = 288;
  const SIDEBAR_COLLAPSE_WIDTH = 700;
  const PANE_OVERLAY_WIDTH = 768;

  const COLUMN_BUDGET_PX = 360;
  const MAX_COLUMNS = 5;
  const COLUMN_MIN_FRACTION = 0.15;
  const COLUMN_MAX_FRACTION = 0.85;
  const DEFAULT_SPLIT = 0.5;
  const COLUMN_MIN_PX = 320;

  /** Modes Claude keys its pane layouts by. */
  type PaneMode = 'chat' | 'cowork' | 'code';

  interface PaneAddress {
    col: number;
    row: 0 | 1;
  }

  interface PaneEntry {
    ref: string;
    pos: PaneAddress;
    openedBy: string;
  }

  interface PaneGridState {
    extraPanesByMode: Partial<Record<PaneMode, PaneEntry[]>>;
    focusedIndex: number;
    colWeightsByMode: Partial<Record<PaneMode, number[]>>;
    rowSplit: number;
    maxColumns: number;
    constrained: boolean;
  }

  interface AgentSidebarState {
    expandedBySession: Record<string, boolean>;
    autoOpenSeededFor: Record<string, boolean>;
    perSessionExpanded: Record<string, boolean>;
    userCollapsed: boolean;
    isViewportNarrow: boolean;
    isCuDocked: boolean;
    isOverlayOpen: boolean;
  }

  function isPaneMode(value: unknown): value is PaneMode {
    return value === 'chat' || value === 'cowork' || value === 'code';
  }

  /**
   * Column count for a container width: `floor(width / 360)` clamped to 1..5.
   * A zero-width container still gets one column.
   */
  function maxColumnsFor(availableWidth: unknown): number {
    const width = Number(availableWidth);
    if (!Number.isFinite(width)) {
      return 1;
    }
    const fitted = Math.floor(width / COLUMN_BUDGET_PX);
    if (fitted < 1) {
      return 1;
    }
    return Math.min(MAX_COLUMNS, fitted);
  }

  /** Column width as a fraction of the row, clamped to 15%..85%. */
  function clampColumnFraction(fraction: unknown): number {
    const value = Number(fraction);
    const safe = Number.isFinite(value) ? value : DEFAULT_SPLIT;
    return Math.min(COLUMN_MAX_FRACTION, Math.max(COLUMN_MIN_FRACTION, safe));
  }

  /** The horizontal split between a top and bottom pane in one column. */
  function clampRowSplit(split: unknown): number {
    return clampColumnFraction(split);
  }

  /**
   * Pixel width for a column given the row width. Returns the absolute floor
   * when the fractional result would fall below `COLUMN_MIN_PX`.
   */
  function columnWidthPx(rowWidth: unknown, fraction: unknown): number {
    const width = Number(rowWidth);
    const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
    return Math.max(COLUMN_MIN_PX, Math.round(safeWidth * clampColumnFraction(fraction)));
  }

  function createPaneGridState(): PaneGridState {
    return {
      extraPanesByMode: {},
      focusedIndex: 0,
      colWeightsByMode: {},
      rowSplit: DEFAULT_SPLIT,
      maxColumns: 2,
      constrained: false,
    };
  }

  /**
   * Claude discards a mode's remembered weights whenever its column count
   * changes, so a layout is never remembered across a count change.
   */
  function setMaxColumns(
    state: PaneGridState,
    mode: PaneMode,
    nextMaxColumns: unknown,
  ): PaneGridState {
    const columns = Number(nextMaxColumns);
    const clamped = Number.isFinite(columns)
      ? Math.max(1, Math.min(MAX_COLUMNS, Math.floor(columns)))
      : state.maxColumns;
    if (clamped === state.maxColumns) {
      return state;
    }
    const colWeightsByMode = {...state.colWeightsByMode};
    delete colWeightsByMode[mode];
    return {...state, maxColumns: clamped, colWeightsByMode};
  }

  function createAgentSidebarState(): AgentSidebarState {
    return {
      expandedBySession: {},
      autoOpenSeededFor: {},
      perSessionExpanded: {},
      userCollapsed: false,
      isViewportNarrow: false,
      isCuDocked: false,
      isOverlayOpen: false,
    };
  }

  function sidebarViewportIsNarrow(containerWidth: unknown): boolean {
    const width = Number(containerWidth);
    if (!Number.isFinite(width)) {
      return false;
    }
    return width < PANE_OVERLAY_WIDTH;
  }

  function setSidebarViewportNarrow(
    state: AgentSidebarState,
    narrow: boolean,
  ): AgentSidebarState {
    if (narrow === state.isViewportNarrow) {
      return state;
    }
    return {
      ...state,
      isViewportNarrow: narrow,
      isOverlayOpen: narrow ? state.isOverlayOpen : false,
    };
  }

  /** A docked computer-use surface wins the right side outright. */
  function setComputerUseDocked(
    state: AgentSidebarState,
    docked: boolean,
  ): AgentSidebarState {
    if (docked === state.isCuDocked) {
      return state;
    }
    return {
      ...state,
      isCuDocked: docked,
      isOverlayOpen: docked ? false : state.isOverlayOpen,
    };
  }

  function sidebarIsExpandedForSession(
    state: AgentSidebarState,
    sessionId: string,
    options: {perSession?: boolean; fallback?: boolean} = {},
  ): boolean {
    if (state.isViewportNarrow || state.isCuDocked) {
      return false;
    }
    const fallback = options.fallback === true;
    if (options.perSession) {
      return state.perSessionExpanded[sessionId] ?? fallback;
    }
    return state.expandedBySession[sessionId] ?? !state.userCollapsed;
  }

  /**
   * Toggle from the pane header. Mirrors Claude exactly:
   * a docked computer-use surface does nothing; a narrow viewport flips the
   * overlay instead of the column; otherwise the global collapse flag becomes
   * the inverse of this session's expansion and every per-session expansion is
   * dropped.
   */
  function toggleSidebarForSession(
    state: AgentSidebarState,
    sessionId: string,
  ): AgentSidebarState {
    if (state.isCuDocked) {
      return state;
    }
    if (state.isViewportNarrow) {
      return {...state, isOverlayOpen: !state.isOverlayOpen};
    }
    const expanded = sidebarIsExpandedForSession(state, sessionId);
    return {
      ...state,
      userCollapsed: expanded,
      expandedBySession: {},
    };
  }

  /** Per-session override, with the same viewport guard as the main toggle. */
  function toggleSidebarPerSession(
    state: AgentSidebarState,
    sessionId: string,
  ): AgentSidebarState {
    if (state.isCuDocked) {
      return state;
    }
    if (state.isViewportNarrow) {
      return {...state, isOverlayOpen: !state.isOverlayOpen};
    }
    return {
      ...state,
      perSessionExpanded: {
        ...state.perSessionExpanded,
        [sessionId]: state.perSessionExpanded[sessionId] !== true,
      },
    };
  }

  /**
   * Seed a session as collapsed, exactly once. Claude tracks the seeding
   * separately so a later `toggleSidebarForSession` is not undone by a re-seed.
   */
  function seedSidebarCollapsedForSession(
    state: AgentSidebarState,
    sessionId: string,
  ): AgentSidebarState {
    if (state.autoOpenSeededFor[sessionId] === true) {
      return state;
    }
    return {
      ...state,
      autoOpenSeededFor: {...state.autoOpenSeededFor, [sessionId]: true},
      expandedBySession: {...state.expandedBySession, [sessionId]: false},
    };
  }

  /** The persisted slice: Claude stores `userCollapsed` and nothing else. */
  function serializeAgentSidebarState(state: AgentSidebarState): string {
    return JSON.stringify({state: {userCollapsed: state.userCollapsed}, version: 0});
  }

  function restoreAgentSidebarState(raw: unknown): AgentSidebarState {
    const base = createAgentSidebarState();
    if (typeof raw !== 'string' || raw === '') {
      return base;
    }
    try {
      const parsed = JSON.parse(raw) as {state?: {userCollapsed?: unknown}};
      return {...base, userCollapsed: parsed?.state?.userCollapsed === true};
    } catch {
      return base;
    }
  }

  const SessionPaneStateApi = {
    SIDEBAR_WIDTH,
    SIDEBAR_COLLAPSE_WIDTH,
    PANE_OVERLAY_WIDTH,
    COLUMN_BUDGET_PX,
    MAX_COLUMNS,
    COLUMN_MIN_FRACTION,
    COLUMN_MAX_FRACTION,
    DEFAULT_SPLIT,
    COLUMN_MIN_PX,
    isPaneMode,
    maxColumnsFor,
    clampColumnFraction,
    clampRowSplit,
    columnWidthPx,
    createPaneGridState,
    setMaxColumns,
    createAgentSidebarState,
    sidebarViewportIsNarrow,
    setSidebarViewportNarrow,
    setComputerUseDocked,
    sidebarIsExpandedForSession,
    toggleSidebarForSession,
    toggleSidebarPerSession,
    seedSidebarCollapsedForSession,
    serializeAgentSidebarState,
    restoreAgentSidebarState,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SessionPaneStateApi;
  }
  if (typeof globalThis !== 'undefined') {
    (
      globalThis as typeof globalThis & {
        SessionPaneState?: typeof SessionPaneStateApi;
      }
    ).SessionPaneState = SessionPaneStateApi;
  }
})();
