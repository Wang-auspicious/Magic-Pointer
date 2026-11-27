import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {ToolRegistry} from './tools';

export type CompanionFactKind =
  | 'trait'
  | 'weak_spot'
  | 'goal'
  | 'banter'
  | 'preference';

export type CompanionInteractionMood =
  | 'normal'
  | 'impatient'
  | 'challenged'
  | 'repeat_ask'
  | 'banter';

export interface CompanionTopicRecord {
  topic: string;
  count: number;
  lastAskedAt: string;
  note?: string;
}

export interface CompanionFact {
  id: string;
  kind: CompanionFactKind;
  text: string;
  recordedAt: string;
}

export interface CompanionInteractionNote {
  date: string;
  summary: string;
  mood: CompanionInteractionMood;
}

export interface CompanionMemoryState {
  schemaVersion: 1;
  updatedAt: string;
  totalTurns: number;
  sessionIds: string[];
  familiarity: 'fresh' | 'warming' | 'close_buddy';
  recurringTopics: CompanionTopicRecord[];
  memorableFacts: CompanionFact[];
  recentInteractions: CompanionInteractionNote[];
}

const MEMORY_FILENAME = 'learn-companion-memory.json';
const MAX_TOPICS = 24;
const MAX_FACTS = 20;
const MAX_INTERACTIONS = 8;
const MAX_SESSIONS = 30;
const MAX_BLOCK_CHARS = 760;

const CANONICAL_TOPICS: ReadonlyArray<{label: string; pattern: RegExp}> = [
  {label: 'Transformer', pattern: /\btransformer\b/i},
  {label: '多头注意力', pattern: /(多头注意力|self[- ]?attention|注意力机制|qkv|\battention\b)/i},
  {label: '位置编码/RoPE', pattern: /(位置编码|\brope\b|旋转位置)/i},
  {label: 'FlashAttention', pattern: /(flashattention|online softmax|分块注意力)/i},
  {label: 'BatchNorm/LayerNorm', pattern: /(batchnorm|layernorm|rmsnorm|归一化)/i},
  {label: '反向传播/梯度', pattern: /(反向传播|backprop|梯度消失|梯度爆炸|链式法则)/i},
  {label: '微调/LoRA', pattern: /(\blora\b|微调|finetune|rlhf|sft|dpo)/i},
  {label: 'Softmax/交叉熵', pattern: /(softmax|交叉熵|cross[- ]?entropy)/i},
  {label: '过拟合/正则化', pattern: /(过拟合|欠拟合|dropout|正则化)/i},
  {label: '特征值/特征向量', pattern: /(特征值|特征向量|\beigen)/i},
  {label: '微积分/求导积分', pattern: /(微积分|求导|导数|不定积分|定积分|泰勒|拉普拉斯)/i},
  {label: '线性代数/矩阵', pattern: /(线性代数|矩阵|秩|正交|svd|奇异值)/i},
  {label: '概率/贝叶斯', pattern: /(贝叶斯|概率论|期望|方差|极大似然|条件概率)/i},
  {label: '傅里叶/卷积', pattern: /(傅里叶|fourier|卷积)/i},
  {label: '熵与信息论', pattern: /(信息熵|熵增|热力学熵|香农熵|信息论)/i},
  {label: 'Kafka', pattern: /\bkafka\b/i},
  {label: 'Hadoop/HDFS', pattern: /(hadoop|hdfs|mapreduce|yarn)/i},
  {label: 'Spark', pattern: /\bspark\b/i},
  {label: 'Redis', pattern: /\bredis\b/i},
  {label: 'B+树/数据库索引', pattern: /(b\+树|b树|数据库索引|mysql|postgres|事务隔离|mvcc)/i},
  {label: '分布式一致性/Raft', pattern: /(\braft\b|\bpaxos\b|分布式一致性|分布式锁)/i},
  {label: '并发/线程协程', pattern: /(多线程|并发|协程|死锁|锁机制|竞态)/i},
  {label: 'TCP/HTTP网络', pattern: /(\btcp\b|\budp\b|\bhttp\b|三次握手|四次挥手)/i},
  {label: '操作系统/虚拟内存', pattern: /(操作系统|虚拟内存|页表|进程调度|文件系统)/i},
  {label: '动态规划/算法', pattern: /(动态规划|\bdp\b|二叉树|红黑树|哈希表|图论)/i},
  {label: 'Docker/K8s', pattern: /(docker|kubernetes|\bk8s\b)/i},
];

