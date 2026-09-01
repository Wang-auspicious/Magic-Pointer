'use strict';

// 对话记录：你指过什么、问了什么、它答了什么、留下了什么。
//
// 之前只有 session_timeline（诊断用的耗时环），里面没有"你问的那句话"，
// 也没有"你指的那个对象"。所以工作室里只能摆写死的样例。这个模块补上
// 真正的那一份，并且按**你指的对象**归类——你记得的是"那个 Excel 的第三列"，
// 不是"周二下午的第 4 次会话"。
//
// 落盘，不常驻内存：关掉窗口再打开，历史还在。

const fs = require('node:fs');
const path = require('node:path');
const { projectStudioHomeStats } = require('./studio_home_stats');

const MAX_CONVERSATIONS = 500;
const MAX_TURNS = 200;
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
  id: string;
  at: number;
  question: string;
  answer: string;
  trace: unknown[];
  facts: unknown[];
  artifacts: Artifact[];
  outcome: string;
  events?: unknown[];
  thinking?: string;
  activities: unknown[];
  trajectory: unknown[];
  receipts: unknown[];
  modelUsage: Record<string, number>;
  modelId?: string;
  timingMs?: number;
  usedBackend?: string;
  /** 划线轮次的现场证据：截图存档 + 标注图 + 当时读到的内容摘要。追问时随桥回上下文。 */
  evidence?: TurnEvidence;
  /** 结构化提问（ask_user_question / 权限门）随轮存档：会话重开后审批卡靠它 reconstruct。 */
  pendingInput?: TurnPendingInput;
}

export interface TurnEvidence {
  capturePath?: string;
  annotatedPath?: string;
  label?: string;
  contentDigest?: string;
}

export interface TurnPendingInput {
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
  /** 用户重命名过：后续追问的自动标题不再覆盖它。 */
  titleCustom?: boolean;
  subtitle: string;
  object: ReferencedObject;
  createdAt: number;
  updatedAt: number;
  closed: boolean;
  turns?: TurnEntry[];
  workspaceRoot?: string;
  /** 可跨重启继续的 Agent session 与其最后一个真实终态。 */
  agentSessionId?: string;
  hasPendingWork?: boolean;
  /** Codex thread workspace_roots：线程级绑定，追问保持，显式换才跟随。 */
  permissionGrants?: string[];
  permissionDenials?: string[];
  /** CC toolPermissionDecision：用户在本会话授予/拒绝过的工具名。 */
}

interface TurnInput {
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
  evidence?: unknown;
  pendingInput?: unknown;
}

interface ConversationStoreOptions {
  baseDir: string;
  now?: () => number;
}

interface ProjectRecord {
  root: string;
  name: string;
  addedAt: number;
  lastOpenedAt: number;
}

// 同一个对象的稳定标识：进程 + 窗口标题 + 元素路径。
// 拿不到元素路径就退到标题；都拿不到就用进程名——宁可粗一点，也不要每次都算成新对象。
// elementPath 形如 `selection-<uuid>`（每次划线都是新的）时不算稳定标识，
// 否则同一个对象会被 UUID 拆成无数条碎片记忆。UUID 段降级丢弃。
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

// 这条提问有信息量吗？问候/泛问（你好、在吗、这是什么、这啥）不构成
// 记忆——记下的是「用户对某个对象做过什么」，不是「用户说过什么」。
const VAPID_QUESTION_RE =
  /^(你好|您好|嗨|在吗|在不在|你是谁|你叫什么|hello|hi|hey|这是什么|这是啥|这啥|那是什么|这啥意思|这啥字|啥意思|什么意思)$/i;

function isSubstantiveQuestion(title: unknown = ''): boolean {
  const t = String(title).trim();
  if (!t) return false;
  if (VAPID_QUESTION_RE.test(t)) return false;
  // 泛问的规则化结果（如「这是什么」剥成「这」）也挡掉
  if (t.length <= 2 && /^[这那它啥谁]/.test(t)) return false;
  return true;
}

// 标题不是用户问题的截断——把问题压成一句「对象 + 动作」的小结。
// 纯规则、零延迟、不调模型：句子短、疑问词与语气词剥掉、保留名词。
// 规则做不好（句子太怪）才退回截断，绝不显示「你问的那句原话」。
function titleFrom(question: unknown = ''): string {
  const clean = String(question).replace(/\s+/g, ' ').trim();
  if (!clean) return '未命名';

  let t = clean;
  // 剥问句尾巴：这些词结尾时截掉，问句变陈述
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
  // 剥开头语气词
  t = t.replace(/^(请|帮我|麻烦|能不能|可以|怎么|如何|为什么)/, '');
  t = t.replace(/^(请问|我想问|问一下)/, '');
  t = t.replace(/^(这个|这段|这行|这里|那边)/, '');
  t = t.trim();
  if (!t) t = clean;

  // 太长就按标点断第一句；还长就截断
  if (t.length > TITLE_MAX) {
    const cut = t.search(/[，。；,;:：]/);
    if (cut > 0 && cut < TITLE_MAX) t = t.slice(0, cut).trim();
  }
  if (t.length > TITLE_MAX) t = `${t.slice(0, TITLE_MAX - 1)}…`;
  return t;
}

