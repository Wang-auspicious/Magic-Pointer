import type {
  BoundThreadSession,
  ProjectBoardColumn,
  ProjectNotificationKind,
  ProjectNotificationLevel,
  ProjectSidebarBadge,
  ProjectThreadBucket,
  ProjectThreadRecord,
  ProjectThreadStatus,
  ProjectWaitingCountMode,
} from './project_multiagent_types';

export type SessionMachineState =
  | 'failed'
  | 'archived'
  | 'working'
  | 'start_failed'
  | 'paused'
  | 'active';

export interface ThreadStatusInfo {
  status: ProjectThreadStatus;
  bucket: ProjectThreadBucket;
  boardColumn: ProjectBoardColumn;
  icon: string;
  tone: string;
  label: string;
}

export interface ThreadLifecycleConfig {
  quietAfterDays?: number;
  autoResolveDays?: number;
}

export interface ThreadLifecycleAction {
  threadId: string;
  title: string;
  action: 'quiet' | 'resolve';
  idleDays: number;
}

export interface ThreadLifecycleEvaluation {
  valid: boolean;
  error?: string;
  quietAfterDays: number;
  autoResolveDays: number;
  actions: ThreadLifecycleAction[];
  preview: ThreadLifecycleAction[];
}

export interface NotificationClassificationInput {
  author?: 'user' | 'human' | 'coordinator' | 'worker' | 'system';
  isCoordinator?: boolean;
  isError?: boolean;
  isDigest?: boolean;
  viewerMentioned?: boolean;
  needsInput?: boolean;
  derivedStatus?: ProjectThreadStatus;
}

export const DEFAULT_QUIET_AFTER_DAYS = 3;
export const DEFAULT_AUTO_RESOLVE_DAYS = 7;
export const THREAD_LIFECYCLE_PREVIEW_LIMIT = 6;
const DAY_MS = 86_400_000;

const STATUS_META: Record<
  ProjectThreadStatus,
  Omit<ThreadStatusInfo, 'status'>
> = {
  needs_input: {
    bucket: 'needs',
    boardColumn: 'blocked',
    icon: 'Warning',
    tone: 'text-warning',
    label: 'Needs input',
  },
  failed: {
    bucket: 'needs',
    boardColumn: 'blocked',
    icon: 'Warning',
    tone: 'text-warning',
    label: 'Failed',
  },
  paused: {
    bucket: 'active',
    boardColumn: 'working',
    icon: 'DotsCircle',
    tone: 'text-muted-as-secondary',
    label: 'Paused',
  },
  running: {
    bucket: 'running',
    boardColumn: 'working',
    icon: 'Spinner',
    tone: 'text-secondary',
    label: 'Working',
  },
  in_progress: {
    bucket: 'running',
    boardColumn: 'working',
    icon: 'DotsCircle',
    tone: 'text-secondary',
    label: 'Working',
  },
  review: {
    bucket: 'review',
    boardColumn: 'review',
    icon: 'Eye',
    tone: 'text-accent',
    label: 'Ready for review',
  },
  landing: {
    bucket: 'landing',
    boardColumn: 'review',
    icon: 'GitMergeQueue',
    tone: 'text-git-modified',
    label: 'Ready to land',
  },
  remind_later: {
    bucket: 'later',
    boardColumn: 'working',
    icon: 'Clock',
    tone: 'text-muted-as-secondary',
    label: 'Remind later',
  },
  waiting_others: {
    bucket: 'others',
    boardColumn: 'blocked',
    icon: 'Clock',
    tone: 'text-muted-as-secondary',
    label: 'Waiting on others',
  },
  todo: {
    bucket: 'active',
    boardColumn: 'working',
    icon: 'DotsCircle',
    tone: 'muted',
    label: 'Open',
  },
  idle: {
    bucket: 'active',
    boardColumn: 'working',
    icon: 'DotsCircle',
    tone: 'muted',
    label: 'Idle',
  },
  done: {
    bucket: 'active',
    boardColumn: 'done',
    icon: 'DotsCircle',
    tone: 'muted',
    label: 'Completed',
  },
  archived: {
    bucket: 'resolved',
    boardColumn: 'done',
    icon: 'CheckCircle',
    tone: 'text-success',
    label: 'Archived',
  },
  resolved: {
    bucket: 'resolved',
    boardColumn: 'done',
    icon: 'CheckCircle',
    tone: 'text-success',
    label: 'Resolved',
  },
};

export function selectPrimaryBoundSession(
  sessions: readonly BoundThreadSession[] = [],
): BoundThreadSession | undefined {
  return (
    sessions.find(session => session.status === 'active') ??
    sessions.find(session => session.status !== 'failed') ??
    sessions[0]
  );
}

