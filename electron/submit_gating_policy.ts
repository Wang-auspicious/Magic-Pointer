'use strict';


const MAX_GROUNDING_WAIT_MS = 20000;

const UNKNOWN_CAPTURE_WAIT_MS = 1500;

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
      return {
        decision: DECISION_FAIL,
        message: '读取这个选区花的时间超出了预期，已经停下。请再选一次，或换一个小一点的范围。',
        reason: 'capture_exceeded_bridge_budget',
      };
    }
    return {
      decision: DECISION_WAIT,
      reason: 'capture_in_flight',
      notice: elapsed >= PROGRESS_NOTICE_AFTER_MS ? '正在读取选中的内容，马上就好…' : '',
    };
  }
  if (elapsed < UNKNOWN_CAPTURE_WAIT_MS) {
    return { decision: DECISION_WAIT, reason: 'awaiting_capture_start', notice: '' };
  }
  return {
    decision: DECISION_FAIL,
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
