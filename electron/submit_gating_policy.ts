'use strict';

// When may a typed command be submitted?
//
// The capsule opens before perception finishes, so a fast typist can press
// Enter while the snapshot is still being read. The old rule was a fixed 6s
// deadline: wait up to six seconds for grounding, then tell the user
// "目标识别没能完成，请重新选择一次。"
//
// On 2026-08-04 a first-run read took 12.9s and finished successfully at 13.6s.
// The user got the failure message 0.8s before their own selection was ready,
// was told to select again, and the retry worked — which is the worst possible
// shape: the work succeeded, the app said it failed, and the advice was wrong.
//
// A deadline is the wrong instrument. What matters is whether the perception
// bridge is still working: while it is, waiting is correct and the honest thing
// to show is progress. The ceiling exists only to catch a bridge that died
// without reporting, so it is tied to the bridge's own timeout rather than to
// how long a person is assumed to tolerate.

// Matches the snapshot bridge's own budget (see BRIDGE_TIMEOUTS in main.js).
// If the bridge is alive at this point it will be killed by its own timeout, so
// waiting past it can only produce a hang.
const MAX_GROUNDING_WAIT_MS = 20000;

// How long to wait when we cannot tell whether a capture is running. Short,
// because "no capture in flight and no snapshot" usually means the session is
// genuinely gone rather than slow.
const UNKNOWN_CAPTURE_WAIT_MS = 1500;

// Past this, say something. A silent spinner and a slow read look identical.
const PROGRESS_NOTICE_AFTER_MS = 1200;

const DECISION_SUBMIT = 'submit';
const DECISION_WAIT = 'wait';
const DECISION_FAIL = 'fail';

type SubmitGateInput = {
  hasSnapshot?: boolean;
  captureInFlight?: boolean;
  elapsedMs?: number;
  sessionAlive?: boolean;
};

type SubmitGateDecision = {
  decision: typeof DECISION_SUBMIT | typeof DECISION_WAIT | typeof DECISION_FAIL;
  reason: string;
  message?: string;
  notice?: string;
};

function decideSubmitGate(input?: SubmitGateInput): SubmitGateDecision {
  const hasSnapshot = input?.hasSnapshot === true;
  const captureInFlight = input?.captureInFlight === true;
  const elapsedMs = Number(input?.elapsedMs);
  const sessionAlive = input?.sessionAlive !== false;
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : 0;

  if (!sessionAlive) {
    return {
      decision: DECISION_FAIL,
      message: '当前 THIS 已过期，请重新激活 Magic Pointer。',
      reason: 'session_missing',
    };
  }
  if (hasSnapshot) {
    return { decision: DECISION_SUBMIT, reason: 'grounded' };
  }
  if (captureInFlight) {
    if (elapsed >= MAX_GROUNDING_WAIT_MS) {
      // The bridge outlived its own timeout, so it is not going to answer.
      return {
        decision: DECISION_FAIL,
        message: '读取这个选区花的时间超出了预期，已经停下。请再选一次，或换一个小一点的范围。',
        reason: 'capture_exceeded_bridge_budget',
      };
    }
    return {
      decision: DECISION_WAIT,
      reason: 'capture_in_flight',
      // Only after a beat: a fast read should not flash a notice.
      notice: elapsed >= PROGRESS_NOTICE_AFTER_MS ? '正在读取选中的内容，马上就好…' : '',
    };
  }
  if (elapsed < UNKNOWN_CAPTURE_WAIT_MS) {
    return { decision: DECISION_WAIT, reason: 'awaiting_capture_start', notice: '' };
  }
  return {
    decision: DECISION_FAIL,
    // Says what happened and what to do, and does not claim the selection was
    // wrong — it usually was not.
    message: '这次没能读到选中的内容，请再选一次。',
    reason: 'no_capture_running',
  };
}

module.exports = {
  DECISION_FAIL,
  DECISION_SUBMIT,
  DECISION_WAIT,
  MAX_GROUNDING_WAIT_MS,
  PROGRESS_NOTICE_AFTER_MS,
  UNKNOWN_CAPTURE_WAIT_MS,
  decideSubmitGate,
};
