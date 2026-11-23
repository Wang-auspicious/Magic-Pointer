'use strict';

(() => {
  interface StudioInspectorState {
    open: boolean;
    maximized: boolean;
    width: number;
    previousWidth: number;
    tab: string;
    contentSelection?: {kind: 'material' | 'artifact'; id: string} | null;
  }

  type StudioInspectorAction =
    | {type: 'open'; tab?: string; availableWidth?: number}
    | {type: 'close'}
    | {type: 'select-tab'; tab: string}
    | {type: 'resize'; width: number; availableWidth?: number}
    | {type: 'viewport'; availableWidth?: number}
    | {type: 'maximize'}
    | {type: 'restore'; availableWidth?: number}
    | {
        type: 'select-content';
        contentKind: 'material' | 'artifact';
        contentId: string;
      }
    | {type: 'clear-content'};

  const MIN_WIDTH = 300;
  const MAX_RATIO = 0.72;
  const MIN_PRIMARY = 320;
  const GAP = 8;

  function sessionRailGeometry(availableWidth: number): {
    width: number;
    overlay: boolean;
  } {
    return {
      width: Math.min(320, Math.max(240, availableWidth - 768 - 3 * 24)),
      overlay: availableWidth < 592,
    };
  }

  function clampInspectorWidth(
    desired: unknown,
    availableWidth: unknown,
  ): number {
    const requested = Number(desired);
    const available = Number(availableWidth);
    const safeAvailable = Number.isFinite(available) && available > 0 ? available : 1320;
    const defaultWidth = Math.round(safeAvailable * 0.5);
    const safeRequested =
      desired !== undefined &&
      desired !== null &&
      desired !== '' &&
      Number.isFinite(requested)
        ? requested
        : defaultWidth;
    const ratioMax = Math.floor(safeAvailable * MAX_RATIO);
    const spaceMax = safeAvailable - MIN_PRIMARY - GAP;
    const maximum = Math.max(MIN_WIDTH, Math.min(Math.max(760, ratioMax), spaceMax));
    return Math.round(Math.min(maximum, Math.max(MIN_WIDTH, safeRequested)));
  }

  function reduceInspectorState(
    state: StudioInspectorState,
    action: StudioInspectorAction,
  ): StudioInspectorState {
    switch (action.type) {
      case 'open': {
        const width =
          action.availableWidth === undefined
            ? state.width
            : clampInspectorWidth(
                state.previousWidth || state.width,
                action.availableWidth,
              );
        return {
          ...state,
          open: true,
          width,
          tab: action.tab || state.tab,
        };
      }
      case 'close':
        return {...state, open: false, maximized: false};
      case 'select-tab':
        return {...state, open: true, tab: action.tab};
      case 'resize': {
        const width = clampInspectorWidth(action.width, action.availableWidth);
        return {
          ...state,
          open: true,
          maximized: false,
          width,
          previousWidth: width,
        };
      }
      case 'viewport': {
        if (state.maximized) {
          return state;
        }
        const width = clampInspectorWidth(
          state.previousWidth || state.width,
          action.availableWidth,
        );
        return {...state, width};
      }
      case 'maximize':
        if (state.maximized) {
          return state;
        }
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
          width:
            action.availableWidth === undefined
              ? state.previousWidth
              : clampInspectorWidth(state.previousWidth, action.availableWidth),
        };
      case 'select-content':
        return {
          ...state,
          contentSelection: {
            kind: action.contentKind,
            id: action.contentId,
          },
        };
      case 'clear-content':
        return {...state, contentSelection: null};
      default:
        return state;
    }
  }

  const StudioInspectorStateApi = {
    sessionRailGeometry,
    clampInspectorWidth,
    reduceInspectorState,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = StudioInspectorStateApi;
  }
  if (typeof globalThis !== 'undefined') {
    (
      globalThis as typeof globalThis & {
        StudioInspectorState?: typeof StudioInspectorStateApi;
      }
    ).StudioInspectorState = StudioInspectorStateApi;
  }
})();
