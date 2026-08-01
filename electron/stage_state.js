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
    // Real UIA draft-write progress ({ step, totalSteps, label }) or null.
    // Only ever set from genuine DELIVERY_PROGRESS events — never synthesized.
    deliveryProgress: null,
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

// Delivery progress must describe a real, bounded write ({ step, totalSteps }).
// Malformed payloads are rejected so the UI can never render invented progress.
function normalizeDeliveryProgress(value) {
  if (!value || typeof value !== 'object') return null;
  const step = Number(value.step);
  const totalSteps = Number(value.totalSteps);
  if (!Number.isFinite(step) || !Number.isFinite(totalSteps) || totalSteps <= 0) return null;
  return {
    step: Math.min(Math.max(0, step), totalSteps),
    totalSteps,
    label: value.label == null ? '' : String(value.label),
  };
}

function toDismissing(state) {
  return { ...state, name: 'dismissing' };
}

function toResult(state, event) {
  return { ...state, name: 'result', result: event.result == null ? null : event.result };
}

function toError(state, event) {
  return { ...state, name: 'error', error: event.error == null ? { message: 'unknown error' } : event.error };
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
      // Direct results (runtime-issue capture) and early errors (ineligible
      // selection) may land before the capsule ever opens.
      if (type === 'RESULT') return toResult(state, event);
      if (type === 'ERROR') return toError(state, event);
      if (type === 'DISMISS') return toDismissing(state);
      return state;

    case 'frozen':
      if (type === 'OPEN_CAPSULE') {
        const mode = event.mode === 'text' ? 'text' : 'voice';
        return { ...state, name: `capsule-${mode}`, inputMode: mode, transcript: '' };
      }
      if (type === 'RESULT') return toResult(state, event);
      if (type === 'ERROR') return toError(state, event);
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
      // Dictation failures surface immediately from the capsule.
      if (type === 'RESULT') return toResult(state, event);
      if (type === 'ERROR') return toError(state, event);
      if (type === 'DISMISS') return toDismissing(state);
      return state;
    }

    case 'processing':
      if (type === 'COMPLETE') return toDismissing(state);
      if (type === 'RESULT') return toResult(state, event);
      if (type === 'ERROR') return toError(state, event);
      if (type === 'DELIVERY_PROGRESS') {
        const progress = normalizeDeliveryProgress(event.progress);
        if (!progress) return state;
        return { ...state, deliveryProgress: progress };
      }
      if (type === 'DISMISS') return toDismissing(state);
      return state;

    case 'result':
    case 'error':
      if (type === 'DISMISS') return toDismissing(state);
      if (state.name === 'result' && type === 'ACTION_START') {
        return {
          ...state,
          name: 'processing',
          command: String(event.command || ''),
          result: null,
          error: null,
          deliveryProgress: null,
        };
      }
      if (state.name === 'result' && type === 'DELIVERY_PROGRESS') {
        const progress = normalizeDeliveryProgress(event.progress);
        if (!progress) return state;
        return { ...state, deliveryProgress: progress };
      }
      return state;

    case 'dismissing':
      if (type === 'HIDDEN') return initialState(state.config);
      return state;

    default:
      return state;
  }
}

// --- Word-level diff (pure helper for the text-draft result card) ------------
// Lives in this module (not stage.js) so plain `node tests/...` can require it;
// stage.js is a DOM-bound IIFE. Tokens: each CJK char individually, whitespace
// runs, and runs of everything else — so Chinese and space-delimited text both
// diff at natural word granularity.

function tokenizeWords(text) {
  if (text == null) return [];
  return String(text).match(/[㐀-鿿]|\s+|[^\s㐀-鿿]+/g) || [];
}

// Classic LCS diff. Returns merged segments:
// [{ type: 'equal' | 'ins' | 'del', text }].
function wordDiff(oldText, newText) {
  const a = tokenizeWords(oldText);
  const b = tokenizeWords(newText);
  const n = a.length;
  const m = b.length;
  const table = [];
  for (let i = 0; i <= n; i += 1) table.push(new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const segments = [];
  const push = (type, text) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last && last.type === type) last.text += text;
    else segments.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('equal', a[i]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push('del', a[i]);
      i += 1;
    } else {
      push('ins', b[j]);
      j += 1;
    }
  }
  while (i < n) {
    push('del', a[i]);
    i += 1;
  }
  while (j < m) {
    push('ins', b[j]);
    j += 1;
  }
  return segments;
}

const StageState = { STATES, initialState, transition, wordDiff };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = StageState;
}
if (typeof globalThis !== 'undefined') {
  globalThis.StageState = StageState;
}
