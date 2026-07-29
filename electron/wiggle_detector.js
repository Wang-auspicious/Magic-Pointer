class WiggleDetector {
  constructor({
    sensitivity = 0.55,
    disabledApps = [],
    cooldownMs = 900,
    windowMs = 700,
  } = {}) {
    this.sensitivity = Math.max(0, Math.min(1, Number(sensitivity) || 0.55));
    this.disabledApps = disabledApps.map((value) => String(value).toLowerCase()).filter(Boolean);
    this.cooldownMs = Math.max(500, Number(cooldownMs) || 900);
    this.windowMs = Math.max(280, Math.min(900, Number(windowMs) || 700));
    this.points = [];
    this.lastSample = null;
    this.lastMotionAt = null;
    this.idleResetMs = 140;
    this.lastTriggeredAt = Number.NEGATIVE_INFINITY;
    this.thresholdScale = 1 + (0.5 - this.sensitivity) * 0.8;
    this.immediateCancels = 0;
    this.calibration = null;
  }

  reset() {
    this.points = [];
    this.lastSample = null;
    this.lastMotionAt = null;
  }

  updateSettings({
    sensitivity = this.sensitivity,
    disabledApps = this.disabledApps,
    cooldownMs = this.cooldownMs,
    windowMs = this.windowMs,
  } = {}) {
    this.sensitivity = Math.max(0, Math.min(1, Number(sensitivity) || 0.55));
    this.disabledApps = Array.from(disabledApps || [])
      .map((value) => String(value).toLowerCase())
      .filter(Boolean);
    this.cooldownMs = Math.max(500, Number(cooldownMs) || 900);
    this.windowMs = Math.max(280, Math.min(900, Number(windowMs) || 700));
    this.thresholdScale = 1 + (0.5 - this.sensitivity) * 0.8;
    this.reset();
  }

  startCalibration(now = Date.now(), durationMs = 10000) {
    this.calibration = {
      startedAt: Number(now),
      until: Number(now) + Math.max(3000, Number(durationMs) || 10000),
      samples: [],
    };
    this.reset();
  }

  finishCalibration() {
    const calibration = this.calibration;
    this.calibration = null;
    this.reset();
    if (!calibration || calibration.samples.length === 0) {
      return { ok: false, samples: 0, sensitivity: this.sensitivity };
    }
    const ranges = calibration.samples.map((metrics) => metrics.xRange).sort((a, b) => a - b);
    const medianRange = ranges[Math.floor(ranges.length / 2)];
    const targetScale = Math.max(0.68, Math.min(1.24, (medianRange * 0.58) / 38));
    const sensitivity = Math.max(0.2, Math.min(0.9, 0.5 + (1 - targetScale) / 0.8));
    this.updateSettings({ sensitivity });
    return {
      ok: true,
      samples: calibration.samples.length,
      medianRange,
      sensitivity: this.sensitivity,
    };
  }

  recordOutcome({ cancelledImmediately = false, completed = false } = {}) {
    if (cancelledImmediately) {
      this.immediateCancels += 1;
      this.thresholdScale = Math.min(1.45, this.thresholdScale + 0.08);
    }
    if (completed) {
      this.immediateCancels = Math.max(0, this.immediateCancels - 1);
      this.thresholdScale = Math.max(0.82, this.thresholdScale - 0.04);
    }
  }

  _blocked(sample, recent) {
    if (recent.some((point) => Number(point.buttons || 0) !== 0)) return 'button_down';
    if (recent.reduce((sum, point) => sum + Math.abs(Number(point.scrollDelta || 0)), 0) >= 80) return 'active_scroll';
    if (recent.some((point) => point.isWindowMoving === true)) return 'window_move';
    const app = String(sample.foregroundApp || '').toLowerCase();
    if (app && this.disabledApps.some((entry) => app.includes(entry))) return 'disabled_app';
    return null;
  }

  _metrics(recent) {
    if (recent.length < 4) return { ready: false, reason: 'insufficient_samples' };
    const first = recent[0];
    const last = recent[recent.length - 1];
    const durationMs = last.t - first.t;
    if (durationMs < 65) return { ready: false, reason: 'too_fast', durationMs };
    if (durationMs > this.windowMs) return { ready: false, reason: 'too_slow', durationMs };

    const xs = recent.map((point) => point.x);
    const ys = recent.map((point) => point.y);
    const xRange = Math.max(...xs) - Math.min(...xs);
    const yRange = Math.max(...ys) - Math.min(...ys);
    const minRange = 28 * this.thresholdScale;
    if (xRange < minRange) return { ready: false, reason: 'horizontal_range', durationMs, xRange, yRange };
    // User intent is three alternating horizontal-ish strokes. Permit a
    // generous diagonal axis; reject only motion that is predominantly vertical.
    if (yRange > Math.max(48, xRange * 0.90)) {
      return { ready: false, reason: 'vertical_drift', durationMs, xRange, yRange };
    }

    const segments = [];
    let direction = 0;
    let distance = 0;
    let total = 0;
    for (let index = 1; index < recent.length; index += 1) {
      const dx = recent[index].x - recent[index - 1].x;
      const dy = recent[index].y - recent[index - 1].y;
      total += Math.hypot(dx, dy);
      if (Math.abs(dx) < 5) continue;
      const nextDirection = dx > 0 ? 1 : -1;
      if (direction === 0 || nextDirection === direction) {
        direction = nextDirection;
        distance += Math.abs(dx);
      } else {
        if (distance >= 10 * this.thresholdScale) segments.push({ direction, distance });
        direction = nextDirection;
        distance = Math.abs(dx);
      }
    }
    if (distance >= 10 * this.thresholdScale) segments.push({ direction, distance });
    const reversals = Math.max(0, segments.length - 1);
    const horizontalTravel = segments.reduce((sum, segment) => sum + segment.distance, 0);
    const net = Math.hypot(last.x - first.x, last.y - first.y);
    const returnRatio = 1 - Math.min(1, net / Math.max(xRange, 1));
    const velocity = horizontalTravel / Math.max(durationMs / 1000, 0.001);

    const metrics = {
      ready: true,
      durationMs,
      xRange,
      yRange,
      reversals,
      horizontalTravel,
      totalTravel: total,
      net,
      returnRatio,
      velocity,
    };
    if (reversals < 2) return { ...metrics, ready: false, reason: 'insufficient_reversals' };
    if (horizontalTravel < 68 * this.thresholdScale) return { ...metrics, ready: false, reason: 'travel_too_short' };
    if (returnRatio < 0.12) return { ...metrics, ready: false, reason: 'did_not_return' };
    if (velocity < 90 * this.thresholdScale) return { ...metrics, ready: false, reason: 'velocity_too_low' };
    return metrics;
  }

  push(sample = {}) {
    const point = {
      t: Number(sample.t),
      x: Number(sample.x),
      y: Number(sample.y),
      buttons: Number(sample.buttons || 0),
      scrollDelta: Number(sample.scrollDelta || 0),
      isWindowMoving: sample.isWindowMoving === true,
      foregroundApp: String(sample.foregroundApp || ''),
    };
    if (!Number.isFinite(point.t) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return { triggered: false, reason: 'invalid_sample', metrics: {} };
    }
    const previousSample = this.lastSample;
    this.lastSample = point;
    const blocked = this._blocked(point, [...this.points, point]);
    if (blocked) {
      this.points = [];
      this.lastMotionAt = null;
      return { triggered: false, reason: blocked, metrics: {} };
    }

    if (!previousSample) {
      this.points = [point];
      return { triggered: false, reason: 'insufficient_samples', metrics: {} };
    }

    const movement = Math.hypot(point.x - previousSample.x, point.y - previousSample.y);
    if (movement < 1.5 * this.thresholdScale) {
      if (this.lastMotionAt === null || point.t - this.lastMotionAt >= this.idleResetMs) {
        this.points = [point];
        this.lastMotionAt = null;
      }
      return { triggered: false, reason: 'idle', metrics: {} };
    }

    // A wiggle is one continuous movement burst. Old ordinary mouse travel
    // must never make the next deliberate left-right-left gesture harder.
    if (this.lastMotionAt === null || point.t - this.lastMotionAt >= this.idleResetMs) {
      this.points = [previousSample];
    }
    this.lastMotionAt = point.t;
    this.points.push(point);
    const cutoff = point.t - this.windowMs;
    this.points = this.points.filter((item) => item.t >= cutoff);

    const metrics = this._metrics(this.points);
    if (!metrics.ready) return { triggered: false, reason: metrics.reason, metrics };
    if (this.calibration && point.t <= this.calibration.until) {
      this.calibration.samples.push(metrics);
      this.reset();
      return { triggered: false, reason: 'calibrating', metrics };
    }
    if (point.t - this.lastTriggeredAt < this.cooldownMs) {
      this.reset();
      return { triggered: false, reason: 'cooldown', metrics };
    }
    this.lastTriggeredAt = point.t;
    this.reset();
    return { triggered: true, reason: 'intentional_wiggle', metrics };
  }
}

module.exports = { WiggleDetector };
