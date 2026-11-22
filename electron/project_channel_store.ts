import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  BoundThreadSession,
  ProjectDecisionCard,
  ProjectDecisionOption,
  ProjectOverviewSectionState,
  ProjectPublishedArtifact,
  ProjectRecapData,
  ProjectRecapLink,
  ProjectThreadMessage,
  ProjectThreadRecord,
  ProjectTimelineEntry,
  ProjectTimelineEventType,
} from './project_multiagent_types';

export const INLINE_TEXT_EDIT_LIMIT_BYTES = 65_536;
export const MAX_LIVE_THREADS = 200;
export const KEEP_BOTH_MAX_SUFFIX = 21;

export class ProjectReadOnlyError extends Error {
  readonly code = 'PROJECT_READ_ONLY';

  constructor(message = 'Project is paused or archived and strictly read-only.') {
    super(message);
    this.name = 'ProjectReadOnlyError';
  }
}

export interface ProjectChannelStoreOptions {
  projectId: string;
  projectDataDir: string;
  now?: () => number;
  paused?: boolean;
  archived?: boolean;
}

export interface CreateThreadInput {
  id?: string;
  title?: string;
  displayName?: string;
  body?: string;
  parentThreadId?: string;
  boundSessionIds?: string[];
  boundSessions?: BoundThreadSession[];
  authorSessionId?: string;
  taskStatus?: ProjectThreadRecord['taskStatus'];
  threadStatus?: ProjectThreadRecord['threadStatus'];
  worktreePath?: string;
  worktreeBranch?: string;
  lastPromptText?: string;
}

export interface AskDecisionInput {
  threadId?: string;
  question: string;
  context?: string;
  options: ProjectDecisionOption[];
  recommended?: number;
  reason?: string;
  taskId?: string;
}

export interface SharedFileInfo {
  path: string;
  size: number;
  updatedAt: number;
  inlineEditable: boolean;
}

export interface SharedFileWriteResult {
  ok: boolean;
  path?: string;
  status?: 'created' | 'overwritten' | 'kept_both' | 'unchanged';
  sha256?: string;
  code?: 'EEXIST' | 'FILE_EXISTS_LIMIT';
  existingSha256?: string;
  error?: string;
}

export interface MemoryReadResult {
  exists: boolean;
  path: string;
  content: string;
  sha256: string;
}

export interface MemoryMutationResult {
  ok: boolean;
  path: string;
  sha256?: string;
  currentSha256?: string;
  code?: 'PRECONDITION_FAILED';
  error?: string;
}

export interface SectionsUpdateResult {
  ok: boolean;
  state?: ProjectOverviewSectionState;
  code?: 'PRECONDITION_FAILED';
  error?: string;
}

type StoredProjectThreadMessage = ProjectThreadMessage & {
  routeFromOverview?: boolean;
};

function sha256Of(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function readFileStamp(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }
}

function writeAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function stripMarkdownLine(raw: string): string {
  return raw
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/[`*_~[\]]/g, '')
    .trim();
}

export function deriveThreadTitle(input: {
  title?: string;
  displayName?: string;
  boundSessions?: BoundThreadSession[];
  body?: string;
}): string {
  const display = input.displayName?.trim() || input.title?.trim();
  if (display) {
    return display;
  }
  const sessionTitle = input.boundSessions?.find(s => s.title?.trim())?.title?.trim();
  if (sessionTitle) {
    return sessionTitle;
  }
  const firstLine = String(input.body || '')
    .split(/\r?\n/)
    .map(stripMarkdownLine)
    .find(Boolean);
  if (!firstLine) {
    return 'Untitled thread';
  }
  if (firstLine.length <= 80) {
    return firstLine;
  }
  return `${firstLine.slice(0, 80).trimEnd()}…`;
}

function normalizeRelativePosix(rawPath: string): string {
  const cleaned = String(rawPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!cleaned) {
    throw new Error('File path is required.');
  }
  const segments = cleaned.split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error('Path traversal segments are not allowed.');
  }
  return segments.join('/');
}

function resolveContainedPath(rootDir: string, relativePosix: string): string {
  const rootResolved = path.resolve(rootDir);
  const target = path.resolve(rootResolved, relativePosix);
  const rel = path.relative(rootResolved, target);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('Path escapes project directory.');
  }
  return target;
}

function withSuffix(relativePosix: string, index: number): string {
  const dir = path.posix.dirname(relativePosix);
  const base = path.posix.basename(relativePosix);
  const ext = path.posix.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  const nextBase = `${stem} (${index})${ext}`;
  return dir === '.' ? nextBase : `${dir}/${nextBase}`;
}

export class ProjectChannelStore {
  readonly projectId: string;
  readonly projectDataDir: string;
  private readonly now: () => number;
  private readonly timelineFile: string;
  private readonly threadsFile: string;
  private readonly decisionsFile: string;
  private readonly artifactsFile: string;
  private readonly filesDir: string;
  private readonly memoryDir: string;
  private readonly overviewDir: string;
  private readonly statusPageFile: string;
  private readonly recapFile: string;
  private readonly sectionsFile: string;
  private readonly stateFile: string;

  private readOnlyState: {paused: boolean; archived: boolean};
  private timelineCache: ProjectTimelineEntry[] | null = null;
  private timelineStamp: string | null = null;
  private threadsCache: ProjectThreadRecord[] | null = null;
  private threadsStamp: string | null = null;
  private decisionsCache: ProjectDecisionCard[] | null = null;
  private decisionsStamp: string | null = null;
  private artifactsCache: ProjectPublishedArtifact[] | null = null;
  private artifactsStamp: string | null = null;

  constructor(options: ProjectChannelStoreOptions) {
    this.projectId = options.projectId;
    this.projectDataDir = path.resolve(options.projectDataDir);
    this.now = options.now ?? Date.now;
    this.timelineFile = path.join(this.projectDataDir, 'timeline.jsonl');
    this.threadsFile = path.join(this.projectDataDir, 'threads.json');
    this.decisionsFile = path.join(this.projectDataDir, 'decisions.json');
    this.artifactsFile = path.join(this.projectDataDir, 'artifacts.json');
    this.filesDir = path.join(this.projectDataDir, 'files');
    this.memoryDir = path.join(this.projectDataDir, 'memory');
    this.overviewDir = path.join(this.projectDataDir, 'overview');
    this.statusPageFile = path.join(this.overviewDir, 'status_page.html');
    this.recapFile = path.join(this.overviewDir, 'recap.json');
    this.sectionsFile = path.join(this.overviewDir, 'sections.json');
    this.stateFile = path.join(this.projectDataDir, 'state.json');

    const persisted = this.loadStateFile();
    this.readOnlyState = {
      paused: options.paused ?? persisted.paused,
      archived: options.archived ?? persisted.archived,
    };
  }

  private loadStateFile(): {paused: boolean; archived: boolean} {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as {
        paused?: boolean;
        archived?: boolean;
      };
      return {
        paused: Boolean(parsed.paused),
        archived: Boolean(parsed.archived),
      };
    } catch {
      return {paused: false, archived: false};
    }
  }

  setReadOnlyState(next: {paused?: boolean; archived?: boolean}): void {
    this.readOnlyState = {
      paused: next.paused ?? this.readOnlyState.paused,
      archived: next.archived ?? this.readOnlyState.archived,
    };
    writeAtomic(this.stateFile, JSON.stringify(this.readOnlyState, null, 2));
  }

  isReadOnly(): boolean {
    return this.readOnlyState.paused || this.readOnlyState.archived;
  }

  private assertWritable(): void {
    if (this.isReadOnly()) {
      throw new ProjectReadOnlyError();
    }
  }

  private readJsonArray<T>(filePath: string): T[] {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    if (!raw.trim()) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      if (error instanceof SyntaxError) {
        const retryRaw = fs.readFileSync(filePath, 'utf8');
        if (!retryRaw.trim()) {
          return [];
        }
        parsed = JSON.parse(retryRaw);
      } else {
        throw error;
      }
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Expected JSON array in ${path.basename(filePath)}.`);
    }
    return parsed as T[];
  }

  private loadTimeline(forceReload = false): ProjectTimelineEntry[] {
    const stamp = readFileStamp(this.timelineFile);
    if (
      !forceReload &&
      this.timelineCache !== null &&
      this.timelineStamp === stamp
    ) {
      return this.timelineCache;
    }
    try {
      const raw = fs.readFileSync(this.timelineFile, 'utf8');
      const lines = raw.split(/\r?\n/).filter(line => line.trim().length > 0);
      const entries: ProjectTimelineEntry[] = [];
      let skippedTrailingPartial = false;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          if (error instanceof SyntaxError && i === lines.length - 1) {
            skippedTrailingPartial = true;
            continue;
          }
          throw error;
        }
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed) ||
          typeof (parsed as ProjectTimelineEntry).seq !== 'number' ||
          typeof (parsed as ProjectTimelineEntry).type !== 'string'
        ) {
          throw new Error('Invalid timeline entry schema in timeline.jsonl.');
        }
        entries.push(parsed as ProjectTimelineEntry);
      }
      this.timelineCache = entries;
      this.timelineStamp = skippedTrailingPartial ? null : stamp;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.timelineCache = [];
        this.timelineStamp = 'missing';
      } else {
        throw error;
      }
    }
    return this.timelineCache;
  }

  appendTimeline(input: {
    type: ProjectTimelineEventType;
    threadId?: string;
    sessionId?: string;
    author?: 'user' | 'coordinator' | 'worker' | 'system';
    text?: string;
    payload?: Record<string, unknown>;
    hiddenFromChat?: boolean;
  }): ProjectTimelineEntry {
    this.assertWritable();
    const entries = this.loadTimeline(true);
    const seq = (entries.at(-1)?.seq ?? 0) + 1;
    const entry: ProjectTimelineEntry = {
      seq,
      id: `cmsg_${randomUUID()}`,
      type: input.type,
      timestamp: this.now(),
      ...(input.threadId ? {threadId: input.threadId} : {}),
      ...(input.sessionId ? {sessionId: input.sessionId} : {}),
      ...(input.author ? {author: input.author} : {}),
      ...(input.text !== undefined ? {text: input.text} : {}),
      ...(input.payload ? {payload: input.payload} : {}),
      ...(input.hiddenFromChat ? {hiddenFromChat: true} : {}),
    };
    fs.mkdirSync(path.dirname(this.timelineFile), {recursive: true});
    fs.appendFileSync(this.timelineFile, `${JSON.stringify(entry)}\n`, 'utf8');
    entries.push(entry);
    this.timelineCache = entries;
    this.timelineStamp = readFileStamp(this.timelineFile);
    return structuredClone(entry);
  }

  readTimeline(options: {
    sinceSeq?: number;
    limit?: number;
    includeHidden?: boolean;
  } = {}): ProjectTimelineEntry[] {
    let items = this.loadTimeline();
    if (!options.includeHidden) {
      items = items.filter(item => !item.hiddenFromChat);
    }
    if (options.sinceSeq !== undefined) {
      items = items.filter(item => item.seq > options.sinceSeq!);
    }
    if (options.limit !== undefined && options.limit > 0) {
      items = items.slice(-options.limit);
    }
    return items.map(item => structuredClone(item));
  }

  private loadThreads(forceReload = false): ProjectThreadRecord[] {
    const stamp = readFileStamp(this.threadsFile);
    if (
      !forceReload &&
      this.threadsCache !== null &&
      this.threadsStamp === stamp
    ) {
      return this.threadsCache;
    }
    this.threadsCache = this.readJsonArray<ProjectThreadRecord>(this.threadsFile);
    this.threadsStamp = stamp;
    return this.threadsCache;
  }

  private saveThreads(threads: ProjectThreadRecord[]): void {
    const trimmed =
      threads.length > MAX_LIVE_THREADS
        ? threads.slice(-MAX_LIVE_THREADS)
        : threads;
    writeAtomic(this.threadsFile, JSON.stringify(trimmed, null, 2));
    this.threadsCache = trimmed;
    this.threadsStamp = readFileStamp(this.threadsFile);
  }

  listThreads(): ProjectThreadRecord[] {
    return this.loadThreads().map(thread => structuredClone(thread));
  }

  getThread(threadId: string): ProjectThreadRecord | undefined {
    const found = this.loadThreads().find(thread => thread.id === threadId);
    return found ? structuredClone(found) : undefined;
  }

  createThread(input: CreateThreadInput): ProjectThreadRecord {
    this.assertWritable();
    const timestamp = this.now();
    const id = input.id?.trim() || `thr_${randomUUID()}`;
    const boundSessionIds = [...new Set(input.boundSessionIds ?? [])];
    const boundSessions: BoundThreadSession[] =
      input.boundSessions && input.boundSessions.length > 0
        ? structuredClone(input.boundSessions)
        : boundSessionIds.map(sessionId => ({
            id: sessionId,
            status: 'active',
            ...(input.worktreePath ? {worktreePath: input.worktreePath} : {}),
            ...(input.worktreeBranch ? {branch: input.worktreeBranch} : {}),
          }));
    const title = deriveThreadTitle({
      title: input.title,
      displayName: input.displayName,
      boundSessions,
      body: input.body,
    });
    const record: ProjectThreadRecord = {
      id,
      projectId: this.projectId,
      title,
      ...(input.displayName ? {displayName: input.displayName} : {}),
      ...(input.body !== undefined ? {body: input.body} : {}),
      ...(input.parentThreadId ? {parentThreadId: input.parentThreadId} : {}),
      boundSessionIds:
        boundSessionIds.length > 0
          ? boundSessionIds
          : boundSessions.map(session => session.id),
      boundSessions,
      ...(input.authorSessionId ? {authorSessionId: input.authorSessionId} : {}),
      createdAt: timestamp,
      lastReplyAt: timestamp,
      replyCount: 0,
      hasUnread: false,
      ...(input.taskStatus ? {taskStatus: input.taskStatus} : {}),
      ...(input.threadStatus ? {threadStatus: input.threadStatus} : {}),
      ...(input.worktreePath ? {worktreePath: input.worktreePath} : {}),
      ...(input.worktreeBranch ? {worktreeBranch: input.worktreeBranch} : {}),
      ...(input.lastPromptText ? {lastPromptText: input.lastPromptText} : {}),
      messages: [],
    };
    const threads = this.loadThreads(true);
    this.saveThreads([...threads, record]);
    this.appendTimeline({
      type: 'thread_started',
      threadId: record.id,
      sessionId: record.boundSessionIds[0],
      author: 'coordinator',
      text: title,
      payload: {
        threadRootId: record.id,
        boundSessionIds: record.boundSessionIds,
      },
    });
    return structuredClone(record);
  }

  updateThread(
    threadId: string,
    patch: Partial<ProjectThreadRecord>,
  ): ProjectThreadRecord {
    this.assertWritable();
    const threads = this.loadThreads(true);
    const index = threads.findIndex(thread => thread.id === threadId);
    if (index < 0) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    const previous = threads[index];
    const next: ProjectThreadRecord = {
      ...previous,
      ...structuredClone(patch),
      id: previous.id,
      projectId: previous.projectId,
    };
    const updated = [...threads];
    updated[index] = next;
    this.saveThreads(updated);
    return structuredClone(next);
  }

  appendThreadMessage(
    threadId: string,
    input: {
      author: ProjectThreadMessage['author'];
      text: string;
      sessionId?: string;
      viewerMentioned?: boolean;
      routeFromOverview?: boolean;
    },
  ): ProjectThreadRecord {
    this.assertWritable();
    const threads = this.loadThreads(true);
    const index = threads.findIndex(thread => thread.id === threadId);
    if (index < 0) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    const previous = threads[index];
    const timestamp = this.now();
    const message: StoredProjectThreadMessage = {
      id: `msg_${randomUUID()}`,
      threadId,
      author: input.author,
      text: input.text,
      timestamp,
      ...(input.sessionId ? {sessionId: input.sessionId} : {}),
      ...(input.viewerMentioned ? {viewerMentioned: true} : {}),
      ...(input.routeFromOverview ? {routeFromOverview: true} : {}),
    };
    const next: ProjectThreadRecord = {
      ...previous,
      lastReplyAt: timestamp,
      replyCount: (previous.replyCount || 0) + 1,
      hasUnread: input.author !== 'user',
      viewerMentioned: previous.viewerMentioned || Boolean(input.viewerMentioned),
      messages: [...(previous.messages || []), message],
    };
    const updated = [...threads];
    updated[index] = next;
    this.saveThreads(updated);
    this.appendTimeline({
      type: input.routeFromOverview ? 'message_routed' : 'activity',
      threadId,
      sessionId: input.sessionId ?? next.boundSessionIds[0],
      author: input.author,
      text: input.text,
      ...(input.routeFromOverview ? {payload: {routeFromOverview: true}} : {}),
      hiddenFromChat: Boolean(input.routeFromOverview),
    });
    return structuredClone(next);
  }

  markThreadRead(threadId: string): ProjectThreadRecord {
    return this.updateThread(threadId, {
      hasUnread: false,
      readAt: this.now(),
    });
  }

  setThreadRemindLater(
    threadId: string,
    remindAt: number | undefined,
  ): ProjectThreadRecord {
    const next = this.updateThread(threadId, {remindAt});
    this.appendTimeline({
      type: 'thread_status_change',
      threadId,
      author: 'user',
      payload: {remindAt: remindAt ?? null},
    });
    return next;
  }

  resolveThread(threadId: string, resolved: boolean): ProjectThreadRecord {
    const timestamp = this.now();
    const next = this.updateThread(threadId, {
      resolved,
      resolvedAt: resolved ? timestamp : undefined,
      remindAt: undefined,
      threadStatus: resolved ? 'resolved' : 'idle',
    });
    this.appendTimeline({
      type: 'thread_status_change',
      threadId,
      author: 'coordinator',
      payload: {resolved},
    });
    return next;
  }

  private loadDecisions(forceReload = false): ProjectDecisionCard[] {
    const stamp = readFileStamp(this.decisionsFile);
    if (
      !forceReload &&
      this.decisionsCache !== null &&
      this.decisionsStamp === stamp
    ) {
      return this.decisionsCache;
    }
    this.decisionsCache = this.readJsonArray<ProjectDecisionCard>(
      this.decisionsFile,
    );
    this.decisionsStamp = stamp;
    return this.decisionsCache;
  }

  private saveDecisions(cards: ProjectDecisionCard[]): void {
    writeAtomic(this.decisionsFile, JSON.stringify(cards, null, 2));
    this.decisionsCache = cards;
    this.decisionsStamp = readFileStamp(this.decisionsFile);
  }

  listDecisions(status?: ProjectDecisionCard['status']): ProjectDecisionCard[] {
    const all = this.loadDecisions();
    const filtered = status ? all.filter(item => item.status === status) : all;
    return filtered.map(item => structuredClone(item));
  }

  askDecision(input: AskDecisionInput): ProjectDecisionCard {
    this.assertWritable();
    const question = input.question.trim();
    if (!question || question.length > 1200) {
      throw new Error('Decision question must be 1..1200 characters.');
    }
    if (input.context && input.context.length > 2400) {
      throw new Error('Decision context must be <= 2400 characters.');
    }
    if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 4) {
      throw new Error('Decision card requires 2 to 4 options.');
    }
    for (const option of input.options) {
      if (!option.label?.trim() || option.label.trim().length > 40) {
        throw new Error('Option label must be 1..40 characters.');
      }
      if (!option.consequence?.trim() || option.consequence.trim().length > 800) {
        throw new Error('Option consequence must be 1..800 characters.');
      }
    }
    if (
      input.recommended !== undefined &&
      (input.recommended < 0 || input.recommended >= input.options.length)
    ) {
      throw new Error('Recommended option index is out of range.');
    }
    if (input.reason && input.reason.length > 800) {
      throw new Error('Decision reason must be <= 800 characters.');
    }
    if (input.taskId && input.taskId.length > 64) {
      throw new Error('Decision taskId must be <= 64 characters.');
    }

    const card: ProjectDecisionCard = {
      id: `dec_${randomUUID()}`,
      projectId: this.projectId,
      ...(input.threadId ? {threadId: input.threadId} : {}),
      question,
      ...(input.context ? {context: input.context} : {}),
      options: input.options.map(option => ({
        label: option.label.trim(),
        consequence: option.consequence.trim(),
      })),
      ...(input.recommended !== undefined ? {recommended: input.recommended} : {}),
      ...(input.reason ? {reason: input.reason} : {}),
      ...(input.taskId ? {taskId: input.taskId} : {}),
      status: 'open',
      createdAt: this.now(),
    };
    this.saveDecisions([...this.loadDecisions(true), card]);

    if (input.threadId && this.getThread(input.threadId)) {
      const existing = this.getThread(input.threadId)!;
      this.updateThread(input.threadId, {
        openDecisionId: card.id,
        openDecisionCount: (existing.openDecisionCount ?? 0) + 1,
        waitsOnLivePrompt: true,
      });
    }

    this.appendTimeline({
      type: 'decision_card',
      threadId: input.threadId,
      author: 'coordinator',
      text: card.question,
      payload: {decisionId: card.id, options: card.options},
    });
    return structuredClone(card);
  }

  decide(
    decisionId: string,
    resolution: {
      optionIndex?: number;
      chosenBy?: string;
      close?: 'answered' | 'withdrawn';
    },
  ): ProjectDecisionCard {
    this.assertWritable();
    const cards = this.loadDecisions(true);
    const index = cards.findIndex(item => item.id === decisionId);
    if (index < 0) {
      throw new Error(`Decision card not found: ${decisionId}`);
    }
    const previous = cards[index];
    const close = resolution.close ?? 'answered';
    if (close === 'answered') {
      if (
        resolution.optionIndex === undefined ||
        resolution.optionIndex < 0 ||
        resolution.optionIndex >= previous.options.length
      ) {
        throw new Error('Decision optionIndex is out of range.');
      }
    }
    const next: ProjectDecisionCard = {
      ...previous,
      status: close,
      ...(resolution.optionIndex !== undefined
        ? {chosenIndex: resolution.optionIndex}
        : {}),
      ...(resolution.chosenBy ? {chosenBy: resolution.chosenBy} : {}),
      resolvedAt: this.now(),
    };
    const updated = [...cards];
    updated[index] = next;
    this.saveDecisions(updated);

    if (next.threadId && this.getThread(next.threadId)) {
      const thread = this.getThread(next.threadId)!;
      const openDecisions = updated.filter(
        item => item.threadId === next.threadId && item.status === 'open',
      );
      this.updateThread(next.threadId, {
        openDecisionId: openDecisions[0]?.id,
        openDecisionCount: openDecisions.length,
        waitsOnLivePrompt: openDecisions.length > 0,
        threadStatus: openDecisions.length > 0 ? 'needs_input' : 'idle',
      });
      void thread;
    }

    this.appendTimeline({
      type: 'activity',
      threadId: next.threadId,
      author: 'user',
      text:
        close === 'answered'
          ? `Selected "${next.options[next.chosenIndex!]?.label}" for "${next.question}"`
          : `Withdrew decision "${next.question}"`,
      payload: {
        decisionId: next.id,
        close,
        optionIndex: next.chosenIndex,
      },
    });
    return structuredClone(next);
  }

  private loadArtifacts(forceReload = false): ProjectPublishedArtifact[] {
    const stamp = readFileStamp(this.artifactsFile);
    if (
      !forceReload &&
      this.artifactsCache !== null &&
      this.artifactsStamp === stamp
    ) {
      return this.artifactsCache;
    }
    this.artifactsCache = this.readJsonArray<ProjectPublishedArtifact>(
      this.artifactsFile,
    );
    this.artifactsStamp = stamp;
    return this.artifactsCache;
  }

  private saveArtifacts(artifacts: ProjectPublishedArtifact[]): void {
    writeAtomic(this.artifactsFile, JSON.stringify(artifacts, null, 2));
    this.artifactsCache = artifacts;
    this.artifactsStamp = readFileStamp(this.artifactsFile);
  }

  publishArtifact(input: {
    id?: string;
    threadId?: string;
    kind: ProjectPublishedArtifact['kind'];
    title: string;
    summary?: string;
    pathOrUrl: string;
    pinned?: boolean;
  }): ProjectPublishedArtifact {
    this.assertWritable();
    const timestamp = this.now();
    const artifact: ProjectPublishedArtifact = {
      id: input.id?.trim() || `art_${randomUUID()}`,
      projectId: this.projectId,
      ...(input.threadId ? {threadId: input.threadId} : {}),
      kind: input.kind,
      title: input.title.trim(),
      ...(input.summary ? {summary: input.summary.trim()} : {}),
      pathOrUrl: input.pathOrUrl.trim(),
      pinned: Boolean(input.pinned),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.saveArtifacts([...this.loadArtifacts(true), artifact]);
    this.appendTimeline({
      type: 'artifact_published',
      threadId: artifact.threadId,
      author: 'coordinator',
      text: artifact.title,
      payload: {artifactId: artifact.id, kind: artifact.kind},
    });
    return structuredClone(artifact);
  }

  listArtifacts(options: {
    filter?: 'all' | 'pinned';
    sort?: 'newest' | 'recent';
  } = {}): ProjectPublishedArtifact[] {
    let items = this.loadArtifacts();
    if (options.filter === 'pinned') {
      items = items.filter(item => item.pinned);
    }
    const sorted = [...items].sort((left, right) => {
      const leftTs = options.sort === 'recent' ? left.updatedAt : left.createdAt;
      const rightTs =
        options.sort === 'recent' ? right.updatedAt : right.createdAt;
      return rightTs - leftTs;
    });
    return sorted.map(item => structuredClone(item));
  }

  setArtifactPinned(artifactId: string, pinned: boolean): ProjectPublishedArtifact {
    this.assertWritable();
    const artifacts = this.loadArtifacts(true);
    const index = artifacts.findIndex(item => item.id === artifactId);
    if (index < 0) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }
    const next: ProjectPublishedArtifact = {
      ...artifacts[index],
      pinned,
      updatedAt: this.now(),
    };
    const updated = [...artifacts];
    updated[index] = next;
    this.saveArtifacts(updated);
    return structuredClone(next);
  }

  listFiles(subDir = ''): SharedFileInfo[] {
    const base = subDir
      ? resolveContainedPath(this.filesDir, normalizeRelativePosix(subDir))
      : this.filesDir;
    if (!fs.existsSync(base)) {
      return [];
    }
    const results: SharedFileInfo[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const stat = fs.statSync(full);
          const rel = path.relative(this.filesDir, full).replace(/\\/g, '/');
          results.push({
            path: rel,
            size: stat.size,
            updatedAt: stat.mtimeMs,
            inlineEditable: stat.size <= INLINE_TEXT_EDIT_LIMIT_BYTES,
          });
        }
      }
    };
    walk(base);
    return results.sort((left, right) => left.path.localeCompare(right.path));
  }

  readFile(
    relativePath: string,
    range?: {offset?: number; length?: number},
  ): {
    path: string;
    content: string;
    sha256: string;
    size: number;
    truncated: boolean;
    inlineEditable: boolean;
  } {
    const rel = normalizeRelativePosix(relativePath);
    const full = resolveContainedPath(this.filesDir, rel);
    const buf = fs.readFileSync(full);
    const sha256 = sha256Of(buf);
    const offset = Math.max(0, range?.offset ?? 0);
    const length = range?.length;
    const sliced =
      length !== undefined ? buf.subarray(offset, offset + length) : buf.subarray(offset);
    return {
      path: rel,
      content: sliced.toString('utf8'),
      sha256,
      size: buf.length,
      truncated: offset > 0 || sliced.length < buf.length,
      inlineEditable: buf.length <= INLINE_TEXT_EDIT_LIMIT_BYTES,
    };
  }

  writeFile(input: {
    path: string;
    content: string;
    overwrite?: boolean;
    keepBoth?: boolean;
  }): SharedFileWriteResult {
    this.assertWritable();
    const rel = normalizeRelativePosix(input.path);
    const full = resolveContainedPath(this.filesDir, rel);
    const overwrite = input.overwrite ?? false;

    if (fs.existsSync(full)) {
      const existingContent = fs.readFileSync(full, 'utf8');
      const existingSha256 = sha256Of(existingContent);
      if (existingContent === input.content) {
        return {
          ok: true,
          path: rel,
          status: 'unchanged',
          sha256: existingSha256,
        };
      }
      if (!overwrite && !input.keepBoth) {
        return {
          ok: false,
          code: 'EEXIST',
          existingSha256,
          error: `File already exists: ${rel}`,
        };
      }
      if (input.keepBoth && !overwrite) {
        for (let suffix = 1; suffix <= KEEP_BOTH_MAX_SUFFIX; suffix += 1) {
          const candidateRel = withSuffix(rel, suffix);
          const candidateFull = resolveContainedPath(this.filesDir, candidateRel);
          if (!fs.existsSync(candidateFull)) {
            writeAtomic(candidateFull, input.content);
            return {
              ok: true,
              path: candidateRel,
              status: 'kept_both',
              sha256: sha256Of(input.content),
            };
          }
        }
        return {
          ok: false,
          code: 'FILE_EXISTS_LIMIT',
          error: `Could not create keep-both copy for ${rel} within 1..${KEEP_BOTH_MAX_SUFFIX}.`,
        };
      }
    }

    const existed = fs.existsSync(full);
    writeAtomic(full, input.content);
    return {
      ok: true,
      path: rel,
      status: existed ? 'overwritten' : 'created',
      sha256: sha256Of(input.content),
    };
  }

  mkdir(relativePath: string): void {
    this.assertWritable();
    const rel = normalizeRelativePosix(relativePath);
    const full = resolveContainedPath(this.filesDir, rel);
    fs.mkdirSync(full, {recursive: true});
  }

  moveFile(fromPath: string, toPath: string, overwrite = false): {ok: boolean; path?: string; error?: string} {
    this.assertWritable();
    const srcRel = normalizeRelativePosix(fromPath);
    const dstRel = normalizeRelativePosix(toPath);
    const srcFull = resolveContainedPath(this.filesDir, srcRel);
    const dstFull = resolveContainedPath(this.filesDir, dstRel);
    if (!fs.existsSync(srcFull)) {
      return {ok: false, error: `Source file not found: ${srcRel}`};
    }
    if (fs.existsSync(dstFull) && !overwrite) {
      return {ok: false, error: `Destination already exists: ${dstRel}`};
    }
    fs.mkdirSync(path.dirname(dstFull), {recursive: true});
    fs.renameSync(srcFull, dstFull);
    return {ok: true, path: dstRel};
  }

  deleteFile(relativePath: string): boolean {
    this.assertWritable();
    const rel = normalizeRelativePosix(relativePath);
    const full = resolveContainedPath(this.filesDir, rel);
    if (!fs.existsSync(full)) {
      return false;
    }
    fs.rmSync(full, {recursive: true, force: true});
    return true;
  }

  private normalizeMemoryPath(memPath = '/MEMORY.md'): string {
    const rel = normalizeRelativePosix(memPath);
    return `/${rel}`;
  }

  readMemory(memPath = '/MEMORY.md'): MemoryReadResult {
    const normalized = this.normalizeMemoryPath(memPath);
    const full = resolveContainedPath(this.memoryDir, normalized.slice(1));
    if (!fs.existsSync(full)) {
      return {
        exists: false,
        path: normalized,
        content: '',
        sha256: '',
      };
    }
    const content = fs.readFileSync(full, 'utf8');
    return {
      exists: true,
      path: normalized,
      content,
      sha256: sha256Of(content),
    };
  }

  createMemory(memPath = '/MEMORY.md', content = ''): MemoryMutationResult {
    this.assertWritable();
    const normalized = this.normalizeMemoryPath(memPath);
    const full = resolveContainedPath(this.memoryDir, normalized.slice(1));
    if (fs.existsSync(full)) {
      const currentSha256 = sha256Of(fs.readFileSync(full, 'utf8'));
      return {
        ok: false,
        path: normalized,
        code: 'PRECONDITION_FAILED',
        currentSha256,
        error: `Memory file already exists: ${normalized}`,
      };
    }
    writeAtomic(full, content);
    return {
      ok: true,
      path: normalized,
      sha256: sha256Of(content),
    };
  }

  updateMemory(
    memPath = '/MEMORY.md',
    content: string,
    expectedSha256: string,
  ): MemoryMutationResult {
    this.assertWritable();
    const normalized = this.normalizeMemoryPath(memPath);
    const full = resolveContainedPath(this.memoryDir, normalized.slice(1));
    if (!fs.existsSync(full)) {
      return {
        ok: false,
        path: normalized,
        code: 'PRECONDITION_FAILED',
        currentSha256: '',
        error: `Memory file does not exist: ${normalized}`,
      };
    }
    const currentSha256 = sha256Of(fs.readFileSync(full, 'utf8'));
    if (currentSha256 !== expectedSha256) {
      return {
        ok: false,
        path: normalized,
        code: 'PRECONDITION_FAILED',
        currentSha256,
        error: 'Memory file changed concurrently (SHA-256 mismatch).',
      };
    }
    writeAtomic(full, content);
    return {
      ok: true,
      path: normalized,
      sha256: sha256Of(content),
    };
  }

  deleteMemory(memPath: string, expectedSha256: string): MemoryMutationResult {
    this.assertWritable();
    const normalized = this.normalizeMemoryPath(memPath);
    const full = resolveContainedPath(this.memoryDir, normalized.slice(1));
    if (!fs.existsSync(full)) {
      return {
        ok: false,
        path: normalized,
        code: 'PRECONDITION_FAILED',
        currentSha256: '',
        error: `Memory file does not exist: ${normalized}`,
      };
    }
    const currentSha256 = sha256Of(fs.readFileSync(full, 'utf8'));
    if (currentSha256 !== expectedSha256) {
      return {
        ok: false,
        path: normalized,
        code: 'PRECONDITION_FAILED',
        currentSha256,
        error: 'Memory file changed concurrently (SHA-256 mismatch).',
      };
    }
    fs.rmSync(full, {force: true});
    return {
      ok: true,
      path: normalized,
    };
  }

  listMemoryFiles(): string[] {
    if (!fs.existsSync(this.memoryDir)) {
      return [];
    }
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          found.push(`/${path.relative(this.memoryDir, full).replace(/\\/g, '/')}`);
        }
      }
    };
    walk(this.memoryDir);
    return found.sort();
  }

  getStatusPage(): string {
    try {
      return fs.readFileSync(this.statusPageFile, 'utf8');
    } catch {
      return '';
    }
  }

  setStatusPage(html: string): void {
    this.assertWritable();
    writeAtomic(this.statusPageFile, html);
  }

  getRecap(): ProjectRecapData | null {
    try {
      return JSON.parse(fs.readFileSync(this.recapFile, 'utf8')) as ProjectRecapData;
    } catch {
      return null;
    }
  }

  setRecap(text: string, links?: ProjectRecapLink[]): ProjectRecapData {
    this.assertWritable();
    const recap: ProjectRecapData = {
      text,
      updatedAt: this.now(),
      dismissed: false,
      ...(links ? {links} : {}),
    };
    writeAtomic(this.recapFile, JSON.stringify(recap, null, 2));
    return recap;
  }

  dismissRecap(dismissed = true): ProjectRecapData | null {
    this.assertWritable();
    const existing = this.getRecap();
    if (!existing) {
      return null;
    }
    const next: ProjectRecapData = {
      ...existing,
      dismissed,
    };
    writeAtomic(this.recapFile, JSON.stringify(next, null, 2));
    return next;
  }

  getSections(): ProjectOverviewSectionState {
    try {
      return JSON.parse(
        fs.readFileSync(this.sectionsFile, 'utf8'),
      ) as ProjectOverviewSectionState;
    } catch {
      return {version: 0, hiddenIds: [], order: []};
    }
  }

  updateSections(patch: {
    hiddenIds?: string[];
    order?: string[];
    expectedVersion: number;
  }): SectionsUpdateResult {
    this.assertWritable();
    const current = this.getSections();
    if (current.version !== patch.expectedVersion) {
      return {
        ok: false,
        code: 'PRECONDITION_FAILED',
        state: current,
        error: 'Section layout version mismatch.',
      };
    }
    const next: ProjectOverviewSectionState = {
      version: current.version + 1,
      hiddenIds: patch.hiddenIds ?? current.hiddenIds,
      order: patch.order ?? current.order,
    };
    writeAtomic(this.sectionsFile, JSON.stringify(next, null, 2));
    return {ok: true, state: next};
  }
}
