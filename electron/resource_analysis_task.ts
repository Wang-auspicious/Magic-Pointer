import type {createConversationStore} from './conversation_store';

export interface ResourceAnalysisTask {
  id: string;
  state: 'running' | 'waiting' | 'succeeded' | 'failed';
  ok?: boolean;
  answer?: string;
  error?: string;
  usedBackend?: string;
  timingMs?: number;
}

export function resourceAnalysisTask(
  store: Pick<ReturnType<typeof createConversationStore>, 'list' | 'get'>,
  taskId: string,
  requestId: string,
): ResourceAnalysisTask | null {
  if (!requestId) {
    return null;
  }
  const ids = taskId ? [taskId] : store.list().map(item => item.id);
  for (const id of ids) {
    const conversation = store.get(id);
    const turn = conversation?.turns?.find(turn => {
      const input = turn.request?.taskInput;
      return (
        input &&
        typeof input === 'object' &&
        (input as Record<string, unknown>).inputId ===
          `input:studio:${requestId}`
      );
    });
    if (!conversation || !turn) {
      continue;
    }
    const latest = turn === conversation.turns?.at(-1);
    const unfinished = latest && conversation.hasPendingWork;
    const state =
      turn.outcome === '已完成' && !turn.failed && !unfinished
        ? 'succeeded'
        : turn.pendingInput ||
            turn.outcome === '等待输入' ||
            turn.outcome === '待核对' ||
            (turn.outcome === '已完成' && unfinished)
          ? 'waiting'
          : turn.outcome === '进行中' || (latest && conversation.resumePending)
            ? 'running'
            : 'failed';
    return {
      id,
      state,
      ok: state === 'succeeded',
      answer: turn.answer,
      error: turn.error || (state === 'failed' ? turn.outcome : ''),
      usedBackend: turn.usedBackend,
      timingMs: turn.timingMs,
    };
  }
  return null;
}
