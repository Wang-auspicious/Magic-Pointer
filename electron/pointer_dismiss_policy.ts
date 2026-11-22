'use strict';

type PointerDismissInput = {
  currentButtons?: number;
  previousButtons?: number;
  hasVisibleTemporarySurface?: boolean;
  interactiveOverlayOwnsPointer?: boolean;
  stagePhase?: string;
};

function shouldDismissStageOnOutsideClick(phase: unknown): boolean {
  return phase === 'capsule-text';
}

function shouldDismissFromGlobalPointer({
  currentButtons = 0,
  previousButtons = 0,
  hasVisibleTemporarySurface = false,
  interactiveOverlayOwnsPointer = false,
  stagePhase,
}: PointerDismissInput = {}): boolean {
  if (!hasVisibleTemporarySurface || interactiveOverlayOwnsPointer) {
    return false;
  }
  if (
    typeof stagePhase === 'string' &&
    stagePhase &&
    !shouldDismissStageOnOutsideClick(stagePhase)
  ) {
    return false;
  }
  const rightButtonPressed = (Number(currentButtons) & 2) !== 0;
  const rightButtonWasPressed = (Number(previousButtons) & 2) !== 0;
  return rightButtonPressed && !rightButtonWasPressed;
}

module.exports = {
  shouldDismissFromGlobalPointer,
  shouldDismissStageOnOutsideClick,
};
