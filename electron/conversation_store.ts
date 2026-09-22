'use strict';


const fs = require('node:fs');
const path = require('node:path');
const { projectStudioHomeStats } = require('./studio_home_stats');

const MAX_CONVERSATIONS = 500;
const TITLE_MAX = 28;

interface ReferencedObject {
  app?: string;
  windowTitle?: string;
  elementPath?: string;
  label?: string;
  [key: string]: unknown;
}

type Artifact = Record<string, unknown>;

interface TurnEntry {
  runtimeTurn?: number;
  id: string;
  at: number;
  startedAt: number;
  completedAt?: number;
  question: string;
  answer: string;
  trace: unknown[];
  facts: unknown[];
  artifacts: Artifact[];
  outcome: string;
  failed?: boolean;
  error?: string;
  events?: unknown[];
  thinking?: string;
  activities: unknown[];
  trajectory: unknown[];
  receipts: unknown[];
  modelUsage: Record<string, number>;
  modelId?: string;
  timingMs?: number;
  usedBackend?: string;
  evidence?: TurnEvidence;
  permissionAnswer?: { decision: 'once' | 'grant' | 'deny'; rule: string };
  pendingInput?: TurnPendingInput;
}

export interface TurnEvidence {
  capturePath?: string;
  annotatedPath?: string;
  label?: string;
  contentDigest?: string;
}

export interface TurnPendingInput {
  actionPreview?: string;
  plan?: string;
  requestId?: string;
  questions?: Array<{ question: string; header?: string; multiSelect?: boolean; options: Array<{ label: string; description?: string; preview?: string }> }>;
  question?: string;
  options?: string[];
  kind?: string;
  tool?: string;
  prefix?: string;
}

interface Conversation {
  id: string;
  objectKey: string;
  title: string;
  titleCustom?: boolean;
  subtitle: string;
  object: ReferencedObject;
  createdAt: number;
  updatedAt: number;
  closed: boolean;
  turns?: TurnEntry[];
  workspaceRoot?: string;
  agentSessionId?: string;
  hasPendingWork?: boolean;
  permissionGrants?: string[];
  permissionDenials?: string[];
  taskContext?: Record<string, unknown>;
}

interface TurnInput {
  runtimeTurn?: unknown;
  capturedAt?: number;
  conversationId?: string;
  newConversation?: boolean;
  question?: unknown;
  answer?: unknown;
  object?: ReferencedObject;
  trace?: unknown;
  facts?: unknown;
  artifacts?: unknown;
  outcome?: unknown;
  failed?: unknown;
  error?: unknown;
  events?: unknown;
  thinking?: unknown;
  activities?: unknown;
  trajectory?: unknown;
  receipts?: unknown;
  modelUsage?: unknown;
  modelId?: unknown;
  timingMs?: unknown;
  usedBackend?: unknown;
  workspaceRoot?: unknown;
  agentSessionId?: unknown;
  hasPendingWork?: unknown;
  permissionGrant?: unknown;
  permissionDeny?: unknown;
  permissionGrantOnce?: unknown;
  evidence?: unknown;
  pendingInput?: unknown;
  taskContext?: unknown;
}

interface ConversationStoreOptions {
  baseDir: string;
  now?: () => number;
  deferPersist?: boolean;
  persistDebounceMs?: number;
  onPersistError?: (error: unknown, context: string) => void;
}

const CONVERSATION_PERSIST_DEBOUNCE_MS = 1000;

const MAX_PERSIST_FAILURE_REPORTS = 5;
const PERSIST_FAILURE_REPORT_INTERVAL_MS = 60_000;

const ASYNC_WRITE_RETRY_BUDGET = 3;

interface ProjectRecord {
  root: string;
  name: string;
  addedAt: number;
  lastOpenedAt: number;
}

function isTurnSettled(outcome: unknown): boolean {
  const value = String(outcome || '').trim().toLocaleLowerCase();
  if (!value) return false;
  return !['进行中', 'running', 'in_progress', 'pending', 'waiting'].includes(value);
}

const TRANSIENT_ELEMENT_RE = /^(selection|snapshot|obj)-[a-f0-9]{8,}$/i;

function stableElementPath(elementPath: unknown): string {
  const raw = String(elementPath || '').trim();
  if (!raw) return '';
  if (TRANSIENT_ELEMENT_RE.test(raw)) return '';
  return raw;
}

function objectKey(object: ReferencedObject = {}): string {
  const parts = [object.app || '', object.windowTitle || '', stableElementPath(object.elementPath)];
  const filled = parts.filter(Boolean);
  return filled.length ? filled.join('|') : 'unknown';
}

