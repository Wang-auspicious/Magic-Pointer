'use strict';

// FrameLease v1 contract: an immutable full-surface frame bound before
// structured perception starts. Both Electron and the Python capture worker
// share this shape, so the two validators must agree on every field.

const assert = require('assert');
const { validateFrameLease, cloneFrameLease } = require('../electron/frame_lease');

function fixtureLease() {
  return {
    schemaVersion: 1,
    frameLeaseId: 'frame-1',
    epochId: 'epoch-1',
    capturedAtMonotonicMs: 1250.5,
    capturedAtUtc: '2026-08-11T00:00:00.000Z',
    source: 'test',
    targetWindow: { hwnd: 42, processId: 7, processName: 'demo.exe', title: 'Demo' },
    surfaceBoundsPx: [0, 0, 1920, 1080],
    displayId: 'display-1',
    scaleFactor: 1,
    gesture: { coordinateSpace: 'physical_screen_pixels', strokes: [] },
    localArtifact: {
      path: 'D:/tmp/frame.png',
      mimeType: 'image/png',
      width: 1920,
      height: 1080,
    },
    contentHash: 'sha256:abc',
    overlayExcluded: true,
    captureLatencyMs: 12.5,
  };
}

// Accepts an immutable frame lease with physical coordinates.
{
  const lease = validateFrameLease(fixtureLease());
  assert.strictEqual(lease.frameLeaseId, 'frame-1');
  assert.strictEqual(lease.epochId, 'epoch-1');
  assert.strictEqual(lease.capturedAtMonotonicMs, 1250.5);
  assert.strictEqual(lease.capturedAtUtc, '2026-08-11T00:00:00.000Z');
  assert.strictEqual(lease.source, 'test');
  assert.deepStrictEqual(lease.surfaceBoundsPx, [0, 0, 1920, 1080]);
  assert.strictEqual(lease.displayId, 'display-1');
  assert.strictEqual(lease.scaleFactor, 1);
  assert.deepStrictEqual(lease.gesture, { coordinateSpace: 'physical_screen_pixels', strokes: [] });
  assert.deepStrictEqual(lease.localArtifact, {
    path: 'D:/tmp/frame.png',
    mimeType: 'image/png',
    width: 1920,
    height: 1080,
  });
  assert.strictEqual(lease.contentHash, 'sha256:abc');
  assert.strictEqual(lease.overlayExcluded, true);
  assert.strictEqual(lease.captureLatencyMs, 12.5);
}

// Rejects non-physical or incomplete frame leases.
{
  assert.throws(() => validateFrameLease({ schemaVersion: 1 }), /frameLeaseId/);
  assert.throws(() => validateFrameLease(null), /frameLease/);
  assert.throws(() => validateFrameLease({ ...fixtureLease(), schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => validateFrameLease({ ...fixtureLease(), source: 'wgc' }), /source/);
  assert.doesNotThrow(() => validateFrameLease({ ...fixtureLease(), source: 'gdi-fallback' }),
    'gdi-fallback is a permitted honest backend source');
  assert.throws(() => validateFrameLease({ ...fixtureLease(), surfaceBoundsPx: [0, 0, 0, 1080] }),
    /surfaceBoundsPx/);
  assert.throws(() => validateFrameLease({ ...fixtureLease(), capturedAtMonotonicMs: -1 }),
    /capturedAtMonotonicMs/);
  assert.throws(() => validateFrameLease({ ...fixtureLease(), captureLatencyMs: Infinity }),
    /captureLatencyMs/);
  assert.throws(() => validateFrameLease({ ...fixtureLease(), contentHash: '  ' }),
    /contentHash/);
  assert.throws(() => validateFrameLease({ ...fixtureLease(), targetWindow: { hwnd: 42 } }),
    /targetWindow\./);
}

// Deeply frozen copies: the consumer may never mutate the committed frame's
// metadata, and a later caller cannot alias the same nested objects.
{
  const lease = validateFrameLease(fixtureLease());
  assert.strictEqual(Object.isFrozen(lease), true);
  assert.strictEqual(Object.isFrozen(lease.targetWindow), true);
  assert.strictEqual(Object.isFrozen(lease.localArtifact), true);
  assert.strictEqual(Object.isFrozen(lease.gesture), true);
  assert.strictEqual(Object.isFrozen(lease.surfaceBoundsPx), true);
}

{
  const original = fixtureLease();
  const lease = validateFrameLease(original);
  assert.notStrictEqual(lease.targetWindow, original.targetWindow,
    'the validator must copy nested objects instead of aliasing input');
  const cloned = cloneFrameLease(lease);
  assert.notStrictEqual(cloned, lease);
  assert.notStrictEqual(cloned.targetWindow, lease.targetWindow);
  assert.notStrictEqual(cloned.localArtifact, lease.localArtifact);
  assert.deepStrictEqual(cloned, lease);
  assert.strictEqual(Object.isFrozen(cloned), true);
}

console.log('frame lease contract test ok');
