'use strict';

const assert = require('assert');
const { VoiceFocusGuard } = require('../electron/voice_focus_guard');

function expectThrows(action, message) {
  assert.throws(action, TypeError, message);
}

(function recordsAnUnbrokenVoiceLifecycle() {
  const guard = new VoiceFocusGuard({
    expectedHwnd: 4242,
    sessionId: 'voice-session-1',
    startedAt: 100,
  });

  for (const [phase, timestamp] of [
    ['wake', 101],
    ['loading', 102],
    ['partial', 103],
    ['final', 104],
    ['result', 105],
  ]) {
    assert.strictEqual(guard.observe(phase, 4242, timestamp), true);
  }

  const evidence = guard.finish(106);
  assert.deepStrictEqual(evidence, {
    sessionId: 'voice-session-1',
    expectedHwnd: 4242,
    contract: 'foreground-hwnd-stable',
    invariant: true,
    violationCount: 0,
    violations: [],
    phases: [
      { phase: 'wake', hwnd: 4242, timestamp: 101 },
      { phase: 'loading', hwnd: 4242, timestamp: 102 },
      { phase: 'partial', hwnd: 4242, timestamp: 103 },
      { phase: 'final', hwnd: 4242, timestamp: 104 },
      { phase: 'result', hwnd: 4242, timestamp: 105 },
    ],
    startedAt: 100,
    finishedAt: 106,
  });
  assert.doesNotThrow(() => JSON.stringify(evidence));
}());

(function failsClosedForChangedOrZeroHwnd() {
  const changed = new VoiceFocusGuard({ expectedHwnd: 4242, sessionId: 'changed', startedAt: 1 });
  assert.strictEqual(changed.observe('wake', 4242, 2), true);
  assert.strictEqual(changed.observe('loading', 4243, 3), false);
  assert.strictEqual(changed.observe('final', 4242, 4), false);
  assert.strictEqual(changed.finish(5).violationCount, 1);
  assert.strictEqual(changed.finish(5).invariant, false);
  assert.deepStrictEqual(changed.finish(5).violations, [{
    phase: 'loading', expectedHwnd: 4242, observedHwnd: 4243, timestamp: 3,
  }]);

  const zero = new VoiceFocusGuard({ expectedHwnd: 4242, sessionId: 'zero', startedAt: 1 });
  assert.strictEqual(zero.observe('wake', 0, 2), false);
  assert.strictEqual(zero.finish(3).violationCount, 1);
}());

(function deduplicatesAndBoundsContentFreePhaseSamples() {
  const guard = new VoiceFocusGuard({ expectedHwnd: 4242, sessionId: 'bounded', startedAt: 1 });
  for (let index = 0; index < 100; index += 1) {
    assert.strictEqual(guard.observe('partial', 4242, index + 2), true);
  }

  const evidence = guard.finish(200);
  assert.deepStrictEqual(evidence.phases, [{ phase: 'partial', hwnd: 4242, timestamp: 2 }]);
  assert.ok(evidence.phases.length <= VoiceFocusGuard.MAX_PHASE_SAMPLES);
  assert.deepStrictEqual(Object.keys(evidence.phases[0]), ['phase', 'hwnd', 'timestamp']);
  assert.strictEqual('title' in evidence.phases[0], false);
  assert.strictEqual('content' in evidence.phases[0], false);
}());

(function rejectsObservationAfterFinishAndInvalidInputs() {
  expectThrows(() => new VoiceFocusGuard({ expectedHwnd: 0 }), 'zero expected hwnd is rejected');
  expectThrows(() => new VoiceFocusGuard({ expectedHwnd: 1.5 }), 'non-integer expected hwnd is rejected');

  const guard = new VoiceFocusGuard({ expectedHwnd: 4242, sessionId: 'closed', startedAt: 1 });
  expectThrows(() => guard.observe('', 4242, 2), 'empty phase is rejected');
  expectThrows(() => guard.observe('wake', 4242, -1), 'negative timestamp is rejected');
  guard.finish(3);
  expectThrows(() => guard.observe('result', 4242, 4), 'observation after finish is rejected');
}());

console.log('voice_focus_guard_test: PASS');