const VAPID_QUESTION_RE =
  /^(你好|您好|嗨|在吗|在不在|你是谁|你叫什么|hello|hi|hey|这是什么|这是啥|这啥|那是什么|这啥意思|这啥字|啥意思|什么意思)$/i;

function isSubstantiveQuestion(title: unknown = ''): boolean {
  const t = String(title).trim();
  if (!t) return false;
  if (VAPID_QUESTION_RE.test(t)) return false;
  if (t.length <= 2 && /^[这那它啥谁]/.test(t)) return false;
  return true;
}

function titleFrom(question: unknown = ''): string {
  const clean = String(question).replace(/\s+/g, ' ').trim();
  if (!clean) return '未命名';

  let t = clean;
  t = t.replace(/([？?])$/, '');
  for (const tail of [
    '是什么意思',
    '是干什么的',
    '是怎么回事',
    '在干嘛',
    '在做什么',
    '怎么用',
    '怎么做',
    '为什么',
  ]) {
    if (t.endsWith(tail)) {
      t = t.slice(0, -tail.length).trim();
      break;
    }
  }
  t = t.replace(/^(请|帮我|麻烦|能不能|可以|怎么|如何|为什么)/, '');
  t = t.replace(/^(请问|我想问|问一下)/, '');
  t = t.replace(/^(这个|这段|这行|这里|那边)/, '');
  t = t.trim();
  if (!t) t = clean;

  if (t.length > TITLE_MAX) {
    const cut = t.search(/[，。；,;:：]/);
    if (cut > 0 && cut < TITLE_MAX) t = t.slice(0, cut).trim();
  }
  if (t.length > TITLE_MAX) t = `${t.slice(0, TITLE_MAX - 1)}…`;
  return t;
}

function subtitleFrom(object: ReferencedObject = {}): string {
  const bits = [object.app, object.label || object.windowTitle].filter(Boolean);
  return bits.join(' · ');
}