export function deriveSessionMachine(
  session: BoundThreadSession | undefined,
): SessionMachineState {
  if (!session) {
    return 'active';
  }
  if (session.status === 'failed') {
    return 'failed';
  }
  if (session.status === 'archived' && !session.reopenedOver) {
    return 'archived';
  }
  if (session.working || session.boardStatus === 'working') {
    return 'working';
  }
  if (session.startFailureCode) {
    return 'start_failed';
  }
  if (session.status === 'paused') {
    return 'paused';
  }
  return 'active';
}

function evaluateBaseStatus(thread: ProjectThreadRecord): ProjectThreadStatus {
  if (thread.resolved || Boolean(thread.resolvedAt)) {
    return 'resolved';
  }
  if (thread.taskStatus === 'blocked') {
    return 'needs_input';
  }
  const sessions = thread.boundSessions ?? [];
  const primary = selectPrimaryBoundSession(sessions);
  const machine = deriveSessionMachine(primary);

  if (machine === 'failed') {
    return 'failed';
  }
  if (machine === 'start_failed') {
    return 'needs_input';
  }
  if (machine === 'working' || thread.threadStatus === 'working') {
    return 'running';
  }
  if (primary?.boardStatus === 'blocked') {
    return 'needs_input';
  }
  if (machine === 'archived' || thread.threadStatus === 'archived') {
    return 'archived';
  }
  if (
    thread.threadStatus === 'needs_input' ||
    thread.waitsOnLivePrompt ||
    (thread.openDecisionCount ?? 0) > 0 ||
    Boolean(thread.openDecisionId) ||
    Boolean(primary?.failingPr)
  ) {
    return 'needs_input';
  }
  if (thread.taskStatus === 'done' || thread.taskStatus === 'cancelled') {
    return 'done';
  }
  if (thread.taskStatus === 'in_progress') {
    return 'in_progress';
  }
  if (thread.taskStatus === 'open') {
    return 'todo';
  }
  if (sessions.some(session => session.boardStatus === 'review')) {
    return 'review';
  }
  if (sessions.some(session => Boolean(session.landingPr))) {
    return 'landing';
  }
  if (machine === 'paused') {
    return 'paused';
  }
  if (thread.threadStatus === 'failed') {
    return 'failed';
  }
  return 'idle';
}

export function deriveThreadStatus(
  thread: ProjectThreadRecord,
  now = Date.now(),
): ThreadStatusInfo {
  let status = evaluateBaseStatus(thread);

  if (
    status !== 'resolved' &&
    status !== 'archived' &&
    typeof thread.remindAt === 'number' &&
    thread.remindAt > now
  ) {
    status = 'remind_later';
  } else if (status === 'needs_input' && thread.waitsOnOthers) {
    status = 'waiting_others';
  }

  return {
    status,
    ...STATUS_META[status],
  };
}

function attentionRank(
  thread: ProjectThreadRecord,
  info: ThreadStatusInfo,
): number {
  if (info.status === 'resolved' || info.status === 'archived') {
    return 6;
  }
  if (thread.hasUnread && !thread.quieted) {
    return info.bucket === 'needs' ? 0 : 1;
  }
  if (info.bucket === 'needs') {
    return 2;
  }
  if (info.bucket === 'review' || info.bucket === 'landing') {
    return 3;
  }
  if (info.bucket === 'running') {
    return 4;
  }
  return 5;
}

export function sortThreadsByAttention(
  threads: readonly ProjectThreadRecord[],
  now = Date.now(),
): ProjectThreadRecord[] {
  return [...threads].sort((left, right) => {
    const leftInfo = deriveThreadStatus(left, now);
    const rightInfo = deriveThreadStatus(right, now);
    const rankDiff =
      attentionRank(left, leftInfo) - attentionRank(right, rightInfo);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    const leftTime = left.lastReplyAt || left.createdAt;
    const rightTime = right.lastReplyAt || right.createdAt;
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    return left.id.localeCompare(right.id);
  });
}

export function validateThreadLifecycleConfig(
  quietAfterDays = DEFAULT_QUIET_AFTER_DAYS,
  autoResolveDays = DEFAULT_AUTO_RESOLVE_DAYS,
): {valid: boolean; error?: string} {
  if (!Number.isInteger(quietAfterDays) || quietAfterDays < 1) {
    return {
      valid: false,
      error: 'quietAfterDays must be an integer >= 1.',
    };
  }
  if (!Number.isInteger(autoResolveDays) || autoResolveDays < 0) {
    return {
      valid: false,
      error: 'autoResolveDays must be an integer >= 0.',
    };
  }
  if (autoResolveDays !== 0 && autoResolveDays <= quietAfterDays) {
    return {
      valid: false,
      error: 'autoResolveDays must be 0 or greater than quietAfterDays.',
    };
  }
  return {valid: true};
}

