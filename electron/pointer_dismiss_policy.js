'use strict';

function shouldDismissFromGlobalPointer({
  currentButtons = 0,
  previousButtons = 0,
  hasVisibleTemporarySurface = false,
  interactiveOverlayOwnsPointer = false,
} = {}) {
  if (!hasVisibleTemporarySurface || interactiveOverlayOwnsPointer) return false;
  const rightButtonPressed = (Number(currentButtons) & 2) !== 0;
  const rightButtonWasPressed = (Number(previousButtons) & 2) !== 0;
  return rightButtonPressed && !rightButtonWasPressed;
}

module.exports = { shouldDismissFromGlobalPointer };
