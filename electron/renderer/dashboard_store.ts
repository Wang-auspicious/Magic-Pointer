'use strict';

interface DashboardStoreFilter {
  field: string;
  op: 'eq' | 'in' | 'gte' | 'lte';
  values: Array<string | number>;
  sourceId?: string;
}

interface DashboardStoreHistoryStats {
  personEdits: number;
  agentEdits: number;
  personUndidAgent: number;
  personRedidAgent: number;
}

interface DashboardStoreSnapshot {
  generatedAt: string;
  trustBadge?: string;
  charts: Array<{
    chartId: string;
    queryText: string;
    error?: string;
    errorCode?: string;
    warnings?: string[];
    diagnostics?: Array<{
      code: string;
      message: string;
      severity: 'warning' | 'error';
    }>;
    trustBadge?: string;
    groups: Array<{
      key: string;
      dimensions: string[];
      total: {value: number | null; trace: {traceId?: string; excludedCount?: number}};
    }>;
    current?: {value: number | null; trace: {traceId?: string; excludedCount?: number}};
    prior?: {value: number | null; trace: {traceId?: string; excludedCount?: number}};
    table?: {
      columns: string[];
      rows: Array<{
        key: string;
        cells: Array<{
          value: number | null;
          trace: {traceId?: string; excludedCount?: number};
        } | null>;
      }>;
    };
  }>;
}

interface DashboardStoreChartMeta {
  chartId: string;
  title: string;
  type: string;
  format?: 'money' | 'number' | 'percent';
  currency?: string;
  xField?: string;
  yField?: string;
  seriesField?: string;
  ghostSeries?: string;
  orientation?: 'vertical' | 'horizontal';
  watch?: {target?: number; min?: number; max?: number; label?: string};
  columns?: Array<{format?: 'money' | 'number' | 'percent'; currency?: string}>;
}

interface DashboardStoreState {
  snapshot: DashboardStoreSnapshot;
  metas: DashboardStoreChartMeta[];
  activeFilters: DashboardStoreFilter[];
  hoveredX: string | null;
  hiddenSeries: Map<string, Set<string>>;
  canUndo: boolean;
  canRedo: boolean;
  historyStats: DashboardStoreHistoryStats;
}

interface DashboardStoreInstance {
  getState(): DashboardStoreState;
  subscribe(listener: (state: DashboardStoreState) => void): () => void;
  setSnapshot(snapshot: DashboardStoreSnapshot, metas?: DashboardStoreChartMeta[]): void;
  toggleFilter(filter: DashboardStoreFilter): void;
  removeFilter(index: number): void;
  clearFilters(): void;
  setHoveredX(x: string | null): void;
  toggleSeries(chartId: string, seriesLabel: string): void;
  applyEdit(
    label: string,
    actor: 'person' | 'agent',
    nextSnapshot: DashboardStoreSnapshot,
    nextMetas?: DashboardStoreChartMeta[],
  ): void;
  undo(): boolean;
  redo(): boolean;
}

declare global {
  var DashboardStore: {
    createDashboardStore(
      initialSnapshot: DashboardStoreSnapshot,
      metas: DashboardStoreChartMeta[],
    ): DashboardStoreInstance;
    filterSnapshot(
      snapshot: DashboardStoreSnapshot,
      activeFilters: DashboardStoreFilter[],
    ): DashboardStoreSnapshot;
  };
}

