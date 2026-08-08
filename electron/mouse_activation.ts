const BUTTON_MASKS = Object.freeze({
  xbutton1: 8,
  xbutton2: 16,
  middle_hold: 4,
});
type MouseButtonMode = keyof typeof BUTTON_MASKS | 'none';

class MouseActivationDetector {
  middleHoldMs: number;
  lastButtons: number;
  middleDownAt: number | null;
  middleTriggered: boolean;

  constructor({ middleHoldMs = 450 }: { middleHoldMs?: number } = {}) {
    this.middleHoldMs = middleHoldMs;
    this.lastButtons = 0;
    this.middleDownAt = null;
    this.middleTriggered = false;
  }

  reset(buttons = 0): void {
    this.lastButtons = Number(buttons || 0);
    this.middleDownAt = null;
    this.middleTriggered = false;
  }

  push({
    t = Date.now(),
    buttons = 0,
    mode = 'none',
  }: {
    t?: number;
    buttons?: number;
    mode?: MouseButtonMode;
  } = {}): string | null {
    const current = Number(buttons || 0);
    const previous = this.lastButtons;
    this.lastButtons = current;
    if (mode === 'xbutton1' || mode === 'xbutton2') {
      const mask = BUTTON_MASKS[mode];
      return (current & mask) !== 0 && (previous & mask) === 0 ? `mouse-button-${mode}` : null;
    }
    if (mode !== 'middle_hold') {
      this.middleDownAt = null;
      this.middleTriggered = false;
      return null;
    }
    const isDown = (current & BUTTON_MASKS.middle_hold) !== 0;
    const wasDown = (previous & BUTTON_MASKS.middle_hold) !== 0;
    if (!isDown) {
      this.middleDownAt = null;
      this.middleTriggered = false;
      return null;
    }
    if (!wasDown) {
      this.middleDownAt = Number(t);
      this.middleTriggered = false;
    }
    if (
      !this.middleTriggered &&
      this.middleDownAt !== null &&
      Number(t) - this.middleDownAt >= this.middleHoldMs
    ) {
      this.middleTriggered = true;
      return 'mouse-button-middle-hold';
    }
    return null;
  }
}

module.exports = { BUTTON_MASKS, MouseActivationDetector };