export function evaluateThreadLifecycle(
  threads: readonly ProjectThreadRecord[],
  now = Date.now(),
  config: ThreadLifecycleConfig = {},
): ThreadLifecycleEvaluation {
  const quietAfterDays = config.quietAfterDays ?? DEFAULT_QUIET_AFTER_DAYS;
  const autoResolveDays = config.autoResolveDays ?? DEFAULT_AUTO_RESOLVE_DAYS;
  const validation = validateThreadLifecycleConfig(
    quietAfterDays,
    autoResolveDays,
  );
  if (!validation.valid) {
    return {
      valid: false,
      error: validation.error,
      quietAfterDays,
      autoResolveDays,
      actions: [],
      preview: [],
    };
  }

  const actions: ThreadLifecycleAction[] = [];
  for (const thread of threads) {
    const info = deriveThreadStatus(thread, now);
    if (
      info.status === 'resolved' ||
      info.status === 'archived' ||
      info.status === 'paused'
    ) {
      continue;
    }
    const lastActivity = Math.max(thread.lastReplyAt || 0, thread.createdAt || 0);
    const idleDays = Math.floor(Math.max(0, now - lastActivity) / DAY_MS);

    if (autoResolveDays !== 0 && idleDays >= autoResolveDays) {
      actions.push({
        threadId: thread.id,
        title: thread.title,
        action: 'resolve',
        idleDays,
      });
      continue;
    }

    const isQuietCandidate =
      !thread.quieted &&
      !thread.hasUnread &&
      info.status !== 'running' &&
      info.status !== 'in_progress' &&
      idleDays >= quietAfterDays;
    if (isQuietCandidate) {
      actions.push({
        threadId: thread.id,
        title: thread.title,
        action: 'quiet',
        idleDays,
      });
    }
  }

  return {
    valid: true,
    quietAfterDays,
    autoResolveDays,
    actions,
    preview: actions.slice(0, THREAD_LIFECYCLE_PREVIEW_LIMIT),
  };
}

export function classifyNotification(
  input: NotificationClassificationInput,
  level: ProjectNotificationLevel = 'coordinator',
): {kind: ProjectNotificationKind; shouldNotify: boolean} {
  let kind: ProjectNotificationKind;
  if (input.isDigest) {
    kind = 'digest';
  } else if (input.viewerMentioned) {
    kind = 'mentions';
  } else if (
    input.needsInput ||
    input.derivedStatus === 'needs_input' ||
    input.derivedStatus === 'failed'
  ) {
    kind = 'needs_input';
  } else if (
    input.isCoordinator ||
    input.author === 'coordinator' ||
    input.isError
  ) {
    kind = 'coordinator_posts';
  } else if (input.author === 'worker') {
    kind = 'thread_replies';
  } else {
    kind = 'member_messages';
  }

  let shouldNotify = false;
  if (level === 'all') {
    shouldNotify = true;
  } else if (level === 'coordinator') {
    shouldNotify =
      kind === 'mentions' ||
      kind === 'needs_input' ||
      kind === 'coordinator_posts' ||
      kind === 'digest';
  } else if (level === 'mentions') {
    shouldNotify = kind === 'mentions' || kind === 'needs_input';
  }

  return {kind, shouldNotify};
}

export function computeProjectSidebarBadge(
  threads: readonly ProjectThreadRecord[],
  options: {
    coordinatorWorking?: boolean;
    waitingCount?: ProjectWaitingCountMode;
    now?: number;
  } = {},
): ProjectSidebarBadge {
  const now = options.now ?? Date.now();
  const waitingCount = options.waitingCount ?? 'read';
  let blockedCount = 0;
  let unreadCount = 0;
  let working = Boolean(options.coordinatorWorking);

  for (const thread of threads) {
    const info = deriveThreadStatus(thread, now);
    if (info.status === 'resolved' || info.status === 'archived') {
      continue;
    }
    if (info.status === 'needs_input' || info.status === 'failed') {
      const isUnreadWaiting =
        thread.hasUnread ||
        !thread.readAt ||
        thread.readAt < (thread.lastReplyAt || thread.createdAt);
      if (waitingCount === 'answered' || isUnreadWaiting) {
        blockedCount += 1;
      }
    }
    if (info.status === 'running' || info.status === 'in_progress') {
      working = true;
    }
    if (thread.hasUnread && !thread.quieted) {
      unreadCount += 1;
    }
  }

  if (blockedCount > 0) {
    return {kind: 'count', count: blockedCount, blocked: true};
  }
  if (working) {
    return {kind: 'working'};
  }
  if (unreadCount > 0) {
    return {kind: 'dot', count: unreadCount};
  }
  return {kind: 'none'};
}
