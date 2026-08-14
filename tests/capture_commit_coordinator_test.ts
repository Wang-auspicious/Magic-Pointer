'use strict';

// CaptureCommitCoordinator: pointerup must freeze pixels before the overlay is
// released and before the selection session opens. The coordinator owns that
// order deterministically, independent of Electron window timing.

const assert = require('assert');
const { CaptureCommitCoordinator } = require('../electron/capture_commit_coordinator');

function rawLease(frameLeaseId = 'frame-1') {
  return {
    schemaVersion: 1,
    frameLeaseId,
    epochId: 'epoch-1',
    capturedAtMonotonicMs: 1250.5,
    capturedAtUtc: '2026-08-11T00:00:00.000Z',
    source: 'test',
    targetWindow: { hwnd: 42, processId: 7, processName: 'demo.exe', title: 'Demo' },
    surfaceBoundsPx: [0, 0, 1920, 1080],
    displayId: 'display-1',
    scaleFactor: 1,
    gesture: { coordinateSpace: 'physical_screen_pixels', strokes: [] },
    localArtifact: { path: 'D:/tmp/frame.png', mimeType: 'image/png', width: 1920, height: 1080 },
    contentHash: 'sha256:abc',
    overlayExcluded: true,
    captureLatencyMs: 12.5,
  };
}

function armRequest(epochId = 'epoch-1') {
  return {
    epochId,
    displayId: 'display-1',
    scaleFactor: 1,
    surfaceBoundsPx: [0, 0, 1920, 1080],
    targetWindow: { hwnd: 42, processId: 7, processName: 'demo.exe', title: 'Demo' },
    overlayExcluded: true,
  };
}

function gesture() {
  return { schemaVersion: 2, coordinateSpace: 'physical_screen_pixels', strokes: [] };
}

function fakeProvider(events: string[], { failCommit = false, slowCommit = false } = {}) {
  return {
    arm: async () => { events.push('arm'); },
    commit: async () => {
      events.push('commit');
      if (slowCommit) await new Promise((resolve) => setTimeout(resolve, 5));
      if (failCommit) throw new Error('capture_failed');
      return rawLease();
    },
    cancel: async () => { events.push('cancel'); },
  };
}

(async function commitsPixelsBeforeOverlayReleaseAndSessionStart() {
  const events: string[] = [];
  const coordinator = new CaptureCommitCoordinator({
    provider: fakeProvider(events),
    releaseOverlay: () => events.push('overlay-release'),
    beginSession: (_gesture: unknown, lease: any) => events.push(`session:${lease.frameLeaseId}`),
  });
  await coordinator.arm(armRequest());
  await coordinator.complete(gesture());
  assert.deepStrictEqual(events, ['arm', 'commit', 'overlay-release', 'session:frame-1']);
})();

(async function completeWithoutArmIsRefused() {
  const events: string[] = [];
  const coordinator = new CaptureCommitCoordinator({
    provider: fakeProvider(events),
    releaseOverlay: () => events.push('overlay-release'),
    beginSession: () => events.push('session'),
  });
  await assert.rejects(coordinator.complete(gesture()), /frame_commit_not_armed/);
  assert.deepStrictEqual(events, []);
})();

(async function staleTokenCannotCompleteAReplacedEpoch() {
  const events: string[] = [];
  const coordinator = new CaptureCommitCoordinator({
    provider: fakeProvider(events),
    releaseOverlay: () => events.push('overlay-release'),
    beginSession: () => events.push('session'),
  });
  const token1 = await coordinator.arm(armRequest('epoch-1'));
  await coordinator.arm(armRequest('epoch-2'));
  assert.deepStrictEqual(events, ['arm', 'cancel', 'arm']);
  await assert.rejects(coordinator.complete(gesture(), token1), /frame_commit_stale_token/);
  assert.deepStrictEqual(events, ['arm', 'cancel', 'arm']);
})();

(async function duplicateCompletionStartsOnlyOneSession() {
  const events: string[] = [];
  const coordinator = new CaptureCommitCoordinator({
    provider: fakeProvider(events),
    releaseOverlay: () => events.push('overlay-release'),
    beginSession: () => events.push('session'),
  });
  await coordinator.arm(armRequest());
  await coordinator.complete(gesture());
  await assert.rejects(coordinator.complete(gesture()), /frame_commit_not_armed/);
  assert.strictEqual(events.filter((event) => event === 'session').length, 1);
})();

