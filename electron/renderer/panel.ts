// @ts-nocheck -- legacy classic-script globals are preserved during the extension migration.
const api = window.magicPointerPanel;
const commandInput = document.getElementById('command');
const statusNode = document.getElementById('result');
const capsule = document.getElementById('inline-action-rail');

let currentSelectionSessionToken = null;
let currentPanelLayoutNonce = null;
let currentCaptureSummary = null;
let defaultInputMode = 'voice';
let voiceAutoSubmit = true;
let voiceSilenceMs = 1600;
let submitting = false;
let autoDismissTimer = null;
let voiceSubmitTimer = null;
let composing = false;

const measureCanvas = document.createElement('canvas');
const measureContext = measureCanvas.getContext('2d');

function clearTimers() {
  if (autoDismissTimer) window.clearTimeout(autoDismissTimer);
  if (voiceSubmitTimer) window.clearTimeout(voiceSubmitTimer);
  autoDismissTimer = null;
  voiceSubmitTimer = null;
}

function measuredWidth(text = '', state = capsule.dataset.state) {
  if (state === 'running') return 210;
  if (state === 'error') return 320;
  const value = String(text || '').trim();
  if (!value) return defaultInputMode === 'voice' ? 72 : 176;
  measureContext.font = '750 18px "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
  const glyphWidth = defaultInputMode === 'voice' ? 58 : 44;
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

function setCapsuleState(state, message = '') {
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
  if (voiceSubmitTimer) window.clearTimeout(voiceSubmitTimer);
  voiceSubmitTimer = null;
  submitting = true;
  setCapsuleState('running', 'Processing…');
  api.submitSelectionCommand({
    command,
    selectionSessionToken: currentSelectionSessionToken,
  });
}

function scheduleVoiceAutoSubmit() {
  if (voiceSubmitTimer) window.clearTimeout(voiceSubmitTimer);
  voiceSubmitTimer = null;
  if (
    defaultInputMode !== 'voice'
    || voiceAutoSubmit !== true
    || composing
    || !commandInput.value.trim()
  ) return;
  voiceSubmitTimer = window.setTimeout(() => submitCommand(), voiceSilenceMs);
}

function renderCaptureEligibility(captureEligibility) {
  if (!captureEligibility || captureEligibility.commandReady !== false) return true;
  setCapsuleState('error', captureEligibility.message || '当前对象不可用');
  commandInput.disabled = true;
  const delay = Number(captureEligibility.autoDismissMs);
  if (Number.isFinite(delay) && delay > 0) {
    autoDismissTimer = window.setTimeout(() => api.hide(), delay);
  }
  return false;
}

function showResult(payload = {}) {
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
  setCapsuleState(commandInput.value ? 'input' : (defaultInputMode === 'voice' ? 'listening' : 'ready'));
  scheduleVoiceAutoSubmit();
});
commandInput.addEventListener('compositionstart', () => {
  composing = true;
  if (voiceSubmitTimer) window.clearTimeout(voiceSubmitTimer);
});
commandInput.addEventListener('compositionend', () => {
  composing = false;
  syncCapsuleSize();
  scheduleVoiceAutoSubmit();
});
commandInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitCommand();
  } else if (event.key === 'Escape') {
    api.hide();
  }
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.hide();
});

api.onShow((payload = {}) => {
  clearTimers();
  submitting = false;
  composing = false;
  currentSelectionSessionToken = payload.selectionSessionToken || null;
  currentPanelLayoutNonce = payload.panelLayoutNonce || null;
  currentCaptureSummary = payload.captureSummary || null;
  defaultInputMode = payload.defaultInputMode === 'text' ? 'text' : 'voice';
  voiceAutoSubmit = payload.voiceAutoSubmit !== false;
  voiceSilenceMs = Math.max(600, Math.min(5000, Number(payload.voiceSilenceMs) || 1600));
  capsule.dataset.inputMode = defaultInputMode;
  commandInput.value = '';
  commandInput.disabled = false;
  commandInput.placeholder = defaultInputMode === 'text' ? '输入命令…' : '';
  setCapsuleState(defaultInputMode === 'voice' ? 'listening' : 'ready');
  if (!renderCaptureEligibility(payload.captureEligibility)) return;
  const sessionRemainingMs = Number(payload.sessionExpiresAt) - Date.now();
  if (Number.isFinite(sessionRemainingMs) && sessionRemainingMs > 0) {
    autoDismissTimer = window.setTimeout(() => api.hide(), sessionRemainingMs);
  }
  window.setTimeout(() => {
    commandInput.focus();
    if (defaultInputMode === 'voice') api.startDictation();
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
api.onDictationResult((payload = {}) => {
  if (payload.surface !== 'panel') return;
  if (payload.ok === false) {
    setCapsuleState('error', payload.error || '本地语音输入不可用');
    return;
  }
  if (typeof payload.transcript === 'string' && payload.transcript.trim()) {
    commandInput.value = payload.transcript.trim();
    setCapsuleState('input');
    if (payload.final === true && voiceAutoSubmit === true) {
      window.setTimeout(() => submitCommand(), 80);
    }
    return;
  }
  if (!commandInput.value) setCapsuleState('listening');
});
