'use strict';

type GestureSettings = {
  activation?: Record<string, unknown>;
  appearance?: Record<string, unknown>;
};

type GestureRuntimeContract = Readonly<{
  armDelayMs: number;
  timeoutMs: number;
  chainGapMs: number;
  interactionMode: 'exclusive_overlay' | 'pass_through';
  lineStyle: 'thin' | 'demo6_band';
  lineWidthDip: number;
}>;

function finiteNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function gestureRuntimeContract(settings: GestureSettings = {}): GestureRuntimeContract {
  const activation = settings.activation || {};
  const appearance = settings.appearance || {};
  return Object.freeze({
    armDelayMs: finiteNumber(activation.gesture_arm_delay_ms, 180, 60, 600),
    timeoutMs: finiteNumber(activation.gesture_timeout_ms, 5000, 1000, 15000),
    chainGapMs: finiteNumber(activation.multi_stroke_submit_ms, 2500, 1500, 30000),
    interactionMode:
      activation.gesture_interaction_mode === 'exclusive_overlay'
        ? 'exclusive_overlay'
        : 'pass_through',
    lineStyle: appearance.gesture_line_style === 'thin' ? 'thin' : 'demo6_band',
    lineWidthDip: finiteNumber(appearance.gesture_line_width_dip, 40, 3, 40),
  });
}

function gestureRuntimeSettingsChanged(previous: GestureSettings, next: GestureSettings): boolean {
  const before = gestureRuntimeContract(previous);
  const after = gestureRuntimeContract(next);
  return (Object.keys(before) as Array<keyof GestureRuntimeContract>).some(
    (key) => before[key] !== after[key],
  );
}

module.exports = { gestureRuntimeContract, gestureRuntimeSettingsChanged };
