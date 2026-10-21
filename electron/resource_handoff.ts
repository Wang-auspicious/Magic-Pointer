import type {
  HandoffReceipt,
  ProjectInboxEntry,
  ResourceHandoff,
} from './resource_collection_contract';

interface HandoffTurn {
  request?: Record<string, unknown>;
  handoffsAcceptedAt?: number;
}

export function handoffReceipts(
  conversations: ReadonlyArray<{
    id: string;
    turns?: ReadonlyArray<HandoffTurn & {id: string}>;
  }>,
  projectId: string,
): HandoffReceipt[] {
  return conversations.flatMap(conversation =>
    (conversation.turns || []).flatMap(turn =>
      turn.handoffsAcceptedAt
        ? savedHandoffs(turn)
            .filter(item => item.projectId === projectId)
            .map(item => ({
              resourceId: item.id,
              version: item.version,
              conversationId: conversation.id,
              turnId: turn.id,
              acceptedAt: turn.handoffsAcceptedAt!,
            }))
        : [],
    ),
  );
}

export function savedHandoffs(
  turn: HandoffTurn | undefined,
): ResourceHandoff[] {
  return Array.isArray(turn?.request?.projectHandoffs)
    ? (turn.request.projectHandoffs as ResourceHandoff[])
    : [];
}

export function handoffsForTurn(
  inbox: readonly ProjectInboxEntry[],
  turns: readonly HandoffTurn[] = [],
  continuation = false,
  now = Date.now(),
): ResourceHandoff[] {
  if (continuation) {
    return structuredClone(savedHandoffs(turns.at(-1)));
  }
  const accepted = new Set(
    turns
      .filter(turn => turn.handoffsAcceptedAt)
      .flatMap(turn =>
        savedHandoffs(turn).map(item => `${item.id}:${item.version}`),
      ),
  );
  return inbox
    .filter(
      item =>
        item.available &&
        item.state !== 'handled' &&
        (item.state !== 'snoozed' || item.snoozedUntil <= now) &&
        !accepted.has(`${item.id}:${item.version}`),
    )
    .slice(0, 8)
    .map(item => ({
      id: item.id,
      version: item.version,
      projectId: item.projectId,
      title: item.title,
      summary: item.summary.slice(0, 1200),
      coverage: item.coverage,
      path: item.path,
      intent: item.intent,
      sourceUrl: item.sourceUrl,
      createdAt: item.createdAt,
    }));
}
