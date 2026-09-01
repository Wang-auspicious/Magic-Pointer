export interface StudioInspectorState {
  open: boolean;
  maximized: boolean;
  width: number;
  previousWidth: number;
  tab: string;
}

export type StudioInspectorAction =
  | { type: 'open'; tab?: string }
  | { type: 'close' }
  | { type: 'select-tab'; tab: string }
  | { type: 'resize'; width: number; availableWidth?: number }
  | { type: 'maximize' }
  | { type: 'restore' };

const MIN_WIDTH = 420;
const MAX_WIDTH = 760;
const MIN_PRIMARY = 420;
const GAP = 8;

export function clampInspectorWidth(desired: unknown, availableWidth: unknown): number {
  const requested = Number(desired);
  const available = Number(availableWidth);
  const safeRequested = Number.isFinite(requested) ? requested : 560;
  const safeAvailable = Number.isFinite(available) ? available : 1320;
  const maximum = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, safeAvailable - MIN_PRIMARY - GAP));
  return Math.round(Math.min(maximum, Math.max(MIN_WIDTH, safeRequested)));
}

export function reduceInspectorState(
  state: StudioInspectorState,
  action: StudioInspectorAction,
): StudioInspectorState {
  switch (action.type) {
    case 'open':
      return {
        ...state,
        open: true,
        tab: action.tab || state.tab,
      };
    case 'close':
      return { ...state, open: false, maximized: false };
    case 'select-tab':
      return { ...state, open: true, tab: action.tab };
    case 'resize': {
      if (state.maximized) return state;
      const width = clampInspectorWidth(action.width, action.availableWidth);
      return { ...state, open: true, width, previousWidth: width };
    }
    case 'maximize':
      if (state.maximized) return state;
      return {
        ...state,
        open: true,
        maximized: true,
        previousWidth: state.width,
      };
    case 'restore':
      return {
        ...state,
        open: true,
        maximized: false,
        width: state.previousWidth,
      };
  }
}

const StudioInspectorStateApi = {
  clampInspectorWidth,
  reduceInspectorState,
};

if (typeof module !== 'undefined' && module.exports) module.exports = StudioInspectorStateApi;
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { StudioInspectorState?: typeof StudioInspectorStateApi })
    .StudioInspectorState = StudioInspectorStateApi;
}
