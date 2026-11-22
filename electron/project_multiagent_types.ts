export type ProjectThreadStatus =
  | 'resolved'
  | 'needs_input'
  | 'failed'
  | 'running'
  | 'in_progress'
  | 'archived'
  | 'done'
  | 'todo'
  | 'review'
  | 'landing'
  | 'paused'
  | 'idle'
  | 'remind_later'
  | 'waiting_others';

export type ProjectThreadBucket =
  | 'needs'
  | 'running'
  | 'review'
  | 'landing'
  | 'later'
  | 'others'
  | 'active'
  | 'resolved';

export type ProjectBoardColumn = 'blocked' | 'review' | 'working' | 'done';

export type ProjectNotificationLevel =
  | 'all'
  | 'coordinator'
  | 'mentions'
  | 'none';

export type ProjectNotificationKind =
  | 'mentions'
  | 'needs_input'
  | 'coordinator_posts'
  | 'thread_replies'
  | 'member_messages'
  | 'digest';

export type ProjectWaitingCountMode = 'read' | 'answered';

export type ProjectEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ProjectAgentTeamPreset =
  | 'solo'
  | 'pair'
  | 'squad'
  | 'research'
  | 'custom';

export interface ProjectSidebarBadge {
  kind: 'count' | 'working' | 'dot' | 'none';
  count?: number;
  blocked?: boolean;
}

export interface ProjectMultiAgentConfig {
  agentTeam?: ProjectAgentTeamPreset;
  coordinatorModel?: string;
  coordinatorEffort?: ProjectEffortLevel;
  workerModel?: string;
  workerEffort?: ProjectEffortLevel;
  autoModeRules?: string[];
  limitAutoContinue?: boolean;
  quietAfterDays?: number;
  autoResolveDays?: number;
  notifyLevel?: ProjectNotificationLevel;
  waitingCount?: ProjectWaitingCountMode;
}

export interface BoundThreadSession {
  id: string;
  status: 'active' | 'archived' | 'paused' | 'failed';
  title?: string;
  reopenedOver?: boolean;
  boardStatus?: 'blocked' | 'review' | 'working' | 'done' | 'idle';
  working?: boolean;
  startFailureCode?: string;
  landingPr?: boolean;
  failingPr?: boolean;
  deviceRoute?: string;
  deviceState?: string;
  worktreePath?: string;
  branch?: string;
}

export interface ProjectThreadMessage {
  id: string;
  threadId: string;
  author: 'user' | 'coordinator' | 'worker' | 'system';
  sessionId?: string;
  text: string;
  timestamp: number;
  viewerMentioned?: boolean;
}

export interface ProjectThreadRecord {
  id: string;
  projectId: string;
  title: string;
  displayName?: string;
  body?: string;
  parentThreadId?: string;
  boundSessionIds: string[];
  boundSessions: BoundThreadSession[];
  authorSessionId?: string;
  createdAt: number;
  lastReplyAt: number;
  replyCount: number;
  hasUnread: boolean;
  readAt?: number;
  viewerMentioned?: boolean;
  threadStatus?:
    | 'resolved'
    | 'failed'
    | 'working'
    | 'needs_input'
    | 'archived'
    | 'idle';
  taskStatus?: 'blocked' | 'open' | 'in_progress' | 'done' | 'cancelled';
  waitsOnLivePrompt?: boolean;
  waitsOnOthers?: boolean;
  resolved?: boolean;
  resolvedAt?: number;
  remindAt?: number;
  quieted?: boolean;
  openDecisionId?: string;
  openDecisionCount?: number;
  openPrUrl?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  attachedOutputs?: string[];
  lastPromptText?: string;
  messages?: ProjectThreadMessage[];
}

export interface ProjectDecisionOption {
  label: string;
  consequence: string;
}

export interface ProjectDecisionCard {
  id: string;
  projectId: string;
  threadId?: string;
  question: string;
  context?: string;
  options: ProjectDecisionOption[];
  recommended?: number;
  reason?: string;
  taskId?: string;
  status: 'open' | 'answered' | 'withdrawn';
  chosenIndex?: number;
  chosenBy?: string;
  createdAt: number;
  resolvedAt?: number;
}

export type ProjectTimelineEventType =
  | 'goal'
  | 'coordinator_post'
  | 'thread_started'
  | 'message_routed'
  | 'activity'
  | 'decision_card'
  | 'artifact_published'
  | 'thread_status_change';

export interface ProjectTimelineEntry {
  seq: number;
  id: string;
  type: ProjectTimelineEventType;
  timestamp: number;
  threadId?: string;
  sessionId?: string;
  author?: 'user' | 'coordinator' | 'worker' | 'system';
  text?: string;
  payload?: Record<string, unknown>;
  hiddenFromChat?: boolean;
}

export interface ProjectPublishedArtifact {
  id: string;
  projectId: string;
  threadId?: string;
  kind: 'artifact' | 'file' | 'link';
  title: string;
  summary?: string;
  pathOrUrl: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectRecapLink {
  label: string;
  threadId?: string;
  surface?: 'thread_recap';
}

export interface ProjectRecapData {
  text: string;
  updatedAt: number;
  dismissed?: boolean;
  links?: ProjectRecapLink[];
}

export interface ProjectOverviewSectionState {
  version: number;
  hiddenIds: string[];
  order: string[];
}

export interface ProjectRosterWorker {
  step: number;
  names: string[];
  threadId?: string;
  status?: ProjectThreadStatus;
}

export interface UncommittedFileChange {
  path: string;
  status: string;
  staged: boolean;
  folder: string;
}

export interface UncommittedFolderReport {
  folder: string;
  worktreePath: string;
  primary: boolean;
  unreadable: boolean;
  changes: Array<{path: string; status: string; staged: boolean}>;
}

export interface UncommittedChangesReport {
  status: 'clean' | 'dirty' | 'unknown';
  changes: UncommittedFileChange[];
  folders: UncommittedFolderReport[];
  committedOn: string[];
}