// 侧栏那一行副标题：应用 + 你指的那个东西。
function subtitleFrom(object: ReferencedObject = {}): string {
  const bits = [object.app, object.label || object.windowTitle].filter(Boolean);
  return bits.join(' · ');
}

function createConversationStore(
  { baseDir, now = () => Date.now() }: ConversationStoreOptions = {
    baseDir: '',
  },
) {
  const file = path.join(baseDir, 'conversations.json');
  const projectsFile = path.join(baseDir, 'projects.json');
  let items: Conversation[] | null = null;
  let projectItems: ProjectRecord[] | null = null;

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

  function persist(): void {
    fs.mkdirSync(baseDir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(items || []), 'utf8');
    fs.renameSync(tmp, file);
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

  /** 一个确定的文件夹就是一个项目。项目先于对话存在，因此单独落盘。 */
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

  // 一次追问接在同一条对话上；指向了别的对象就另起一条。
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
      question: String(turn.question || ''),
      answer: String(turn.answer || ''),
      trace: Array.isArray(turn.trace) ? turn.trace.slice(0, 24) : [],
      facts: Array.isArray(turn.facts) ? turn.facts.slice(0, 24) : [],
      artifacts: Array.isArray(turn.artifacts) ? (turn.artifacts.slice(0, 12) as Artifact[]) : [],
      outcome: String(turn.outcome || ''),
      events: Array.isArray(turn.events) ? turn.events.slice(0, 48) : [],
      thinking: turn.thinking !== undefined ? String(turn.thinking) : undefined,
      activities: Array.isArray(turn.activities) ? turn.activities.slice(0, 96) : [],
      trajectory: Array.isArray(turn.trajectory) ? turn.trajectory.slice(0, 256) : [],
      receipts: Array.isArray(turn.receipts) ? turn.receipts.slice(0, 48) : [],
      modelUsage: turn.modelUsage && typeof turn.modelUsage === 'object' && !Array.isArray(turn.modelUsage)
        ? Object.fromEntries(Object.entries(turn.modelUsage as Record<string, unknown>)
          .filter(([, value]) => Number.isFinite(Number(value)))
          .map(([key, value]) => [key, Number(value)]))
        : {},
      modelId: String(turn.modelId || '').trim() || undefined,
      timingMs: Number.isFinite(Number(turn.timingMs)) ? Number(turn.timingMs) : undefined,
      usedBackend: turn.usedBackend !== undefined ? String(turn.usedBackend) : undefined,
      // 划线轮次的现场证据与结构化提问随轮存档：追问时桥把它们带回上下文，
      // 审批卡在会话重开后还能从这 reconstruct。没有这两样，「五分钟后问
      // 就接不上」是无解的。
      evidence: sanitizeEvidence(turn.evidence),
      pendingInput: sanitizePendingInput(turn.pendingInput),
    };

    if (target) {
      if (!Array.isArray(target.turns)) target.turns = [];
      target.turns.push(entry);
      if (target.turns.length > MAX_TURNS) target.turns.splice(0, target.turns.length - MAX_TURNS);
      // Codex thread semantics: the thread keeps its workspace across
      // follow-ups; an explicit root on this turn moves THIS thread only.
      const explicitRoot = String(turn.workspaceRoot || '').trim();
      if (explicitRoot) target.workspaceRoot = registerProject(explicitRoot)?.root || explicitRoot;
      const agentSessionId = String(turn.agentSessionId || '').trim();
      if (agentSessionId) target.agentSessionId = agentSessionId;
      if (typeof turn.hasPendingWork === 'boolean') target.hasPendingWork = turn.hasPendingWork;
      // 用户起过的名字不覆盖；自动标题只在未自定义时跟随最新问题。
      if (!target.titleCustom) target.title = titleFrom(turn.question);
      // CC toolPermissionDecision: a chip grant/deny joins the thread memo
      // (dedup); the memo rides every later request in this thread.
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
      // 换到列表最前面：最近碰过的排最上，和人的记忆顺序一致
      conversations.splice(conversations.indexOf(target), 1);
      conversations.unshift(target);
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
      ...(String(turn.permissionGrant || '').trim() ? { permissionGrants: [String(turn.permissionGrant).trim()] } : {}),
      ...(String(turn.permissionDeny || '').trim() ? { permissionDenials: [String(turn.permissionDeny).trim()] } : {}),
    };
    conversations.unshift(created);
    if (conversations.length > MAX_CONVERSATIONS) {
      conversations.length = MAX_CONVERSATIONS;
    }
    persist();
    return created;
  }

  // Stage↔GUI 实时同步：先 appendTurn 一条「进行中」的占位 turn，读取
  // 过程中用 updateTurn 就地补 answer/终态——不再等整轮跑完才在 GUI 出现。
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
      kind: kind || undefined,
      tool: String(raw.tool ?? '').trim() || undefined,
      prefix: String(raw.prefix ?? '').trim().slice(0, 160) || undefined,
    };
  }

  function updateTurn(input: {
    conversationId?: unknown;
    turnIndex?: unknown;
    answer?: unknown;
    outcome?: unknown;
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
    if (input.answer !== undefined) turn.answer = String(input.answer || '').slice(0, 200000);
    if (input.outcome !== undefined) turn.outcome = String(input.outcome || '').slice(0, 40);
    if (Array.isArray(input.events)) turn.events = input.events.slice(0, 48);
    if (Array.isArray(input.activities)) turn.activities = input.activities.slice(0, 96);
    if (Array.isArray(input.trajectory)) turn.trajectory = input.trajectory.slice(0, 256);
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
    turn.at = now();
    target.updatedAt = now();
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
    persist();
    return { ok: true, conversation: target };
  }

  // 侧栏用：只要摘要，不要把全部 turn 塞进 IPC
  function list(limit = 60) {
    const conversations = load();
    return conversations.slice(0, limit).map((c) => ({
      id: c.id,
      title: c.title,
      subtitle: c.subtitle,
      object: c.object,
      updatedAt: c.updatedAt,
      workspaceRoot: c.workspaceRoot || '',
      agentSessionId: c.agentSessionId || '',
      hasPendingWork: c.hasPendingWork === true,
      permissionGrants: Array.isArray(c.permissionGrants) ? c.permissionGrants : [],
      permissionDenials: Array.isArray(c.permissionDenials) ? c.permissionDenials : [],
      // 磁盘上的旧文件可能没有 turns 字段（早期版本/手改），逐条判空，
      // 否则一条坏记录会把整个列表、时间线、记忆、产物五个 handler 一起打挂。
      turns: (c.turns || []).length,
      outcomes: [...new Set((c.turns || []).map((t) => t.outcome).filter(Boolean))],
    }));
  }

  function get(id: unknown): Conversation | null {
    return load().find((conversation) => conversation.id === id) || null;
  }

  /**
   * 从一个已经完成的回合创建真正的新对话。turnIndex 为包含式索引：
   * 分支保留该回合及之前的上下文，但清空运行时 session / 待续状态，
   * 避免两个对话继续写进同一个 Agent session。
   */
  function branch(id: unknown, turnIndex: unknown): Conversation | null {
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
      hasPendingWork: false,
      permissionGrants: structuredClone(source.permissionGrants || []),
      permissionDenials: structuredClone(source.permissionDenials || []),
    };
    conversations.unshift(created);
    if (conversations.length > MAX_CONVERSATIONS) conversations.length = MAX_CONVERSATIONS;
    persist();
    return created;
  }

  // 时间线按天分组；同一天里最近的在上面。
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

  // 记忆 = 反复被指到的对象。指过一次的不算记忆，指过三次的才是。
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
        // 记忆得有内容：纯问候/无信息量提问（你好、这是啥、这是什么）不构成记忆
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
          out.push({ ...a, at: t.at, conversationId: c.id, from: c.title });
        }
      }
    }
    return out.sort((x, y) => y.at - x.at).slice(0, limit);
  }

  function stats(at = now()) {
    return projectStudioHomeStats(load(), at);
  }

  function clear(): void {
    items = [];
    persist();
  }

  /** 用户自定义标题优先于自动标题；空白拒绝，不把对话改成空标题。 */
  function rename(id: unknown, title: unknown): { ok: boolean; conversation?: Conversation } {
    const clean = String(title || '').trim().slice(0, TITLE_MAX);
    if (!clean) return { ok: false };
    const conversations = load();
    const target = conversations.find((conversation) => conversation.id === id);
    if (!target) return { ok: false };
    target.title = clean;
    target.titleCustom = true;
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

  return {
    appendTurn,
    updateTurn,
    recordPermissionDecision,
    list,
    get,
    branch,
    rename,
    remove,
    timeline,
    memories,
    artifacts,
    stats,
    clear,
    registerProject,
    listProjects,
    objectKey,
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
