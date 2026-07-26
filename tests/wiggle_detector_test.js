const assert = require('assert');
const { WiggleDetector } = require('../electron/wiggle_detector');

function feed(detector, points, extra = {}) {
  let result = null;
  for (const [t, x, y] of points) result = detector.push({ t, x, y, ...extra });
  return result;
}

const intentional = [
  [0, 500, 400],
  [70, 526, 402],
  [140, 478, 399],
  [220, 528, 401],
  [310, 493, 400],
];

{
  const detector = new WiggleDetector();
  const result = feed(detector, intentional);
  assert.strictEqual(result.triggered, true);
  assert.strictEqual(result.reason, 'intentional_wiggle');
  assert(result.metrics.reversals >= 3);
  assert(result.metrics.durationMs >= 250 && result.metrics.durationMs <= 600);
}

{
  const detector = new WiggleDetector();
  const travel = Array.from({ length: 10 }, (_, i) => [i * 45, 100 + i * 18, 200]);
  assert.strictEqual(feed(detector, travel).triggered, false);
}

{
  const detector = new WiggleDetector();
  const diagonal = intentional.map(([t, x], i) => [t, x, 200 + i * 22]);
  const result = feed(detector, diagonal);
  assert.strictEqual(result.triggered, false);
  assert.strictEqual(result.reason, 'vertical_drift');
}

{
  const detector = new WiggleDetector();
  const result = feed(detector, intentional, { buttons: 1 });
  assert.strictEqual(result.triggered, false);
  assert.strictEqual(result.reason, 'button_down');
}

{
  const detector = new WiggleDetector();
  let result = null;
  for (const [t, x, y] of intentional) result = detector.push({ t, x, y, scrollDelta: 40 });
  assert.strictEqual(result.triggered, false);
  assert.strictEqual(result.reason, 'active_scroll');
}

{
  const detector = new WiggleDetector();
  const result = feed(detector, intentional, { isWindowMoving: true });
  assert.strictEqual(result.triggered, false);
  assert.strictEqual(result.reason, 'window_move');
}

{
  const detector = new WiggleDetector({ disabledApps: ['blender', '原神'] });
  const result = feed(detector, intentional, { foregroundApp: 'C:/Program Files/Blender/blender.exe' });
  assert.strictEqual(result.triggered, false);
  assert.strictEqual(result.reason, 'disabled_app');
}

{
  const detector = new WiggleDetector({ cooldownMs: 900 });
  assert.strictEqual(feed(detector, intentional.map(([t, x, y]) => [t + 1000, x, y])).triggered, true);
  const second = feed(detector, intentional.map(([t, x, y]) => [t + 1500, x, y]));
  assert.strictEqual(second.triggered, false);
  assert.strictEqual(second.reason, 'cooldown');
  assert.strictEqual(feed(detector, intentional.map(([t, x, y]) => [t + 2200, x, y])).triggered, true);
}

{
  const detector = new WiggleDetector();
  const tooSlow = intentional.map(([t, x, y]) => [Math.round(t * 2.2), x, y]);
  assert.strictEqual(feed(detector, tooSlow).triggered, false);
}

{
  const detector = new WiggleDetector({ sensitivity: 0.5 });
  const before = detector.thresholdScale;
  detector.recordOutcome({ cancelledImmediately: true });
  detector.recordOutcome({ cancelledImmediately: true });
  assert(detector.thresholdScale > before);
  detector.recordOutcome({ completed: true });
  assert(detector.thresholdScale <= 1.35);
}

{
  const detector = new WiggleDetector({ sensitivity: 0.2, disabledApps: ['old-app'] });
  detector.updateSettings({ sensitivity: 0.9, disabledApps: ['new-app'], cooldownMs: 1400 });
  assert.strictEqual(detector.sensitivity, 0.9);
  assert.strictEqual(detector.cooldownMs, 1400);
  assert(detector.disabledApps.includes('new-app'));
  assert(!detector.disabledApps.includes('old-app'));
  const blocked = feed(detector, intentional, { foregroundApp: 'C:/new-app.exe' });
  assert.strictEqual(blocked.reason, 'disabled_app');
}

{
  const detector = new WiggleDetector({ sensitivity: 0.5 });
  detector.startCalibration(1000, 10000);
  const sample = feed(detector, intentional.map(([t, x, y]) => [t + 1200, x, y]));
  assert.strictEqual(sample.triggered, false);
  assert.strictEqual(sample.reason, 'calibrating');
  const calibrated = detector.finishCalibration();
  assert.strictEqual(calibrated.ok, true);
  assert.strictEqual(calibrated.samples, 1);
  assert(calibrated.sensitivity >= 0.2 && calibrated.sensitivity <= 0.9);
}

console.log('wiggle detector test ok');
