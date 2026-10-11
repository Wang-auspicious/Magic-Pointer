type ActivityState =
  | 'idle'
  | 'running'
  | 'awaiting'
  | 'interrupted'
  | 'failed'
  | 'pending'
  | 'completed';

declare global {
  interface ConversationActivityInput {
    hasPendingWork?: boolean;
    lastOutcome?: string;
    lastFailed?: boolean;
    lastPendingInputKind?: string;
    failed?: boolean;
    turns?: ReadonlyArray<{
      outcome?: string;
      failed?: boolean;
      pendingInput?: object | null;
    }>;
  }

  interface ConversationStateApi {
    derive(
      input: ConversationActivityInput,
      locallyRunning?: boolean,
    ): ActivityState;
    label(state: ActivityState): string;
  }

  var ConversationState: ConversationStateApi;
}

(() => {
  const labels: Record<ActivityState, string> = {
    idle: 'Not started',
    running: 'Running',
    awaiting: 'Needs input',
    interrupted: 'Interrupted',
    failed: 'Failed',
    pending: 'Ready to continue',
    completed: 'Completed',
  };

  function derive(
    input: ConversationActivityInput,
    locallyRunning = false,
  ): ActivityState {
    if (locallyRunning) {
      return 'running';
    }
    const turn = input.turns?.at(-1);
    const outcome = (input.lastOutcome || turn?.outcome || '')
      .trim()
      .toLowerCase();
    if (input.lastPendingInputKind || turn?.pendingInput) {
      return 'awaiting';
    }
    // Startup recovery marks interrupted turns failed as well. Their recoverable
    // outcome is more specific than that failure bit.
    if (
      ['可恢复', '已中断', 'interrupted', 'stopped', 'cancelled'].includes(
        outcome,
      )
    ) {
      return 'interrupted';
    }
    if (
      input.lastFailed ||
      input.failed ||
      turn?.failed ||
      outcome === '失败'
    ) {
      return 'failed';
    }
    if (
      input.hasPendingWork &&
      ['进行中', 'running', 'in_progress'].includes(outcome)
    ) {
      return 'running';
    }
    if (input.hasPendingWork) {
      return 'pending';
    }
    return outcome ? 'completed' : 'idle';
  }

  const api: ConversationStateApi = {derive, label: state => labels[state]};

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalThis.ConversationState = api;
})();
