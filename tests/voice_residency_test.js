const assert = require('assert');
const { VoiceResidencyController } = require('../electron/voice_residency');

function makeClock(startMs = 10_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (elapsedMs) => { nowMs += elapsedMs; },
  };
}

function makeController(options = {}) {
  const clock = options.clock || makeClock();
  return {
    clock,
    controller: new VoiceResidencyController({
      memoryLimitMb: 512,
      idleUnloadMs: 1_000,
      clock: clock.now,
      ...options,
    }),
  };
}

(function coldLoadTransitionsToReadyWithJsonSafeMetadata() {
  const { controller, clock } = makeController();

  assert.strictEqual(controller.snapshot().state, 'unloaded');
  assert.strictEqual(controller.requestLoad(120), true);
  assert.strictEqual(controller.snapshot().state, 'loading');
  assert.strictEqual(controller.loaded(118), true);

  const snapshot = controller.snapshot();
  assert.deepStrictEqual(snapshot, {
    state: 'ready',
    memoryLimitMb: 512,
    idleUnloadMs: 1_000,
    estimatedMb: 120,
    actualMb: 118,
    activeSessions: 0,
    idleSinceMs: null,
    lastTouchedMs: clock.now(),
    unloadRequested: false,
    errorCode: null,
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
  assert.strictEqual('audio' in snapshot, false);
  assert.strictEqual('transcript' in snapshot, false);
})();

(function residentModelIsReusedForASecondSession() {
  const { controller, clock } = makeController();
  controller.requestLoad(100);
  controller.loaded(100);

  assert.strictEqual(controller.beginSession(), true);
  assert.strictEqual(controller.snapshot().state, 'busy');
  clock.advance(250);
  assert.strictEqual(controller.endSession(), true);
  assert.strictEqual(controller.snapshot().state, 'idle');

  clock.advance(500);
  assert.strictEqual(controller.beginSession(), true);
  const snapshot = controller.snapshot();
  assert.strictEqual(snapshot.state, 'busy');
  assert.strictEqual(snapshot.actualMb, 100);
  assert.strictEqual(snapshot.unloadRequested, false);
})();

(function estimatedMemoryOverLimitFailsClosedBeforeLoad() {
  const { controller } = makeController({ memoryLimitMb: 128 });

  assert.strictEqual(controller.requestLoad(129), false);
  assert.deepStrictEqual(controller.snapshot(), {
    state: 'error',
    memoryLimitMb: 128,
    idleUnloadMs: 1_000,
    estimatedMb: 129,
    actualMb: null,
    activeSessions: 0,
    idleSinceMs: null,
    lastTouchedMs: 10_000,
    unloadRequested: false,
    errorCode: 'memory_limit_exceeded',
  });
})();

(function actualMemoryOverLimitImmediatelyRequestsUnload() {
  const { controller } = makeController({ memoryLimitMb: 128 });
  controller.requestLoad(120);

  assert.strictEqual(controller.loaded(129), false);
  assert.strictEqual(controller.snapshot().state, 'unloading');
  assert.strictEqual(controller.snapshot().actualMb, 129);
  assert.strictEqual(controller.snapshot().unloadRequested, true);
})();

(function idleModelIsReclaimedOnlyAtTheDeadlineAndTouchExtendsIt() {
  const { controller, clock } = makeController();
  controller.requestLoad(100);
  controller.loaded(100);
  controller.beginSession();
  controller.endSession();

  clock.advance(900);
  assert.strictEqual(controller.tick(), false);
  assert.strictEqual(controller.snapshot().state, 'idle');
  assert.strictEqual(controller.touch(), true);
  clock.advance(999);
  assert.strictEqual(controller.tick(), false);
  clock.advance(1);
  assert.strictEqual(controller.tick(), true);
  assert.strictEqual(controller.snapshot().state, 'unloading');
  assert.strictEqual(controller.snapshot().unloadRequested, true);

  assert.strictEqual(controller.unloaded(), true);
  assert.strictEqual(controller.snapshot().state, 'unloaded');
  assert.strictEqual(controller.snapshot().actualMb, null);
})();

(function busySessionIsNeverReclaimedByIdleTick() {
  const { controller, clock } = makeController();
  controller.requestLoad(100);
  controller.loaded(100);
  controller.beginSession();

  clock.advance(10_000);
  assert.strictEqual(controller.tick(), false);
  assert.strictEqual(controller.snapshot().state, 'busy');
  assert.strictEqual(controller.snapshot().unloadRequested, false);
})();

(function duplicateEventsAreIdempotentAndIllegalOrderFailsClosed() {
  const { controller } = makeController();
  assert.strictEqual(controller.beginSession(), false);
  assert.strictEqual(controller.snapshot().state, 'error');
  assert.strictEqual(controller.snapshot().errorCode, 'session_before_ready');
  assert.strictEqual(controller.requestLoad(100), false);

  assert.strictEqual(controller.unloaded(), true);
  assert.strictEqual(controller.requestLoad(100), true);
  assert.strictEqual(controller.requestLoad(100), true);
  assert.strictEqual(controller.loaded(100), true);
  assert.strictEqual(controller.loaded(100), true);
  assert.strictEqual(controller.beginSession(), true);
  assert.strictEqual(controller.beginSession(), true);
  assert.strictEqual(controller.loaded(100), true);
  assert.strictEqual(controller.snapshot().activeSessions, 1);
  assert.strictEqual(controller.endSession(), true);
  assert.strictEqual(controller.endSession(), true);
  assert.strictEqual(controller.loaded(100), true);
  assert.strictEqual(controller.snapshot().state, 'idle');

  const { controller: outOfOrder } = makeController();
  assert.strictEqual(outOfOrder.loaded(100), false);
  assert.strictEqual(outOfOrder.snapshot().state, 'error');
  assert.strictEqual(outOfOrder.snapshot().errorCode, 'loaded_without_request');
})();

console.log('voice_residency_test: all assertions passed');
