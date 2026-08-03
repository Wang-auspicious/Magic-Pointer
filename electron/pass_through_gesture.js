'use strict';

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

class PassThroughGestureCapture {
  constructor({ minimumPointDistance = 2.5 } = {}) {
    this.minimumPointDistance = Math.max(0, finite(minimumPointDistance, 2.5));
    this.cancel();
  }

  get active() {
    return Boolean(this.armState);
  }

  arm({ token, displayBounds, initialButtons = 0, source = null, multiStroke = false } = {}) {
    const bounds = displayBounds || {};
    this.armState = {
      token: String(token || ''),
      displayBounds: {
        x: finite(bounds.x),
        y: finite(bounds.y),
        width: Math.max(1, finite(bounds.width, 1)),
        height: Math.max(1, finite(bounds.height, 1)),
      },
      source,
      multiStroke: multiStroke === true,
    };
    this.previousButtons = Number(initialButtons || 0);
    this.drawing = false;
    this.points = [];
    this.strokes = [];
  }

  cancel() {
    this.armState = null;
    this.previousButtons = 0;
    this.drawing = false;
    this.points = [];
    this.strokes = [];
  }

  localPoint(sample) {
    const bounds = this.armState.displayBounds;
    return {
      x: Math.max(0, Math.min(bounds.width - 1, finite(sample?.x) - bounds.x)),
      y: Math.max(0, Math.min(bounds.height - 1, finite(sample?.y) - bounds.y)),
      t: finite(sample?.t, Date.now()),
    };
  }

  appendPoint(sample) {
    const point = this.localPoint(sample);
    const previous = this.points.at(-1);
    if (
      previous
      && Math.hypot(point.x - previous.x, point.y - previous.y) < this.minimumPointDistance
    ) {
      return null;
    }
    this.points.push(point);
    return point;
  }

  push(sample = {}) {
    if (!this.armState) return [];
    const buttons = Number(sample.buttons || 0);
    const primaryDown = (buttons & 1) !== 0;
    const primaryWasDown = (this.previousButtons & 1) !== 0;
    const secondaryDown = (buttons & 2) !== 0;
    const secondaryWasDown = (this.previousButtons & 2) !== 0;
    this.previousButtons = buttons;

    if (secondaryDown && !secondaryWasDown) {
      const token = this.armState.token;
      this.cancel();
      return [{ type: 'dismissed', token }];
    }

    const events = [];
    if (!this.drawing && primaryDown && !primaryWasDown) {
      this.drawing = true;
      this.points = [];
      events.push({ type: 'started', token: this.armState.token });
      const point = this.appendPoint(sample);
      if (point) events.push({ type: 'point', token: this.armState.token, point });
      return events;
    }
    if (!this.drawing) return events;

    const point = this.appendPoint(sample);
    if (point) events.push({ type: 'point', token: this.armState.token, point });
    if (!primaryDown && primaryWasDown) {
      const { token, source } = this.armState;
      const releaseSample = this.localPoint(sample);
      const latest = this.points.at(-1);
      if (
        !latest
        || latest.x !== releaseSample.x
        || latest.y !== releaseSample.y
        || latest.t !== releaseSample.t
      ) {
        this.points.push(releaseSample);
      }
      const points = this.points.map((entry) => ({ ...entry }));
      const release = points.at(-1) || releaseSample;
      if (this.armState.multiStroke) {
        this.strokes.push({ points });
        this.drawing = false;
        this.points = [];
        events.push({
          type: 'stroke-completed',
          token,
          source,
          index: this.strokes.length,
          points,
          releasePoint: { x: release.x, y: release.y },
        });
        return events;
      }
      this.cancel();
      events.push({
        type: 'completed',
        token,
        source,
        points,
        releasePoint: { x: release.x, y: release.y },
      });
    }
    return events;
  }

  finish() {
    if (!this.armState || !this.strokes.length) return null;
    const { token, source } = this.armState;
    const strokes = this.strokes.map((stroke) => ({
      points: stroke.points.map((point) => ({ ...point })),
    }));
    const points = strokes.flatMap((stroke) => stroke.points);
    const release = points.at(-1);
    this.cancel();
    return {
      type: 'completed',
      token,
      source,
      points,
      strokes,
      releasePoint: release ? { x: release.x, y: release.y } : null,
    };
  }
}

module.exports = { PassThroughGestureCapture };