const SELF_DISCLOSURE_PATTERNS: ReadonlyArray<{
  kind: CompanionFactKind;
  pattern: RegExp;
}> = [
  {
    kind: 'goal',
    pattern:
      /(?:我(?:最近|现在|正在|今年|打算|准备|要)|最近(?:在|要))((?:准备|考|刷|学|做|搞|写|冲击)[^，。！？\n]{2,26})/,
  },
  {
    kind: 'weak_spot',
    pattern:
      /(?:我(?:最怕|最烦|老是|总是|每次都|一直)|一看到)([^，。！？\n]{3,28})/,
  },
  {
    kind: 'preference',
    pattern:
      /(?:我(?:喜欢|偏爱|更习惯|不想看|讨厌|受不了))([^，。！？\n]{3,28})/,
  },
  {
    kind: 'trait',
    pattern:
      /(?:我是(?:个|一名)?)((?:大[一二三四]|研[一二三]|博士|本科|转码|前端|后端|算法|非科班|产品|学生|上班族)[^，。！？\n]{0,16})/,
  },
];

function todayDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function defaultState(): CompanionMemoryState {
  return {
    schemaVersion: 1,
    updatedAt: '',
    totalTurns: 0,
    sessionIds: [],
    familiarity: 'fresh',
    recurringTopics: [],
    memorableFacts: [],
    recentInteractions: [],
  };
}

export function companionMemoryPath(userDataDir: string): string {
  return path.join(userDataDir, MEMORY_FILENAME);
}

export function loadCompanionMemory(userDataDir: string): CompanionMemoryState {
  if (!userDataDir) {
    return defaultState();
  }
  const filePath = companionMemoryPath(userDataDir);
  try {
    if (!fs.existsSync(filePath)) {
      return defaultState();
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object') {
      return defaultState();
    }
    return {
      schemaVersion: 1,
      updatedAt: String(raw.updatedAt || ''),
      totalTurns: Math.max(0, Number(raw.totalTurns || 0)),
      sessionIds: Array.isArray(raw.sessionIds)
        ? raw.sessionIds.map(String).filter(Boolean).slice(-MAX_SESSIONS)
        : [],
      familiarity:
        raw.familiarity === 'close_buddy' || raw.familiarity === 'warming'
          ? raw.familiarity
          : 'fresh',
      recurringTopics: Array.isArray(raw.recurringTopics)
        ? raw.recurringTopics
            .filter(
              (item: unknown): item is CompanionTopicRecord =>
                Boolean(item) &&
                typeof item === 'object' &&
                typeof (item as CompanionTopicRecord).topic === 'string',
            )
            .slice(0, MAX_TOPICS)
        : [],
      memorableFacts: Array.isArray(raw.memorableFacts)
        ? raw.memorableFacts
            .filter(
              (item: unknown): item is CompanionFact =>
                Boolean(item) &&
                typeof item === 'object' &&
                typeof (item as CompanionFact).text === 'string',
            )
            .slice(0, MAX_FACTS)
        : [],
      recentInteractions: Array.isArray(raw.recentInteractions)
        ? raw.recentInteractions
            .filter(
              (item: unknown): item is CompanionInteractionNote =>
                Boolean(item) &&
                typeof item === 'object' &&
                typeof (item as CompanionInteractionNote).summary === 'string',
            )
            .slice(-MAX_INTERACTIONS)
        : [],
    };
  } catch {
    return defaultState();
  }
}

export function saveCompanionMemory(
  userDataDir: string,
  state: CompanionMemoryState,
): void {
  if (!userDataDir) {
    return;
  }
  const filePath = companionMemoryPath(userDataDir);
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {}
    throw error;
  }
}

export function extractTopicKeys(text: string): string[] {
  const sample = String(text || '').trim();
  if (!sample) {
    return [];
  }
  const hits: string[] = [];
  for (const item of CANONICAL_TOPICS) {
    if (item.pattern.test(sample)) {
      hits.push(item.label);
    }
  }
  return hits;
}

export function findRecurringTopicHit(
  state: CompanionMemoryState,
  text: string,
): CompanionTopicRecord | null {
  const topics = extractTopicKeys(text);
  if (!topics.length || !state.recurringTopics.length) {
    return null;
  }
  let best: CompanionTopicRecord | null = null;
  for (const label of topics) {
    const found = state.recurringTopics.find(item => item.topic === label);
    if (found && found.count >= 1) {
      if (!best || found.count > best.count) {
        best = found;
      }
    }
  }
  return best;
}

