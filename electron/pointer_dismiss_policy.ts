'use strict';

type PointerDismissInput = {
  currentButtons?: number;
  previousButtons?: number;
  hasVisibleTemporarySurface?: boolean;
  interactiveOverlayOwnsPointer?: boolean;
};

function shouldDismissFromGlobalPointer({
  currentButtons = 0,
  previousButtons = 0,
  hasVisibleTemporarySurface = false,
  interactiveOverlayOwnsPointer = false,
}: PointerDismissInput = {}): boolean {
  if (!hasVisibleTemporarySurface || interactiveOverlayOwnsPointer) return false;
  const rightButtonPressed = (Number(currentButtons) & 2) !== 0;
  const rightButtonWasPressed = (Number(previousButtons) & 2) !== 0;
  return rightButtonPressed && !rightButtonWasPressed;
}

module.exports = { shouldDismissFromGlobalPointer };
