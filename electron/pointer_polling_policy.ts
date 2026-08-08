'use strict';

const POINTER_VOICE_STRATEGIES = new Set(['push_to_talk', 'hover']);
const WIGGLE_WAKE_MODES = new Set(['wiggle', 'wiggle_hotkey']);

type PointerPollingInput = {
  wakeMode?: unknown;
  wiggleEnabled?: boolean;
  mouseShakeOverride?: unknown;
  voicePointerConfigured?: boolean;
  voiceStartStrategy?: unknown;
  episodeActive?: boolean;
  mouseSideButton?: unknown;
  onboardingRequired?: boolean;
  inputPaused?: boolean;
};

type PointerPollingPolicy = {
  shouldPoll: boolean;
  detectWiggle: boolean;
  detectMouseButton: boolean;
};

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
}: PointerPollingInput = {}): PointerPollingPolicy {
  if (onboardingRequired === true || inputPaused === true) {
    return disabledPolicy();
  }

  const normalizedWakeMode = String(wakeMode || '')
    .trim()
    .toLowerCase();
  const normalizedOverride = String(mouseShakeOverride || '').trim();
  const configuredWiggle = WIGGLE_WAKE_MODES.has(normalizedWakeMode) && wiggleEnabled !== false;
  const detectWiggle =
    normalizedOverride === '1' ? true : normalizedOverride === '0' ? false : configuredWiggle;
  const normalizedSideButton = String(mouseSideButton || '')
    .trim()
    .toLowerCase();
  const episodeContinuation =
    episodeActive === true &&
    ['xbutton1', 'xbutton2', 'middle_hold'].includes(normalizedSideButton);
  const detectMouseButton = normalizedWakeMode === 'mouse_button' || episodeContinuation;
  const stageVoicePointer =
    voicePointerConfigured === true &&
    POINTER_VOICE_STRATEGIES.has(
      String(voiceStartStrategy || '')
        .trim()
        .toLowerCase(),
    );

  return {
    shouldPoll: detectWiggle || detectMouseButton || stageVoicePointer,
    detectWiggle,
    detectMouseButton,
  };
}

function disabledPolicy(): PointerPollingPolicy {
  return {
    shouldPoll: false,
    detectWiggle: false,
    detectMouseButton: false,
  };
}

module.exports = { pointerPollingPolicy };
