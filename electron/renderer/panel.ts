const api = window.magicPointerPanel;
const commandInput = document.getElementById('command') as HTMLInputElement;
const statusNode = document.getElementById('result')!;
const capsule = document.getElementById('inline-action-rail')!;

let currentSelectionSessionToken: string | null = null;
let currentPanelLayoutNonce: string | null = null;
let currentCaptureSummary: MagicPointerCaptureSummary | null = null;
let submitting = false;
let autoDismissTimer: number | null = null;
let composing = false;

const measureCanvas = document.createElement('canvas');
const measureContext = measureCanvas.getContext('2d')!;

function clearTimers() {
  if (autoDismissTimer) window.clearTimeout(autoDismissTimer);
  autoDismissTimer = null;
}

function measuredWidth(text = '', state = capsule.dataset.state) {
  if (state === 'running') return 210;
  if (state === 'error') return 320;
  const value = String(text || '').trim();
  if (!value) return 176;
  measureContext.font = '750 18px "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
  const glyphWidth = 44;
  return Math.max(118, Math.min(560, Math.ceil(measureContext.measureText(value).width + glyphWidth + 42)));
}

function syncCapsuleSize(text = commandInput.value, state = capsule.dataset.state) {
  if (!currentSelectionSessionToken || !currentPanelLayoutNonce) return;
  api.resize({
    width: measuredWidth(text, state),
    height: 72,
    selectionSessionToken: currentSelectionSessionToken,
    layoutNonce: currentPanelLayoutNonce,
  });
}

function setCapsuleState(state: string, message = '') {
  capsule.dataset.state = state;
  statusNode.replaceChildren(document.createTextNode(message));
  statusNode.hidden = !message;
  commandInput.hidden = Boolean(message);
  syncCapsuleSize(message || commandInput.value, state);
}

function submitCommand(commandOverride = '') {
  if (submitting || !currentSelectionSessionToken) return;
  const command = String(commandOverride || commandInput.value).trim();
  if (!command) {
    commandInput.focus();
    return;
  }
  submitting = true;
  setCapsuleState('running', 'Processing…');
  api.submitSelectionCommand({
    command,
    selectionSessionToken: currentSelectionSessionToken,
  });
}


function renderCaptureEligibility(captureEligibility: MagicPointerCaptureEligibility | undefined) {
  if (!captureEligibility || captureEligibility.commandReady !== false) return true;
  setCapsuleState('error', captureEligibility.message || '当前对象不可用');
  commandInput.disabled = true;
  const delay = Number(captureEligibility.autoDismissMs);
  if (Number.isFinite(delay) && delay > 0) {
    autoDismissTimer = window.setTimeout(() => api.hide(), delay);
  }
  return false;
}

function showResult(payload: MagicPointerPanelResultPayload = {}) {
  submitting = false;
  if (
    payload.selectionSessionToken
    && currentSelectionSessionToken
    && payload.selectionSessionToken !== currentSelectionSessionToken
  ) return;
  if (payload.ok === null) {
    setCapsuleState('running', payload.status || 'Processing…');
    return;
  }
  if (payload.ok === false) {
    setCapsuleState('error', payload.error || '执行失败');
    return;
  }
  setCapsuleState('running', 'Done');
  api.showContextualResult({
    ...payload,
    sourceLabel: currentCaptureSummary?.label || '',
    selectionSessionToken: currentSelectionSessionToken,
  });
}

commandInput.addEventListener('input', () => {
  setCapsuleState(commandInput.value ? 'input' : 'ready');
});
commandInput.addEventListener('compositionstart', () => {
  composing = true;
});
commandInput.addEventListener('compositionend', () => {
  composing = false;
  syncCapsuleSize();
});
commandInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !composing) {
    event.preventDefault();
    submitCommand();
  } else if (event.key === 'Escape') {
    api.hide();
  }
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.hide();
});

api.onShow((payload: MagicPointerPanelShowPayload = {}) => {
  clearTimers();
  submitting = false;
  composing = false;
  currentSelectionSessionToken = payload.selectionSessionToken || null;
  currentPanelLayoutNonce = payload.panelLayoutNonce || null;
  currentCaptureSummary = payload.captureSummary || null;
  capsule.dataset.inputMode = 'text';
  commandInput.value = '';
  commandInput.disabled = false;
  commandInput.placeholder = '输入命令…';
  setCapsuleState('ready');
  if (!renderCaptureEligibility(payload.captureEligibility)) return;
  window.setTimeout(() => {
    commandInput.focus();
  }, 0);
});

api.onHide(() => {
  clearTimers();
  currentSelectionSessionToken = null;
  currentPanelLayoutNonce = null;
  currentCaptureSummary = null;
  submitting = false;
});

api.onResult(showResult);