(async function commitFailureReleasesOverlayAndReportsWithoutSession() {
  const events: string[] = [];
  const failures: Error[] = [];
  const coordinator = new CaptureCommitCoordinator({
    provider: fakeProvider(events, { failCommit: true }),
    releaseOverlay: () => events.push('overlay-release'),
    beginSession: () => events.push('session'),
    onCommitFailure: (error: any) => failures.push(error),
  });
  await coordinator.arm(armRequest());
  await coordinator.complete(gesture());
  assert.deepStrictEqual(events, ['arm', 'commit', 'overlay-release']);
  assert.strictEqual(failures.length, 1);
  assert(failures[0] instanceof Error);
  assert.strictEqual(coordinator.state, 'failed');
  assert.strictEqual(events.includes('session'), false);
})();

(async function cancellationDuringCommitSkipsTheSession() {
  const events: string[] = [];
  const coordinator = new CaptureCommitCoordinator({
    provider: fakeProvider(events, { slowCommit: true }),
    releaseOverlay: () => events.push('overlay-release'),
    beginSession: () => events.push('session'),
  });
  await coordinator.arm(armRequest());
  const completing = coordinator.complete(gesture());
  await coordinator.cancel();
  await completing;
  assert.deepStrictEqual(events, ['arm', 'commit', 'overlay-release']);
  assert.strictEqual(events.includes('session'), false);
  assert.strictEqual(coordinator.state, 'cancelled');
})();

(async function cancelWhileArmedCancelsTheWorkerEpoch() {
  const events: string[] = [];
  const coordinator = new CaptureCommitCoordinator({
    provider: fakeProvider(events),
    releaseOverlay: () => events.push('overlay-release'),
    beginSession: () => events.push('session'),
  });
  await coordinator.arm(armRequest());
  await coordinator.cancel();
  assert.deepStrictEqual(events, ['arm', 'cancel']);
  assert.strictEqual(coordinator.state, 'cancelled');
  await assert.rejects(coordinator.complete(gesture()), /frame_commit_not_armed/);
})();

(async function beginSessionReceivesADeepFrozenLease() {
  let received: any = null;
  const coordinator = new CaptureCommitCoordinator({
    provider: {
      arm: async () => {},
      commit: async () => rawLease(),
      cancel: async () => {},
    },
    releaseOverlay: () => {},
    beginSession: (_gesture: unknown, lease: any) => { received = lease; },
  });
  await coordinator.arm(armRequest());
  await coordinator.complete(gesture());
  assert.notStrictEqual(received, null);
  assert.strictEqual(Object.isFrozen(received), true);
  assert.strictEqual(Object.isFrozen(received.targetWindow), true);
  assert.strictEqual(Object.isFrozen(received.localArtifact), true);
  assert.strictEqual(Object.isFrozen(received.gesture), true);
  assert.strictEqual(received.frameLeaseId, 'frame-1');
})();

(async function rearmDuringCommitMustNotClobberTheNewEpoch() {
  const events: string[] = [];
  const coordinator = new CaptureCommitCoordinator({
    provider: {
      arm: async (req: any) => { events.push(`arm:${req.epochId}`); },
      commit: async (req: any) => {
        events.push(`commit:${req.epochId}`);
        if (req.epochId === 'epoch-1') {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return rawLease(req.epochId === 'epoch-1' ? 'frame-1' : 'frame-2');
      },
      cancel: async () => { events.push('cancel'); },
    },
    releaseOverlay: () => events.push('overlay-release'),
    beginSession: (_g: unknown, lease: any) => events.push(`session:${lease.frameLeaseId}`),
  });
  await coordinator.arm(armRequest('epoch-1'));
  const completing1 = coordinator.complete(gesture());
  await coordinator.arm(armRequest('epoch-2'));
  const lease1 = await completing1;
  // The stale commit tail must be fully discarded: no overlay release, no
  // session for the old gesture, and the new epoch's armed request survives.
  assert.strictEqual(lease1, null);
  assert(!events.includes('overlay-release'));
  assert(!events.includes('session:frame-1'));
  assert.strictEqual(coordinator.state, 'armed');
  const lease2 = await coordinator.complete(gesture());
  assert.strictEqual(lease2.frameLeaseId, 'frame-2');
  assert.deepStrictEqual(events, [
    'arm:epoch-1',
    'commit:epoch-1',
    'arm:epoch-2',
    'commit:epoch-2',
    'overlay-release',
    'session:frame-2',
  ]);
})();

(async function commitFailureStillReleasesOverlayAndResolvesNull() {
  const events: string[] = [];
  const failures: Error[] = [];
  const coordinator = new CaptureCommitCoordinator({
    provider: fakeProvider(events, { failCommit: true }),
    releaseOverlay: () => events.push('overlay-release'),
    beginSession: () => events.push('session'),
    onCommitFailure: (error: any) => failures.push(error),
  });
  await coordinator.arm(armRequest());
  const lease = await coordinator.complete(gesture());
  assert.strictEqual(lease, null);
  assert.deepStrictEqual(events, ['arm', 'commit', 'overlay-release']);
  assert.strictEqual(failures.length, 1);
})();

console.log('capture commit coordinator test ok');
