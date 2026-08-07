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

// 同一个对象的稳定标识：进程 + 窗口标题 + 元素路径。
// 拿不到元素路径就退到标题；都拿不到就用进程名——宁可粗一点，也不要每次都算成新对象。
// elementPath 形如 `selection-<uuid>`（每次划线都是新的）时不算稳定标识，
// 否则同一个对象会被 UUID 拆成无数条碎片记忆。UUID 段降级丢弃。
const TRANSIENT_ELEMENT_RE = /^(selection|snapshot|obj)-[a-f0-9]{8,}$/i;

function stableElementPath(elementPath) {
  const raw = String(elementPath || '').trim();
  if (!raw) return '';
  if (TRANSIENT_ELEMENT_RE.test(raw)) return '';
  return raw;
}

function objectKey(object = {}) {
  const parts = [object.app || '', object.windowTitle || '', stableElementPath(object.elementPath)];
  const filled = parts.filter(Boolean);
  return filled.length ? filled.join('|') : 'unknown';
}

// 这条提问有信息量吗？问候/泛问（你好、在吗、这是什么、这啥）不构成
// 记忆——记下的是「用户对某个对象做过什么」，不是「用户说过什么」。
const VAPID_QUESTION_RE = /^(你好|您好|嗨|在吗|在不在|你是谁|你叫什么|hello|hi|hey|这是什么|这是啥|这啥|那是什么|这啥意思|这啥字|啥意思|什么意思)$/i;

function isSubstantiveQuestion(title = '') {
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
function titleFrom(question = '') {
  const clean = String(question).replace(/\s+/g, ' ').trim();
  if (!clean) return '未命名';

  let t = clean;
  // 剥问句尾巴：这些词结尾时截掉，问句变陈述
  t = t.replace(/([？?])$/, '');
  for (const tail of ['是什么意思', '是干什么的', '是怎么回事', '在干嘛', '在做什么', '怎么用', '怎么做', '为什么']) {
    if (t.endsWith(tail)) { t = t.slice(0, -tail.length).trim(); break; }
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
function subtitleFrom(object = {}) {
  const bits = [object.app, object.label || object.windowTitle].filter(Boolean);
  return bits.join(' · ');
}

function createConversationStore({ baseDir, now = () => Date.now() } = {}) {
  const file = path.join(baseDir, 'conversations.json');
  let items = null;

  function load() {
    if (items) return items;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      items = Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      items = [];
    }
    return items;
  }

  function persist() {
    fs.mkdirSync(baseDir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(items), 'utf8');
    fs.renameSync(tmp, file);
  }

  // 一次追问接在同一条对话上；指向了别的对象就另起一条。
  function appendTurn(turn = {}) {
    load();
    const at = turn.capturedAt || now();
    const key = objectKey(turn.object || {});
    const explicit = turn.conversationId
      ? items.find((c) => c.id === turn.conversationId)
      : null;
    const target = explicit || items.find((c) => c.objectKey === key && !c.closed);

    const entry = {
      id: `t${at}`,
      at,
      question: String(turn.question || ''),
      answer: String(turn.answer || ''),
      trace: Array.isArray(turn.trace) ? turn.trace.slice(0, 24) : [],
      facts: Array.isArray(turn.facts) ? turn.facts.slice(0, 24) : [],
      artifacts: Array.isArray(turn.artifacts) ? turn.artifacts.slice(0, 12) : [],
      outcome: String(turn.outcome || ''),
    };

    if (target) {
      if (!Array.isArray(target.turns)) target.turns = [];
      target.turns.push(entry);
      if (target.turns.length > MAX_TURNS) target.turns.splice(0, target.turns.length - MAX_TURNS);
      target.updatedAt = at;
      // 换到列表最前面：最近碰过的排最上，和人的记忆顺序一致
      items.splice(items.indexOf(target), 1);
      items.unshift(target);
      persist();
      return target;
    }

    const created = {
      id: `c${at}`,
      objectKey: key,
      title: titleFrom(turn.question),
      subtitle: subtitleFrom(turn.object || {}),
      object: turn.object || {},
      createdAt: at,
      updatedAt: at,
      closed: false,
      turns: [entry],
    };
    items.unshift(created);
    if (items.length > MAX_CONVERSATIONS) items.length = MAX_CONVERSATIONS;
    persist();
    return created;
  }

  // 侧栏用：只要摘要，不要把全部 turn 塞进 IPC
  function list(limit = 60) {
    load();
    return items.slice(0, limit).map((c) => ({
      id: c.id,
      title: c.title,
      subtitle: c.subtitle,
      object: c.object,
      updatedAt: c.updatedAt,
      // 磁盘上的旧文件可能没有 turns 字段（早期版本/手改），逐条判空，
      // 否则一条坏记录会把整个列表、时间线、记忆、产物五个 handler 一起打挂。
      turns: (c.turns || []).length,
      outcomes: [...new Set((c.turns || []).map((t) => t.outcome).filter(Boolean))],
    }));
  }

  function get(id) {
    load();
    return items.find((c) => c.id === id) || null;
  }

  // 时间线按天分组；同一天里最近的在上面。
  function timeline(limit = 60) {
    const days = new Map();
    for (const c of list(limit)) {
      const d = new Date(c.updatedAt);
      const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      if (!days.has(key)) days.set(key, { key, at: c.updatedAt, items: [] });
      days.get(key).items.push(c);
    }
    return [...days.values()];
  }

  // 记忆 = 反复被指到的对象。指过一次的不算记忆，指过三次的才是。
  function memories(minTouches = 2) {
    load();
    const byObject = new Map();
    for (const c of items) {
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
    return [...byObject.values()]
      .filter((m) => m.touches >= minTouches)
      // 记忆得有内容：纯问候/无信息量提问（你好、这是啥、这是什么）不构成记忆
      .filter((m) => m.questions.some((q) => isSubstantiveQuestion(q)))
      .sort((a, b) => b.lastAt - a.lastAt);
  }

  function artifacts(limit = 80) {
    load();
    const out = [];
    for (const c of items) {
      for (const t of (c.turns || [])) {
        for (const a of t.artifacts || []) {
          out.push({ ...a, at: t.at, conversationId: c.id, from: c.title });
        }
      }
    }
    return out.sort((x, y) => y.at - x.at).slice(0, limit);
  }

  function clear() {
    items = [];
    persist();
  }

  return { appendTurn, list, get, timeline, memories, artifacts, clear, objectKey };
}

module.exports = { createConversationStore, objectKey, titleFrom, subtitleFrom, isSubstantiveQuestion, MAX_CONVERSATIONS };