function createConversationStore(
  {
    baseDir,
    now = () => Date.now(),
    deferPersist = false,
    persistDebounceMs = CONVERSATION_PERSIST_DEBOUNCE_MS,
    onPersistError = () => {},
  }: ConversationStoreOptions = {
    baseDir: '',
  },
) {
  const file = path.join(baseDir, 'conversations.json');
  const projectsFile = path.join(baseDir, 'projects.json');
  let items: Conversation[] | null = null;
  let projectItems: ProjectRecord[] | null = null;
  let dirty = false;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  let failureReports = 0;
  let lastFailureReportAt = 0;

  function reportPersistFailure(error: unknown, context: string): void {
    if (failureReports >= MAX_PERSIST_FAILURE_REPORTS) return;
    const at = now();
    if (failureReports > 0 && at - lastFailureReportAt < PERSIST_FAILURE_REPORT_INTERVAL_MS) return;
    failureReports += 1;
    lastFailureReportAt = at;
    try {
      onPersistError(error, context);
    } catch (_) {
      // The reporter must not be able to break persistence.
    }
  }

  interface SerializedConversation {
    ref: Conversation;
    json: string;
    updatedAt: number;
    turnCount: number;
    title: string;
  }
  const serializedConversations = new Map<string, SerializedConversation>();
  const dirtyConversations = new WeakSet<object>();

  function markDirty(conversation: Conversation | null | undefined): void {
    if (conversation && typeof conversation === 'object') dirtyConversations.add(conversation);
  }

  function serializeConversations(): string {
    const conversations = items || [];
    const live = new Set<string>();
    const parts: string[] = [];
    for (const conversation of conversations) {
      const id = String(conversation.id);
      live.add(id);
      const cached = serializedConversations.get(id);
      const turnCount = (conversation.turns || []).length;
      if (
        cached
        && cached.ref === conversation
        && !dirtyConversations.has(conversation)
        && cached.updatedAt === Number(conversation.updatedAt)
        && cached.turnCount === turnCount
        && cached.title === String(conversation.title || '')
      ) {
        parts.push(cached.json);
        continue;
      }
      const json = JSON.stringify(conversation);
      serializedConversations.set(id, {
        ref: conversation,
        json,
        updatedAt: Number(conversation.updatedAt),
        turnCount,
        title: String(conversation.title || ''),
      });
      dirtyConversations.delete(conversation);
      parts.push(json);
    }
    for (const id of [...serializedConversations.keys()]) {
      if (!live.has(id)) serializedConversations.delete(id);
    }
    return `[${parts.join(',')}]`;
  }

  function load(): Conversation[] {
    if (items) return items;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      items = Array.isArray(parsed) ? (parsed as Conversation[]) : [];
    } catch {
      items = [];
    }
    return items;
  }

  let syncWriteCount = 0;
  let asyncWritePending = false;
  let asyncRetryBudget = ASYNC_WRITE_RETRY_BUDGET;

  function writeNow(): void {
    const payload = serializeConversations();
    fs.mkdirSync(baseDir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, file);
    syncWriteCount += 1;
  }

  function writeNowAsync(): void {
    if (asyncWritePending) return;
    dirty = false;
    asyncWritePending = true;
    const startedAtSyncWrite = syncWriteCount;
    let payload: string;
    try {
      payload = serializeConversations();
    } catch (error) {
      asyncWritePending = false;
      dirty = true;
      reportPersistFailure(error, 'serialize');
      return;
    }
    const tmp = `${file}.tmp.async`;
    const finish = (error: unknown): void => {
      asyncWritePending = false;
      if (!error) {
        asyncRetryBudget = ASYNC_WRITE_RETRY_BUDGET;
        if (dirty) writeNowAsync();
        return;
      }
      dirty = true;
      reportPersistFailure(error, 'background-write');
      if (persistTimer === null && asyncRetryBudget > 0) {
        asyncRetryBudget -= 1;
        persistTimer = setTimeout(() => {
          persistTimer = null;
          if (!dirty) return;
          writeNowAsync();
        }, persistDebounceMs);
        if (typeof persistTimer === 'object' && persistTimer !== null && 'unref' in persistTimer) {
          (persistTimer as unknown as { unref(): void }).unref();
        }
      }
    };
    fs.mkdir(baseDir, { recursive: true }, (mkdirError: NodeJS.ErrnoException | null) => {
      if (mkdirError) { finish(mkdirError); return; }
      fs.writeFile(tmp, payload, 'utf8', (writeError: NodeJS.ErrnoException | null) => {
        if (writeError) { finish(writeError); return; }
        if (syncWriteCount !== startedAtSyncWrite) {
          finish(null);
          return;
        }
        fs.rename(tmp, file, (renameError: NodeJS.ErrnoException | null) => {
          if (renameError) { finish(renameError); return; }
          finish(null);
        });
      });
    });
  }

  function persist(): void {
    if (!deferPersist) {
      dirty = true;
      try {
        writeNow();
        dirty = false;
      } catch (error) {
        reportPersistFailure(error, 'persist');
      }
      return;
    }
    dirty = true;
    asyncRetryBudget = ASYNC_WRITE_RETRY_BUDGET;
    if (persistTimer !== null) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (!dirty) return;
      writeNowAsync();
    }, persistDebounceMs);
    if (typeof persistTimer === 'object' && persistTimer !== null && 'unref' in persistTimer) {
      (persistTimer as unknown as { unref(): void }).unref();
    }
  }

  function flush(): void {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (!dirty && !asyncWritePending) return;
    dirty = false;
    try {
      writeNow();
    } catch (error) {
      dirty = true;
      reportPersistFailure(error, 'flush');
    }
  }

  function loadProjects(): ProjectRecord[] {
    if (projectItems) return projectItems;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
      projectItems = Array.isArray(parsed)
        ? (parsed as ProjectRecord[]).filter((project) => Boolean(String(project?.root || '').trim()))
        : [];
    } catch {
      projectItems = [];
    }
    return projectItems;
  }

  function persistProjects(): void {
    fs.mkdirSync(baseDir, { recursive: true });
    const tmp = `${projectsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(projectItems || []), 'utf8');
    fs.renameSync(tmp, projectsFile);
  }

  function registerProject(rawRoot: unknown): ProjectRecord | null {
    const input = String(rawRoot || '').trim();
    if (!input) return null;
    const root = input;
    const key = root.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
    const projects = loadProjects();
    const existing = projects.find((project) => {
      const candidate = project.root.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
      return candidate === key;
    });
    const openedAt = now();
    if (existing) {
      existing.lastOpenedAt = openedAt;
      persistProjects();
      return existing;
    }
    const project: ProjectRecord = {
      root,
      name: path.basename(path.normalize(root)) || root,
      addedAt: openedAt,
      lastOpenedAt: openedAt,
    };
    projects.unshift(project);
    persistProjects();
    return project;
  }

  function listProjects(): ProjectRecord[] {
    const projects = loadProjects();
    let imported = false;
    for (const conversation of load()) {
      const root = String(conversation.workspaceRoot || '').trim();
      if (!root) continue;
      const normalized = root;
      const key = normalized.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
      if (projects.some((project) => {
        const candidate = project.root.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
        return candidate === key;
      })) continue;
      projects.push({
        root: normalized,
        name: path.basename(path.normalize(normalized)) || normalized,
        addedAt: conversation.createdAt,
        lastOpenedAt: conversation.updatedAt,
      });
      imported = true;
    }
    if (imported) persistProjects();
    return [...projects]
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
      .map((project) => ({ ...project }));
  }

  function permissionAnswerOf(
    turn: TurnInput,
  ): { decision: 'once' | 'grant' | 'deny'; rule: string } | undefined {
    const grant = String(turn.permissionGrant || '').trim();
    const deny = String(turn.permissionDeny || '').trim();
    const once = String(turn.permissionGrantOnce || '').trim();
    if (deny) return { decision: 'deny', rule: deny };
    if (grant) return { decision: 'grant', rule: grant };
    if (once) return { decision: 'once', rule: once };
    return undefined;
  }

  function appendTurn(turn: TurnInput = {}): Conversation {
    const conversations = load();
    const at = turn.capturedAt || now();
    const key = objectKey(turn.object || {});
    const explicit = turn.conversationId
      ? conversations.find((conversation) => conversation.id === turn.conversationId)
      : null;
    const target = turn.newConversation === true
      ? null
      : explicit || conversations.find((conversation) => conversation.objectKey === key && !conversation.closed);

    const entry: TurnEntry = {
      id: `t${at}`,
      at,
      startedAt: at,
      ...(isTurnSettled(turn.outcome) ? { completedAt: at } : {}),
      ...(permissionAnswerOf(turn) ? { permissionAnswer: permissionAnswerOf(turn) } : {}),
      question: String(turn.question || ''),
      answer: String(turn.answer || ''),
      trace: Array.isArray(turn.trace) ? turn.trace.slice(0, 24) : [],
      facts: Array.isArray(turn.facts) ? turn.facts.slice(0, 24) : [],
      artifacts: Array.isArray(turn.artifacts) ? (turn.artifacts.slice(0, 12) as Artifact[]) : [],
      outcome: String(turn.outcome || ''),
      ...(typeof turn.failed === 'boolean' ? { failed: turn.failed } : {}),
      ...(turn.error ? { error: String(turn.error) } : {}),
      events: Array.isArray(turn.events) ? turn.events.slice(0, 48) : [],
      thinking: turn.thinking !== undefined ? String(turn.thinking) : undefined,
      activities: Array.isArray(turn.activities) ? turn.activities.slice(0, 96) : [],
      trajectory: Array.isArray(turn.trajectory) ? turn.trajectory.slice() : [],
      receipts: Array.isArray(turn.receipts) ? turn.receipts.slice(0, 48) : [],
      modelUsage: turn.modelUsage && typeof turn.modelUsage === 'object' && !Array.isArray(turn.modelUsage)
        ? Object.fromEntries(Object.entries(turn.modelUsage as Record<string, unknown>)
          .filter(([, value]) => Number.isFinite(Number(value)))
          .map(([key, value]) => [key, Number(value)]))
        : {},
      modelId: String(turn.modelId || '').trim() || undefined,
      runtimeTurn: Number.isInteger(Number(turn.runtimeTurn)) && Number(turn.runtimeTurn) > 0 ? Number(turn.runtimeTurn) : undefined,
      timingMs: Number.isFinite(Number(turn.timingMs)) ? Number(turn.timingMs) : undefined,
      usedBackend: turn.usedBackend !== undefined ? String(turn.usedBackend) : undefined,
      evidence: sanitizeEvidence(turn.evidence),
      pendingInput: sanitizePendingInput(turn.pendingInput),
    };

    if (target) {
      if (!Array.isArray(target.turns)) target.turns = [];
      target.turns.push(entry);
      const explicitRoot = String(turn.workspaceRoot || '').trim();
      if (explicitRoot) target.workspaceRoot = registerProject(explicitRoot)?.root || explicitRoot;
      const agentSessionId = String(turn.agentSessionId || '').trim();
      if (agentSessionId) target.agentSessionId = agentSessionId;
      if (typeof turn.hasPendingWork === 'boolean') target.hasPendingWork = turn.hasPendingWork;
      const taskContext = sanitizeTaskContext(turn.taskContext);
      if (taskContext) target.taskContext = taskContext;
      if (!target.titleCustom && !permissionAnswerOf(turn)) target.title = titleFrom(turn.question);
      const grant = String(turn.permissionGrant || '').trim();
      if (grant) {
        target.permissionGrants = target.permissionGrants || [];
        if (!target.permissionGrants.includes(grant)) target.permissionGrants.push(grant);
      }
      const deny = String(turn.permissionDeny || '').trim();
      if (deny) {
        target.permissionDenials = target.permissionDenials || [];
        if (!target.permissionDenials.includes(deny)) target.permissionDenials.push(deny);
      }
      target.updatedAt = at;
      conversations.splice(conversations.indexOf(target), 1);
      conversations.unshift(target);
      markDirty(target);
      persist();
      return target;
    }

    const created: Conversation = {
      id: `c${at}`,
      objectKey: key,
      title: titleFrom(turn.question),
      subtitle: subtitleFrom(turn.object || {}),
      object: turn.object || {},
      createdAt: at,
      updatedAt: at,
      closed: false,
      turns: [entry],
      workspaceRoot: registerProject(turn.workspaceRoot)?.root || undefined,
      agentSessionId: String(turn.agentSessionId || '').trim() || undefined,
      hasPendingWork: typeof turn.hasPendingWork === 'boolean' ? turn.hasPendingWork : false,
      ...(sanitizeTaskContext(turn.taskContext)
        ? { taskContext: sanitizeTaskContext(turn.taskContext) }
        : {}),
      ...(String(turn.permissionGrant || '').trim() ? { permissionGrants: [String(turn.permissionGrant).trim()] } : {}),
      ...(String(turn.permissionDeny || '').trim() ? { permissionDenials: [String(turn.permissionDeny).trim()] } : {}),
    };
    conversations.unshift(created);
    markDirty(created);
    persist();
    return created;
  }

  function sanitizeEvidence(value: unknown): TurnEntry['evidence'] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const key of ['capturePath', 'annotatedPath', 'label', 'contentDigest'] as const) {
      const text = String(raw[key] ?? '').trim();
      if (text) out[key] = text.slice(0, key === 'contentDigest' ? 1600 : 500);
    }
    return Object.keys(out).length ? out : undefined;
  }

  function sanitizePendingInput(value: unknown): TurnEntry['pendingInput'] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const question = String(raw.question ?? '').trim();
    const options = Array.isArray(raw.options) ? raw.options.map((o) => String(o)).filter(Boolean) : [];
    const kind = String(raw.kind ?? '').trim();
    if (!question && !options.length && !kind) return undefined;
    return {
      question,
      options,
      requestId: String(raw.requestId || '').trim() || undefined,
      ...(Array.isArray(raw.questions) ? { questions: raw.questions.slice(0, 4).map((item: any) => ({
        question: String(item.question || ''), header: String(item.header || ''), multiSelect: item.multiSelect === true,
        options: Array.isArray(item.options) ? item.options.slice(0, 4).map((option: any) => ({
          label: String(option.label || option || ''), description: String(option.description || ''),
          ...(option.preview ? { preview: String(option.preview).slice(0, 16000) } : {}),
        })) : [],
      })) } : {}),
      kind: kind || undefined,
      ...(kind === 'plan' ? { plan: String(raw.plan || '').slice(0, 32000) } : {}),
      tool: String(raw.tool ?? '').trim() || undefined,
      prefix: String(raw.prefix ?? '').trim().slice(0, 160) || undefined,
      actionPreview: typeof raw.actionPreview === 'string' ? raw.actionPreview : undefined,
    };
  }

  function updateTurn(input: {
    runtimeTurn?: unknown;
    conversationId?: unknown;
    turnIndex?: unknown;
    agentSessionId?: unknown;
    hasPendingWork?: unknown;
    answer?: unknown;
    taskContext?: unknown;
    outcome?: unknown;
    failed?: unknown;
    error?: unknown;
    events?: unknown;
    activities?: unknown;
    trajectory?: unknown;
    receipts?: unknown;
    artifacts?: unknown;
    modelUsage?: unknown;
    usedBackend?: unknown;
    timingMs?: unknown;
    thinking?: unknown;
    evidence?: unknown;
    pendingInput?: unknown;
  }): { ok: boolean; conversation?: Conversation } {
    const conversations = load();
    const target = String(input.conversationId || '').trim()
      ? conversations.find((conversation) => conversation.id === String(input.conversationId).trim())
      : null;
    if (!target || !Array.isArray(target.turns) || target.turns.length === 0) {
      return { ok: false };
    }
    const index = Number.isInteger(Number(input.turnIndex))
      ? Math.max(0, Math.min(target.turns.length - 1, Number(input.turnIndex)))
      : target.turns.length - 1;
    const turn = target.turns[index];
    if (!turn) return { ok: false };
    if (input.agentSessionId !== undefined) target.agentSessionId = String(input.agentSessionId || '');
    if (Number.isInteger(Number(input.runtimeTurn)) && Number(input.runtimeTurn) > 0) turn.runtimeTurn = Number(input.runtimeTurn);
    if (typeof input.hasPendingWork === 'boolean') target.hasPendingWork = input.hasPendingWork;
    const taskContext = sanitizeTaskContext(input.taskContext);
    if (taskContext) target.taskContext = taskContext;
    if (input.answer !== undefined) turn.answer = String(input.answer || '').slice(0, 200000);
    if (input.outcome !== undefined) turn.outcome = String(input.outcome || '').slice(0, 40);
    if (typeof input.failed === 'boolean') turn.failed = input.failed;
    if (input.error !== undefined) turn.error = String(input.error || '');
    if (Array.isArray(input.events)) turn.events = input.events.slice(0, 48);
    if (Array.isArray(input.activities)) turn.activities = input.activities.slice(0, 96);
    if (Array.isArray(input.trajectory)) turn.trajectory = input.trajectory.slice();
    if (Array.isArray(input.receipts)) turn.receipts = input.receipts.slice(0, 48);
    if (Array.isArray(input.artifacts)) turn.artifacts = input.artifacts.slice(0, 12);
    if (input.modelUsage && typeof input.modelUsage === 'object' && !Array.isArray(input.modelUsage)) {
      turn.modelUsage = Object.fromEntries(Object.entries(input.modelUsage as Record<string, unknown>)
        .filter(([, value]) => Number.isFinite(Number(value)))
        .map(([key, value]) => [key, Number(value)]));
    }
    if (input.usedBackend !== undefined) turn.usedBackend = String(input.usedBackend || '');
    if (input.thinking !== undefined) turn.thinking = String(input.thinking || '');
    if (input.evidence !== undefined) turn.evidence = sanitizeEvidence(input.evidence);
    if (input.pendingInput !== undefined) turn.pendingInput = sanitizePendingInput(input.pendingInput);
    if (Number.isFinite(Number(input.timingMs))) turn.timingMs = Number(input.timingMs);
    const updatedAt = now();
    if (!Number.isFinite(Number(turn.startedAt))) turn.startedAt = Number(turn.at) || updatedAt;
    turn.at = turn.startedAt;
    if (input.outcome !== undefined) {
      if (isTurnSettled(turn.outcome)) turn.completedAt = updatedAt;
      else delete turn.completedAt;
    }
    target.updatedAt = updatedAt;
    markDirty(target);
    persist();
    return { ok: true, conversation: target };
  }

  function recordPermissionDecision(input: {
    conversationId?: unknown;
    grant?: unknown;
    deny?: unknown;
  }): { ok: boolean; conversation?: Conversation } {
    const conversations = load();
    const target = conversations.find(
      (conversation) => conversation.id === String(input.conversationId || '').trim(),
    );
    const grant = String(input.grant || '').trim();
    const deny = String(input.deny || '').trim();
    if (!target || (!grant && !deny)) return { ok: false };
    if (grant) {
      target.permissionGrants = target.permissionGrants || [];
      if (!target.permissionGrants.includes(grant)) target.permissionGrants.push(grant);
    }
    if (deny) {
      target.permissionDenials = target.permissionDenials || [];
      if (!target.permissionDenials.includes(deny)) target.permissionDenials.push(deny);
    }
    const turns = target.turns || [];
    const lastTurn = turns[turns.length - 1];
    if (lastTurn?.pendingInput?.kind === 'permission') delete lastTurn.pendingInput;
    target.updatedAt = now();
    markDirty(target);
    persist();
    return { ok: true, conversation: target };
  }

  function recoverInterruptedTurns(): void {
    let changed = false;
    for (const conversation of load()) {
      let recovered = false;
      const turns = conversation.turns || [];
      for (const [index, turn] of turns.entries()) {
        if (turn.outcome !== '进行中') continue;
        turn.outcome = '可恢复';
        turn.failed = true;
        turn.error = '上次客户端会话已中断，可以继续此任务。此前操作结果需恢复后核实。';
        if (index === turns.length - 1) conversation.hasPendingWork = true;
        recovered = true;
      }
      if (recovered) {
        markDirty(conversation);
        changed = true;
      }
    }
    if (changed) persist();
  }

  function list(limit = Number.POSITIVE_INFINITY) {
    const conversations = load();
    return conversations.slice(0, limit).map((c) => ({
      id: c.id,
      title: c.title,
      subtitle: c.subtitle,
      object: c.object,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      workspaceRoot: c.workspaceRoot || '',
      agentSessionId: c.agentSessionId || '',
      hasPendingWork: c.hasPendingWork === true,
      taskContext: sanitizeTaskContext(c.taskContext),
      permissionGrants: Array.isArray(c.permissionGrants) ? c.permissionGrants : [],
      permissionDenials: Array.isArray(c.permissionDenials) ? c.permissionDenials : [],
      turns: (c.turns || []).length,
      outcomes: [...new Set((c.turns || []).map((t) => t.outcome).filter(Boolean))],
    }));
  }

  function get(id: unknown): Conversation | null {
    return load().find((conversation) => conversation.id === id) || null;
  }

  function branch(id: unknown, turnIndex: unknown, runtime?: { agentSessionId: string; taskContext?: unknown }): Conversation | null {
    const conversations = load();
    const source = conversations.find((conversation) => conversation.id === id);
    const index = Number(turnIndex);
    const sourceTurns = source?.turns || [];
    if (!source || !Number.isInteger(index) || index < 0 || index >= sourceTurns.length) return null;

    const at = now();
    const titleSuffix = ' · 分支';
    const baseTitle = String(source.title || '未命名');
    const title = `${baseTitle.slice(0, Math.max(1, TITLE_MAX - titleSuffix.length))}${titleSuffix}`;
    const created: Conversation = {
      id: `c${at}`,
      objectKey: source.objectKey,
      title,
      titleCustom: true,
      subtitle: source.subtitle,
      object: structuredClone(source.object || {}),
      createdAt: at,
      updatedAt: at,
      closed: false,
      turns: structuredClone(sourceTurns.slice(0, index + 1)),
      workspaceRoot: source.workspaceRoot,
      ...(runtime ? { agentSessionId: runtime.agentSessionId, taskContext: sanitizeTaskContext(runtime.taskContext) } : {}),
      hasPendingWork: false,
      permissionGrants: structuredClone(source.permissionGrants || []),
      permissionDenials: structuredClone(source.permissionDenials || []),
    };
    conversations.unshift(created);
    markDirty(created);
    persist();
    return created;
  }

  function timeline(limit = 60) {
    const days = new Map<string, { key: string; at: number; items: ReturnType<typeof list> }>();
    for (const c of list(limit)) {
      const d = new Date(c.updatedAt);
      const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      if (!days.has(key)) days.set(key, { key, at: c.updatedAt, items: [] });
      days.get(key)?.items.push(c);
    }
    return [...days.values()];
  }

  function memories(minTouches = 2) {
    const conversations = load();
    const byObject = new Map<
      string,
      {
        key: string;
        object: ReferencedObject;
        subtitle: string;
        touches: number;
        lastAt: number;
        questions: string[];
      }
    >();
    for (const c of conversations) {
      const m = byObject.get(c.objectKey) || {
        key: c.objectKey,
        object: c.object,
        subtitle: c.subtitle,
        touches: 0,
        lastAt: 0,
        questions: [],
      };
      m.touches += (c.turns || []).length;
      m.lastAt = Math.max(m.lastAt, c.updatedAt);
      m.questions.push(c.title);
      byObject.set(c.objectKey, m);
    }
    return (
      [...byObject.values()]
        .filter((m) => m.touches >= minTouches)
        .filter((m) => m.questions.some((q) => isSubstantiveQuestion(q)))
        .sort((a, b) => b.lastAt - a.lastAt)
    );
  }

  function artifacts(limit = 80) {
    const conversations = load();
    const out: Array<Artifact & { at: number; conversationId: string; from: string }> = [];
    for (const c of conversations) {
      for (const t of c.turns || []) {
        for (const a of t.artifacts || []) {
          out.push({
            ...a,
            at: Number(t.completedAt || t.startedAt || t.at),
            conversationId: c.id,
            from: c.title,
          });
        }
      }
    }
    return out.sort((x, y) => y.at - x.at).slice(0, limit);
  }

  function stats(at = now()) {
    return projectStudioHomeStats(load(), at);
  }

  function sanitizeTaskContext(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const data = value as Record<string, unknown>;
    const taskId = String(data.taskId || '').trim();
    const revision = Number(data.referenceRevision);
    if (!taskId || !Number.isInteger(revision) || revision < 0) return undefined;
    return {
      taskId,
      referenceRevision: revision,
      ...(typeof data.permissionMode === 'string' ? { permissionMode: data.permissionMode } : {}),
      ...(typeof data.effort === 'string' ? { effort: data.effort } : {}),
      sources: Array.isArray(data.sources) ? structuredClone(data.sources) : [],
      references: Array.isArray(data.references) ? structuredClone(data.references) : [],
    };
  }

  function eventSummaries(options: {
    fromMs?: unknown;
    toMs?: unknown;
    conversationIds?: unknown;
    limit?: unknown;
  } = {}) {
    const fromMs = Math.max(0, Number(options.fromMs) || 0);
    const toMs = Math.max(fromMs, Number(options.toMs) || now());
    const requested = new Set(
      (Array.isArray(options.conversationIds) ? options.conversationIds : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .slice(0, 500),
    );
    const limit = Math.max(0, Math.min(500, Number(options.limit) || 200));
    const events: Array<Record<string, unknown>> = [];
    const includedConversations = new Set<string>();
    for (const conversation of load()) {
      if (requested.size && !requested.has(conversation.id)) continue;
      for (const turn of conversation.turns || []) {
        const startedAt = Number(turn.startedAt || turn.at || 0);
        const completedAt = Number.isFinite(Number(turn.completedAt))
          ? Number(turn.completedAt)
          : (isTurnSettled(turn.outcome) ? Number(turn.at || 0) : null);
        const observedAt = completedAt || startedAt;
        if (observedAt < fromMs || observedAt > toMs) continue;
        includedConversations.add(conversation.id);
        events.push({
          conversationId: conversation.id,
          conversationTitle: conversation.title,
          turnId: turn.id,
          startedAt,
          completedAt,
          question: String(turn.question || '').slice(0, 4000),
          answer: String(turn.answer || '').slice(0, 12000),
          outcome: String(turn.outcome || '').slice(0, 100),
          source: structuredClone(conversation.object || {}),
          events: structuredClone((turn.events || []).slice(0, 48)),
          receipts: structuredClone((turn.receipts || []).slice(0, 48)),
          artifacts: structuredClone((turn.artifacts || []).slice(0, 24)),
          evidence: turn.evidence ? structuredClone(turn.evidence) : null,
        });
      }
    }
    events.sort((left, right) => (
      Number(right.completedAt || right.startedAt) - Number(left.completedAt || left.startedAt)
    ));
    const selected = events.slice(0, limit);
    return {
      fromMs,
      toMs,
      conversationIds: [...requested],
      materialAvailable: selected.length > 0,
      events: selected,
      coverage: {
        includedConversations: includedConversations.size,
        includedTurns: selected.length,
        complete: events.length <= limit,
        message: selected.length
          ? `已纳入 ${selected.length} 条真实任务记录。`
          : '所选时间和任务范围没有纳入本次材料；不要补造全天活动。',
      },
    };
  }

  function clear(): void {
    items = [];
    persist();
  }

  function rename(id: unknown, title: unknown): { ok: boolean; conversation?: Conversation } {
    const clean = String(title || '').trim().slice(0, TITLE_MAX);
    if (!clean) return { ok: false };
    const conversations = load();
    const target = conversations.find((conversation) => conversation.id === id);
    if (!target) return { ok: false };
    target.title = clean;
    target.titleCustom = true;
    markDirty(target);
    persist();
    return { ok: true, conversation: target };
  }

  function remove(id: unknown): { ok: boolean } {
    const conversations = load();
    const next = conversations.filter((conversation) => conversation.id !== id);
    if (next.length === conversations.length) return { ok: false };
    items = next;
    persist();
    return { ok: true };
  }

  function setProject(id: unknown, rawRoot: unknown): { ok: boolean; conversation?: Conversation } {
    const target = load().find((conversation) => conversation.id === id);
    if (!target) return { ok: false };
    const root = String(rawRoot || '').trim();
    target.workspaceRoot = root ? registerProject(root)?.root : undefined;
    target.updatedAt = now();
    markDirty(target);
    persist();
    return { ok: true, conversation: target };
  }

  return {
    appendTurn,
    updateTurn,
    recordPermissionDecision,
    recoverInterruptedTurns,
    list,
    get,
    branch,
    rename,
    remove,
    setProject,
    timeline,
    memories,
    artifacts,
    eventSummaries,
    stats,
    clear,
    registerProject,
    listProjects,
    objectKey,
    flush,
  };
}

export {
  MAX_CONVERSATIONS,
  createConversationStore,
  isSubstantiveQuestion,
  objectKey,
  subtitleFrom,
  titleFrom,
};
