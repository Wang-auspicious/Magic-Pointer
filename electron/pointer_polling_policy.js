'use strict';

const POINTER_VOICE_STRATEGIES = new Set(['push_to_talk', 'hover']);
const WIGGLE_WAKE_MODES = new Set(['wiggle', 'wiggle_hotkey']);

function pointerPollingPolicy({
  wakeMode = 'wiggle_hotkey',
  wiggleEnabled = true,
  mouseShakeOverride = '',
  voicePointerConfigured = false,
  voiceStartStrategy = 'auto',
  episodeActive = false,
  mouseSideButton = 'none',
  onboardingRequired = false,
  inputPaused = false,
} = {}) {
  if (onboardingRequired === true || inputPaused === true) {
    return disabledPolicy();
  }

  const normalizedWakeMode = String(wakeMode || '').trim().toLowerCase();
  const normalizedOverride = String(mouseShakeOverride || '').trim();
  const configuredWiggle = WIGGLE_WAKE_MODES.has(normalizedWakeMode)
    && wiggleEnabled !== false;
  const detectWiggle = normalizedOverride === '1'
    ? true
    : normalizedOverride === '0'
      ? false
      : configuredWiggle;
  const normalizedSideButton = String(mouseSideButton || '').trim().toLowerCase();
  const episodeContinuation = episodeActive === true
    && ['xbutton1', 'xbutton2', 'middle_hold'].includes(normalizedSideButton);
  const detectMouseButton = normalizedWakeMode === 'mouse_button' || episodeContinuation;
  const stageVoicePointer = voicePointerConfigured === true
    && POINTER_VOICE_STRATEGIES.has(String(voiceStartStrategy || '').trim().toLowerCase());

  return {
    shouldPoll: detectWiggle || detectMouseButton || stageVoicePointer,
    detectWiggle,
    detectMouseButton,
  };
}

function disabledPolicy() {
  return {
    shouldPoll: false,
    detectWiggle: false,
    detectMouseButton: false,
  };
}

module.exports = { pointerPollingPolicy };
