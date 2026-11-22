'use strict';

declare global {
  interface ProjectOverviewThreadSession {
    id: string;
    status: 'active' | 'archived' | 'paused' | 'failed';
    title?: string;
    reopenedOver?: boolean;
    boardStatus?: 'blocked' | 'review' | 'working' | 'done' | 'idle';
    working?: boolean;
    startFailureCode?: string;
    landingPr?: boolean;
    failingPr?: boolean;
    branch?: string;
  }

  interface ProjectOverviewThreadMessage {
    id: string;
    author: 'user' | 'coordinator' | 'worker' | 'system';
    text: string;
    timestamp: number;
    routeFromOverview?: boolean;
    viewerMentioned?: boolean;
    sessionId?: string;
  }

  interface ProjectOverviewThread {
    id: string;
    projectId: string;
    title: string;
    displayName?: string;
    body?: string;
    boundSessionIds: string[];
    boundSessions: ProjectOverviewThreadSession[];
    createdAt: number;
    lastReplyAt: number;
    replyCount: number;
    hasUnread: boolean;
    readAt?: number;
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
    lastPromptText?: string;
    messages?: ProjectOverviewThreadMessage[];
  }

  interface ProjectOverviewDecision {
    id: string;
    projectId: string;
    threadId?: string;
    question: string;
    context?: string;
    options: Array<{label: string; consequence: string}>;
    recommended?: number;
    reason?: string;
    status: 'open' | 'answered' | 'withdrawn';
    chosenIndex?: number;
    createdAt: number;
  }

  interface ProjectOverviewTimelineEntry {
    seq: number;
    id: string;
    type: string;
    timestamp: number;
    threadId?: string;
    author?: string;
    text?: string;
    payload?: Record<string, unknown>;
    hiddenFromChat?: boolean;
  }

  interface ProjectOverviewActiveRun {
    running: boolean;
    startedAt?: number;
    answer?: string;
    thinking?: string;
    trajectory?: Array<Record<string, unknown>>;
    stopped?: boolean;
    error?: string;
    retryNotice?: string;
    queuedCount?: number;
  }

  interface ProjectOverviewAvailableModel {
    model: string;
    label?: string;
    provider?: string;
    profileId?: string;
    active?: boolean;
  }

  interface ProjectOverviewModelContext {
    defaultModel?: string;
    coordinatorModel?: string;
    coordinatorEffort?: string;
    workerModel?: string;
    workerEffort?: string;
    availableModels?: ProjectOverviewAvailableModel[];
  }

  interface ProjectOverviewArtifact {
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

  interface ProjectOverviewFileItem {
    path: string;
    size: number;
    updatedAt: number;
    inlineEditable?: boolean;
  }

  interface ProjectOverviewMemoryState {
    path: string;
    content: string;
    sha256: string;
    topicPaths?: string[];
  }

  interface ProjectOverviewSectionsState {
    version: number;
    hiddenIds: string[];
    order: string[];
  }

  interface ProjectOverviewWorkerPill {
    step: number;
    names: string[];
    threadId?: string;
    status?: string;
  }

  interface ProjectOverviewProject {
    id?: string;
    root: string;
    name: string;
    description?: string;
    instructions?: string;
    goal?: string;
    color?: string;
    projectIcon?: string;
    paused?: boolean;
    archived?: boolean;
    defaultEnvironmentId?: string;
    environments?: Array<{
      id: string;
      name: string;
      branch?: string;
      worktree?: boolean;
    }>;
    multiAgentConfig?: {
      agentTeam?: string;
      coordinatorModel?: string;
      coordinatorEffort?: string;
      workerModel?: string;
      workerEffort?: string;
      autoModeRules?: string[];
      limitAutoContinue?: boolean;
      quietAfterDays?: number;
      autoResolveDays?: number;
      notifyLevel?: 'all' | 'coordinator' | 'mentions' | 'none';
      waitingCount?: 'read' | 'answered';
    };
  }

  interface ProjectOverviewDiffResult {
    ok?: boolean;
    diff?: string;
    summary?: string;
    files?: string[];
    stat?: string;
    addedLines?: number;
    deletedLines?: number;
    changedFiles?: number;
    error?: string;
  }

  interface ProjectOverviewActions {
    onBack(): void;
    onSendGoal(text: string): Promise<void> | void;
    onStopRun?(threadId?: string): Promise<void> | void;
    onAnswerDecision(
      decisionId: string,
      optionIndex: number,
    ): Promise<void> | void;
    onWithdrawDecision?(decisionId: string): Promise<void> | void;
    onSelectThread(threadId: string): Promise<void> | void;
    onOpenSession?(sessionId: string): Promise<void> | void;
    onStartThread?(input: {
      title?: string;
      prompt: string;
      useWorktree: boolean;
    }): Promise<
      {ok: boolean; thread?: ProjectOverviewThread; error?: string} | void
    >;
    onMessageThread?(
      threadId: string,
      text: string,
    ): Promise<
      {ok: boolean; thread?: ProjectOverviewThread; error?: string} | void
    >;
    onResolveThread(threadId: string, resolved: boolean): Promise<void> | void;
    onRemindThread(threadId: string, remindAt: number): Promise<void> | void;
    onInspectDiff(threadId: string): Promise<ProjectOverviewDiffResult | void>;
    onMergeWorktree?(
      threadId: string,
    ): Promise<{ok: boolean; error?: string} | void>;
    onDiscardThread(threadId: string): Promise<void> | void;
    onRefresh?(): Promise<void> | void;
    onReadFile?(path: string): Promise<{content: string; sha256?: string}>;
    onSaveFile(input: {
      path: string;
      content: string;
      overwrite?: boolean;
      keepBoth?: boolean;
    }): Promise<{ok: boolean; code?: string; error?: string}>;
    onReadMemory?(path: string): Promise<ProjectOverviewMemoryState>;
    onSaveMemory(input: {
      path: string;
      content: string;
      expectedSha256: string;
    }): Promise<{
      ok: boolean;
      sha256?: string;
      currentSha256?: string;
      code?: string;
      error?: string;
    }>;
    onSaveSettings(
      patch: Record<string, unknown>,
    ): Promise<{ok: boolean; error?: string}>;
    onTogglePinArtifact(
      artifactId: string,
      pinned: boolean,
    ): Promise<void> | void;
    onDismissRecap(): Promise<void> | void;
    onUpdateSections(patch: {
      hiddenIds?: string[];
      order?: string[];
      expectedVersion: number;
    }): Promise<void> | void;
    onTogglePause?(paused: boolean): Promise<void> | void;
    onToggleArchive?(archived: boolean): Promise<void> | void;
    onDeleteProject?(): Promise<void> | void;
  }

  interface ProjectOverviewState {
    project: ProjectOverviewProject;
    threads: ProjectOverviewThread[];
    timeline: ProjectOverviewTimelineEntry[];
    decisions: ProjectOverviewDecision[];
    artifacts: ProjectOverviewArtifact[];
    userName?: string;
    modelContext?: ProjectOverviewModelContext;
    activeRuns?: Record<string, ProjectOverviewActiveRun>;
    recap?: {
      text: string;
      updatedAt: number;
      dismissed?: boolean;
      links?: Array<{label: string; threadId?: string}>;
    } | null;
    statusPageHtml?: string;
    sections?: ProjectOverviewSectionsState;
    files?: ProjectOverviewFileItem[];
    memory?: ProjectOverviewMemoryState;
    workers?: ProjectOverviewWorkerPill[];
    activeRun?: ProjectOverviewActiveRun | null;
    pacingNotice?: string;
    activeTab?: 'overview' | 'threads' | 'artifacts' | 'files' | 'settings';
    actions: ProjectOverviewActions;
  }

  type ProjectOverviewUpdateState = Omit<ProjectOverviewState, 'actions'> & {
    actions?: ProjectOverviewActions;
  };

  interface ProjectOverviewManagedHandle {
    unmount: () => void;
    update: (nextState: ProjectOverviewUpdateState) => void;
  }

  interface ProjectOverviewApi {
    mount(host: HTMLElement, state: ProjectOverviewState): () => void;
    mountManaged(
      host: HTMLElement,
      state: ProjectOverviewState,
    ): ProjectOverviewManagedHandle;
  }

  var ProjectOverview: ProjectOverviewApi;
}

(() => {
  type TabId = 'overview' | 'threads' | 'artifacts' | 'files' | 'settings';
  type RightTileTab = Exclude<TabId, 'settings'>;
  type BoardCol = 'blocked' | 'review' | 'working' | 'done';
  type ThreadGroupKey = 'waiting' | 'working' | 'idle' | 'resolved';
  type PickerKind =
    | 'coord-model'
    | 'coord-effort'
    | 'worker-model'
    | 'worker-effort';

  // Codepoints verified against electron/renderer/cds_icons.ts (Anthropicons variable font)
  const VERIFIED_CODEPOINTS: Record<string, number> = {
    Projects: 0xe0c9,
    Artifacts: 0xe017,
    Eye: 0xe069,
    Warning: 0xe109,
    MoonStars: 0xe0b2,
    GitBranch: 0xe078,
    GitMergeQueue: 0xe111,
    Check: 0xe03b,
    CheckCircle: 0xe03c,
    Clock: 0xe043,
    DotsCircle: 0xe060,
    Spinner: 0xe0e5,
    Play: 0xe0c1,
    Pause: 0xe0bb,
    Copy: 0xe056,
    Add: 0xe001,
    Search: 0xe0d3,
    Folder: 0xe072,
    File: 0xe06c,
    Memory: 0xe0a8,
    Settings: 0xe0d6,
    DotsHorizontal: 0xe061,
    CaretLeft: 0xe029,
    CaretRight: 0xe02a,
    CaretDown: 0xe027,
    CaretDownSmall: 0xf003,
    X: 0xe10f,
    Pin: 0xe0bd,
    PinSlash: 0xe0bf,
    Archive: 0xe008,
    Trash: 0xe101,
    ArrowUp: 0xe013,
    ArrowReturn: 0xe00f,
    ArrowClockwise: 0xe11d,
    SidebarRight: 0xe113,
    StopFilled: 0xe0ec,
    Expand: 0xe067,
    Collapse: 0xe04d,
    Lightbulb: 0xe097,
    ExtendedThinking: 0xe068,
    Tool: 0xe100,
    Edit: 0xe064,
    LayoutList: 0xe09c,
    LayoutGrid: 0xe084,
  };

  const PROJECT_PALETTE = [
    '#D97757',
    '#2566D0',
    '#2E7D4F',
    '#8B3A9E',
    '#AF3A03',
    '#0F766E',
    '#6B7280',
  ];

  const PROJECT_ICON_OPTIONS = [
    'Projects',
    'Artifacts',
    'GitBranch',
    'Folder',
    'Memory',
    'Eye',
  ];

  const STARTER_PROMPTS = [
    'Audit project architecture',
    'Run tests & plan improvements',
    'Summarize workspace status',
  ];

  const EFFORT_CHOICES = ['low', 'medium', 'high', 'max'];

  const STATUS_PAGE_BASE_CSS = `
    body { margin: 0; padding: 14px 16px; font-family: "anthropic-sans", system-ui, sans-serif; color: #1f1e1b; background: transparent; font-size: 13px; line-height: 1.5; }
    section { margin-bottom: 16px; }
    section > h2 { font-size: 13px; font-weight: 400; color: #52514e; margin: 0 0 8px; }
    section > h2 .count { color: #898781; }
    .recap { border: 1px solid #e4e3dd; border-radius: 10px; padding: 11px 13px; background: #faf9f6; margin-bottom: 14px; }
    .recap p { margin: 4px 0 0; font-style: italic; color: #52514e; }
    ul.threads, ul.attn, ul.routines { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
    ul.threads > li, ul.attn > li, ul.routines > li { padding: 11px 13px; border: 1px solid #e4e3dd; border-radius: 10px; background: #FFFFFF; box-shadow: 0 1px 2px rgba(11,11,11,0.04); }
    .callout { border: 1px solid #ecd7a2; background: #fcf5df; border-radius: 10px; padding: 10px 12px; }
    .prog { display: inline-flex; gap: 3px; align-items: center; }
    .prog .cells { width: 9px; height: 9px; border-radius: 2px; background: #98643f; display: inline-block; }
    ul.tick li { color: #4f8a3f; }
  `;

  function esc(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, ch => {
      switch (ch) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        case "'":
          return '&#39;';
        default:
          return ch;
      }
    });
  }

  function iconHtml(name: string, size: 'xs' | 'sm' | 'md' = 'sm'): string {
    const cds = (globalThis as Record<string, unknown>).CdsIcons as
      | {html?: (iconName: string, iconSize: string) => string}
      | undefined;
    if (cds && typeof cds.html === 'function') {
      const rendered = cds.html(name, size);
      if (rendered) {
        return rendered;
      }
    }
    const cp = VERIFIED_CODEPOINTS[name] ?? VERIFIED_CODEPOINTS.Projects;
    return `<span class="cds-icon" data-size="${size}" aria-hidden="true" data-glyph="&#x${cp.toString(16).toUpperCase()};"></span>`;
  }

  function renderMarkdownHtml(text: string): string {
    const src = String(text || '');
    if (!src.trim()) {
      return '';
    }
    const md = (globalThis as Record<string, unknown>).ChatMarkdown as
      | {
          render?: (
            input: unknown,
          ) => {outerHTML?: string; innerHTML?: string} | null;
        }
      | undefined;
    if (md && typeof md.render === 'function') {
      try {
        const node = md.render(src);
        if (node) {
          if (typeof node.outerHTML === 'string' && node.outerHTML) {
            return node.outerHTML;
          }
          if (typeof node.innerHTML === 'string' && node.innerHTML) {
            return `<div class="mp-chat-markdown">${node.innerHTML}</div>`;
          }
        }
      } catch {
        // Safe fallback when ChatMarkdown is absent or running in minimal test DOMs.
      }
    }
    const paragraphs = src
      .split(/\n{2,}/)
      .map(part => part.trim())
      .filter(Boolean);
    if (paragraphs.length === 0) {
      return '';
    }
    return `<div class="mp-chat-markdown">${paragraphs
      .map(part => `<p>${esc(part).replace(/\n/g, '<br>')}</p>`)
      .join('')}</div>`;
  }

  function formatRelativeTime(ts: number | undefined, now = Date.now()): string {
    if (!ts || !Number.isFinite(ts)) {
      return '';
    }
    const diffSec = Math.max(0, Math.floor((now - ts) / 1000));
    if (diffSec < 45) {
      return 'now';
    }
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) {
      return `${mins}m`;
    }
    const hours = Math.floor(mins / 60);
    if (hours < 24) {
      return `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }

  function formatElapsedSeconds(
    startedAt: number | undefined,
    now = Date.now(),
  ): string {
    if (!startedAt || !Number.isFinite(startedAt)) {
      return '0s';
    }
    return `${Math.max(0, Math.floor((now - startedAt) / 1000))}s`;
  }

  function formatTimestamp(ts: number): string {
    if (!ts || !Number.isFinite(ts)) {
      return '';
    }
    try {
      return new Date(ts).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  function capitalizeEffort(effort: string): string {
    const clean = String(effort || 'high').trim().toLowerCase();
    if (!clean) {
      return 'High';
    }
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }

  function firstLineSnippet(text: string | undefined, maxLen = 96): string {
    const raw = String(text || '')
      .replace(/\r/g, '')
      .split('\n')
      .map(line => line.trim())
      .find(line => line && !/^[-*]\s+\[[ xX]\]/.test(line));
    if (!raw) {
      return '';
    }
    const clean = raw.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
    if (clean.length <= maxLen) {
      return clean;
    }
    return `${clean.slice(0, maxLen - 1)}…`;
  }

  function isWorkerErrorText(text: string): boolean {
    const trimmed = String(text || '').trim();
    return (
      /^Worker error:/i.test(trimmed) ||
      /^Coordinator error:/i.test(trimmed) ||
      /^Rate limit exceeded/i.test(trimmed) ||
      /^backend_error/i.test(trimmed) ||
      /^backenderror/i.test(trimmed)
    );
  }

  function humanizeProjectError(raw: string): string {
    const text = String(raw || '').trim();
    if (!text) {
      return 'Request failed — ready to retry';
    }
    if (/session_busy/i.test(text)) {
      return 'Session busy — ready to retry';
    }
    if (/http_?429|rate_limit|ratelimit|too many requests|\b429\b/i.test(text)) {
      return 'Rate limit exceeded — switch model or retry';
    }
    const jsonIdx = text.indexOf('{');
    if (jsonIdx >= 0) {
      try {
        const parsed = JSON.parse(text.slice(jsonIdx)) as {
          error?: {message?: string} | string;
          message?: string;
        };
        const msg =
          typeof parsed?.error === 'object'
            ? parsed.error?.message
            : typeof parsed?.error === 'string'
              ? parsed.error
              : parsed?.message;
        if (msg && msg.trim()) {
          return msg.trim();
        }
      } catch {
        // Fall back to prefix stripping.
      }
    }
    return (
      text
        .replace(/^Coordinator error:\s*/i, '')
        .replace(/^Worker error:\s*/i, '')
        .replace(/^backend_?error:[^:]*:\s*/i, '')
        .trim() || 'Request failed — ready to retry'
    );
  }

  interface ThreadChecklistSummary {
    done: number;
    total: number;
    items: Array<{label: string; done: boolean}>;
  }

  function extractThreadChecklist(
    thread: ProjectOverviewThread,
  ): ThreadChecklistSummary {
    const byKey = new Map<string, {label: string; done: boolean}>();
    const scanText = (raw: string | undefined) => {
      if (!raw) {
        return;
      }
      const lines = raw.split(/\r?\n/);
      for (const line of lines) {
        const match = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
        if (!match) {
          continue;
        }
        const done = match[1].toLowerCase() === 'x';
        const label = match[2].trim();
        if (!label) {
          continue;
        }
        const key = label.toLowerCase();
        byKey.set(key, {label, done});
      }
    };
    scanText(thread.body);
    for (const msg of thread.messages || []) {
      scanText(msg.text);
    }
    const items = [...byKey.values()];
    const done = items.filter(item => item.done).length;
    return {done, total: items.length, items};
  }

  function deriveThreadClientStatus(
    thread: ProjectOverviewThread,
    now = Date.now(),
  ): {
    status: string;
    boardColumn: BoardCol;
    icon: string;
    tone: string;
    label: string;
  } {
    const sessions = thread.boundSessions || [];
    const primary =
      sessions.find(s => s.status === 'active') ??
      sessions.find(s => s.status !== 'failed') ??
      sessions[0];
    const machine = !primary
      ? 'active'
      : primary.status === 'failed'
        ? 'failed'
        : primary.status === 'archived' && !primary.reopenedOver
          ? 'archived'
          : primary.working || primary.boardStatus === 'working'
            ? 'working'
            : primary.startFailureCode
              ? 'start_failed'
              : primary.status === 'paused'
                ? 'paused'
                : 'active';

    let status = 'idle';
    if (thread.resolved || thread.resolvedAt) {
      status = 'resolved';
    } else if (thread.taskStatus === 'blocked') {
      status = 'needs_input';
    } else if (machine === 'failed') {
      status = 'failed';
    } else if (machine === 'start_failed') {
      status = 'needs_input';
    } else if (machine === 'working' || thread.threadStatus === 'working') {
      status = 'running';
    } else if (primary?.boardStatus === 'blocked') {
      status = 'needs_input';
    } else if (machine === 'archived' || thread.threadStatus === 'archived') {
      status = 'archived';
    } else if (
      thread.threadStatus === 'needs_input' ||
      thread.waitsOnLivePrompt ||
      (thread.openDecisionCount ?? 0) > 0 ||
      Boolean(thread.openDecisionId) ||
      Boolean(primary?.failingPr)
    ) {
      status = 'needs_input';
    } else if (
      thread.taskStatus === 'done' ||
      thread.taskStatus === 'cancelled'
    ) {
      status = 'done';
    } else if (thread.taskStatus === 'in_progress') {
      status = 'in_progress';
    } else if (thread.taskStatus === 'open') {
      status = 'todo';
    } else if (sessions.some(s => s.boardStatus === 'review')) {
      status = 'review';
    } else if (sessions.some(s => Boolean(s.landingPr))) {
      status = 'landing';
    } else if (machine === 'paused') {
      status = 'paused';
    } else if (thread.threadStatus === 'failed') {
      status = 'failed';
    }

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

    const map: Record<
      string,
      {boardColumn: BoardCol; icon: string; tone: string; label: string}
    > = {
      needs_input: {
        boardColumn: 'blocked',
        icon: 'Warning',
        tone: 'text-warning',
        label: 'Needs input',
      },
      failed: {
        boardColumn: 'blocked',
        icon: 'Warning',
        tone: 'text-warning',
        label: 'Failed',
      },
      waiting_others: {
        boardColumn: 'blocked',
        icon: 'Clock',
        tone: 'text-muted',
        label: 'Waiting on others',
      },
      review: {
        boardColumn: 'review',
        icon: 'Eye',
        tone: 'text-accent',
        label: 'Ready for review',
      },
      landing: {
        boardColumn: 'review',
        icon: 'GitMergeQueue',
        tone: 'text-git-modified',
        label: 'Ready to land',
      },
      running: {
        boardColumn: 'working',
        icon: 'Spinner',
        tone: 'text-secondary',
        label: 'Working',
      },
      in_progress: {
        boardColumn: 'working',
        icon: 'DotsCircle',
        tone: 'text-secondary',
        label: 'Working',
      },
      remind_later: {
        boardColumn: 'working',
        icon: 'Clock',
        tone: 'text-muted',
        label: 'Remind later',
      },
      paused: {
        boardColumn: 'working',
        icon: 'DotsCircle',
        tone: 'text-muted',
        label: 'Paused',
      },
      todo: {
        boardColumn: 'working',
        icon: 'DotsCircle',
        tone: 'text-muted',
        label: 'Open',
      },
      idle: {
        boardColumn: 'working',
        icon: 'DotsCircle',
        tone: 'text-muted',
        label: 'Idle',
      },
      done: {
        boardColumn: 'done',
        icon: 'DotsCircle',
        tone: 'text-muted',
        label: 'Completed',
      },
      archived: {
        boardColumn: 'done',
        icon: 'CheckCircle',
        tone: 'text-success',
        label: 'Archived',
      },
      resolved: {
        boardColumn: 'done',
        icon: 'CheckCircle',
        tone: 'text-success',
        label: 'Resolved',
      },
    };
    return {status, ...(map[status] || map.idle)};
  }

  function classifyThreadGroup(
    thread: ProjectOverviewThread,
    activeRun: ProjectOverviewActiveRun | undefined,
    openDecisionThreadIds: ReadonlySet<string>,
    now = Date.now(),
  ): {
    group: ThreadGroupKey;
    derived: ReturnType<typeof deriveThreadClientStatus>;
  } {
    const derived = deriveThreadClientStatus(thread, now);
    if (
      derived.status === 'resolved' ||
      derived.status === 'archived' ||
      derived.status === 'done'
    ) {
      return {group: 'resolved', derived};
    }
    if (
      derived.status === 'needs_input' ||
      derived.status === 'failed' ||
      derived.status === 'waiting_others' ||
      (thread.openDecisionCount ?? 0) > 0 ||
      Boolean(thread.openDecisionId) ||
      openDecisionThreadIds.has(thread.id)
    ) {
      return {group: 'waiting', derived};
    }
    if (
      activeRun?.running ||
      derived.status === 'running' ||
      derived.status === 'in_progress'
    ) {
      return {group: 'working', derived};
    }
    return {group: 'idle', derived};
  }

  function buildStatusPageSrcDoc(
    rawHtml: string,
    recapText: string | undefined,
    sections: ProjectOverviewSectionsState,
  ): string {
    const hiddenSet = new Set(sections.hiddenIds || []);
    const recapBlock = recapText
      ? `<section class="recap" data-section-id="recap"><h2>Recap</h2><p>${esc(recapText)}</p></section>`
      : '';

    return `<!doctype html><html><head><meta charset="utf-8"><style>${STATUS_PAGE_BASE_CSS}</style></head><body>
      ${recapBlock}
      <div id="mp-status-sections">${rawHtml}</div>
      <script>
        (function () {
          var hidden = ${JSON.stringify([...hiddenSet])};
          var order = ${JSON.stringify(sections.order || [])};
          function applySectionLayout() {
            var container = document.getElementById('mp-status-sections');
            if (!container) return;
            var nodes = Array.prototype.slice.call(container.querySelectorAll('section'));
            nodes.forEach(function (sec, idx) {
              var sid = sec.getAttribute('id') || sec.getAttribute('data-section-id') || ('sec-' + idx);
              sec.setAttribute('data-section-id', sid);
              sec.hidden = hidden.indexOf(sid) >= 0;
            });
            if (order.length) {
              nodes.sort(function (a, b) {
                var ia = order.indexOf(a.getAttribute('data-section-id'));
                var ib = order.indexOf(b.getAttribute('data-section-id'));
                return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
              });
              nodes.forEach(function (n) { container.appendChild(n); });
            }
          }
          window.addEventListener('message', function (ev) {
            var data = ev.data || {};
            if (data.sp === 'thread-progress' && Array.isArray(data.entries)) {
              var host = document.getElementById('mp-live-progress');
              if (!host) {
                host = document.createElement('section');
                host.id = 'mp-live-progress';
                host.innerHTML = '<h2>Live threads <span class="count">(' + data.entries.length + ')</span></h2><ul class="threads"></ul>';
                document.body.appendChild(host);
              }
              var ul = host.querySelector('ul.threads');
              if (ul) {
                ul.innerHTML = data.entries.map(function (item) {
                  return '<li><strong>' + String(item.title || item.threadId) + '</strong> · ' + String(item.state) + '</li>';
                }).join('');
              }
            } else if (data.sp === 'section-layout') {
              hidden = data.hiddenIds || [];
              order = data.order || [];
              applySectionLayout();
            }
          });
          applySectionLayout();
        })();
      </script>
    </body></html>`;
  }

  function extractSectionIds(rawHtml: string): string[] {
    const ids: string[] = [];
    const regex = /<section\b[^>]*\b(?:id|data-section-id)=["']([^"']+)["']/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(rawHtml)) !== null) {
      if (match[1] && !ids.includes(match[1])) {
        ids.push(match[1]);
      }
    }
    return ids;
  }

  function computeLifecyclePreview(
    threads: readonly ProjectOverviewThread[],
    quietAfterDays: number,
    autoResolveDays: number,
  ): {
    valid: boolean;
    error?: string;
    items: Array<{title: string; action: string; idleDays: number}>;
  } {
    if (autoResolveDays !== 0 && autoResolveDays <= quietAfterDays) {
      return {
        valid: false,
        error: 'Auto-resolve days must be 0 (off) or greater than quiet days.',
        items: [],
      };
    }
    const now = Date.now();
    const items: Array<{title: string; action: string; idleDays: number}> = [];
    for (const thread of threads) {
      const info = deriveThreadClientStatus(thread, now);
      if (
        info.status === 'resolved' ||
        info.status === 'archived' ||
        info.status === 'paused'
      ) {
        continue;
      }
      const last = Math.max(thread.lastReplyAt || 0, thread.createdAt || 0);
      const idleDays = Math.floor(Math.max(0, now - last) / 86_400_000);
      if (autoResolveDays !== 0 && idleDays >= autoResolveDays) {
        items.push({title: thread.title, action: 'resolve', idleDays});
      } else if (
        !thread.quieted &&
        !thread.hasUnread &&
        idleDays >= quietAfterDays
      ) {
        items.push({title: thread.title, action: 'quiet', idleDays});
      }
      if (items.length >= 6) {
        break;
      }
    }
    return {valid: true, items};
  }

  function parseDiffFiles(diff: string): string[] {
    if (!diff) {
      return [];
    }
    const files: string[] = [];
    const regex = /^diff --git a\/(.+?) b\/(.+)$/gm;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(diff)) !== null) {
      const filePath = (match[2] || match[1] || '').trim();
      if (filePath && !files.includes(filePath)) {
        files.push(filePath);
      }
    }
    return files;
  }

  function synthesizeDiffSummary(
    res: ProjectOverviewDiffResult,
  ): string | undefined {
    if (res.summary && res.summary.trim()) {
      return res.summary.trim();
    }
    if (typeof res.changedFiles === 'number') {
      return `${res.changedFiles} file(s) changed (+${res.addedLines ?? 0} / -${res.deletedLines ?? 0})`;
    }
    if (res.stat && res.stat.trim()) {
      return res.stat.trim();
    }
    return undefined;
  }

  function renderDiffLinesHtml(diff: string): string {
    return diff
      .split(/\r?\n/)
      .map(line => {
        const cls =
          line.startsWith('+') && !line.startsWith('+++')
            ? 'is-add'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'is-del'
              : line.startsWith('@@') ||
                  line.startsWith('diff --git') ||
                  line.startsWith('index ') ||
                  line.startsWith('--- ') ||
                  line.startsWith('+++ ')
                ? 'is-hunk'
                : '';
        return `<span class="mp-po-diff-line${cls ? ` ${cls}` : ''}">${esc(line)}</span>`;
      })
      .join('\n');
  }

  interface NormalizedToolStep {
    name: string;
    status: string;
    summary: string;
  }

  function extractToolSteps(rawList: unknown): NormalizedToolStep[] {
    if (!Array.isArray(rawList)) {
      return [];
    }
    const out: NormalizedToolStep[] = [];
    for (const item of rawList) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const rec = item as Record<string, unknown>;
      const rawName = rec.name ?? rec.tool ?? rec.toolName ?? rec.type;
      const name = typeof rawName === 'string' ? rawName.trim() : '';
      if (!name) {
        continue;
      }
      const status =
        typeof rec.status === 'string'
          ? rec.status
          : typeof rec.state === 'string'
            ? rec.state
            : 'done';
      const summary =
        typeof rec.summary === 'string'
          ? rec.summary
          : typeof rec.label === 'string'
            ? rec.label
            : '';
      out.push({name, status, summary});
    }
    return out;
  }

  function renderToolsAndThinkingDetails(
    thinkingText: string,
    tools: readonly NormalizedToolStep[],
  ): string {
    if (!thinkingText && tools.length === 0) {
      return '';
    }
    const labelParts: string[] = [];
    if (thinkingText) {
      labelParts.push('Thought process');
    }
    if (tools.length > 0) {
      const previewNames = tools
        .slice(0, 3)
        .map(t => t.name)
        .join(', ');
      labelParts.push(
        `Used ${tools.length} tool${tools.length === 1 ? '' : 's'}${previewNames ? ` · ${previewNames}` : ''}`,
      );
    }
    return `
      <details class="mp-po-tools-summary">
        <summary>
          ${iconHtml(tools.length > 0 ? 'Tool' : 'ExtendedThinking', 'xs')}
          <span>${esc(labelParts.join(' · '))}</span>
          ${iconHtml('CaretRight', 'xs')}
        </summary>
        <div class="mp-po-tools-details">
          ${
            thinkingText
              ? `<div class="mp-po-thinking-body">${esc(thinkingText)}</div>`
              : ''
          }
          ${
            tools.length > 0
              ? `<ul class="mp-po-tool-list">${tools
                  .map(
                    tool => `
                <li class="mp-po-tool-step is-${esc(tool.status)}">
                  <span class="mp-po-tool-name">${esc(tool.name)}</span>
                  ${tool.summary ? `<span class="mp-po-tool-desc">${esc(tool.summary)}</span>` : ''}
                </li>`,
                  )
                  .join('')}</ul>`
              : ''
          }
        </div>
      </details>
    `;
  }

  function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function injectThreadMentionsHtml(
    html: string,
    threads: readonly ProjectOverviewThread[],
    activeRuns: Readonly<Record<string, ProjectOverviewActiveRun>>,
    openDecisionThreadIds: ReadonlySet<string>,
  ): string {
    if (!html || threads.length === 0) {
      return html;
    }
    const candidates = [...threads]
      .filter(t => t.title && t.title.trim().length >= 2)
      .sort((a, b) => b.title.length - a.title.length);
    if (candidates.length === 0) {
      return html;
    }

    const now = Date.now();
    const metaById = new Map<
      string,
      {thread: ProjectOverviewThread; tooltip: string; group: ThreadGroupKey}
    >();
    for (const thread of candidates) {
      const {group, derived} = classifyThreadGroup(
        thread,
        activeRuns[thread.id],
        openDecisionThreadIds,
        now,
      );
      const replies = thread.replyCount || (thread.messages?.length ?? 0);
      const rel = formatRelativeTime(thread.lastReplyAt || thread.createdAt, now);
      const tooltip = `${derived.label} · ${replies} ${replies === 1 ? 'reply' : 'replies'}${rel ? ` · ${rel}` : ''}`;
      metaById.set(thread.id, {thread, tooltip, group});
    }

    const patternParts = candidates.map(t => escapeRegExp(t.title.trim()));
    const titleRegex = new RegExp(
      `(^|[\\s(\\[{"'.,:;!?—–-])(@?(?:${patternParts.join('|')}))(?=$|[\\s)\\]}"'.,:;!?—–-])`,
      'g',
    );
    const titleLookup = new Map<string, ProjectOverviewThread>();
    for (const thread of candidates) {
      titleLookup.set(thread.title.trim(), thread);
    }

    let totalInjected = 0;
    const perThreadCount = new Map<string, number>();
    const skipTags = new Set(['code', 'pre', 'a', 'button', 'script', 'style']);
    const skipStack: string[] = [];

    const tokens = html.split(/(<[^>]+>)/g);
    return tokens
      .map(token => {
        if (!token) {
          return '';
        }
        if (token.startsWith('<')) {
          const closeMatch = token.match(/^<\/([a-zA-Z][\w-]*)/);
          if (closeMatch) {
            const tag = closeMatch[1].toLowerCase();
            const idx = skipStack.lastIndexOf(tag);
            if (idx >= 0) {
              skipStack.splice(idx, 1);
            }
            return token;
          }
          const openMatch = token.match(/^<([a-zA-Z][\w-]*)/);
          if (openMatch && !token.endsWith('/>')) {
            const tag = openMatch[1].toLowerCase();
            if (skipTags.has(tag)) {
              skipStack.push(tag);
            }
          }
          return token;
        }
        if (skipStack.length > 0 || totalInjected >= 8) {
          return token;
        }
        return token.replace(titleRegex, (full, prefix: string, rawMatch: string) => {
          if (totalInjected >= 8) {
            return full;
          }
          const cleanTitle = rawMatch.startsWith('@')
            ? rawMatch.slice(1)
            : rawMatch;
          const thread = titleLookup.get(cleanTitle);
          if (!thread) {
            return full;
          }
          const seen = perThreadCount.get(thread.id) ?? 0;
          if (seen >= 2) {
            return full;
          }
          const meta = metaById.get(thread.id);
          if (!meta) {
            return full;
          }
          totalInjected += 1;
          perThreadCount.set(thread.id, seen + 1);
          const dotClass =
            meta.group === 'working'
              ? 'is-working'
              : meta.group === 'waiting'
                ? 'is-waiting'
                : meta.group === 'resolved'
                  ? 'is-resolved'
                  : 'is-idle';
          return `${prefix}<button type="button" class="mp-po-thread-mention" data-po-thread-mention="${esc(thread.id)}" title="${esc(meta.tooltip)}"><span class="mp-po-mention-dot ${dotClass}" aria-hidden="true"></span><span>${esc(rawMatch)}</span></button>`;
        });
      })
      .join('');
  }

  function computeGoalRoutingCounts(
    timeline: readonly ProjectOverviewTimelineEntry[],
  ): Map<string, number> {
    const counts = new Map<string, number>();
    let activeGoalKey: string | null = null;
    let routedSet = new Set<string>();

    const flush = () => {
      if (activeGoalKey && routedSet.size > 0) {
        counts.set(activeGoalKey, routedSet.size);
      }
    };

    for (const ev of timeline) {
      if (ev.type === 'goal' || ev.author === 'user') {
        flush();
        activeGoalKey = `${ev.id}:${ev.seq}`;
        routedSet = new Set<string>();
        continue;
      }
      if (
        activeGoalKey &&
        ev.threadId &&
        (ev.type === 'thread_started' || ev.type === 'message_routed')
      ) {
        routedSet.add(ev.threadId);
      }
    }
    flush();
    return counts;
  }

  function renderContextRingSvg(percent: number): string {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    const level =
      clamped >= 85
        ? 'critical'
        : clamped >= 65
          ? 'high'
          : clamped >= 35
            ? 'mid'
            : 'low';
    return `
      <span class="mp-po-context-badge" title="~${clamped}% context" aria-label="~${clamped}% context">
        <svg class="mp-po-context-ring" data-level="${level}" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
          <circle class="mp-po-context-track" cx="10" cy="10" r="6.75" pathLength="100"></circle>
          <circle class="mp-po-context-value" cx="10" cy="10" r="6.75" pathLength="100" stroke-dasharray="${clamped} 100"></circle>
        </svg>
      </span>
    `;
  }

  function renderChecklistPieSvg(done: number, total: number): string {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return `
      <span class="mp-po-checklist-pill" title="${done}/${total} tasks done">
        <svg class="mp-po-checklist-pie" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <circle class="mp-po-pie-track" cx="8" cy="8" r="5.5" pathLength="100"></circle>
          <circle class="mp-po-pie-fill" cx="8" cy="8" r="5.5" pathLength="100" stroke-dasharray="${pct} 100"></circle>
        </svg>
        <span>${done}/${total}</span>
      </span>
    `;
  }

  interface DiffModalState {
    threadId: string;
    loading: boolean;
    diff?: string;
    summary?: string;
    files?: string[];
    error?: string;
    merging?: boolean;
    mergeError?: string;
  }

  function mountManaged(
    host: HTMLElement,
    initialState: ProjectOverviewState,
  ): ProjectOverviewManagedHandle {
    let state: ProjectOverviewState = initialState;
    let unmounted = false;
    let activeTab: TabId = state.activeTab || 'threads';
    let lastNonSettingsTab: RightTileTab =
      activeTab === 'settings' ? 'threads' : activeTab;
    let settingsOpen = activeTab === 'settings';
    let rightTileCollapsed = false;
    let threadsViewMode: 'list' | 'board' = 'list';
    let boardExpanded = false;
    let threadSearchOpen = false;
    let threadSearchQuery = '';
    let hideResolved = false;
    const collapsedGroups = new Set<ThreadGroupKey>();
    let resolvedDefaultInitialized = false;
    let filesSubTab: 'files' | 'memory' = 'files';
    let iconPickerOpen = false;
    let projectMenuOpen = false;
    let openPicker: PickerKind | null = null;
    let selectedThreadId: string | null = null;
    let optimisticThread: ProjectOverviewThread | null = null;
    let newThreadOpen = false;
    let newThreadTitleDraft = '';
    let newThreadPromptDraft = '';
    let newThreadUseWorktree = true;
    let newThreadSending = false;
    let newThreadError = '';
    const followupDrafts = new Map<string, string>();
    let followupSending = false;
    let followupError = '';
    let drawerActionError = '';
    let diffModal: DiffModalState | null = null;
    let artifactFilter: 'all' | 'pinned' = 'all';
    let artifactSort: 'newest' | 'recent' = 'newest';
    let selectedFilePath = state.files?.[0]?.path || '';
    let fileContent = '';
    let fileConflictError = '';
    let memoryPath = state.memory?.path || '/MEMORY.md';
    let memoryContent = state.memory?.content || '';
    let memorySha = state.memory?.sha256 || '';
    let memoryDirty = false;
    let memoryConflictSha = '';
    let memoryStatusMsg = '';
    let settingsError = '';
    let goalDraft = '';
    let goalSending = false;
    let initialTimelineScrolled = false;
    let lastScrolledThreadId: string | null = null;
    let liveTickTimer: ReturnType<typeof setInterval> | null = null;

    const root = document.createElement('section');
    root.className = 'mp-po-shell';
    root.setAttribute('aria-label', `${state.project.name} multi-agent project`);
    host.replaceChildren(root);

    function isReadOnly(): boolean {
      return Boolean(state.project.paused || state.project.archived);
    }

    function getActiveRunsMap(): Record<string, ProjectOverviewActiveRun> {
      const map: Record<string, ProjectOverviewActiveRun> = {
        ...(state.activeRuns || {}),
      };
      if (state.activeRun && !map.coordinator) {
        map.coordinator = state.activeRun;
      }
      return map;
    }

    function getAvailableModels(): ProjectOverviewAvailableModel[] {
      const raw = state.modelContext?.availableModels || [];
      const seen = new Set<string>();
      const out: ProjectOverviewAvailableModel[] = [];
      for (const entry of raw) {
        const id = String(entry.model || '').trim();
        if (!id || seen.has(id)) {
          continue;
        }
        seen.add(id);
        out.push({...entry, model: id});
      }
      const ensureModel = (id: string | undefined) => {
        const clean = String(id || '').trim();
        if (clean && !seen.has(clean)) {
          seen.add(clean);
          out.push({model: clean, label: clean});
        }
      };
      ensureModel(state.modelContext?.defaultModel);
      ensureModel(state.project.multiAgentConfig?.coordinatorModel);
      ensureModel(state.project.multiAgentConfig?.workerModel);
      return out;
    }

    function getEffectiveModel(role: 'coordinator' | 'worker'): string {
      const cfg = state.project.multiAgentConfig || {};
      const ctx = state.modelContext || {};
      if (role === 'coordinator') {
        return (
          cfg.coordinatorModel ||
          ctx.coordinatorModel ||
          ctx.defaultModel ||
          'Default model'
        );
      }
      return (
        cfg.workerModel || ctx.workerModel || ctx.defaultModel || 'Default model'
      );
    }

    function getEffectiveEffort(role: 'coordinator' | 'worker'): string {
      const cfg = state.project.multiAgentConfig || {};
      const ctx = state.modelContext || {};
      if (role === 'coordinator') {
        return cfg.coordinatorEffort || ctx.coordinatorEffort || 'high';
      }
      return cfg.workerEffort || ctx.workerEffort || 'medium';
    }

    function formatModelDisplayName(modelId: string): string {
      const models = getAvailableModels();
      const match = models.find(m => m.model === modelId);
      if (match?.label) {
        return match.label;
      }
      return modelId || 'Default model';
    }

    function syncLiveTimerInterval(): void {
      const runs = getActiveRunsMap();
      const hasRunning = Object.values(runs).some(r => Boolean(r?.running));
      if (
        hasRunning &&
        liveTickTimer === null &&
        typeof setInterval === 'function'
      ) {
        liveTickTimer = setInterval(() => {
          if (unmounted) {
            return;
          }
          const currentRuns = getActiveRunsMap();
          const now = Date.now();
          const nodes = root.querySelectorAll<HTMLElement>(
            '[data-po-live-timer]',
          );
          for (const node of nodes) {
            const key = node.dataset.poLiveTimer || 'coordinator';
            const run = currentRuns[key];
            if (run?.running && run.startedAt) {
              node.textContent = formatElapsedSeconds(run.startedAt, now);
            }
          }
        }, 1000);
      } else if (
        !hasRunning &&
        liveTickTimer !== null &&
        typeof clearInterval === 'function'
      ) {
        clearInterval(liveTickTimer);
        liveTickTimer = null;
      }
    }

    function pushProgressToIframe(): void {
      const iframe = root.querySelector<HTMLIFrameElement>(
        '[data-po-status-iframe]',
      );
      if (!iframe || !iframe.contentWindow) {
        return;
      }
      const entries = state.threads.map(thread => {
        const derived = deriveThreadClientStatus(thread);
        return {
          threadId: thread.id,
          title: thread.title,
          state:
            derived.status === 'running' || derived.status === 'in_progress'
              ? 'working'
              : derived.status === 'resolved' || derived.status === 'done'
                ? 'done'
                : derived.status,
        };
      });
      try {
        iframe.contentWindow.postMessage(
          {sp: 'thread-progress', entries},
          '*',
        );
      } catch {
        // Ignore cross-origin / detached iframe errors in headless test runners.
      }
    }

    function renderModelPickerPopover(
      kind: 'coord' | 'worker',
      currentModel: string,
    ): string {
      const targetPicker: PickerKind =
        kind === 'coord' ? 'coord-model' : 'worker-model';
      if (openPicker !== targetPicker) {
        return '';
      }
      const models = getAvailableModels();
      const attrName =
        kind === 'coord' ? 'data-po-pick-coord-model' : 'data-po-pick-worker-model';
      return `
        <div class="mp-po-picker-popover" data-po-picker="${targetPicker}" role="listbox" aria-label="Select model">
          ${
            models.length === 0
              ? '<div class="mp-po-picker-empty">No configured models</div>'
              : models
                  .map(item => {
                    const isSelected = item.model === currentModel;
                    return `
                      <button type="button" class="mp-po-picker-item${isSelected ? ' is-selected' : ''}" ${attrName}="${esc(item.model)}" role="option" aria-selected="${isSelected ? 'true' : 'false'}">
                        <span class="mp-po-picker-main">
                          <span class="mp-po-picker-label">${esc(item.label || item.model)}</span>
                          ${item.provider ? `<small class="mp-po-picker-sub">${esc(item.provider)}</small>` : ''}
                        </span>
                        ${isSelected ? iconHtml('Check', 'xs') : ''}
                      </button>
                    `;
                  })
                  .join('')
          }
        </div>
      `;
    }

    function renderEffortPickerPopover(
      kind: 'coord' | 'worker',
      currentEffort: string,
    ): string {
      const targetPicker: PickerKind =
        kind === 'coord' ? 'coord-effort' : 'worker-effort';
      if (openPicker !== targetPicker) {
        return '';
      }
      const attrName =
        kind === 'coord'
          ? 'data-po-pick-coord-effort'
          : 'data-po-pick-worker-effort';
      const choices = EFFORT_CHOICES.includes(currentEffort)
        ? EFFORT_CHOICES
        : [...EFFORT_CHOICES, currentEffort];
      return `
        <div class="mp-po-picker-popover is-compact" data-po-picker="${targetPicker}" role="listbox" aria-label="Select reasoning effort">
          ${choices
            .map(effort => {
              const isSelected = effort === currentEffort;
              return `
                <button type="button" class="mp-po-picker-item${isSelected ? ' is-selected' : ''}" ${attrName}="${esc(effort)}" role="option" aria-selected="${isSelected ? 'true' : 'false'}">
                  <span class="mp-po-picker-label">${esc(capitalizeEffort(effort))}</span>
                  ${isSelected ? iconHtml('Check', 'xs') : ''}
                </button>
              `;
            })
            .join('')}
        </div>
      `;
    }

    function estimateCoordinatorContextPercent(): number {
      let chars = goalDraft.length;
      for (const ev of state.timeline) {
        chars += String(ev.text || '').length;
      }
      if (chars === 0) {
        return 0;
      }
      return Math.min(99, Math.max(2, Math.round(chars / 4 / 1200)));
    }

    function estimateThreadContextPercent(
      thread: ProjectOverviewThread,
      draft: string,
    ): number {
      let chars = draft.length + String(thread.body || '').length;
      for (const msg of thread.messages || []) {
        chars += String(msg.text || '').length;
      }
      if (chars === 0) {
        return 0;
      }
      return Math.min(99, Math.max(2, Math.round(chars / 4 / 1000)));
    }

    function renderComposer(compactCentered: boolean): string {
      const readOnly = isReadOnly();
      const runs = getActiveRunsMap();
      const coordRun = runs.coordinator;
      const isRunActive = Boolean(coordRun?.running);
      const coordModel = getEffectiveModel('coordinator');
      const coordEffort = getEffectiveEffort('coordinator');
      const contextPct = estimateCoordinatorContextPercent();

      return `
        <form class="mp-po-composer${compactCentered ? ' is-centered' : ''}" data-po-goal-form>
          ${
            readOnly
              ? `<div class="mp-po-readonly-note">${iconHtml('MoonStars', 'sm')}<span>Project is ${state.project.archived ? 'archived' : 'paused'}. Resume or restore to continue.</span></div>`
              : ''
          }
          <div class="mp-po-input-box">
            <textarea name="goal" data-po-goal-input rows="${compactCentered ? '2' : '2'}" placeholder="Ask a question or start a task..." ${readOnly ? 'disabled' : ''}>${esc(goalDraft)}</textarea>
            ${
              isRunActive
                ? `<button type="button" class="mp-po-composer-send is-stop" data-po-action="stop-run" aria-label="Stop coordinator run" title="Stop">${iconHtml('StopFilled', 'sm')}</button>`
                : `<button type="submit" class="mp-po-composer-send is-inline-return" data-po-goal-send aria-label="Send goal" title="Send" ${readOnly || goalSending ? 'disabled' : ''}>${iconHtml('ArrowReturn', 'sm')}</button>`
            }
          </div>
          <div class="mp-po-composer-bar">
            <div class="mp-po-composer-meta">
              <button type="button" class="mp-po-icon-btn mp-po-composer-add" data-po-action="open-new-thread" title="New Thread" aria-label="New Thread" ${readOnly ? 'disabled' : ''}>
                ${iconHtml('Add', 'sm')}
              </button>
              ${
                goalSending
                  ? `<span class="mp-po-coord-running" data-po-goal-sending><span class="mp-po-working-dots" aria-hidden="true"><span></span><span></span><span></span></span><span>Coordinator is running...</span></span>`
                  : coordRun?.queuedCount
                    ? `<span class="mp-po-coord-queued">${coordRun.queuedCount} queued</span>`
                    : ''
              }
            </div>
            <div class="mp-po-composer-actions">
              <div class="mp-po-picker-anchor">
                <button type="button" class="mp-po-picker-btn" data-po-action="toggle-coord-model" aria-haspopup="listbox" aria-expanded="${openPicker === 'coord-model' ? 'true' : 'false'}" title="Coordinator model: ${esc(coordModel)}">
                  <span class="mp-po-picker-btn-label">${esc(formatModelDisplayName(coordModel))}</span>
                </button>
                ${renderModelPickerPopover('coord', coordModel)}
              </div>
              <div class="mp-po-picker-anchor">
                <button type="button" class="mp-po-picker-btn" data-po-action="toggle-coord-effort" aria-haspopup="listbox" aria-expanded="${openPicker === 'coord-effort' ? 'true' : 'false'}" title="Coordinator reasoning effort: ${esc(capitalizeEffort(coordEffort))}">
                  <span>${esc(capitalizeEffort(coordEffort))}</span>
                </button>
                ${renderEffortPickerPopover('coord', coordEffort)}
              </div>
              ${renderContextRingSvg(contextPct)}
            </div>
          </div>
        </form>
      `;
    }

    function renderInlineThreadGroup(
      entries: readonly ProjectOverviewTimelineEntry[],
      activeRuns: Readonly<Record<string, ProjectOverviewActiveRun>>,
      openDecisionThreadIds: ReadonlySet<string>,
    ): string {
      const seen = new Set<string>();
      const cardsHtml: string[] = [];
      const now = Date.now();

      for (const ev of entries) {
        const threadId = ev.threadId || '';
        if (!threadId || seen.has(threadId)) {
          continue;
        }
        seen.add(threadId);
        const thread = state.threads.find(t => t.id === threadId);
        const run = activeRuns[threadId];
        const title = thread?.title || ev.text || 'Worker thread';
        let statusClass = 'is-idle';
        let summaryText = '';

        if (thread) {
          const {group, derived} = classifyThreadGroup(
            thread,
            run,
            openDecisionThreadIds,
            now,
          );
          if (group === 'working') {
            statusClass = 'is-working';
            const steps = extractToolSteps(run?.trajectory);
            const lastStep = steps[steps.length - 1];
            summaryText =
              run?.retryNotice ||
              (lastStep
                ? lastStep.summary || lastStep.name
                : firstLineSnippet(run?.answer)) ||
              (run?.startedAt
                ? `Working · ${formatElapsedSeconds(run.startedAt, now)}`
                : 'Working…');
          } else if (group === 'waiting') {
            statusClass = 'is-waiting';
            const lastMsg = [...(thread.messages || [])]
              .reverse()
              .find(m => m.author === 'worker' || m.author === 'system');
            const msgText = lastMsg?.text || '';
            summaryText =
              (isWorkerErrorText(msgText)
                ? firstLineSnippet(humanizeProjectError(msgText))
                : firstLineSnippet(msgText)) ||
              firstLineSnippet(thread.body) ||
              derived.label;
          } else if (group === 'resolved') {
            statusClass = 'is-resolved';
            const lastMsg = [...(thread.messages || [])]
              .reverse()
              .find(m => m.author === 'worker');
            summaryText = firstLineSnippet(lastMsg?.text) || derived.label;
          } else {
            const lastMsg = [...(thread.messages || [])]
              .reverse()
              .find(m => m.author === 'worker');
            const msgText = lastMsg?.text || '';
            summaryText =
              (isWorkerErrorText(msgText)
                ? firstLineSnippet(humanizeProjectError(msgText))
                : firstLineSnippet(msgText)) ||
              firstLineSnippet(thread.body) ||
              derived.label;
          }
        } else {
          summaryText = firstLineSnippet(ev.text) || 'Thread started';
        }

        const glyphHtml =
          statusClass === 'is-resolved'
            ? `<span class="mp-po-status-check" aria-hidden="true">${iconHtml('CheckCircle', 'xs')}</span>`
            : `<span class="mp-po-status-dot ${statusClass}" aria-hidden="true"></span>`;

        cardsHtml.push(`
          <button type="button" class="mp-po-inline-thread-card${threadId === selectedThreadId ? ' is-selected' : ''}" data-po-select-inline-thread="${esc(threadId)}">
            <span class="mp-po-inline-card-left">
              ${glyphHtml}
              <strong class="mp-po-inline-card-title">${esc(title)}</strong>
            </span>
            <span class="mp-po-inline-card-right">
              <span class="mp-po-inline-card-summary">${esc(summaryText)}</span>
            </span>
          </button>
        `);
      }

      if (cardsHtml.length === 0) {
        return '';
      }
      return `<div class="mp-po-inline-thread-group">${cardsHtml.join('')}</div>`;
    }

    function renderLiveRunTurn(
      runKey: string,
      run: ProjectOverviewActiveRun,
      isThread: boolean,
    ): string {
      const thinkingText =
        typeof run.thinking === 'string' ? run.thinking.trim() : '';
      const tools = extractToolSteps(run.trajectory);
      const detailsHtml = renderToolsAndThinkingDetails(thinkingText, tools);
      const answerHtml = run.answer ? renderMarkdownHtml(run.answer) : '';
      const elapsed = formatElapsedSeconds(run.startedAt);

      return `
        <div class="mp-po-live-turn" ${isThread ? `data-po-thread-live-run="${esc(runKey)}"` : 'data-po-live-run'}>
          ${detailsHtml}
          ${answerHtml ? `<div class="mp-po-live-answer">${answerHtml}</div>` : ''}
          ${
            run.retryNotice
              ? `<div class="mp-po-retry-banner" role="status">${iconHtml('Clock', 'xs')}<span>${esc(run.retryNotice)}</span></div>`
              : ''
          }
          <div class="mp-po-live-header">
            <div class="mp-po-live-indicator">
              <span class="mp-po-working-dots" aria-hidden="true"><span></span><span></span><span></span></span>
              <span>Working</span>
              <span class="mp-po-live-timer" data-po-live-timer="${esc(runKey)}">${esc(elapsed)}</span>
            </div>
            ${
              isThread
                ? `<button type="button" class="mp-po-live-stop-btn" data-po-action="stop-thread-run" data-thread-id="${esc(runKey)}" aria-label="Stop thread run"><span>Stop</span></button>`
                : ''
            }
          </div>
        </div>
      `;
    }

    function renderDecisionCard(
      card: ProjectOverviewDecision,
      readOnly: boolean,
    ): string {
      if (card.status !== 'open') {
        const chosen =
          typeof card.chosenIndex === 'number'
            ? card.options[card.chosenIndex]?.label
            : undefined;
        const summary =
          card.status === 'withdrawn'
            ? `Decision withdrawn: ${card.question}`
            : `Decision answered${chosen ? ` (${chosen})` : ''}: ${card.question}`;
        return `<div class="mp-po-decision-resolved" data-decision-id="${esc(card.id)}">${iconHtml('CheckCircle', 'xs')}<span>${esc(summary)}</span></div>`;
      }

      return `
        <section class="mp-po-decision-card" data-decision-id="${esc(card.id)}" aria-label="Decision required">
          <header class="mp-po-decision-head">
            <div class="mp-po-decision-title">
              <span class="mp-po-status-dot is-waiting" aria-hidden="true"></span>
              <strong>${esc(card.question)}</strong>
            </div>
            <div class="mp-po-decision-head-actions">
              ${
                card.threadId
                  ? `<button type="button" class="mp-po-btn mp-po-view-thread-btn" data-po-thread="${esc(card.threadId)}">View thread</button>`
                  : ''
              }
              ${
                state.actions.onWithdrawDecision
                  ? `<button type="button" class="mp-po-inline-link" data-po-withdraw-decision="${esc(card.id)}" ${readOnly ? 'disabled' : ''}>Withdraw</button>`
                  : ''
              }
            </div>
          </header>
          ${card.context ? `<p class="mp-po-decision-ctx">${esc(card.context)}</p>` : ''}
          ${card.reason ? `<p class="mp-po-decision-reason">${esc(card.reason)}</p>` : ''}
          <div class="mp-po-decision-options">
            ${card.options
              .map(
                (opt, idx) => `
              <button type="button" class="mp-po-decision-opt${card.recommended === idx ? ' is-recommended' : ''}" data-po-decide="${esc(card.id)}" data-option-index="${idx}" ${readOnly ? 'disabled' : ''}>
                <span class="mp-po-opt-head">
                  <strong>${esc(opt.label)}</strong>
                  ${card.recommended === idx ? '<span class="mp-po-rec-tag">Recommended</span>' : ''}
                </span>
                <small>${esc(opt.consequence)}</small>
              </button>`,
              )
              .join('')}
          </div>
        </section>
      `;
    }

    function renderLeftHeader(): string {
      const color = state.project.color || '#D97757';
      const iconName = state.project.projectIcon || 'Projects';
      const tileTab: RightTileTab =
        activeTab === 'settings' ? lastNonSettingsTab : activeTab;

      return `
        <header class="mp-po-header">
          <div class="mp-po-head-left">
            <button type="button" class="mp-po-icon-btn" data-po-action="back" title="Back to Projects" aria-label="Back to Projects">${iconHtml('CaretLeft', 'xs')}</button>
            <div class="mp-po-badge-anchor">
              <button type="button" class="mp-po-project-badge" data-po-action="toggle-icon-picker" aria-label="Customize project icon and color" title="Change icon and color">${iconHtml(iconName, 'sm')}</button>
              ${renderIconPickerPopover(iconName, color)}
            </div>
            <div class="mp-po-head-titles">
              <h1>${esc(state.project.name)}</h1>
            </div>
            ${state.project.paused ? `<span class="mp-po-state-chip">${iconHtml('MoonStars', 'xs')}<span>Paused</span></span>` : ''}
            ${state.project.archived ? `<span class="mp-po-state-chip">${iconHtml('Archive', 'xs')}<span>Archived</span></span>` : ''}
            <div class="mp-po-menu-anchor">
              <button type="button" class="mp-po-icon-btn" data-po-action="toggle-project-menu" aria-label="Project options" title="Project options" aria-expanded="${projectMenuOpen ? 'true' : 'false'}">${iconHtml('DotsHorizontal', 'sm')}</button>
              ${renderProjectMenu()}
            </div>
          </div>
          <nav class="mp-po-tabs" aria-label="Project views">
            <button type="button" class="mp-po-tab-icon${!settingsOpen && tileTab === 'threads' ? ' is-active' : ''}" data-po-tab="threads" aria-label="Threads" title="Threads">${iconHtml('LayoutList', 'xs')}</button>
            <button type="button" class="mp-po-tab-icon${!settingsOpen && tileTab === 'overview' ? ' is-active' : ''}" data-po-tab="overview" aria-label="Overview" title="Overview">${iconHtml('Eye', 'xs')}</button>
            <button type="button" class="mp-po-tab-icon${!settingsOpen && tileTab === 'artifacts' ? ' is-active' : ''}" data-po-tab="artifacts" aria-label="Artifacts" title="Artifacts">${iconHtml('Artifacts', 'xs')}${state.artifacts.length > 0 ? `<span class="mp-po-tab-badge">${state.artifacts.length}</span>` : ''}</button>
            <button type="button" class="mp-po-tab-icon${!settingsOpen && tileTab === 'files' ? ' is-active' : ''}" data-po-tab="files" aria-label="Files & Memory" title="Files & Memory">${iconHtml('Folder', 'xs')}</button>
            <button type="button" class="mp-po-tab-icon${settingsOpen ? ' is-active' : ''}" data-po-tab="settings" aria-label="Project settings" title="Settings">${iconHtml('Settings', 'xs')}</button>
            <button type="button" class="mp-po-tab-icon${!rightTileCollapsed ? ' is-open' : ''}" data-po-action="toggle-right-tile" aria-label="${rightTileCollapsed ? 'Show right pane' : 'Hide right pane'}" title="${rightTileCollapsed ? 'Show right pane' : 'Hide right pane'}">${iconHtml('SidebarRight', 'xs')}</button>
          </nav>
        </header>
      `;
    }

    function renderCoordinatorPane(): string {
      const readOnly = isReadOnly();
      const activeRuns = getActiveRunsMap();
      const coordRun = activeRuns.coordinator;
      const isRunActive = Boolean(coordRun?.running);
      const openDecisions = state.decisions.filter(d => d.status === 'open');
      const openDecisionThreadIds = new Set(
        openDecisions.map(d => d.threadId).filter((id): id is string => Boolean(id)),
      );
      const routingCounts = computeGoalRoutingCounts(state.timeline);
      const visibleEvents = state.timeline.filter(ev => !ev.hiddenFromChat);
      const workers = state.workers || [];
      const isAiryEmpty =
        visibleEvents.length === 0 &&
        openDecisions.length === 0 &&
        !isRunActive;
      const iconName = state.project.projectIcon || 'Projects';

      const statusStrip =
        workers.length > 0 || state.pacingNotice
          ? `
            <div class="mp-po-coord-strip">
              ${
                workers.length > 0
                  ? `<div class="mp-po-worker-roster" data-po-roster>
                      ${iconHtml('Spinner', 'xs')}
                      <span>${workers.map(w => `Step ${w.step}: ${esc(w.names.join(', '))}`).join(' · ')}</span>
                    </div>`
                  : ''
              }
              ${
                state.pacingNotice
                  ? `<div class="mp-po-pacing-banner" role="status">${iconHtml('Clock', 'sm')}<span>${esc(state.pacingNotice)}</span></div>`
                  : ''
              }
            </div>
          `
          : '';

      if (isAiryEmpty) {
        const subtitle =
          state.project.goal ||
          state.project.description ||
          'Coordinate worker threads across your workspace with shared memory and isolated worktrees.';
        return `
          <div class="mp-po-coordinator is-empty" aria-label="Project Coordinator">
            ${renderLeftHeader()}
            ${statusStrip}
            <div class="mp-po-timeline mp-po-empty-scroll">
              <div class="mp-po-empty-workspace">
                <div class="mp-po-empty-badge">${iconHtml(iconName, 'md')}</div>
                <h2 class="mp-po-empty-heading">${esc(state.project.name)}</h2>
                <p class="mp-po-empty-subtitle">${esc(subtitle)}</p>
                <div class="mp-po-starter-pills" aria-label="Suggested goals">
                  ${STARTER_PROMPTS.map(
                    prompt =>
                      `<button type="button" class="mp-po-starter-pill" data-po-starter-prompt="${esc(prompt)}" ${readOnly ? 'disabled' : ''}>${iconHtml('Lightbulb', 'xs')}<span>${esc(prompt)}</span></button>`,
                  ).join('')}
                </div>
                ${renderComposer(true)}
              </div>
            </div>
          </div>
        `;
      }

      const chunks: string[] = [];
      const inlineCardThreadIds = new Set<string>();
      let lastUserPrompt = '';
      let lastErrorDisplay = '';
      let idx = 0;
      while (idx < visibleEvents.length) {
        const ev = visibleEvents[idx];
        if (
          ev.threadId &&
          (ev.type === 'thread_started' || ev.type === 'message_routed')
        ) {
          const groupEntries: ProjectOverviewTimelineEntry[] = [];
          while (
            idx < visibleEvents.length &&
            visibleEvents[idx].threadId &&
            (visibleEvents[idx].type === 'thread_started' ||
              visibleEvents[idx].type === 'message_routed')
          ) {
            inlineCardThreadIds.add(visibleEvents[idx].threadId!);
            groupEntries.push(visibleEvents[idx]);
            idx += 1;
          }
          const groupHtml = renderInlineThreadGroup(
            groupEntries,
            activeRuns,
            openDecisionThreadIds,
          );
          if (groupHtml) {
            chunks.push(groupHtml);
          }
          continue;
        }

        // Worker-scoped activity events belong inside the Focused Thread panel, never duplicated into Coordinator chat.
        if (ev.type === 'activity' && ev.threadId) {
          idx += 1;
          continue;
        }

        const payload = ev.payload || {};
        const text = ev.text || '';
        const isError =
          Boolean(payload.error) ||
          (ev.type !== 'goal' &&
            ev.author !== 'user' &&
            (ev.type === 'error' || isWorkerErrorText(text)));

        if (isError) {
          const friendly = humanizeProjectError(text);
          if (friendly === lastErrorDisplay) {
            idx += 1;
            continue;
          }
          lastErrorDisplay = friendly;
          const failedPrompt =
            typeof payload.failedPrompt === 'string' && payload.failedPrompt.trim()
              ? payload.failedPrompt.trim()
              : lastUserPrompt;
          chunks.push(`
            <div class="mp-po-error-turn mp-po-calm-error" role="status">
              <span class="mp-po-calm-error-text">${esc(friendly)}</span>
              ${
                failedPrompt
                  ? `<button type="button" class="mp-po-calm-retry" data-po-retry-goal="${esc(failedPrompt)}">Retry</button>`
                  : ''
              }
            </div>
          `);
        } else if (ev.type === 'goal' || ev.author === 'user') {
          lastErrorDisplay = '';
          if (text) {
            lastUserPrompt = text;
          }
          const routedCount = routingCounts.get(`${ev.id}:${ev.seq}`) || 0;
          const caption =
            routedCount === 1
              ? '↳ Sent to one thread'
              : routedCount > 1
                ? `↳ Sent to ${routedCount} threads`
                : '';
          chunks.push(`
            <div class="mp-po-user-turn">
              <div class="mp-po-user-bubble">${esc(text)}</div>
              ${caption ? `<div class="mp-po-routing-caption">${esc(caption)}</div>` : ''}
            </div>
          `);
        } else if (ev.type === 'coordinator_post' || ev.author === 'coordinator') {
          lastErrorDisplay = '';
          const thinkingText =
            typeof payload.thinking === 'string' ? payload.thinking.trim() : '';
          const tools = extractToolSteps(payload.tools);
          const detailsHtml = renderToolsAndThinkingDetails(thinkingText, tools);
          const rawBodyHtml = renderMarkdownHtml(text);
          const bodyHtml = injectThreadMentionsHtml(
            rawBodyHtml,
            state.threads,
            activeRuns,
            openDecisionThreadIds,
          );
          const tsLabel = formatTimestamp(ev.timestamp);
          chunks.push(`
            <div class="mp-po-assistant-turn">
              ${detailsHtml}
              ${bodyHtml}
              <div class="mp-po-turn-meta-row">
                <button type="button" class="mp-po-meta-icon-btn" data-po-copy-text="${esc(text)}" aria-label="Copy reply" title="Copy">${iconHtml('Copy', 'xs')}</button>
                ${tsLabel ? `<span class="mp-po-turn-time">${esc(tsLabel)}</span>` : ''}
              </div>
            </div>
          `);
        } else {
          const kindLabel = ev.type.replace(/_/g, ' ');
          chunks.push(`
            <div class="mp-po-activity-row is-${esc(ev.type)}">
              <span class="mp-po-activity-dot" aria-hidden="true"></span>
              <span class="mp-po-activity-text">${esc(text || kindLabel)}</span>
              ${
                ev.threadId
                  ? `<button type="button" class="mp-po-inline-link" data-po-thread="${esc(ev.threadId)}">View thread</button>`
                  : ''
              }
            </div>
          `);
        }
        idx += 1;
      }

      // Only escalate threads needing user input that aren't already represented by inline cards in the stream
      const now = Date.now();
      const escalationThreads = state.threads.filter(thread => {
        if (
          openDecisionThreadIds.has(thread.id) ||
          inlineCardThreadIds.has(thread.id)
        ) {
          return false;
        }
        const {group} = classifyThreadGroup(
          thread,
          activeRuns[thread.id],
          openDecisionThreadIds,
          now,
        );
        return group === 'waiting';
      });

      const escalationHtml = escalationThreads
        .map(thread => {
          const lastMsg = [...(thread.messages || [])]
            .reverse()
            .find(m => m.author === 'worker' || m.author === 'system');
          const rawMsg = lastMsg?.text || '';
          const summary =
            (isWorkerErrorText(rawMsg)
              ? firstLineSnippet(humanizeProjectError(rawMsg))
              : firstLineSnippet(rawMsg)) ||
            firstLineSnippet(thread.body) ||
            'Needs input';
          return `
            <div class="mp-po-escalation-strip" data-po-escalation="${esc(thread.id)}">
              <span class="mp-po-status-dot is-waiting" aria-hidden="true"></span>
              <div class="mp-po-escalation-text">
                <strong>${esc(thread.title)}</strong>
                <span>${esc(summary)}</span>
              </div>
              <button type="button" class="mp-po-btn mp-po-view-thread-btn" data-po-thread="${esc(thread.id)}">View thread</button>
            </div>
          `;
        })
        .join('');

      return `
        <div class="mp-po-coordinator" aria-label="Project Coordinator">
          ${renderLeftHeader()}
          ${statusStrip}
          <div class="mp-po-timeline">
            <div class="mp-po-stream-inner">
              ${chunks.join('')}
              ${isRunActive && coordRun ? renderLiveRunTurn('coordinator', coordRun, false) : ''}
              ${openDecisions.map(card => renderDecisionCard(card, readOnly)).join('')}
              ${escalationHtml}
            </div>
          </div>
          <div class="mp-po-composer-dock">
            ${renderComposer(false)}
          </div>
        </div>
      `;
    }

    function renderOverviewTab(): string {
      const recap = state.recap;
      const sections: ProjectOverviewSectionsState = state.sections || {
        version: 0,
        hiddenIds: [],
        order: [],
      };
      const rawHtml = (state.statusPageHtml || '').trim();
      const sectionIds = rawHtml ? extractSectionIds(rawHtml) : [];
      const hiddenCount = (sections.hiddenIds || []).length;
      const now = Date.now();
      const openDecisions = state.decisions.filter(d => d.status === 'open');
      const openDecisionThreadIds = new Set(
        openDecisions.map(d => d.threadId).filter((id): id is string => Boolean(id)),
      );
      const activeRuns = getActiveRunsMap();

      const needsAttention: Array<{
        thread: ProjectOverviewThread;
        derived: ReturnType<typeof deriveThreadClientStatus>;
      }> = [];
      const activeThreads: Array<{
        thread: ProjectOverviewThread;
        derived: ReturnType<typeof deriveThreadClientStatus>;
      }> = [];
      const completedThreads: Array<{
        thread: ProjectOverviewThread;
        derived: ReturnType<typeof deriveThreadClientStatus>;
      }> = [];

      for (const thread of state.threads) {
        const {group, derived} = classifyThreadGroup(
          thread,
          activeRuns[thread.id],
          openDecisionThreadIds,
          now,
        );
        if (group === 'waiting') {
          needsAttention.push({thread, derived});
        } else if (group === 'resolved') {
          completedThreads.push({thread, derived});
        } else {
          activeThreads.push({thread, derived});
        }
      }

      const attentionCount = openDecisions.length + needsAttention.length;
      const recentArtifacts = state.artifacts.slice(0, 6);
      const hasAnyContent =
        Boolean(recap && !recap.dismissed) ||
        attentionCount > 0 ||
        activeThreads.length > 0 ||
        recentArtifacts.length > 0 ||
        completedThreads.length > 0 ||
        Boolean(rawHtml);

      const srcDoc = rawHtml
        ? buildStatusPageSrcDoc(
            rawHtml,
            recap && !recap.dismissed ? recap.text : undefined,
            sections,
          )
        : '';

      return `
        <div class="mp-po-overview-tab">
          ${
            recap && !recap.dismissed
              ? `<section class="mp-po-recap epitaxy-root" aria-label="Project recap">
                  <header>
                    <strong>Recap</strong>
                    <button type="button" class="mp-po-icon-btn" data-po-action="dismiss-recap" aria-label="Dismiss recap">${iconHtml('X', 'xs')}</button>
                  </header>
                  <p class="mp-po-recap-body">${esc(recap.text)}</p>
                  ${
                    recap.links?.length
                      ? `<div class="mp-po-recap-links">${recap.links
                          .map(
                            l =>
                              `<button type="button" data-po-thread="${esc(l.threadId || '')}">${esc(l.label)}</button>`,
                          )
                          .join('')}</div>`
                      : ''
                  }
                </section>`
              : ''
          }

          ${
            attentionCount > 0
              ? `<section class="mp-po-v2-sec" aria-label="Needs attention">
                  <h2>Needs attention <span class="count">(${attentionCount})</span></h2>
                  <ul class="attn">
                    ${openDecisions
                      .map(
                        card => `
                      <li class="is-decision">
                        <button type="button" class="mp-po-v2-card-btn" data-po-focus-decision="${esc(card.id)}">
                          <span class="mp-po-v2-card-top">
                            <span class="mp-po-thread-badge text-warning">${iconHtml('Warning', 'xs')}<span>Decision</span></span>
                          </span>
                          <strong>${esc(card.question)}</strong>
                        </button>
                      </li>`,
                      )
                      .join('')}
                    ${needsAttention
                      .map(
                        ({thread, derived}) => `
                      <li>
                        <button type="button" class="mp-po-v2-card-btn" data-po-thread="${esc(thread.id)}">
                          <span class="mp-po-v2-card-top">
                            <span class="mp-po-thread-badge ${esc(derived.tone)}">${iconHtml(derived.icon, 'xs')}<span>${esc(derived.label)}</span></span>
                            ${thread.worktreeBranch ? `<span class="mp-po-v2-branch">${esc(thread.worktreeBranch)}</span>` : ''}
                          </span>
                          <strong>${esc(thread.title)}</strong>
                        </button>
                      </li>`,
                      )
                      .join('')}
                  </ul>
                </section>`
              : ''
          }

          ${
            activeThreads.length > 0
              ? `<section class="mp-po-v2-sec" aria-label="Active threads">
                  <h2>Active threads <span class="count">(${activeThreads.length})</span></h2>
                  <ul class="threads">
                    ${activeThreads
                      .map(({thread, derived}) => {
                        const isWorking =
                          Boolean(activeRuns[thread.id]?.running) ||
                          derived.status === 'running' ||
                          derived.status === 'in_progress';
                        return `
                      <li>
                        <button type="button" class="mp-po-v2-card-btn" data-po-thread="${esc(thread.id)}">
                          <span class="mp-po-v2-card-top">
                            <span class="prog${isWorking ? ' is-live' : ''}" aria-hidden="true">
                              <span class="cells"></span>
                              <span class="cells"></span>
                              <span class="cells"></span>
                            </span>
                            <span class="mp-po-thread-badge ${esc(derived.tone)}">${esc(derived.label)}</span>
                            ${thread.worktreeBranch ? `<span class="mp-po-v2-branch">${esc(thread.worktreeBranch)}</span>` : ''}
                          </span>
                          <strong>${esc(thread.title)}</strong>
                        </button>
                      </li>`;
                      })
                      .join('')}
                  </ul>
                </section>`
              : ''
          }

          ${
            recentArtifacts.length > 0
              ? `<section class="mp-po-v2-sec" aria-label="Artifacts">
                  <h2>Artifacts <span class="count">(${state.artifacts.length})</span></h2>
                  <ul class="threads mp-po-v2-artifacts">
                    ${recentArtifacts
                      .map(
                        art => `
                      <li class="mp-po-v2-artifact-row">
                        <div class="mp-po-v2-artifact-info">
                          ${iconHtml(art.kind === 'file' ? 'File' : 'Artifacts', 'xs')}
                          <div>
                            <strong>${esc(art.title)}</strong>
                            <small>${esc(art.pathOrUrl)}</small>
                          </div>
                        </div>
                        <button type="button" class="mp-po-icon-btn" data-po-pin-artifact="${esc(art.id)}" data-pinned="${art.pinned ? 'false' : 'true'}" aria-label="${art.pinned ? 'Unpin' : 'Pin'} ${esc(art.title)}" title="${art.pinned ? 'Unpin' : 'Pin'}">
                          ${iconHtml(art.pinned ? 'PinSlash' : 'Pin', 'xs')}
                        </button>
                      </li>`,
                      )
                      .join('')}
                  </ul>
                </section>`
              : ''
          }

          ${
            completedThreads.length > 0
              ? `<section class="mp-po-v2-sec" aria-label="Completed threads">
                  <h2>Completed threads <span class="count">(${completedThreads.length})</span></h2>
                  <ul class="threads done">
                    ${completedThreads
                      .map(
                        ({thread, derived}) => `
                      <li>
                        <button type="button" class="mp-po-v2-card-btn" data-po-thread="${esc(thread.id)}">
                          <span class="mp-po-v2-card-top">
                            <span class="prog done">${iconHtml('CheckCircle', 'xs')}</span>
                            <span class="mp-po-v2-done-title">${esc(thread.title)}</span>
                            <span class="mp-po-v2-done-label">${esc(derived.label)}</span>
                          </span>
                        </button>
                      </li>`,
                      )
                      .join('')}
                  </ul>
                </section>`
              : ''
          }

          ${
            sectionIds.length > 0
              ? `<div class="mp-po-status-toolbar">
                  <span>Status Canvas</span>
                  <div class="mp-po-status-controls">
                    ${
                      hiddenCount > 0
                        ? `<button type="button" class="mp-po-btn" data-po-action="restore-sections">${hiddenCount} hidden · Restore</button>`
                        : ''
                    }
                    <button type="button" class="mp-po-btn" data-po-action="reset-sections">${iconHtml('ArrowClockwise', 'xs')}<span>Reset section order</span></button>
                  </div>
                </div>
                <div class="mp-po-section-pills">
                  ${sectionIds
                    .map((sid, idx) => {
                      const isHidden = (sections.hiddenIds || []).includes(sid);
                      return `<span class="mp-po-sec-pill${isHidden ? ' is-hidden' : ''}">
                        <span>${esc(sid)}</span>
                        <button type="button" data-po-move-section="${esc(sid)}" data-dir="-1" aria-label="Move ${esc(sid)} up" ${idx === 0 ? 'disabled' : ''}>↑</button>
                        <button type="button" data-po-move-section="${esc(sid)}" data-dir="1" aria-label="Move ${esc(sid)} down" ${idx === sectionIds.length - 1 ? 'disabled' : ''}>↓</button>
                        <button type="button" data-po-toggle-section="${esc(sid)}">${isHidden ? 'Show' : 'Dismiss'}</button>
                      </span>`;
                    })
                    .join('')}
                </div>`
              : ''
          }

          ${
            rawHtml
              ? `<iframe class="mp-po-status-iframe" data-po-status-iframe sandbox="allow-scripts" title="Project status page" srcdoc="${esc(srcDoc)}"></iframe>`
              : ''
          }

          ${
            !hasAnyContent
              ? '<p class="mp-po-v2-empty">Project overview updates live as the Coordinator delegates worker threads.</p>'
              : ''
          }
        </div>
      `;
    }

    function resolveSelectedThread(): ProjectOverviewThread | undefined {
      if (!selectedThreadId) {
        return undefined;
      }
      return (
        state.threads.find(t => t.id === selectedThreadId) ||
        (optimisticThread?.id === selectedThreadId
          ? optimisticThread
          : undefined)
      );
    }

    function renderFocusedThreadDetail(thread: ProjectOverviewThread): string {
      const readOnly = isReadOnly();
      const hasWorktree = Boolean(thread.worktreeBranch || thread.worktreePath);
      const messages = thread.messages || [];
      const followupValue = followupDrafts.get(thread.id) || '';
      const activeRuns = getActiveRunsMap();
      const threadRun = activeRuns[thread.id];
      const checklist = extractThreadChecklist(thread);
      const openDecisions = state.decisions.filter(
        d => d.status === 'open' && d.threadId === thread.id,
      );
      const workerModel = getEffectiveModel('worker');
      const workerEffort = getEffectiveEffort('worker');
      const contextPct = estimateThreadContextPercent(thread, followupValue);
      const retryPrompt = (thread.lastPromptText || thread.body || '').trim();

      return `
        <div class="mp-po-thread-focused" data-focused-thread-id="${esc(thread.id)}">
          <div class="mp-po-thread-feed">
            ${drawerActionError ? `<p class="mp-po-error-banner" role="alert">${esc(drawerActionError)}</p>` : ''}

            ${
              checklist.total > 0
                ? `<section class="mp-po-checklist-card" aria-label="Task checklist">
                    <header>
                      <strong>Tasks</strong>
                      <span>${checklist.done} / ${checklist.total}</span>
                    </header>
                    <ul>
                      ${checklist.items
                        .map(
                          item => `
                        <li class="${item.done ? 'is-done' : ''}">
                          <span class="mp-po-check-glyph" aria-hidden="true">${item.done ? '✓' : '○'}</span>
                          <span>${esc(item.label)}</span>
                        </li>`,
                        )
                        .join('')}
                    </ul>
                  </section>`
                : ''
            }

            ${
              thread.body
                ? `<details class="mp-po-brief-disclosure">
                    <summary>
                      <span>Task prompt</span>
                      ${iconHtml('CaretRight', 'xs')}
                    </summary>
                    <div class="mp-po-brief-body">${renderMarkdownHtml(thread.body)}</div>
                  </details>`
                : ''
            }

            ${
              messages.length === 0 && !threadRun?.running
                ? '<p class="mp-po-empty">No messages in this thread yet.</p>'
                : messages
                    .map(msg => {
                      const forwardedDivider = msg.routeFromOverview
                        ? `<details class="mp-po-forwarded-bar">
                            <summary><span>Message forwarded from project chat</span>${iconHtml('CaretRight', 'xs')}</summary>
                            <div class="mp-po-forwarded-note">Dispatched by Coordinator from the main project chat.</div>
                          </details>`
                        : '';
                      if (msg.author === 'user' || msg.author === 'coordinator') {
                        return `
                          ${forwardedDivider}
                          <div class="mp-po-thread-msg-turn is-${esc(msg.author)}">
                            <div class="mp-po-user-bubble mp-po-thread-user-bubble">${esc(msg.text)}</div>
                            <span class="mp-po-thread-msg-meta">${esc(msg.author === 'coordinator' ? 'Coordinator' : 'You')} · ${esc(formatTimestamp(msg.timestamp))}</span>
                          </div>
                        `;
                      }
                      if (isWorkerErrorText(msg.text)) {
                        return `
                          ${forwardedDivider}
                          <div class="mp-po-thread-error-callout mp-po-calm-error" role="status">
                            <span class="mp-po-calm-error-text">${esc(humanizeProjectError(msg.text))}</span>
                            ${
                              retryPrompt && !readOnly
                                ? `<button type="button" class="mp-po-calm-retry" data-po-retry-thread="${esc(thread.id)}">Retry</button>`
                                : ''
                            }
                          </div>
                        `;
                      }
                      const tsLabel = formatTimestamp(msg.timestamp);
                      return `
                        ${forwardedDivider}
                        <article class="mp-po-thread-msg is-${esc(msg.author)}">
                          ${renderMarkdownHtml(msg.text)}
                          <div class="mp-po-turn-meta-row">
                            <button type="button" class="mp-po-meta-icon-btn" data-po-copy-text="${esc(msg.text)}" aria-label="Copy reply" title="Copy">${iconHtml('Copy', 'xs')}</button>
                            ${tsLabel ? `<span class="mp-po-turn-time">${esc(tsLabel)}</span>` : ''}
                          </div>
                        </article>
                      `;
                    })
                    .join('')
            }

            ${threadRun?.running ? renderLiveRunTurn(thread.id, threadRun, true) : ''}
            ${openDecisions.map(card => renderDecisionCard(card, readOnly)).join('')}
          </div>

          <div class="mp-po-thread-composer-dock">
            <form class="mp-po-composer mp-po-thread-composer" data-po-followup-form data-thread-id="${esc(thread.id)}">
              ${followupError ? `<p class="mp-po-calm-error-text" role="alert">${esc(humanizeProjectError(followupError))}</p>` : ''}
              <div class="mp-po-input-box">
                <textarea name="followup" data-po-followup-input rows="2" placeholder="Steer this thread..." ${readOnly || followupSending ? 'disabled' : ''}>${esc(followupValue)}</textarea>
                ${
                  threadRun?.running
                    ? `<button type="button" class="mp-po-composer-send is-stop" data-po-action="stop-thread-run" data-thread-id="${esc(thread.id)}" aria-label="Stop thread run" title="Stop">${iconHtml('StopFilled', 'sm')}</button>`
                    : `<button type="submit" class="mp-po-composer-send is-inline-return" data-po-followup-send aria-label="Steer thread" title="Send" ${readOnly || followupSending ? 'disabled' : ''}>${iconHtml('ArrowReturn', 'sm')}</button>`
                }
              </div>
              <div class="mp-po-composer-bar">
                <div class="mp-po-composer-meta">
                  <span class="mp-po-workspace-tag">
                    ${hasWorktree ? `${iconHtml('GitBranch', 'xs')}<span>${esc(thread.worktreeBranch || 'Worktree')}</span>` : '<span>Project workspace</span>'}
                  </span>
                </div>
                <div class="mp-po-composer-actions">
                  <div class="mp-po-picker-anchor">
                    <button type="button" class="mp-po-picker-btn" data-po-action="toggle-worker-model" aria-haspopup="listbox" aria-expanded="${openPicker === 'worker-model' ? 'true' : 'false'}" title="Worker model: ${esc(workerModel)}">
                      <span class="mp-po-picker-btn-label">${esc(formatModelDisplayName(workerModel))}</span>
                    </button>
                    ${renderModelPickerPopover('worker', workerModel)}
                  </div>
                  <div class="mp-po-picker-anchor">
                    <button type="button" class="mp-po-picker-btn" data-po-action="toggle-worker-effort" aria-haspopup="listbox" aria-expanded="${openPicker === 'worker-effort' ? 'true' : 'false'}" title="Worker reasoning effort: ${esc(capitalizeEffort(workerEffort))}">
                      <span>${esc(capitalizeEffort(workerEffort))}</span>
                    </button>
                    ${renderEffortPickerPopover('worker', workerEffort)}
                  </div>
                  ${renderContextRingSvg(contextPct)}
                </div>
              </div>
            </form>
          </div>
        </div>
      `;
    }

    function renderDiffModal(): string {
      if (!diffModal) {
        return '';
      }
      const thread = state.threads.find(t => t.id === diffModal?.threadId);
      const title = thread?.title || diffModal.threadId;
      const readOnly = isReadOnly();
      const files = diffModal.files || [];

      return `
        <div class="mp-po-modal-backdrop" data-po-diff-backdrop>
          <section class="mp-po-diff-modal" role="dialog" aria-modal="true" aria-label="Worktree diff for ${esc(title)}">
            <header class="mp-po-diff-head">
              <div>
                <h3>Worktree Diff · ${esc(title)}</h3>
                ${thread?.worktreeBranch ? `<span class="mp-po-thread-branch">${iconHtml('GitBranch', 'xs')}<span>${esc(thread.worktreeBranch)}</span></span>` : ''}
              </div>
              <button type="button" class="mp-po-icon-btn" data-po-action="close-diff-modal" aria-label="Close diff modal">${iconHtml('X', 'xs')}</button>
            </header>

            <div class="mp-po-diff-body">
              ${
                diffModal.loading
                  ? `<div class="mp-po-diff-loading">${iconHtml('Spinner', 'sm')}<span>Inspecting worktree changes...</span></div>`
                  : `
                    ${diffModal.error ? `<p class="mp-po-error-banner" role="alert">${esc(diffModal.error)}</p>` : ''}
                    ${diffModal.summary ? `<div class="mp-po-diff-summary">${esc(diffModal.summary)}</div>` : ''}
                    ${
                      files.length > 0
                        ? `<div class="mp-po-diff-files">${files.map(f => `<span class="mp-po-diff-file-chip">${iconHtml('File', 'xs')}<span>${esc(f)}</span></span>`).join('')}</div>`
                        : ''
                    }
                    ${
                      diffModal.diff
                        ? `<pre class="mp-po-diff-pre">${renderDiffLinesHtml(diffModal.diff)}</pre>`
                        : '<p class="mp-po-empty">No uncommitted changes in this worktree.</p>'
                    }
                  `
              }
              ${diffModal.mergeError ? `<p class="mp-po-error-banner" role="alert">${esc(diffModal.mergeError)}</p>` : ''}
            </div>

            <footer class="mp-po-diff-foot">
              <button type="button" class="mp-po-btn" data-po-action="close-diff-modal">Close</button>
              <button type="button" class="mp-po-btn is-primary" data-po-merge-worktree="${esc(diffModal.threadId)}" ${diffModal.loading || diffModal.merging || readOnly ? 'disabled' : ''}>
                ${iconHtml('GitMergeQueue', 'xs')}<span>${diffModal.merging ? 'Merging...' : 'Merge to main'}</span>
              </button>
            </footer>
          </section>
        </div>
      `;
    }

    function renderThreadRow(
      thread: ProjectOverviewThread,
      groupKey: ThreadGroupKey,
      derived: ReturnType<typeof deriveThreadClientStatus>,
      activeRun: ProjectOverviewActiveRun | undefined,
      now: number,
    ): string {
      const checklist = extractThreadChecklist(thread);
      const rel = formatRelativeTime(thread.lastReplyAt || thread.createdAt, now);
      const steps = extractToolSteps(activeRun?.trajectory);
      const lastStep = steps[steps.length - 1];
      const lastMsg = [...(thread.messages || [])]
        .reverse()
        .find(m => m.author === 'worker' || m.author === 'system');

      let summary = '';
      if (groupKey === 'working') {
        summary =
          activeRun?.retryNotice ||
          (lastStep
            ? lastStep.summary || lastStep.name
            : firstLineSnippet(activeRun?.answer)) ||
          'Working…';
      } else if (groupKey === 'waiting') {
        const msgText = lastMsg?.text || '';
        summary =
          (isWorkerErrorText(msgText)
            ? firstLineSnippet(humanizeProjectError(msgText))
            : firstLineSnippet(msgText)) ||
          firstLineSnippet(thread.body) ||
          derived.label;
      } else {
        const msgText = lastMsg?.text || '';
        summary =
          (isWorkerErrorText(msgText)
            ? firstLineSnippet(humanizeProjectError(msgText))
            : firstLineSnippet(msgText)) ||
          firstLineSnippet(thread.body) ||
          derived.label;
      }

      const glyphHtml =
        groupKey === 'resolved'
          ? `<span class="mp-po-status-check" aria-hidden="true">${iconHtml('CheckCircle', 'xs')}</span>`
          : `<span class="mp-po-status-dot is-${groupKey}" aria-hidden="true"></span>`;

      const pillHtml =
        checklist.total > 0
          ? renderChecklistPieSvg(checklist.done, checklist.total)
          : groupKey === 'working' && activeRun?.startedAt
            ? `<span class="mp-po-elapsed-pill" data-po-live-timer="${esc(thread.id)}">${esc(formatElapsedSeconds(activeRun.startedAt, now))}</span>`
            : '';

      return `
        <button type="button" class="mp-po-thread-row is-${groupKey}${thread.hasUnread ? ' is-unread' : ''}" data-po-thread="${esc(thread.id)}">
          <span class="mp-po-thread-row-main">
            ${glyphHtml}
            <span class="mp-po-thread-row-text">
              <span class="mp-po-thread-row-title-line">
                <strong>${esc(thread.title)}</strong>
                ${thread.worktreeBranch ? `<span class="mp-po-row-branch">${iconHtml('GitBranch', 'xs')}<span>${esc(thread.worktreeBranch)}</span></span>` : ''}
              </span>
              ${summary ? `<span class="mp-po-thread-row-summary">${esc(summary)}</span>` : ''}
            </span>
          </span>
          <span class="mp-po-thread-row-meta">
            ${pillHtml}
            ${rel ? `<span class="mp-po-thread-row-time">${esc(rel)}</span>` : ''}
          </span>
        </button>
      `;
    }

    function renderThreadsHome(): string {
      const readOnly = isReadOnly();
      const now = Date.now();
      const activeRuns = getActiveRunsMap();
      const openDecisionThreadIds = new Set(
        state.decisions
          .filter(d => d.status === 'open' && Boolean(d.threadId))
          .map(d => d.threadId as string),
      );

      const query = threadSearchQuery.trim().toLowerCase();
      const filteredThreads = query
        ? state.threads.filter(t => {
            const hay = `${t.title} ${t.body || ''} ${t.worktreeBranch || ''}`.toLowerCase();
            return hay.includes(query);
          })
        : state.threads;

      const waiting: Array<{
        thread: ProjectOverviewThread;
        derived: ReturnType<typeof deriveThreadClientStatus>;
      }> = [];
      const working: Array<{
        thread: ProjectOverviewThread;
        derived: ReturnType<typeof deriveThreadClientStatus>;
      }> = [];
      const idle: Array<{
        thread: ProjectOverviewThread;
        derived: ReturnType<typeof deriveThreadClientStatus>;
      }> = [];
      const resolved: Array<{
        thread: ProjectOverviewThread;
        derived: ReturnType<typeof deriveThreadClientStatus>;
      }> = [];

      for (const thread of filteredThreads) {
        const {group, derived} = classifyThreadGroup(
          thread,
          activeRuns[thread.id],
          openDecisionThreadIds,
          now,
        );
        if (group === 'waiting') {
          waiting.push({thread, derived});
        } else if (group === 'working') {
          working.push({thread, derived});
        } else if (group === 'resolved') {
          resolved.push({thread, derived});
        } else {
          idle.push({thread, derived});
        }
      }

      if (!resolvedDefaultInitialized) {
        resolvedDefaultInitialized = true;
        if (waiting.length > 0 || working.length > 0 || idle.length > 0) {
          collapsedGroups.add('resolved');
        }
      }

      const newThreadFormHtml =
        newThreadOpen && !readOnly
          ? `<form class="mp-po-new-thread-card" data-po-new-thread-form>
              <div class="mp-po-new-thread-head">
                <strong>New Thread</strong>
                <button type="button" class="mp-po-icon-btn" data-po-action="cancel-new-thread" aria-label="Cancel new thread">${iconHtml('X', 'xs')}</button>
              </div>
              <label class="mp-po-field">
                <span>Title</span>
                <input type="text" name="title" value="${esc(newThreadTitleDraft)}" placeholder="Thread title (optional)" ${newThreadSending ? 'disabled' : ''}>
              </label>
              <label class="mp-po-field">
                <span>Prompt</span>
                <textarea name="prompt" rows="3" placeholder="Describe what this worker thread should accomplish..." required ${newThreadSending ? 'disabled' : ''}>${esc(newThreadPromptDraft)}</textarea>
              </label>
              <label class="mp-po-checkbox">
                <input type="checkbox" name="useWorktree" ${newThreadUseWorktree ? 'checked' : ''} ${newThreadSending ? 'disabled' : ''}>
                <span>Isolated git worktree</span>
              </label>
              ${newThreadError ? `<p class="mp-po-error-banner" role="alert">${esc(newThreadError)}</p>` : ''}
              <div class="mp-po-new-thread-foot">
                <button type="button" class="mp-po-btn" data-po-action="cancel-new-thread" ${newThreadSending ? 'disabled' : ''}>Cancel</button>
                <button type="submit" class="mp-po-btn is-primary" ${newThreadSending ? 'disabled' : ''}>
                  ${iconHtml('Play', 'xs')}<span>${newThreadSending ? 'Starting...' : 'Start thread'}</span>
                </button>
              </div>
            </form>`
          : '';

      const searchBarHtml = threadSearchOpen
        ? `<div class="mp-po-thread-search-bar">
            ${iconHtml('Search', 'xs')}
            <input type="search" data-po-thread-search value="${esc(threadSearchQuery)}" placeholder="Filter threads..." aria-label="Filter threads">
            ${threadSearchQuery ? `<button type="button" class="mp-po-icon-btn" data-po-action="clear-thread-search" aria-label="Clear search">${iconHtml('X', 'xs')}</button>` : ''}
          </div>`
        : '';

      if (threadsViewMode === 'board') {
        const columns: Array<{key: BoardCol; title: string}> = [
          {key: 'blocked', title: 'Needs input'},
          {key: 'review', title: 'Ready for review'},
          {key: 'working', title: 'Working'},
          {key: 'done', title: 'Completed'},
        ];
        const grouped: Record<
          BoardCol,
          Array<{
            thread: ProjectOverviewThread;
            derived: ReturnType<typeof deriveThreadClientStatus>;
          }>
        > = {blocked: [], review: [], working: [], done: []};

        for (const thread of filteredThreads) {
          const derived = deriveThreadClientStatus(thread, now);
          grouped[derived.boardColumn].push({thread, derived});
        }

        return `
          <div class="mp-po-threads-tab${boardExpanded ? ' is-expanded' : ''}">
            ${searchBarHtml}
            ${newThreadFormHtml}
            <div class="mp-po-threads-board">
              ${columns
                .map(
                  col => `
                <section class="mp-po-board-col" data-board-col="${col.key}">
                  <header>
                    <h3>${col.title}</h3>
                    <span class="mp-po-col-count">${grouped[col.key].length}</span>
                  </header>
                  <div class="mp-po-board-cards">
                    ${
                      grouped[col.key].length === 0
                        ? '<p class="mp-po-col-empty">No threads</p>'
                        : grouped[col.key]
                            .map(
                              ({thread, derived}) => `
                          <article class="mp-po-thread-card" data-thread-id="${esc(thread.id)}">
                            <button type="button" class="mp-po-thread-open" data-po-thread="${esc(thread.id)}">
                              <span class="mp-po-thread-badge ${esc(derived.tone)}">${iconHtml(derived.icon, 'xs')}<span>${esc(derived.label)}</span></span>
                              <strong>${esc(thread.title)}</strong>
                            </button>
                            ${
                              thread.worktreeBranch
                                ? `<div class="mp-po-thread-branch">${iconHtml('GitBranch', 'xs')}<span>${esc(thread.worktreeBranch)}</span></div>`
                                : ''
                            }
                            <div class="mp-po-thread-actions">
                              <button type="button" class="mp-po-btn" data-po-remind="${esc(thread.id)}">${iconHtml('Clock', 'xs')}<span>Remind later</span></button>
                              <button type="button" class="mp-po-btn" data-po-resolve="${esc(thread.id)}" data-resolved="${derived.status === 'resolved' ? 'false' : 'true'}">${iconHtml('Check', 'xs')}<span>${derived.status === 'resolved' ? 'Reopen' : 'Resolve'}</span></button>
                              <button type="button" class="mp-po-btn" data-po-diff="${esc(thread.id)}">${iconHtml('GitMergeQueue', 'xs')}<span>Diff</span></button>
                              <button type="button" class="mp-po-btn is-danger" data-po-discard="${esc(thread.id)}">${iconHtml('Trash', 'xs')}<span>Discard</span></button>
                            </div>
                          </article>`,
                            )
                            .join('')
                    }
                  </div>
                </section>`,
                )
                .join('')}
            </div>
          </div>
        `;
      }

      const waitingCount = waiting.length;
      const waitingSubtitle =
        waitingCount === 0
          ? 'Nothing is waiting on you.'
          : waitingCount === 1
            ? '1 thread is waiting on you.'
            : `${waitingCount} threads are waiting on you.`;

      const renderGroup = (
        key: ThreadGroupKey,
        title: string,
        items: Array<{
          thread: ProjectOverviewThread;
          derived: ReturnType<typeof deriveThreadClientStatus>;
        }>,
      ) => {
        if (items.length === 0) {
          return '';
        }
        const collapsed = collapsedGroups.has(key);
        return `
          <section class="mp-po-thread-group is-${key}" data-po-thread-group="${key}">
            <button type="button" class="mp-po-thread-group-head" data-po-toggle-group="${key}" aria-expanded="${collapsed ? 'false' : 'true'}">
              ${iconHtml(collapsed ? 'CaretRight' : 'CaretDown', 'xs')}
              <span class="mp-po-group-title">${esc(title)}</span>
              <span class="mp-po-group-count">${items.length}</span>
            </button>
            ${
              collapsed
                ? ''
                : `<div class="mp-po-thread-group-list">
                    ${items
                      .map(({thread, derived}) =>
                        renderThreadRow(
                          thread,
                          key,
                          derived,
                          activeRuns[thread.id],
                          now,
                        ),
                      )
                      .join('')}
                  </div>`
            }
          </section>
        `;
      };

      return `
        <div class="mp-po-threads-home">
          ${searchBarHtml}
          ${newThreadFormHtml}
          <div class="mp-po-welcome-banner">
            <h2 class="mp-po-welcome-heading">Welcome back, ${esc(state.userName || 'there')}.</h2>
            <p class="mp-po-welcome-sub">${esc(waitingSubtitle)}</p>
          </div>
          ${
            filteredThreads.length === 0
              ? `<div class="mp-po-threads-empty">
                  <p>${query ? 'No threads match your filter.' : 'No worker threads yet. Ask the Coordinator or start a new thread.'}</p>
                </div>`
              : `<div class="mp-po-thread-groups">
                  ${renderGroup('waiting', 'Waiting on you', waiting)}
                  ${renderGroup('working', 'Working', working)}
                  ${renderGroup('idle', 'Idle', idle)}
                  ${hideResolved ? '' : renderGroup('resolved', 'Resolved', resolved)}
                </div>`
          }
        </div>
      `;
    }

    function renderRightHeader(
      tileTab: RightTileTab,
      selectedThread: ProjectOverviewThread | undefined,
    ): string {
      const readOnly = isReadOnly();
      if (tileTab === 'threads' && selectedThread) {
        const derived = deriveThreadClientStatus(selectedThread);
        const sessionId = selectedThread.boundSessionIds?.[0];
        const hasWorktree = Boolean(
          selectedThread.worktreeBranch || selectedThread.worktreePath,
        );
        return `
          <header class="mp-po-right-header">
            <div class="mp-po-breadcrumb">
              <button type="button" class="mp-po-breadcrumb-back" data-po-action="close-thread">Threads</button>
              <span class="mp-po-breadcrumb-sep" aria-hidden="true">${iconHtml('CaretRight', 'xs')}</span>
              <span class="mp-po-breadcrumb-current" title="${esc(selectedThread.title)}">${esc(selectedThread.title)}</span>
            </div>
            <div class="mp-po-right-actions">
              ${
                sessionId
                  ? `<button type="button" class="mp-po-icon-btn" data-po-open-session="${esc(sessionId)}" aria-label="Open session" title="Open session">${iconHtml('Play', 'xs')}</button>`
                  : ''
              }
              <button type="button" class="mp-po-icon-btn" data-po-diff="${esc(selectedThread.id)}" aria-label="Inspect diff" title="Inspect diff">${iconHtml('GitMergeQueue', 'xs')}</button>
              ${
                hasWorktree
                  ? `<button type="button" class="mp-po-icon-btn" data-po-merge-worktree="${esc(selectedThread.id)}" ${readOnly ? 'disabled' : ''} aria-label="Merge worktree" title="Merge worktree">${iconHtml('GitBranch', 'xs')}</button>`
                  : ''
              }
              <button type="button" class="mp-po-icon-btn${derived.status === 'resolved' ? ' is-active' : ''}" data-po-resolve="${esc(selectedThread.id)}" data-resolved="${derived.status === 'resolved' ? 'false' : 'true'}" aria-label="${derived.status === 'resolved' ? 'Reopen thread' : 'Resolve thread'}" title="${derived.status === 'resolved' ? 'Reopen thread' : 'Resolve thread'}">${iconHtml('CheckCircle', 'xs')}</button>
              <button type="button" class="mp-po-icon-btn is-danger" data-po-discard="${esc(selectedThread.id)}" aria-label="Discard thread" title="Discard thread">${iconHtml('Trash', 'xs')}</button>
              <button type="button" class="mp-po-icon-btn" data-po-action="close-thread" aria-label="Close thread" title="Back to Threads">${iconHtml('X', 'xs')}</button>
            </div>
          </header>
        `;
      }

      if (tileTab === 'threads') {
        const activeCount = state.threads.filter(t => {
          const s = deriveThreadClientStatus(t).status;
          return s !== 'resolved' && s !== 'archived' && s !== 'done';
        }).length;
        return `
          <header class="mp-po-right-header">
            <div class="mp-po-right-title">
              ${iconHtml('LayoutList', 'xs')}
              <span>Threads</span>
              ${state.threads.length > 0 ? `<span class="mp-po-right-count">${activeCount}/${state.threads.length}</span>` : ''}
            </div>
            <div class="mp-po-right-actions">
              <button type="button" class="mp-po-icon-btn${threadSearchOpen ? ' is-active' : ''}" data-po-action="toggle-thread-search" aria-label="Search threads" title="Search threads">${iconHtml('Search', 'xs')}</button>
              <button type="button" class="mp-po-icon-btn" data-po-action="open-new-thread" aria-label="New thread" title="New thread" ${readOnly ? 'disabled' : ''}>${iconHtml('Add', 'xs')}</button>
              <button type="button" class="mp-po-icon-btn${threadsViewMode === 'board' ? ' is-active' : ''}" data-po-action="toggle-board-view" aria-label="${threadsViewMode === 'board' ? 'List view' : 'Board view'}" title="${threadsViewMode === 'board' ? 'Switch to List view' : 'Switch to Board view'}">${iconHtml(threadsViewMode === 'board' ? 'LayoutList' : 'LayoutGrid', 'xs')}</button>
              <button type="button" class="mp-po-icon-btn${boardExpanded ? ' is-active' : ''}" data-po-action="toggle-expand-board" aria-label="${boardExpanded ? 'Compact split view' : 'Expand board'}" title="${boardExpanded ? 'Compact split view' : 'Expand full-width board'}">${iconHtml(boardExpanded ? 'Collapse' : 'Expand', 'xs')}</button>
              <button type="button" class="mp-po-icon-btn${hideResolved ? ' is-active' : ''}" data-po-action="toggle-hide-resolved" aria-label="${hideResolved ? 'Show resolved threads' : 'Hide resolved threads'}" title="${hideResolved ? 'Show resolved threads' : 'Hide resolved threads'}">${iconHtml('DotsHorizontal', 'xs')}</button>
            </div>
          </header>
        `;
      }

      const sectionTitle =
        tileTab === 'overview'
          ? 'Overview'
          : tileTab === 'artifacts'
            ? 'Artifacts'
            : 'Files & Memory';

      return `
        <header class="mp-po-right-header">
          <div class="mp-po-breadcrumb">
            <button type="button" class="mp-po-breadcrumb-back" data-po-tab="threads">Threads</button>
            <span class="mp-po-breadcrumb-sep" aria-hidden="true">/</span>
            <span class="mp-po-breadcrumb-current">${esc(sectionTitle)}</span>
          </div>
          <div class="mp-po-right-actions">
            <button type="button" class="mp-po-icon-btn" data-po-action="refresh" aria-label="Refresh" title="Refresh">${iconHtml('ArrowClockwise', 'xs')}</button>
            <button type="button" class="mp-po-icon-btn" data-po-action="toggle-right-tile" aria-label="Close panel" title="Close panel">${iconHtml('X', 'xs')}</button>
          </div>
        </header>
      `;
    }

    function renderArtifactsTab(): string {
      let items = [...state.artifacts];
      if (artifactFilter === 'pinned') {
        items = items.filter(a => a.pinned);
      }
      items.sort((a, b) =>
        artifactSort === 'recent'
          ? b.updatedAt - a.updatedAt
          : b.createdAt - a.createdAt,
      );

      return `
        <div class="mp-po-artifacts-tab">
          <div class="mp-po-toolbar">
            <div class="mp-po-segmented">
              <button type="button" class="${artifactFilter === 'all' ? 'is-active' : ''}" data-po-art-filter="all">All outputs</button>
              <button type="button" class="${artifactFilter === 'pinned' ? 'is-active' : ''}" data-po-art-filter="pinned">Pinned</button>
            </div>
            <select data-po-art-sort aria-label="Sort artifacts">
              <option value="newest" ${artifactSort === 'newest' ? 'selected' : ''}>Newest first</option>
              <option value="recent" ${artifactSort === 'recent' ? 'selected' : ''}>Recent</option>
            </select>
          </div>
          ${
            items.length === 0
              ? '<div class="mp-po-empty-box"><p>Artifacts published in this project appear here.</p></div>'
              : `<ul class="mp-po-artifact-list">${items
                  .map(
                    art => `
                <li class="mp-po-artifact-row">
                  <div class="mp-po-artifact-meta">
                    ${iconHtml(art.kind === 'file' ? 'File' : 'Artifacts', 'sm')}
                    <div>
                      <strong>${esc(art.title)}</strong>
                      <small>${esc(art.kind)} · ${esc(art.pathOrUrl)}</small>
                      ${art.summary ? `<p>${esc(art.summary)}</p>` : ''}
                    </div>
                  </div>
                  <button type="button" class="mp-po-btn" data-po-pin-artifact="${esc(art.id)}" data-pinned="${art.pinned ? 'false' : 'true'}">
                    ${iconHtml(art.pinned ? 'PinSlash' : 'Pin', 'xs')}
                    <span>${art.pinned ? 'Unpin' : 'Pin'}</span>
                  </button>
                </li>`,
                  )
                  .join('')}</ul>`
          }
        </div>
      `;
    }

    function renderFilesAndMemoryTab(): string {
      const readOnly = isReadOnly();
      const files = state.files || [];
      return `
        <div class="mp-po-files-memory">
          ${
            readOnly
              ? `<div class="mp-po-readonly-note">${iconHtml('MoonStars', 'sm')}<span>Files and /MEMORY.md are read-only while project is ${state.project.archived ? 'archived' : 'paused'}.</span></div>`
              : ''
          }
          <div class="mp-po-toolbar">
            <div class="mp-po-segmented" role="tablist" aria-label="Files and memory views">
              <button type="button" class="${filesSubTab === 'files' ? 'is-active' : ''}" data-po-files-subtab="files">Files (${files.length})</button>
              <button type="button" class="${filesSubTab === 'memory' ? 'is-active' : ''}" data-po-files-subtab="memory">Memory (${esc(memoryPath)})</button>
            </div>
          </div>

          <div class="mp-po-single-editor">
            <section class="mp-po-editor-pane"${filesSubTab !== 'files' ? ' hidden' : ''}>
              <header>
                <strong>${iconHtml('Folder', 'sm')} Shared Files (${files.length})</strong>
                <button type="button" class="mp-po-btn" data-po-action="new-file" ${readOnly ? 'disabled' : ''}>${iconHtml('Add', 'xs')}<span>New file</span></button>
              </header>
              <ul class="mp-po-file-list">
                ${
                  files.length === 0
                    ? '<li class="mp-po-empty">No shared files yet.</li>'
                    : files
                        .map(
                          f => `<li><button type="button" class="${f.path === selectedFilePath ? 'is-selected' : ''}" data-po-select-file="${esc(f.path)}">${esc(f.path)} <small>${f.size} B</small></button></li>`,
                        )
                        .join('')
                }
              </ul>
              <div class="mp-po-editor-box">
                <input type="text" data-po-file-path value="${esc(selectedFilePath)}" placeholder="notes/spec.md" ${readOnly ? 'disabled' : ''}>
                <textarea rows="8" data-po-file-content placeholder="File contents..." ${readOnly ? 'disabled' : ''}>${esc(fileContent)}</textarea>
                ${
                  fileConflictError
                    ? `<div class="mp-po-conflict-bar">
                        <span>${esc(fileConflictError)}</span>
                        <button type="button" class="mp-po-btn" data-po-action="save-file-overwrite">Replace</button>
                        <button type="button" class="mp-po-btn is-primary" data-po-action="save-file-keepboth">Keep both</button>
                      </div>`
                    : ''
                }
                <div class="mp-po-editor-foot">
                  <button type="button" class="mp-po-btn is-primary" data-po-action="save-file" ${readOnly ? 'disabled' : ''}>Save file</button>
                </div>
              </div>
            </section>

            <section class="mp-po-editor-pane"${filesSubTab !== 'memory' ? ' hidden' : ''}>
              <header>
                <strong>${iconHtml('Memory', 'sm')} Shared Memory (${esc(memoryPath)})</strong>
                <span class="mp-po-sha-pill" title="${esc(memorySha)}">CAS: ${esc(memorySha ? memorySha.slice(0, 8) : 'new')}</span>
              </header>
              <textarea rows="12" data-po-memory-content placeholder="# Shared project memory..." ${readOnly ? 'disabled' : ''}>${esc(memoryContent)}</textarea>
              ${
                memoryConflictSha
                  ? `<div class="mp-po-conflict-bar">
                      <span>Concurrent edit detected (SHA mismatch). Reload latest before saving.</span>
                      <button type="button" class="mp-po-btn is-primary" data-po-action="reload-memory">Reload latest</button>
                    </div>`
                  : ''
              }
              ${memoryStatusMsg ? `<p class="mp-po-status-msg">${esc(memoryStatusMsg)}</p>` : ''}
              <div class="mp-po-editor-foot">
                <button type="button" class="mp-po-btn is-primary" data-po-action="save-memory" ${readOnly ? 'disabled' : ''}>Save /MEMORY.md</button>
              </div>
            </section>
          </div>
        </div>
      `;
    }

    function renderSettingsModal(): string {
      if (!settingsOpen) {
        return '';
      }
      const cfg = state.project.multiAgentConfig || {};
      const rules = cfg.autoModeRules || [];
      const quietDays = cfg.quietAfterDays ?? 3;
      const resolveDays = cfg.autoResolveDays ?? 7;
      const lifecyclePreview = computeLifecyclePreview(
        state.threads,
        quietDays,
        resolveDays,
      );

      return `
        <div class="mp-po-modal-backdrop" data-po-settings-backdrop>
          <section class="mp-po-settings-modal" role="dialog" aria-modal="true" aria-label="Project settings">
            <header class="mp-po-settings-modal-head">
              <div class="mp-po-settings-modal-title">
                ${iconHtml('Settings', 'sm')}
                <h2>Project Settings</h2>
              </div>
              <button type="button" class="mp-po-icon-btn" data-po-action="close-settings-modal" aria-label="Close settings">${iconHtml('X', 'xs')}</button>
            </header>
            <div class="mp-po-settings-body">
              <form class="mp-po-settings" data-po-settings-form>
                ${settingsError ? `<p class="mp-po-error-banner" role="alert">${esc(settingsError)}</p>` : ''}

                <section class="mp-po-settings-group">
                  <h3>General</h3>
                  <label>Name<input name="name" value="${esc(state.project.name)}" required></label>
                  <label>Goal<input name="goal" value="${esc(state.project.goal || '')}" placeholder="Project goal for Coordinator"></label>
                  <label>Description<textarea name="description" rows="2">${esc(state.project.description || '')}</textarea></label>
                  <label>Instructions<textarea name="instructions" rows="3">${esc(state.project.instructions || '')}</textarea></label>
                  <div class="mp-po-row-2">
                    <label>Icon
                      <select name="projectIcon">
                        ${PROJECT_ICON_OPTIONS.map(ic => `<option value="${ic}" ${(state.project.projectIcon || 'Projects') === ic ? 'selected' : ''}>${ic}</option>`).join('')}
                      </select>
                    </label>
                    <label>Color
                      <select name="color">
                        ${PROJECT_PALETTE.map(c => `<option value="${c}" ${(state.project.color || PROJECT_PALETTE[0]) === c ? 'selected' : ''}>${c}</option>`).join('')}
                      </select>
                    </label>
                  </div>
                </section>

                <section class="mp-po-settings-group">
                  <h3>Models &amp; Team</h3>
                  <label>Agent team preset
                    <select name="agentTeam">
                      ${['solo', 'pair', 'squad', 'research', 'custom'].map(team => `<option value="${team}" ${(cfg.agentTeam || 'squad') === team ? 'selected' : ''}>${team}</option>`).join('')}
                    </select>
                  </label>
                  <div class="mp-po-row-2">
                    <label>Coordinator model<input name="coordinatorModel" value="${esc(cfg.coordinatorModel || '')}" placeholder="Default model"></label>
                    <label>Coordinator effort
                      <select name="coordinatorEffort">
                        ${['low', 'medium', 'high', 'xhigh', 'max'].map(e => `<option value="${e}" ${(cfg.coordinatorEffort || 'high') === e ? 'selected' : ''}>${e}</option>`).join('')}
                      </select>
                    </label>
                  </div>
                  <div class="mp-po-row-2">
                    <label>Worker thread model<input name="workerModel" value="${esc(cfg.workerModel || '')}" placeholder="Default worker model"></label>
                    <label>Worker effort
                      <select name="workerEffort">
                        ${['low', 'medium', 'high', 'xhigh', 'max'].map(e => `<option value="${e}" ${(cfg.workerEffort || 'medium') === e ? 'selected' : ''}>${e}</option>`).join('')}
                      </select>
                    </label>
                  </div>
                </section>

                <section class="mp-po-settings-group">
                  <h3>Environment &amp; Worktree</h3>
                  <p class="mp-po-help">Workspace root: <code>${esc(state.project.root || 'Virtual project (isolated thread sandboxes)')}</code></p>
                  <label>Default environment
                    <select name="defaultEnvironmentId">
                      <option value="">Default</option>
                      ${(state.project.environments || []).map(env => `<option value="${esc(env.id)}" ${state.project.defaultEnvironmentId === env.id ? 'selected' : ''}>${esc(env.name)}${env.worktree ? ' (worktree)' : ''}</option>`).join('')}
                    </select>
                  </label>
                </section>

                <section class="mp-po-settings-group">
                  <h3>Auto-Mode Rules (${rules.length} / 50)</h3>
                  <p class="mp-po-help">One allow rule per line (e.g. <code>tool:Project.*</code>, <code>bash:npm test*</code>, <code>path:src/**</code>). Maximum 50 rules.</p>
                  <textarea name="autoModeRules" rows="4" placeholder="tool:Project.*">${esc(rules.join('\n'))}</textarea>
                </section>

                <section class="mp-po-settings-group">
                  <h3>Thread Lifecycle &amp; Pacing</h3>
                  <label class="mp-po-checkbox">
                    <input type="checkbox" name="limitAutoContinue" ${cfg.limitAutoContinue ? 'checked' : ''}>
                    <span>Auto-continue when usage limits reset (while app stays open)</span>
                  </label>
                  <div class="mp-po-row-2">
                    <label>Quiet after days
                      <select name="quietAfterDays">
                        ${[1, 2, 3, 5, 7, 14].map(d => `<option value="${d}" ${quietDays === d ? 'selected' : ''}>${d} days</option>`).join('')}
                      </select>
                    </label>
                    <label>Auto-resolve after days
                      <select name="autoResolveDays">
                        ${[0, 3, 7, 14, 30].map(d => `<option value="${d}" ${resolveDays === d ? 'selected' : ''}>${d === 0 ? 'Never (0)' : `${d} days`}</option>`).join('')}
                      </select>
                    </label>
                  </div>
                  <div class="mp-po-lifecycle-preview" data-testid="thread-lifecycle-preview">
                    ${
                      !lifecyclePreview.valid
                        ? `<span class="mp-po-warn">${esc(lifecyclePreview.error)}</span>`
                        : lifecyclePreview.items.length === 0
                          ? '<span class="mp-po-help">No threads currently match lifecycle transition.</span>'
                          : `<ul>${lifecyclePreview.items.map(item => `<li>${esc(item.title)} → <strong>${esc(item.action)}</strong> (${item.idleDays}d idle)</li>`).join('')}</ul>`
                    }
                  </div>
                </section>

                <section class="mp-po-settings-group">
                  <h3>Notifications</h3>
                  <div class="mp-po-row-2">
                    <label>Notification level
                      <select name="notifyLevel">
                        <option value="all" ${cfg.notifyLevel === 'all' ? 'selected' : ''}>All activity</option>
                        <option value="coordinator" ${(cfg.notifyLevel || 'coordinator') === 'coordinator' ? 'selected' : ''}>Coordinator &amp; escalations</option>
                        <option value="mentions" ${cfg.notifyLevel === 'mentions' ? 'selected' : ''}>Mentions &amp; needs input</option>
                        <option value="none" ${cfg.notifyLevel === 'none' ? 'selected' : ''}>Muted</option>
                      </select>
                    </label>
                    <label>Sidebar badge clears when
                      <select name="waitingCount">
                        <option value="read" ${(cfg.waitingCount || 'read') === 'read' ? 'selected' : ''}>Thread is read</option>
                        <option value="answered" ${cfg.waitingCount === 'answered' ? 'selected' : ''}>Question is answered</option>
                      </select>
                    </label>
                  </div>
                </section>

                <div class="mp-po-settings-save">
                  <button type="button" class="mp-po-btn" data-po-action="close-settings-modal">Close</button>
                  <button type="submit" class="mp-po-btn is-primary">Save settings</button>
                </div>

                <section class="mp-po-settings-group is-danger-zone">
                  <h3>Danger Zone</h3>
                  <div class="mp-po-danger-actions">
                    <button type="button" class="mp-po-btn" data-po-action="toggle-pause">
                      ${iconHtml(state.project.paused ? 'Play' : 'MoonStars', 'xs')}
                      <span>${state.project.paused ? 'Resume project' : 'Pause project'}</span>
                    </button>
                    <button type="button" class="mp-po-btn" data-po-action="toggle-archive">
                      ${iconHtml('Archive', 'xs')}
                      <span>${state.project.archived ? 'Restore project' : 'Archive project'}</span>
                    </button>
                    <button type="button" class="mp-po-btn is-danger" data-po-action="delete-project">
                      ${iconHtml('Trash', 'xs')}
                      <span>Delete project</span>
                    </button>
                  </div>
                </section>
              </form>
            </div>
          </section>
        </div>
      `;
    }

    function renderIconPickerPopover(
      currentIcon: string,
      currentColor: string,
    ): string {
      if (!iconPickerOpen) {
        return '';
      }
      return `
        <div class="mp-po-icon-popover" role="dialog" aria-label="Customize project icon and color">
          <div class="mp-po-popover-label">Color</div>
          <div class="mp-po-palette-row">
            ${PROJECT_PALETTE.map(
              c =>
                `<button type="button" class="mp-po-color-swatch${c === currentColor ? ' is-selected' : ''}" data-po-pick-color="${esc(c)}" style="background:${esc(c)}" aria-label="Color ${esc(c)}"></button>`,
            ).join('')}
          </div>
          <div class="mp-po-popover-label">Icon</div>
          <div class="mp-po-icon-grid">
            ${PROJECT_ICON_OPTIONS.map(
              ic =>
                `<button type="button" class="mp-po-icon-choice${ic === currentIcon ? ' is-selected' : ''}" data-po-pick-icon="${esc(ic)}" aria-label="Icon ${esc(ic)}">${iconHtml(ic, 'sm')}</button>`,
            ).join('')}
          </div>
        </div>
      `;
    }

    function renderProjectMenu(): string {
      if (!projectMenuOpen) {
        return '';
      }
      return `
        <div class="mp-po-project-menu" role="menu" aria-label="Project actions">
          <button type="button" role="menuitem" data-po-tab="settings">${iconHtml('Settings', 'xs')}<span>Project settings</span></button>
          <button type="button" role="menuitem" data-po-action="toggle-pause">${iconHtml(state.project.paused ? 'Play' : 'MoonStars', 'xs')}<span>${state.project.paused ? 'Resume project' : 'Pause project'}</span></button>
          <button type="button" role="menuitem" data-po-action="toggle-archive">${iconHtml('Archive', 'xs')}<span>${state.project.archived ? 'Restore project' : 'Archive project'}</span></button>
          <button type="button" role="menuitem" class="is-danger" data-po-action="delete-project">${iconHtml('Trash', 'xs')}<span>Delete project</span></button>
        </div>
      `;
    }

    const SCROLL_SELECTORS = [
      '.mp-po-timeline',
      '.mp-po-right-body',
      '.mp-po-thread-feed',
      '.mp-po-diff-pre',
      '.mp-po-settings-body',
    ];

    const FOCUS_SELECTORS = [
      '[data-po-goal-input]',
      '[data-po-thread-search]',
      '[data-po-new-thread-form] input[name="title"]',
      '[data-po-new-thread-form] textarea[name="prompt"]',
      '[data-po-followup-input]',
      '[data-po-file-path]',
      '[data-po-file-content]',
      '[data-po-memory-content]',
    ];

    function paint(): void {
      const savedScrolls = new Map<string, number>();
      for (const sel of SCROLL_SELECTORS) {
        const el = root.querySelector<HTMLElement>(sel);
        if (el && typeof el.scrollTop === 'number') {
          savedScrolls.set(sel, el.scrollTop);
        }
      }

      let focusedSel: string | null = null;
      let selStart: number | null = null;
      let selEnd: number | null = null;
      const activeEl =
        typeof document !== 'undefined'
          ? (document.activeElement as HTMLElement | null)
          : null;
      if (
        activeEl &&
        typeof root.contains === 'function' &&
        root.contains(activeEl) &&
        typeof activeEl.matches === 'function'
      ) {
        for (const sel of FOCUS_SELECTORS) {
          if (activeEl.matches(sel)) {
            focusedSel = sel;
            const textEl = activeEl as HTMLInputElement | HTMLTextAreaElement;
            if (typeof textEl.selectionStart === 'number') {
              selStart = textEl.selectionStart;
              selEnd = textEl.selectionEnd ?? selStart;
            }
            break;
          }
        }
      }

      const tileTab: RightTileTab =
        activeTab === 'settings' ? lastNonSettingsTab : activeTab;
      const selectedThread =
        tileTab === 'threads' ? resolveSelectedThread() : undefined;

      const rightBodyHtml =
        tileTab === 'overview'
          ? renderOverviewTab()
          : tileTab === 'threads'
            ? selectedThread
              ? renderFocusedThreadDetail(selectedThread)
              : renderThreadsHome()
            : tileTab === 'artifacts'
              ? renderArtifactsTab()
              : renderFilesAndMemoryTab();

      const expandedClass =
        boardExpanded && tileTab === 'threads' && !selectedThread && !rightTileCollapsed
          ? ' is-board-expanded'
          : '';
      const collapsedClass = rightTileCollapsed ? ' is-right-collapsed' : '';
      root.className = `mp-po-shell${expandedClass}${collapsedClass}`;

      root.innerHTML = `
        <div class="mp-po-split">
          ${renderCoordinatorPane()}
          <aside class="mp-po-right${expandedClass ? ' is-expanded' : ''}" aria-label="Workspace panel"${rightTileCollapsed ? ' hidden' : ''}>
            ${renderRightHeader(tileTab, selectedThread)}
            <div class="mp-po-right-body${selectedThread && tileTab === 'threads' ? ' is-focused-thread' : ''}">
              ${rightBodyHtml}
            </div>
          </aside>
        </div>
        ${renderDiffModal()}
        ${renderSettingsModal()}
      `;

      for (const [sel, top] of savedScrolls.entries()) {
        const el = root.querySelector<HTMLElement>(sel);
        if (el) {
          el.scrollTop = top;
        }
      }

      if (!initialTimelineScrolled && state.timeline.length > 0) {
        const timelineEl = root.querySelector<HTMLElement>('.mp-po-timeline');
        if (timelineEl && timelineEl.scrollHeight) {
          timelineEl.scrollTop = timelineEl.scrollHeight;
        }
        initialTimelineScrolled = true;
      }

      if (tileTab === 'threads' && selectedThread) {
        if (lastScrolledThreadId !== selectedThread.id) {
          const feedEl = root.querySelector<HTMLElement>('.mp-po-thread-feed');
          if (feedEl && feedEl.scrollHeight) {
            feedEl.scrollTop = feedEl.scrollHeight;
          }
          lastScrolledThreadId = selectedThread.id;
        }
      } else {
        lastScrolledThreadId = null;
      }

      if (focusedSel) {
        const targetEl = root.querySelector<HTMLElement>(focusedSel);
        if (targetEl && typeof targetEl.focus === 'function') {
          try {
            targetEl.focus();
            const textEl = targetEl as HTMLInputElement | HTMLTextAreaElement;
            if (
              selStart !== null &&
              typeof textEl.setSelectionRange === 'function'
            ) {
              textEl.setSelectionRange(selStart, selEnd ?? selStart);
            }
          } catch {
            // Ignore focus errors in headless DOMs.
          }
        }
      }

      if (tileTab === 'overview' && !rightTileCollapsed) {
        pushProgressToIframe();
      }
      syncLiveTimerInterval();
    }

    function submitGoalText(rawText: string): void {
      const text = rawText.trim();
      if (!text || isReadOnly() || goalSending) {
        return;
      }
      goalDraft = '';
      goalSending = true;
      paint();
      Promise.resolve(state.actions.onSendGoal(text))
        .catch(() => {})
        .finally(() => {
          goalSending = false;
          if (!unmounted) {
            paint();
          }
        });
    }

    function submitGoal(): void {
      submitGoalText(goalDraft);
    }

    function openThreadDetail(threadId: string): void {
      if (!threadId) {
        return;
      }
      selectedThreadId = threadId;
      drawerActionError = '';
      followupError = '';
      settingsOpen = false;
      boardExpanded = false;
      rightTileCollapsed = false;
      openPicker = null;
      if (activeTab !== 'threads') {
        activeTab = 'threads';
        lastNonSettingsTab = 'threads';
      }
      paint();
      void state.actions.onSelectThread(threadId);
    }

    function openDiffModal(threadId: string): void {
      diffModal = {threadId, loading: true};
      paint();
      Promise.resolve(state.actions.onInspectDiff(threadId))
        .then(res => {
          if (unmounted || diffModal?.threadId !== threadId) {
            return;
          }
          if (!res) {
            diffModal = {
              threadId,
              loading: false,
              diff: '',
              summary: 'No diff details available.',
              files: [],
            };
          } else {
            const diffText = typeof res.diff === 'string' ? res.diff : '';
            const files = Array.isArray(res.files)
              ? res.files
              : parseDiffFiles(diffText);
            diffModal = {
              threadId,
              loading: false,
              diff: diffText,
              summary: synthesizeDiffSummary(res),
              files,
              error:
                res.ok === false
                  ? res.error || 'Could not inspect diff.'
                  : res.error,
            };
          }
          paint();
        })
        .catch(err => {
          if (unmounted || diffModal?.threadId !== threadId) {
            return;
          }
          diffModal = {
            threadId,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          };
          paint();
        });
    }

    function mergeWorktree(threadId: string): void {
      if (isReadOnly() || !state.actions.onMergeWorktree) {
        return;
      }
      if (diffModal?.threadId === threadId) {
        if (diffModal.merging) {
          return;
        }
        diffModal = {...diffModal, merging: true, mergeError: undefined};
        paint();
      } else {
        drawerActionError = '';
        paint();
      }

      Promise.resolve(state.actions.onMergeWorktree(threadId))
        .then(res => {
          if (unmounted) {
            return;
          }
          if (res && res.ok === false) {
            const msg = res.error || 'Failed to merge worktree.';
            if (diffModal?.threadId === threadId) {
              diffModal = {...diffModal, merging: false, mergeError: msg};
            } else {
              drawerActionError = msg;
            }
            paint();
            return;
          }
          if (diffModal?.threadId === threadId) {
            diffModal = null;
          }
          drawerActionError = '';
          paint();
        })
        .catch(err => {
          if (unmounted) {
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          if (diffModal?.threadId === threadId) {
            diffModal = {...diffModal, merging: false, mergeError: msg};
          } else {
            drawerActionError = msg;
          }
          paint();
        });
    }

    function sendThreadMessage(threadId: string, text: string): void {
      const clean = text.trim();
      if (!threadId || !clean || isReadOnly() || followupSending) {
        return;
      }
      followupSending = true;
      followupError = '';
      paint();
      Promise.resolve(state.actions.onMessageThread?.(threadId, clean))
        .then(res => {
          if (unmounted) {
            return;
          }
          followupSending = false;
          if (res && res.ok === false) {
            followupError = res.error || 'Could not send message.';
          } else {
            followupDrafts.delete(threadId);
            followupError = '';
            if (res && res.thread) {
              optimisticThread = res.thread;
            }
          }
          paint();
        })
        .catch(err => {
          if (unmounted) {
            return;
          }
          followupSending = false;
          followupError = err instanceof Error ? err.message : String(err);
          paint();
        });
    }

    function submitFollowup(form: HTMLFormElement): void {
      const threadId = form.dataset.threadId || selectedThreadId || '';
      if (!threadId) {
        return;
      }
      const draft = (followupDrafts.get(threadId) || '').trim();
      const area = form.querySelector<HTMLTextAreaElement>(
        'textarea[name="followup"]',
      );
      const text = (area?.value ?? draft).trim();
      if (!text) {
        return;
      }
      sendThreadMessage(threadId, text);
    }

    function applyMultiAgentConfigPatch(
      field:
        | 'coordinatorModel'
        | 'coordinatorEffort'
        | 'workerModel'
        | 'workerEffort',
      value: string,
    ): void {
      openPicker = null;
      const prevCfg = state.project.multiAgentConfig || {};
      const prevCtx = state.modelContext || {};
      state = {
        ...state,
        project: {
          ...state.project,
          multiAgentConfig: {
            ...prevCfg,
            [field]: value,
          },
        },
        modelContext: {
          ...prevCtx,
          [field]: value,
        },
      };
      paint();
      void state.actions.onSaveSettings({
        multiAgentConfig: {
          [field]: value,
        },
      });
    }

    root.addEventListener('click', event => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      if (target.matches('[data-po-diff-backdrop]')) {
        diffModal = null;
        paint();
        return;
      }

      if (target.matches('[data-po-settings-backdrop]')) {
        settingsOpen = false;
        activeTab = lastNonSettingsTab;
        paint();
        return;
      }

      if (iconPickerOpen && !target.closest('.mp-po-badge-anchor')) {
        iconPickerOpen = false;
        paint();
      }
      if (projectMenuOpen && !target.closest('.mp-po-menu-anchor')) {
        projectMenuOpen = false;
        paint();
      }
      if (openPicker && !target.closest('.mp-po-picker-anchor')) {
        openPicker = null;
        paint();
      }

      const pickCoordModel = target.closest<HTMLElement>(
        '[data-po-pick-coord-model]',
      );
      if (pickCoordModel?.dataset.poPickCoordModel) {
        applyMultiAgentConfigPatch(
          'coordinatorModel',
          pickCoordModel.dataset.poPickCoordModel,
        );
        return;
      }

      const pickCoordEffort = target.closest<HTMLElement>(
        '[data-po-pick-coord-effort]',
      );
      if (pickCoordEffort?.dataset.poPickCoordEffort) {
        applyMultiAgentConfigPatch(
          'coordinatorEffort',
          pickCoordEffort.dataset.poPickCoordEffort,
        );
        return;
      }

      const pickWorkerModel = target.closest<HTMLElement>(
        '[data-po-pick-worker-model]',
      );
      if (pickWorkerModel?.dataset.poPickWorkerModel) {
        applyMultiAgentConfigPatch(
          'workerModel',
          pickWorkerModel.dataset.poPickWorkerModel,
        );
        return;
      }

      const pickWorkerEffort = target.closest<HTMLElement>(
        '[data-po-pick-worker-effort]',
      );
      if (pickWorkerEffort?.dataset.poPickWorkerEffort) {
        applyMultiAgentConfigPatch(
          'workerEffort',
          pickWorkerEffort.dataset.poPickWorkerEffort,
        );
        return;
      }

      const pickColorBtn = target.closest<HTMLElement>('[data-po-pick-color]');
      if (pickColorBtn?.dataset.poPickColor) {
        const nextColor = pickColorBtn.dataset.poPickColor;
        state = {
          ...state,
          project: {...state.project, color: nextColor},
        };
        paint();
        void state.actions.onSaveSettings({color: nextColor});
        return;
      }

      const pickIconBtn = target.closest<HTMLElement>('[data-po-pick-icon]');
      if (pickIconBtn?.dataset.poPickIcon) {
        const nextIcon = pickIconBtn.dataset.poPickIcon;
        state = {
          ...state,
          project: {...state.project, projectIcon: nextIcon},
        };
        paint();
        void state.actions.onSaveSettings({projectIcon: nextIcon});
        return;
      }

      const tabBtn = target.closest<HTMLElement>('[data-po-tab]');
      if (tabBtn?.dataset.poTab) {
        const nextTab = tabBtn.dataset.poTab as TabId;
        projectMenuOpen = false;
        iconPickerOpen = false;
        openPicker = null;
        if (nextTab === 'settings') {
          settingsOpen = true;
          activeTab = 'settings';
        } else {
          settingsOpen = false;
          activeTab = nextTab;
          lastNonSettingsTab = nextTab;
          rightTileCollapsed = false;
          if (nextTab === 'threads') {
            selectedThreadId = null;
          } else {
            boardExpanded = false;
          }
        }
        paint();
        return;
      }

      const toggleGroupBtn = target.closest<HTMLElement>('[data-po-toggle-group]');
      if (toggleGroupBtn?.dataset.poToggleGroup) {
        const gKey = toggleGroupBtn.dataset.poToggleGroup as ThreadGroupKey;
        if (collapsedGroups.has(gKey)) {
          collapsedGroups.delete(gKey);
        } else {
          collapsedGroups.add(gKey);
        }
        paint();
        return;
      }

      const filesSubBtn = target.closest<HTMLElement>('[data-po-files-subtab]');
      if (filesSubBtn?.dataset.poFilesSubtab) {
        filesSubTab = filesSubBtn.dataset.poFilesSubtab as 'files' | 'memory';
        paint();
        return;
      }

      const starterBtn = target.closest<HTMLElement>('[data-po-starter-prompt]');
      if (starterBtn?.dataset.poStarterPrompt) {
        submitGoalText(starterBtn.dataset.poStarterPrompt);
        return;
      }

      const retryBtn = target.closest<HTMLElement>('[data-po-retry-goal]');
      if (retryBtn?.dataset.poRetryGoal) {
        submitGoalText(retryBtn.dataset.poRetryGoal);
        return;
      }

      const retryThreadBtn = target.closest<HTMLElement>('[data-po-retry-thread]');
      if (retryThreadBtn?.dataset.poRetryThread) {
        const threadId = retryThreadBtn.dataset.poRetryThread;
        const thread = state.threads.find(t => t.id === threadId);
        const prompt = (thread?.lastPromptText || thread?.body || '').trim();
        if (threadId && prompt) {
          sendThreadMessage(threadId, prompt);
        }
        return;
      }

      const artFilter = target.closest<HTMLElement>('[data-po-art-filter]');
      if (artFilter?.dataset.poArtFilter) {
        artifactFilter = artFilter.dataset.poArtFilter as 'all' | 'pinned';
        paint();
        return;
      }

      const decideBtn = target.closest<HTMLElement>('[data-po-decide]');
      if (decideBtn?.dataset.poDecide) {
        const optionIndex = Number(decideBtn.dataset.optionIndex);
        void state.actions.onAnswerDecision(
          decideBtn.dataset.poDecide,
          optionIndex,
        );
        return;
      }

      const withdrawBtn = target.closest<HTMLElement>(
        '[data-po-withdraw-decision]',
      );
      if (withdrawBtn?.dataset.poWithdrawDecision) {
        void state.actions.onWithdrawDecision?.(
          withdrawBtn.dataset.poWithdrawDecision,
        );
        return;
      }

      const focusDecBtn = target.closest<HTMLElement>(
        '[data-po-focus-decision]',
      );
      if (focusDecBtn?.dataset.poFocusDecision) {
        const cardEl = root.querySelector<HTMLElement>(
          `[data-decision-id="${focusDecBtn.dataset.poFocusDecision}"]`,
        );
        if (cardEl && typeof cardEl.scrollIntoView === 'function') {
          cardEl.scrollIntoView({block: 'nearest'});
        }
        return;
      }

      const openSessionBtn = target.closest<HTMLElement>(
        '[data-po-open-session]',
      );
      if (openSessionBtn?.dataset.poOpenSession) {
        void state.actions.onOpenSession?.(
          openSessionBtn.dataset.poOpenSession,
        );
        return;
      }

      const mergeBtn = target.closest<HTMLElement>('[data-po-merge-worktree]');
      if (mergeBtn?.dataset.poMergeWorktree) {
        mergeWorktree(mergeBtn.dataset.poMergeWorktree);
        return;
      }

      const copyBtn = target.closest<HTMLElement>('[data-po-copy-text]');
      if (copyBtn?.dataset.poCopyText !== undefined) {
        const textToCopy = copyBtn.dataset.poCopyText;
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(textToCopy).catch(() => {});
        }
        return;
      }

      const inlineThreadBtn = target.closest<HTMLElement>(
        '[data-po-select-inline-thread]',
      );
      if (inlineThreadBtn?.dataset.poSelectInlineThread) {
        openThreadDetail(inlineThreadBtn.dataset.poSelectInlineThread);
        return;
      }

      const mentionBtn = target.closest<HTMLElement>('[data-po-thread-mention]');
      if (mentionBtn?.dataset.poThreadMention) {
        openThreadDetail(mentionBtn.dataset.poThreadMention);
        return;
      }

      const threadBtn = target.closest<HTMLElement>('[data-po-thread]');
      if (threadBtn?.dataset.poThread) {
        openThreadDetail(threadBtn.dataset.poThread);
        return;
      }

      const resolveBtn = target.closest<HTMLElement>('[data-po-resolve]');
      if (resolveBtn?.dataset.poResolve) {
        void state.actions.onResolveThread(
          resolveBtn.dataset.poResolve,
          resolveBtn.dataset.resolved === 'true',
        );
        return;
      }

      const remindBtn = target.closest<HTMLElement>('[data-po-remind]');
      if (remindBtn?.dataset.poRemind) {
        void state.actions.onRemindThread(
          remindBtn.dataset.poRemind,
          Date.now() + 86_400_000,
        );
        return;
      }

      const diffBtn = target.closest<HTMLElement>('[data-po-diff]');
      if (diffBtn?.dataset.poDiff) {
        openDiffModal(diffBtn.dataset.poDiff);
        return;
      }

      const discardBtn = target.closest<HTMLElement>('[data-po-discard]');
      if (discardBtn?.dataset.poDiscard) {
        const id = discardBtn.dataset.poDiscard;
        if (selectedThreadId === id) {
          selectedThreadId = null;
        }
        void state.actions.onDiscardThread(id);
        return;
      }

      const pinBtn = target.closest<HTMLElement>('[data-po-pin-artifact]');
      if (pinBtn?.dataset.poPinArtifact) {
        void state.actions.onTogglePinArtifact(
          pinBtn.dataset.poPinArtifact,
          pinBtn.dataset.pinned === 'true',
        );
        return;
      }

      const fileBtn = target.closest<HTMLElement>('[data-po-select-file]');
      if (fileBtn?.dataset.poSelectFile) {
        selectedFilePath = fileBtn.dataset.poSelectFile;
        fileConflictError = '';
        if (state.actions.onReadFile) {
          void state.actions.onReadFile(selectedFilePath).then(res => {
            fileContent = res.content;
            if (!unmounted) {
              paint();
            }
          });
        } else {
          paint();
        }
        return;
      }

      const toggleSec = target.closest<HTMLElement>('[data-po-toggle-section]');
      if (toggleSec?.dataset.poToggleSection) {
        const sid = toggleSec.dataset.poToggleSection;
        const sections = state.sections || {
          version: 0,
          hiddenIds: [],
          order: [],
        };
        const hiddenSet = new Set(sections.hiddenIds || []);
        if (hiddenSet.has(sid)) {
          hiddenSet.delete(sid);
        } else {
          hiddenSet.add(sid);
        }
        void state.actions.onUpdateSections({
          hiddenIds: [...hiddenSet],
          expectedVersion: sections.version,
        });
        return;
      }

      const moveSec = target.closest<HTMLElement>('[data-po-move-section]');
      if (moveSec?.dataset.poMoveSection) {
        const sid = moveSec.dataset.poMoveSection;
        const dir = Number(moveSec.dataset.dir || 0);
        const sections = state.sections || {
          version: 0,
          hiddenIds: [],
          order: [],
        };
        const currentIds = extractSectionIds(state.statusPageHtml || '');
        const order = sections.order.length ? [...sections.order] : currentIds;
        const idx = order.indexOf(sid);
        const nextIdx = idx + dir;
        if (idx >= 0 && nextIdx >= 0 && nextIdx < order.length) {
          [order[idx], order[nextIdx]] = [order[nextIdx], order[idx]];
          void state.actions.onUpdateSections({
            order,
            expectedVersion: sections.version,
          });
        }
        return;
      }

      const actionEl = target.closest<HTMLElement>('[data-po-action]');
      const action = actionEl?.dataset.poAction;
      if (!action) {
        return;
      }
      if (action === 'back') {
        state.actions.onBack();
      } else if (action === 'toggle-icon-picker') {
        iconPickerOpen = !iconPickerOpen;
        projectMenuOpen = false;
        openPicker = null;
        paint();
      } else if (action === 'toggle-project-menu') {
        projectMenuOpen = !projectMenuOpen;
        iconPickerOpen = false;
        openPicker = null;
        paint();
      } else if (action === 'toggle-coord-model') {
        openPicker = openPicker === 'coord-model' ? null : 'coord-model';
        paint();
      } else if (action === 'toggle-coord-effort') {
        openPicker = openPicker === 'coord-effort' ? null : 'coord-effort';
        paint();
      } else if (action === 'toggle-worker-model') {
        openPicker = openPicker === 'worker-model' ? null : 'worker-model';
        paint();
      } else if (action === 'toggle-worker-effort') {
        openPicker = openPicker === 'worker-effort' ? null : 'worker-effort';
        paint();
      } else if (action === 'toggle-right-tile') {
        rightTileCollapsed = !rightTileCollapsed;
        if (rightTileCollapsed) {
          boardExpanded = false;
        }
        paint();
      } else if (action === 'toggle-board-view') {
        threadsViewMode = threadsViewMode === 'list' ? 'board' : 'list';
        selectedThreadId = null;
        if (threadsViewMode === 'list') {
          boardExpanded = false;
        }
        settingsOpen = false;
        activeTab = 'threads';
        lastNonSettingsTab = 'threads';
        rightTileCollapsed = false;
        paint();
      } else if (action === 'toggle-expand-board') {
        boardExpanded = !boardExpanded;
        if (boardExpanded) {
          threadsViewMode = 'board';
        }
        selectedThreadId = null;
        settingsOpen = false;
        activeTab = 'threads';
        lastNonSettingsTab = 'threads';
        rightTileCollapsed = false;
        paint();
      } else if (action === 'toggle-thread-search') {
        threadSearchOpen = !threadSearchOpen;
        if (!threadSearchOpen) {
          threadSearchQuery = '';
        }
        paint();
      } else if (action === 'clear-thread-search') {
        threadSearchQuery = '';
        paint();
      } else if (action === 'toggle-hide-resolved') {
        hideResolved = !hideResolved;
        paint();
      } else if (action === 'close-settings-modal') {
        settingsOpen = false;
        activeTab = lastNonSettingsTab;
        paint();
      } else if (action === 'stop-run') {
        void state.actions.onStopRun?.();
      } else if (action === 'stop-thread-run') {
        const tid = actionEl?.dataset.threadId || selectedThreadId || undefined;
        void state.actions.onStopRun?.(tid);
      } else if (
        action === 'open-new-thread' ||
        action === 'quick-new-thread' ||
        action === 'toggle-new-thread'
      ) {
        if (!isReadOnly()) {
          settingsOpen = false;
          activeTab = 'threads';
          lastNonSettingsTab = 'threads';
          rightTileCollapsed = false;
          selectedThreadId = null;
          boardExpanded = false;
          newThreadOpen =
            action === 'toggle-new-thread' ? !newThreadOpen : true;
          newThreadError = '';
          paint();
        }
      } else if (action === 'cancel-new-thread') {
        newThreadOpen = false;
        newThreadTitleDraft = '';
        newThreadPromptDraft = '';
        newThreadUseWorktree = true;
        newThreadError = '';
        paint();
      } else if (action === 'refresh') {
        if (state.actions.onRefresh) {
          void state.actions.onRefresh();
        } else {
          paint();
        }
      } else if (
        action === 'close-thread' ||
        action === 'close-thread-drawer'
      ) {
        selectedThreadId = null;
        drawerActionError = '';
        followupError = '';
        openPicker = null;
        paint();
      } else if (action === 'close-diff-modal') {
        diffModal = null;
        paint();
      } else if (action === 'dismiss-recap') {
        void state.actions.onDismissRecap();
      } else if (action === 'restore-sections' || action === 'reset-sections') {
        const sections = state.sections || {
          version: 0,
          hiddenIds: [],
          order: [],
        };
        void state.actions.onUpdateSections({
          hiddenIds: [],
          order: [],
          expectedVersion: sections.version,
        });
      } else if (action === 'new-file') {
        selectedFilePath = 'notes/untitled.md';
        fileContent = '';
        fileConflictError = '';
        paint();
      } else if (
        action === 'save-file' ||
        action === 'save-file-overwrite' ||
        action === 'save-file-keepboth'
      ) {
        const pathInput = root.querySelector<HTMLInputElement>(
          '[data-po-file-path]',
        );
        const contentInput = root.querySelector<HTMLTextAreaElement>(
          '[data-po-file-content]',
        );
        selectedFilePath = pathInput?.value.trim() || selectedFilePath;
        fileContent = contentInput?.value ?? fileContent;
        void state.actions
          .onSaveFile({
            path: selectedFilePath,
            content: fileContent,
            overwrite: action === 'save-file-overwrite',
            keepBoth: action === 'save-file-keepboth',
          })
          .then(res => {
            if (unmounted) {
              return;
            }
            fileConflictError = res.ok
              ? ''
              : res.error || 'File already exists. Replace or keep both?';
            paint();
          });
      } else if (action === 'save-memory') {
        const memInput = root.querySelector<HTMLTextAreaElement>(
          '[data-po-memory-content]',
        );
        memoryContent = memInput?.value ?? memoryContent;
        void state.actions
          .onSaveMemory({
            path: memoryPath,
            content: memoryContent,
            expectedSha256: memorySha,
          })
          .then(res => {
            if (unmounted) {
              return;
            }
            if (res.ok) {
              memorySha = res.sha256 || memorySha;
              memoryDirty = false;
              memoryConflictSha = '';
              memoryStatusMsg = 'Saved /MEMORY.md.';
            } else if (res.code === 'PRECONDITION_FAILED') {
              memoryConflictSha = res.currentSha256 || 'changed';
              memoryStatusMsg = '';
            } else {
              memoryStatusMsg = res.error || 'Could not save memory.';
            }
            paint();
          });
      } else if (action === 'reload-memory' && state.actions.onReadMemory) {
        void state.actions.onReadMemory(memoryPath).then(latest => {
          if (unmounted) {
            return;
          }
          memoryContent = latest.content;
          memorySha = latest.sha256;
          memoryDirty = false;
          memoryConflictSha = '';
          memoryStatusMsg = 'Reloaded latest /MEMORY.md.';
          paint();
        });
      } else if (action === 'toggle-pause') {
        projectMenuOpen = false;
        void state.actions.onTogglePause?.(!state.project.paused);
      } else if (action === 'toggle-archive') {
        projectMenuOpen = false;
        void state.actions.onToggleArchive?.(!state.project.archived);
      } else if (action === 'delete-project') {
        projectMenuOpen = false;
        void state.actions.onDeleteProject?.();
      }
    });

    root.addEventListener('change', event => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('[data-po-art-sort]')) {
        artifactSort = (target as HTMLSelectElement).value as
          | 'newest'
          | 'recent';
        paint();
      } else if (
        target?.matches('[data-po-new-thread-form] input[name="useWorktree"]')
      ) {
        newThreadUseWorktree = (target as HTMLInputElement).checked;
      }
    });

    root.addEventListener('input', event => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }
      if (target.matches('[data-po-goal-form] textarea')) {
        goalDraft = (target as HTMLTextAreaElement).value;
      } else if (target.matches('[data-po-thread-search]')) {
        threadSearchQuery = (target as HTMLInputElement).value;
        paint();
      } else if (
        target.matches('[data-po-new-thread-form] input[name="title"]')
      ) {
        newThreadTitleDraft = (target as HTMLInputElement).value;
      } else if (
        target.matches('[data-po-new-thread-form] textarea[name="prompt"]')
      ) {
        newThreadPromptDraft = (target as HTMLTextAreaElement).value;
      } else if (
        target.matches('[data-po-followup-form] textarea[name="followup"]')
      ) {
        const form = target.closest<HTMLFormElement>('[data-po-followup-form]');
        const threadId = form?.dataset.threadId || selectedThreadId || '';
        if (threadId) {
          followupDrafts.set(threadId, (target as HTMLTextAreaElement).value);
        }
      } else if (target.matches('[data-po-file-path]')) {
        selectedFilePath = (target as HTMLInputElement).value;
      } else if (target.matches('[data-po-file-content]')) {
        fileContent = (target as HTMLTextAreaElement).value;
      } else if (target.matches('[data-po-memory-content]')) {
        memoryContent = (target as HTMLTextAreaElement).value;
        memoryDirty = true;
      }
    });

    root.addEventListener('keydown', event => {
      const keyEvent = event as KeyboardEvent;
      if (
        keyEvent.key !== 'Enter' ||
        keyEvent.shiftKey ||
        keyEvent.isComposing ||
        keyEvent.keyCode === 229
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }
      if (target.matches('[data-po-goal-form] textarea')) {
        event.preventDefault();
        submitGoal();
      } else if (
        target.matches('[data-po-followup-form] textarea[name="followup"]')
      ) {
        const form = target.closest<HTMLFormElement>('[data-po-followup-form]');
        if (form) {
          event.preventDefault();
          submitFollowup(form);
        }
      }
    });

    root.addEventListener('submit', event => {
      const form = event.target as HTMLFormElement | null;
      if (!form) {
        return;
      }
      event.preventDefault();
      if (form.matches('[data-po-goal-form]')) {
        submitGoal();
      } else if (form.matches('[data-po-new-thread-form]')) {
        if (isReadOnly() || newThreadSending) {
          return;
        }
        const fd = new FormData(form);
        const title = String(fd.get('title') ?? newThreadTitleDraft).trim();
        const prompt = String(fd.get('prompt') ?? newThreadPromptDraft).trim();
        const useWorktree = form.querySelector<HTMLInputElement>(
          'input[name="useWorktree"]',
        )
          ? Boolean(
              form.querySelector<HTMLInputElement>('input[name="useWorktree"]')
                ?.checked,
            )
          : fd.get('useWorktree') === 'on';
        if (!prompt) {
          newThreadError = 'Prompt is required.';
          paint();
          return;
        }
        newThreadSending = true;
        newThreadError = '';
        paint();
        Promise.resolve(
          state.actions.onStartThread?.({
            title: title || undefined,
            prompt,
            useWorktree,
          }),
        )
          .then(res => {
            if (unmounted) {
              return;
            }
            newThreadSending = false;
            if (res && res.ok === false) {
              newThreadError = res.error || 'Could not start thread.';
              paint();
              return;
            }
            newThreadTitleDraft = '';
            newThreadPromptDraft = '';
            newThreadUseWorktree = true;
            newThreadError = '';
            newThreadOpen = false;
            if (res && res.thread) {
              optimisticThread = res.thread;
              selectedThreadId = res.thread.id;
            }
            paint();
          })
          .catch(err => {
            if (unmounted) {
              return;
            }
            newThreadSending = false;
            newThreadError = err instanceof Error ? err.message : String(err);
            paint();
          });
      } else if (form.matches('[data-po-followup-form]')) {
        submitFollowup(form);
      } else if (form.matches('[data-po-settings-form]')) {
        const fd = new FormData(form);
        const rules = String(fd.get('autoModeRules') || '')
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(Boolean);
        if (rules.length > 50) {
          settingsError = 'Maximum 50 auto-mode rules allowed.';
          paint();
          return;
        }
        const quietAfterDays = Number(fd.get('quietAfterDays') || 3);
        const autoResolveDays = Number(fd.get('autoResolveDays') || 7);
        if (autoResolveDays !== 0 && autoResolveDays <= quietAfterDays) {
          settingsError =
            'Auto-resolve days must be 0 or greater than quiet days.';
          paint();
          return;
        }
        settingsError = '';
        void state.actions
          .onSaveSettings({
            name: String(fd.get('name') || ''),
            goal: String(fd.get('goal') || ''),
            description: String(fd.get('description') || ''),
            instructions: String(fd.get('instructions') || ''),
            projectIcon: String(fd.get('projectIcon') || 'Projects'),
            color: String(fd.get('color') || '#D97757'),
            defaultEnvironmentId: String(fd.get('defaultEnvironmentId') || ''),
            multiAgentConfig: {
              agentTeam: String(fd.get('agentTeam') || 'squad'),
              coordinatorModel: String(fd.get('coordinatorModel') || ''),
              coordinatorEffort: String(fd.get('coordinatorEffort') || 'high'),
              workerModel: String(fd.get('workerModel') || ''),
              workerEffort: String(fd.get('workerEffort') || 'medium'),
              autoModeRules: rules,
              limitAutoContinue: fd.get('limitAutoContinue') === 'on',
              quietAfterDays,
              autoResolveDays,
              notifyLevel: String(fd.get('notifyLevel') || 'coordinator'),
              waitingCount: String(fd.get('waitingCount') || 'read'),
            },
          })
          .then(res => {
            if (!unmounted && !res.ok) {
              settingsError = res.error || 'Could not save settings.';
              paint();
            }
          });
      }
    });

    paint();

    return {
      unmount: () => {
        unmounted = true;
        if (liveTickTimer !== null && typeof clearInterval === 'function') {
          clearInterval(liveTickTimer);
          liveTickTimer = null;
        }
        host.replaceChildren();
      },
      update: (nextState: ProjectOverviewUpdateState) => {
        if (unmounted) {
          return;
        }
        state = {
          ...state,
          ...nextState,
          actions: nextState.actions ?? state.actions,
        };
        if (!selectedFilePath && state.files?.[0]?.path) {
          selectedFilePath = state.files[0].path;
        }
        if (nextState.memory) {
          memoryPath = nextState.memory.path || memoryPath;
          if (!memoryDirty && !memoryConflictSha) {
            memoryContent = nextState.memory.content || '';
            memorySha = nextState.memory.sha256 || '';
          }
        }
        if (
          optimisticThread &&
          state.threads.some(t => t.id === optimisticThread?.id)
        ) {
          optimisticThread = null;
        }
        if (
          selectedThreadId &&
          !state.threads.some(t => t.id === selectedThreadId) &&
          optimisticThread?.id !== selectedThreadId
        ) {
          selectedThreadId = null;
        }
        paint();
      },
    };
  }

  function mount(host: HTMLElement, state: ProjectOverviewState): () => void {
    return mountManaged(host, state).unmount;
  }

  globalThis.ProjectOverview = {mount, mountManaged};
})();
