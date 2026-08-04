'use strict';

// The 2026-08-04 regression, pinned.
//
// A first-run perception read took 12.9s and finished successfully at 13.6s.
// The fixed 6s deadline fired at 6.0s, so the user was told "目标识别没能完成，
// 请重新选择一次" 0.8s before their own selection became available. The work
// succeeded; the app said it failed; the advice was wrong.

const assert = require('assert');
const {
  DECISION_FAIL,
  DECISION_SUBMIT,
  DECISION_WAIT,
  MAX_GROUNDING_WAIT_MS,
  UNKNOWN_CAPTURE_WAIT_MS,
  decideSubmitGate,
} = require('../electron/submit_gating_policy');

// A slow read that is still running must never be reported as a failure.
{
  for (const elapsedMs of [0, 3000, 6001, 9000, 12873, MAX_GROUNDING_WAIT_MS - 1]) {
    const result = decideSubmitGate({ hasSnapshot: false, captureInFlight: true, elapsedMs });
    assert.strictEqual(
      result.decision,
      DECISION_WAIT,
      `a capture still in flight at ${elapsedMs}ms was reported as ${result.decision}`,
    );
  }
}

// The exact timeline from the log: it would have succeeded at 13.6s.
{
  const atOldDeadline = decideSubmitGate({ hasSnapshot: false, captureInFlight: true, elapsedMs: 6000 });
  assert.strictEqual(atOldDeadline.decision, DECISION_WAIT);
  const whenReady = decideSubmitGate({ hasSnapshot: true, captureInFlight: false, elapsedMs: 13633 });
  assert.strictEqual(whenReady.decision, DECISION_SUBMIT);
}

// A grounded session submits immediately, whatever the elapsed time.
{
  assert.strictEqual(decideSubmitGate({ hasSnapshot: true, captureInFlight: true, elapsedMs: 0 }).decision, DECISION_SUBMIT);
  assert.strictEqual(decideSubmitGate({ hasSnapshot: true, captureInFlight: false, elapsedMs: 99999 }).decision, DECISION_SUBMIT);
}

// A bridge that outlived its own timeout is not going to answer; stopping there
// is honest, and the message must not blame the user's selection.
{
  const result = decideSubmitGate({ hasSnapshot: false, captureInFlight: true, elapsedMs: MAX_GROUNDING_WAIT_MS });
  assert.strictEqual(result.decision, DECISION_FAIL);
  assert.strictEqual(result.reason, 'capture_exceeded_bridge_budget');
  assert(!result.message.includes('目标识别'), 'kept the message that told the user to blame their selection');
  assert(result.message.includes('请再选一次'));
}

// No capture running and no snapshot: brief grace, then an honest stop.
{
  assert.strictEqual(
    decideSubmitGate({ hasSnapshot: false, captureInFlight: false, elapsedMs: 200 }).decision,
    DECISION_WAIT,
  );
  const gaveUp = decideSubmitGate({ hasSnapshot: false, captureInFlight: false, elapsedMs: UNKNOWN_CAPTURE_WAIT_MS });
  assert.strictEqual(gaveUp.decision, DECISION_FAIL);
  assert.strictEqual(gaveUp.reason, 'no_capture_running');
}

// A dead session fails at once rather than waiting out any budget.
{
  const result = decideSubmitGate({ hasSnapshot: false, captureInFlight: true, elapsedMs: 0, sessionAlive: false });
  assert.strictEqual(result.decision, DECISION_FAIL);
  assert.strictEqual(result.reason, 'session_missing');
}

// The user is told something is happening, but only after a beat — a fast read
// must not flash a notice.
{
  assert.strictEqual(decideSubmitGate({ hasSnapshot: false, captureInFlight: true, elapsedMs: 300 }).notice, '');
  assert(decideSubmitGate({ hasSnapshot: false, captureInFlight: true, elapsedMs: 4000 }).notice.length > 0);
}

// Malformed input must not silently become "submit".
{
  assert.strictEqual(decideSubmitGate({}).decision, DECISION_WAIT);
  assert.strictEqual(decideSubmitGate({ hasSnapshot: false, captureInFlight: true, elapsedMs: -5 }).decision, DECISION_WAIT);
  assert.strictEqual(decideSubmitGate(null).decision, DECISION_WAIT);
}

console.log('submit_gating_policy_test: all assertions passed');
