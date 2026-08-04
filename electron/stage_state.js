// PointerStage state machine (pure, no Electron imports).
//
// Lifecycle: hidden -> targeting -> frozen -> capsule-voice | capsule-text
//            -> processing -> result | error -> dismissing -> hidden
//
// A session accumulates `turns`: one entry per thing the user asked for, in
// order, each carrying the ask and its outcome. The capsule is a composer that
// stays put; a result never replaces the question that produced it, and a
// follow-up appends instead of wiping the thread.
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
    // The conversation so far, oldest first. Each turn is
    // { id, ask, status: 'pending' | 'done' | 'failed', result, error }.
    // Kept for the whole session: a follow-up appends a turn rather than
    // discarding the one before it, so the user can still read what they asked.
    turns: [],
    nextTurnId: 1,
    // Real UIA draft-write progress ({ step, totalSteps, label }) or null.
    // Only ever set from genuine DELIVERY_PROGRESS events — never synthesized.
    deliveryProgress: null,
    // A transient status line ({ message }) or null. Cleared the moment a real
    // outcome arrives, so "正在读取…" can never sit under a finished answer.
    notice: null,
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

// Open a turn for something the user just asked for. The ask is recorded up
// front so the question is on screen while the answer is still being produced.
function openTurn(state, ask) {
  const turn = {
    id: state.nextTurnId,
    ask: ask == null ? '' : String(ask),
    status: 'pending',
    result: null,
    error: null,
  };
  return { turns: [...state.turns, turn], nextTurnId: state.nextTurnId + 1 };
}

// Settle the newest pending turn. Results can also arrive without a preceding
// ask (a runtime-issue capture, an ineligible selection), in which case the
// outcome opens and closes a turn of its own so the thread stays complete.
function closeTurn(state, { result = null, error = null }) {
  const status = error == null ? 'done' : 'failed';
  const turns = state.turns.slice();
  let index = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].status === 'pending') { index = i; break; }
  }
  if (index === -1) {
    return {
      turns: [...turns, { id: state.nextTurnId, ask: '', status, result, error }],
      nextTurnId: state.nextTurnId + 1,
    };
  }
  turns[index] = { ...turns[index], status, result, error };
  return { turns, nextTurnId: state.nextTurnId };
}

function toResult(state, event) {
  const result = event.result == null ? null : event.result;
  return { ...state, name: 'result', result, error: null, notice: null, ...closeTurn(state, { result }) };
}

function toError(state, event) {
  const error = event.error == null ? { message: 'unknown error' } : event.error;
  return { ...state, name: 'error', error, notice: null, ...closeTurn(state, { error }) };
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

  // A transient line of status ("正在读取选中的内容…"), shown while something
  // slow is genuinely still running. It is not an interaction state: a waiting
  // read must not move the machine, or a slow first-run read would look like a
  // different phase than a fast one.
  if (type === 'NOTICE') {
    const message = String(event.notice?.message || '');
    return { ...state, notice: message ? { message } : null };
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
        return { ...state, name: 'processing', command, ...openTurn(state, command) };
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
      // A follow-up reopens the composer over the same thread. `turns` is
      // deliberately preserved: the earlier question and its answer stay on
      // screen instead of being replaced by whatever comes next.
      if (type === 'OPEN_CAPSULE') {
        const mode = event.mode === 'text' ? 'text' : 'voice';
        return {
          ...state,
          name: `capsule-${mode}`,
          inputMode: mode,
          transcript: '',
          result: null,
          error: null,
          deliveryProgress: null,
        };
      }
      // The composer stays live under a finished thread, so a follow-up can be
      // typed and sent without first reopening the capsule.
      if (type === 'SUBMIT') {
        const command = event.command == null ? state.transcript : String(event.command);
        return {
          ...state,
          name: 'processing',
          command,
          result: null,
          error: null,
          deliveryProgress: null,
          ...openTurn(state, command),
        };
      }
      if (state.name === 'result' && type === 'ACTION_START') {        const command = String(event.command || '');
        return {
          ...state,
          name: 'processing',
          command,
          result: null,
          error: null,
          deliveryProgress: null,
          ...openTurn(state, command),
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