(() => {
  interface HistoryEntry {
    label: string;
    actor: 'person' | 'agent';
    snapshot: DashboardStoreSnapshot;
    metas: DashboardStoreChartMeta[];
  }

  function cloneSnapshot(s: DashboardStoreSnapshot): DashboardStoreSnapshot {
    return JSON.parse(JSON.stringify(s)) as DashboardStoreSnapshot;
  }

  function filterSnapshot(
    snapshot: DashboardStoreSnapshot,
    activeFilters: DashboardStoreFilter[],
  ): DashboardStoreSnapshot {
    if (!activeFilters.length) {
      return snapshot;
    }
    const next = cloneSnapshot(snapshot);
    for (const chart of next.charts) {
      if (chart.groups.length) {
        chart.groups = chart.groups.filter(g =>
          activeFilters.every(f => {
            if (!f.values.length) {
              return true;
            }
            const targets = f.values.map(v => String(v));
            return g.dimensions.some(d => targets.includes(d));
          }),
        );
      }
      if (chart.table) {
        chart.table.rows = chart.table.rows.filter(r =>
          activeFilters.every(f => {
            if (!f.values.length) {
              return true;
            }
            return f.values.some(v => String(v) === r.key);
          }),
        );
      }
    }
    return next;
  }

  function createDashboardStore(
    initialSnapshot: DashboardStoreSnapshot,
    initialMetas: DashboardStoreChartMeta[],
  ): DashboardStoreInstance {
    let snapshot = cloneSnapshot(initialSnapshot);
    let metas = [...initialMetas];
    let activeFilters: DashboardStoreFilter[] = [];
    let hoveredX: string | null = null;
    const hiddenSeries = new Map<string, Set<string>>();
    const undoStack: HistoryEntry[] = [];
    const redoStack: HistoryEntry[] = [];
    const historyStats: DashboardStoreHistoryStats = {
      personEdits: 0,
      agentEdits: 0,
      personUndidAgent: 0,
      personRedidAgent: 0,
    };
    const listeners = new Set<(state: DashboardStoreState) => void>();

    const getState = (): DashboardStoreState => ({
      snapshot,
      metas,
      activeFilters: [...activeFilters],
      hoveredX,
      hiddenSeries,
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      historyStats: {...historyStats},
    });

    const emit = () => {
      const state = getState();
      for (const listener of listeners) {
        listener(state);
      }
    };

    return {
      getState,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      setSnapshot(nextSnapshot, nextMetas) {
        snapshot = cloneSnapshot(nextSnapshot);
        if (nextMetas) {
          metas = [...nextMetas];
        }
        emit();
      },
      toggleFilter(filter) {
        const key = `${filter.field}:${filter.op}:${filter.values.join(',')}`;
        const idx = activeFilters.findIndex(
          f => `${f.field}:${f.op}:${f.values.join(',')}` === key,
        );
        if (idx >= 0) {
          activeFilters.splice(idx, 1);
        } else {
          activeFilters.push(filter);
        }
        emit();
      },
      removeFilter(index) {
        if (index >= 0 && index < activeFilters.length) {
          activeFilters.splice(index, 1);
          emit();
        }
      },
      clearFilters() {
        if (activeFilters.length) {
          activeFilters = [];
          emit();
        }
      },
      setHoveredX(x) {
        if (hoveredX !== x) {
          hoveredX = x;
          emit();
        }
      },
      toggleSeries(chartId, seriesLabel) {
        const set = hiddenSeries.get(chartId) ?? new Set<string>();
        if (set.has(seriesLabel)) {
          set.delete(seriesLabel);
        } else {
          set.add(seriesLabel);
        }
        hiddenSeries.set(chartId, set);
        emit();
      },
      applyEdit(label, actor, nextSnapshot, nextMetas) {
        undoStack.push({
          label,
          actor,
          snapshot: cloneSnapshot(snapshot),
          metas: [...metas],
        });
        redoStack.length = 0;
        if (actor === 'agent') {
          historyStats.agentEdits += 1;
        } else {
          historyStats.personEdits += 1;
        }
        snapshot = cloneSnapshot(nextSnapshot);
        if (nextMetas) {
          metas = [...nextMetas];
        }
        emit();
      },
      undo() {
        const prev = undoStack.pop();
        if (!prev) {
          return false;
        }
        redoStack.push({
          label: prev.label,
          actor: prev.actor,
          snapshot: cloneSnapshot(snapshot),
          metas: [...metas],
        });
        if (prev.actor === 'agent') {
          historyStats.personUndidAgent += 1;
        }
        snapshot = prev.snapshot;
        metas = prev.metas;
        emit();
        return true;
      },
      redo() {
        const next = redoStack.pop();
        if (!next) {
          return false;
        }
        undoStack.push({
          label: next.label,
          actor: next.actor,
          snapshot: cloneSnapshot(snapshot),
          metas: [...metas],
        });
        if (next.actor === 'agent') {
          historyStats.personRedidAgent += 1;
        }
        snapshot = next.snapshot;
        metas = next.metas;
        emit();
        return true;
      },
    };
  }

  globalThis.DashboardStore = {createDashboardStore, filterSnapshot};
})();
