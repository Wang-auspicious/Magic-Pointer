// PointerStage state machine (pure, no Electron imports).
//
// Lifecycle: hidden -> targeting -> frozen -> capsule-voice | capsule-text
//            -> processing -> result | error -> dismissing -> hidden
//
// `transition(state, event)` is a pure function: illegal transitions return the
// incoming state object unchanged (same reference), so callers can cheaply
// detect no-ops. Loaded both from node tests (CommonJS) and from the stage
// renderer via a plain <script> tag (globalThis.StageState).

const STATES = Object.freeze([
  'hidden',
  'targeting',
  'frozen',
  'capsule-voice',
  'capsule-text',
  'processing',
  'result',
  'error',
  'dismissing',
]);

function initialState(config = {}) {
  return {
    name: 'hidden',
    target: null,
    inputMode: null,
    transcript: '',
    command: '',
    result: null,
    error: null,
    config: { reducedMotion: Boolean(config && config.reducedMotion) },
  };
}

function normalizeRect(value) {
  if (!value || typeof value !== 'object') return null;
  const rect = {
    x: Number(value.x),
    y: Number(value.y),
    width: Number(value.width),
    height: Number(value.height),
  };
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return null;
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
  return rect;
}

function toDismissing(state) {
  return { ...state, name: 'dismissing' };
}

function transition(state, event) {
  if (!state || typeof state !== 'object') return state;
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return state;
  const type = event.type;

  // Reduced motion may change at any time (OS setting toggle) without
  // disturbing the interaction state.
  if (type === 'SET_REDUCED_MOTION') {
    return { ...state, config: { ...state.config, reducedMotion: Boolean(event.value) } };
  }

  switch (state.name) {
    case 'hidden':
      if (type === 'WAKE') {
        return { ...initialState(state.config), name: 'targeting', target: normalizeRect(event.target) };
      }
      return state;

    case 'targeting':
      if (type === 'TARGET_MOVE') return { ...state, target: normalizeRect(event.target) };
      if (type === 'FREEZE') return { ...state, name: 'frozen', target: normalizeRect(event.target) || state.target };
      if (type === 'DISMISS') return toDismissing(state);
      return state;

    case 'frozen':
      if (type === 'OPEN_CAPSULE') {
        const mode = event.mode === 'text' ? 'text' : 'voice';
        return { ...state, name: `capsule-${mode}`, inputMode: mode, transcript: '' };
      }
      if (type === 'DISMISS') return toDismissing(state);
      return state;

    case 'capsule-voice':
    case 'capsule-text': {
      if (type === 'TRANSCRIPT') {
        return { ...state, transcript: String(event.transcript == null ? '' : event.transcript) };
      }
      if (type === 'OPEN_CAPSULE') {
        const mode = event.mode === 'text' ? 'text' : 'voice';
        if (`capsule-${mode}` === state.name) return state;
        return { ...state, name: `capsule-${mode}`, inputMode: mode };
      }
      if (type === 'SUBMIT') {
        const command = event.command == null ? state.transcript : String(event.command);
        return { ...state, name: 'processing', command };
      }
      if (type === 'DISMISS') return toDismissing(state);
      return state;
    }

    case 'processing':
      if (type === 'RESULT') return { ...state, name: 'result', result: event.result == null ? null : event.result };
      if (type === 'ERROR') return { ...state, name: 'error', error: event.error == null ? { message: 'unknown error' } : event.error };
      if (type === 'DISMISS') return toDismissing(state);
      return state;

    case 'result':
    case 'error':
      if (type === 'DISMISS') return toDismissing(state);
      return state;

    case 'dismissing':
      if (type === 'HIDDEN') return initialState(state.config);
      return state;

    default:
      return state;
  }
}

const StageState = { STATES, initialState, transition };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = StageState;
}
if (typeof globalThis !== 'undefined') {
  globalThis.StageState = StageState;
}
