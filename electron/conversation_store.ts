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
  timingMs?: number;
  usedBackend?: string;
}

interface Conversation {
  id: string;
  objectKey: string;
  title: string;
  subtitle: string;
  object: ReferencedObject;
  createdAt: number;
  updatedAt: number;
  closed: boolean;
  turns?: TurnEntry[];
  workspaceRoot?: string;
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
  timingMs?: unknown;
  usedBackend?: unknown;
  workspaceRoot?: unknown;
  permissionGrant?: unknown;
  permissionDeny?: unknown;
}

interface ConversationStoreOptions {
  baseDir: string;
  now?: () => number;
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
  let items: Conversation[] | null = null;

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
      timingMs: Number.isFinite(Number(turn.timingMs)) ? Number(turn.timingMs) : undefined,
      usedBackend: turn.usedBackend !== undefined ? String(turn.usedBackend) : undefined,
    };

    if (target) {
      if (!Array.isArray(target.turns)) target.turns = [];
      target.turns.push(entry);
      if (target.turns.length > MAX_TURNS) target.turns.splice(0, target.turns.length - MAX_TURNS);
      // Codex thread semantics: the thread keeps its workspace across
      // follow-ups; an explicit root on this turn moves THIS thread only.
      const explicitRoot = String(turn.workspaceRoot || '').trim();
      if (explicitRoot) target.workspaceRoot = explicitRoot;
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
      workspaceRoot: String(turn.workspaceRoot || '').trim() || undefined,
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

  function clear(): void {
    items = [];
    persist();
  }

  return { appendTurn, list, get, timeline, memories, artifacts, clear, objectKey };
}

export {
  MAX_CONVERSATIONS,
  createConversationStore,
  isSubstantiveQuestion,
  objectKey,
  subtitleFrom,
  titleFrom,
};