function cleanSnippet(text: string, maxChars: number): string {
  return String(text || '')
    .replace(/<quoted_reply[\s\S]*?<\/quoted_reply>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function extractSelfDisclosures(
  userText: string,
): Array<{kind: CompanionFactKind; text: string}> {
  const cleaned = cleanSnippet(userText, 240);
  if (!cleaned) {
    return [];
  }
  const found: Array<{kind: CompanionFactKind; text: string}> = [];
  for (const entry of SELF_DISCLOSURE_PATTERNS) {
    const match = cleaned.match(entry.pattern);
    if (!match) {
      continue;
    }
    const raw = (match[0] || '').trim();
    if (raw.length < 4 || raw.length > 42) {
      continue;
    }
    if (!found.some(item => item.text === raw)) {
      found.push({kind: entry.kind, text: raw});
    }
  }
  return found.slice(0, 2);
}

function computeFamiliarity(
  totalTurns: number,
  sessionCount: number,
): CompanionMemoryState['familiarity'] {
  if (totalTurns >= 12 || sessionCount >= 3) {
    return 'close_buddy';
  }
  if (totalTurns >= 3 || sessionCount >= 2) {
    return 'warming';
  }
  return 'fresh';
}

function moodFromTension(tension?: string): CompanionInteractionMood {
  if (tension === 'user_impatient') {
    return 'impatient';
  }
  if (tension === 'user_scolding_bot') {
    return 'challenged';
  }
  if (tension === 'repeat_asking') {
    return 'repeat_ask';
  }
  if (tension === 'user_testing_flattery') {
    return 'banter';
  }
  return 'normal';
}

export function rememberCompanionFact(
  userDataDir: string,
  input: {kind?: CompanionFactKind; text: string},
): CompanionFact | null {
  const text = cleanSnippet(input.text, 120);
  if (!text) {
    return null;
  }
  const state = loadCompanionMemory(userDataDir);
  const kind: CompanionFactKind = input.kind || 'trait';
  const normalized = text.toLowerCase();
  const existing = state.memorableFacts.find(
    item =>
      item.text.toLowerCase() === normalized ||
      item.text.toLowerCase().includes(normalized) ||
      normalized.includes(item.text.toLowerCase()),
  );
  const now = todayDateString();
  if (existing) {
    if (text.length > existing.text.length) {
      existing.text = text;
    }
    existing.kind = kind;
    existing.recordedAt = now;
    state.updatedAt = now;
    saveCompanionMemory(userDataDir, state);
    return existing;
  }
  const fact: CompanionFact = {
    id: `mem-${randomUUID().slice(0, 8)}`,
    kind,
    text,
    recordedAt: now,
  };
  state.memorableFacts = [...state.memorableFacts, fact].slice(-MAX_FACTS);
  state.updatedAt = now;
  saveCompanionMemory(userDataDir, state);
  return fact;
}

export function forgetCompanionFact(
  userDataDir: string,
  query: string,
): number {
  const needle = cleanSnippet(query, 80).toLowerCase();
  if (!needle) {
    return 0;
  }
  const state = loadCompanionMemory(userDataDir);
  const before = state.memorableFacts.length;
  state.memorableFacts = state.memorableFacts.filter(
    item => !item.text.toLowerCase().includes(needle),
  );
  const removed = before - state.memorableFacts.length;
  if (removed > 0) {
    state.updatedAt = todayDateString();
    saveCompanionMemory(userDataDir, state);
  }
  return removed;
}

export function recordCompanionTurn(
  userDataDir: string,
  input: {
    sessionId?: string;
    userText: string;
    assistantText?: string;
    tension?: string;
  },
): CompanionMemoryState {
  const state = loadCompanionMemory(userDataDir);
  const now = todayDateString();
  const userSnippet = cleanSnippet(input.userText, 120);
  if (!userSnippet) {
    return state;
  }

  state.totalTurns += 1;
  state.updatedAt = now;
  if (input.sessionId && !state.sessionIds.includes(input.sessionId)) {
    state.sessionIds = [...state.sessionIds, input.sessionId].slice(
      -MAX_SESSIONS,
    );
  }
  state.familiarity = computeFamiliarity(
    state.totalTurns,
    state.sessionIds.length,
  );

  const topics = extractTopicKeys(input.userText);
  for (const topic of topics) {
    const existing = state.recurringTopics.find(item => item.topic === topic);
    if (existing) {
      existing.count += 1;
      existing.lastAskedAt = now;
    } else {
      state.recurringTopics.push({
        topic,
        count: 1,
        lastAskedAt: now,
      });
    }
  }
  state.recurringTopics.sort(
    (a, b) =>
      b.count - a.count || b.lastAskedAt.localeCompare(a.lastAskedAt),
  );
  state.recurringTopics = state.recurringTopics.slice(0, MAX_TOPICS);

  const disclosures = extractSelfDisclosures(input.userText);
  for (const item of disclosures) {
    const normalized = item.text.toLowerCase();
    const dup = state.memorableFacts.some(
      existing =>
        existing.text.toLowerCase() === normalized ||
        existing.text.toLowerCase().includes(normalized),
    );
    if (!dup) {
      state.memorableFacts.push({
        id: `mem-${randomUUID().slice(0, 8)}`,
        kind: item.kind,
        text: item.text,
        recordedAt: now,
      });
    }
  }
  state.memorableFacts = state.memorableFacts.slice(-MAX_FACTS);

  const mood = moodFromTension(input.tension);
  if (mood !== 'normal' || topics.length > 0) {
    const label =
      mood === 'impatient'
        ? `不耐烦催促：${userSnippet.slice(0, 42)}`
        : mood === 'challenged'
          ? `嫌弃/开怼：${userSnippet.slice(0, 42)}`
          : mood === 'repeat_ask'
            ? `反复追问 ${topics[0] || userSnippet.slice(0, 24)}`
            : `聊过 ${topics.slice(0, 2).join(' / ')}`;
    state.recentInteractions = [
      ...state.recentInteractions,
      {date: now, summary: label, mood},
    ].slice(-MAX_INTERACTIONS);
  }

  saveCompanionMemory(userDataDir, state);
  return state;
}

export function buildCompanionMemoryBlock(
  state?: CompanionMemoryState | null,
): string {
  if (
    !state ||
    (state.totalTurns === 0 &&
      state.recurringTopics.length === 0 &&
      state.memorableFacts.length === 0 &&
      state.recentInteractions.length === 0)
  ) {
    return '';
  }

  const lines: string[] = ['<companion_memory>'];
  const famLabel =
    state.familiarity === 'close_buddy'
      ? `老熟人（已聊过 ${state.sessionIds.length} 次会话 / ${state.totalTurns} 轮，说话更随意熟络，老毛病可以直接点破调侃）`
      : state.familiarity === 'warming'
        ? `熟起来的师友（已聊过 ${state.totalTurns} 轮，记得之前聊过的梗和卡点，自然衔接）`
        : `刚认识但自来熟的真朋友老师（累计 ${state.totalTurns} 轮）`;
  lines.push(`熟络度：${famLabel}`);

  if (state.memorableFacts.length > 0) {
    const factItems = state.memorableFacts
      .slice(-8)
      .map(item => item.text)
      .join('；');
    lines.push(`关于对方的长期记忆（数据参考，聊到相关处自然带出，别硬背）：${factItems}`);
  }

  if (state.recurringTopics.length > 0) {
    const topicItems = state.recurringTopics
      .slice(0, 6)
      .map(item => `${item.topic}(${item.count}次,最近${item.lastAskedAt})`)
      .join('、');
    lines.push(`常问/容易卡住的话题：${topicItems}`);
  }

  const friction = state.recentInteractions
    .filter(item => item.mood !== 'normal')
    .slice(-3);
  if (friction.length > 0) {
    lines.push(
      `近期拌嘴/小脾气记忆：${friction.map(item => `${item.date} ${item.summary}`).join('；')}`,
    );
  }

  lines.push('</companion_memory>');
  const full = lines.join('\n');
  if (full.length <= MAX_BLOCK_CHARS) {
    return full;
  }
  return `${full.slice(0, MAX_BLOCK_CHARS - 24).trimEnd()}\n</companion_memory>`;
}

export function registerLearnCompanionMemoryTools(
  registry: ToolRegistry,
  userDataDir: string,
): void {
  registry.register({
    name: 'LearnMemory.remember',
    description:
      'Save a durable long-term memory about the user (study goal, recurring weak spot, background, communication preference, or inside joke) so future Learn sessions remember them like a real teacher-friend.',
    effect: 'reversible_write',
    is_concurrency_safe: true,
    used_backend: 'learn_companion_memory',
    input_schema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['trait', 'weak_spot', 'goal', 'banter', 'preference'],
          description: 'Category of memory note.',
        },
        text: {
          type: 'string',
          minLength: 2,
          maxLength: 120,
          description: 'Short factual note to remember (Chinese or English).',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    execute: async args => {
      const saved = rememberCompanionFact(userDataDir, {
        kind: (args.kind as CompanionFactKind) || 'trait',
        text: String(args.text || ''),
      });
      return {
        saved: Boolean(saved),
        fact: saved,
      };
    },
  });

  registry.register({
    name: 'LearnMemory.forget',
    description:
      'Remove saved long-term companion memories matching a keyword when the user asks you to forget something.',
    effect: 'reversible_write',
    is_concurrency_safe: true,
    used_backend: 'learn_companion_memory',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 80,
          description: 'Keyword matching the memory note to forget.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async args => {
      const removed = forgetCompanionFact(
        userDataDir,
        String(args.query || ''),
      );
      return {removed};
    },
  });
}
