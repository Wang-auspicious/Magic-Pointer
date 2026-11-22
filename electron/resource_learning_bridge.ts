export interface LearningGoalItem {
  id: string;
  label: string;
  keywords: string[];
  source: 'thread' | 'vault-note' | 'vault-todo';
}

export interface LearningGoalContext {
  goals: LearningGoalItem[];
  vaultNotes: Array<{title: string; slug?: string; tags?: string[]}>;
  pendingTodos: Array<{text: string}>;
}

export type LearningIntent = 'concept' | 'practice' | 'reference';

export interface ResourceLearningMeta {
  intent: LearningIntent;
  intentLabel: string;
  goalMatch?: {goalId: string; label: string; reason: string};
  paragraphs: string[];
  cleanTags: string[];
  lead: string;
  relatedNoteTitles: string[];
  score: number;
}

export interface LearningBridgeInput {
  id?: string;
  title?: string;
  source?: string;
  url?: string;
  author?: string | {name?: string};
  text?: string;
  postText?: string;
  summary?: string;
  note?: string;
  tags?: string[];
  capturedAt?: string | number;
  createdAt?: string | number;
  updatedAt?: string | number;
  collection?: {
    title?: string;
    note?: string;
    tags?: string[];
    summary?: string;
    postText?: string;
    author?: string;
    url?: string;
  };
}

const STOP_KEYWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'what',
  'how',
  'why',
  'are',
  'can',
  'not',
  'http',
  'https',
  'www',
  'com',
  'cn',
  '为什么',
  '怎么',
  '什么是',
  '一个',
  '一下',
  '如何',
  '笔记',
  '学习',
  '内容',
  '问题',
  '对比',
  '使用',
  '每天',
  '今天',
  '分享',
  '合集',
]);

const GENERIC_SPAM_TAGS = new Set([
  '每天学习一点点',
  '学习打卡',
  '每日分享',
  '干货分享',
  '笔记灵感',
  '考研',
  '日常',
  'ai',
  'study',
]);

function extractKeywords(text: string): string[] {
  const seen = new Set<string>();
  const add = (token: string) => {
    const clean = token.trim().toLowerCase();
    if (clean.length < 2 || STOP_KEYWORDS.has(clean)) {
      return;
    }
    if (!seen.has(clean)) {
      seen.add(clean);
    }
  };

  for (const match of text.matchAll(/[a-zA-Z][a-zA-Z0-9_-]{1,31}/g)) {
    add(match[0]);
  }
  for (const seg of text.matchAll(/[\u4e00-\u9fa5]{2,8}/g)) {
    const chunk = seg[0];
    if (chunk.length <= 4) {
      add(chunk);
    } else {
      for (const anchor of [
        '位置编码',
        '注意力',
        '旋转编码',
        '大模型',
        '深度学习',
        '分布式',
        '梯度下降',
        '反向传播',
        '神经网络',
        '强化学习',
        '机器学习',
        '矩阵乘法',
        '特征值',
        '微调',
        '量化',
        '编译器',
        '数据库',
        '操作系统',
        '位置',
        '编码',
        '算子',
        '调优',
        '原理',
        '推导',
      ]) {
        if (chunk.includes(anchor)) {
          add(anchor);
        }
      }
      if (chunk.length >= 2) {
        add(chunk.slice(0, 4));
      }
    }
  }
  return [...seen].slice(0, 14);
}

const OPERATIONAL_COMMAND_TITLE_RE =
  /关闭|打开|启动|重启|删除|卸载|安装|帮我|指挥|电脑|computer\s*use|commputer|\bcu\b|codex|claude|桌面|截图|鼠标|点击|修一下|修复|测试|你好|\b(?:hello|hi)\b|只回答|继续\s*cu/i;

export function isOperationalCommandTitle(raw: string): boolean {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return true;
  }
  return OPERATIONAL_COMMAND_TITLE_RE.test(trimmed);
}

function cleanGoalLabel(raw: string): string {
  const cleaned = String(raw || '')
    .replace(/^(为什么|怎么|如何|请解释一下|解释一下|讲讲)/, '')
    .replace(/[？?。！!\s]+$/g, '')
    .trim()
    .slice(0, 36);
  if (
    /^(?:未命名|untitled(?:\s+chat)?|new\s+chat|新对话|分支|教一下)$/i.test(
      cleaned,
    )
  ) {
    return '';
  }
  return cleaned;
}

export function buildLearningGoalContext(input: {
  threads?: Array<{title?: string; summary?: string}>;
  vault?: {
    notes?: Array<{title?: string; slug?: string; tags?: string[]}>;
    todos?: Array<{text: string; done: boolean}>;
  };
}): LearningGoalContext {
  const goals: LearningGoalItem[] = [];
  const seenLabels = new Set<string>();
  const vaultNotes = (input.vault?.notes || []).map(note => ({
    title: String(note.title || '').trim(),
    slug: note.slug,
    tags: Array.isArray(note.tags) ? note.tags : [],
  }));
  const pendingTodos = (input.vault?.todos || [])
    .filter(todo => todo && !todo.done && String(todo.text || '').trim())
    .map(todo => ({text: String(todo.text).trim()}));

  const pushGoal = (
    rawLabel: string,
    extraText: string,
    source: LearningGoalItem['source'],
  ) => {
    const label = cleanGoalLabel(rawLabel);
    if (!label || label.length < 2) {
      return;
    }
    const key = label.toLowerCase();
    if (seenLabels.has(key)) {
      return;
    }
    const keywords = extractKeywords(`${label} ${extraText}`);
    if (keywords.length === 0) {
      return;
    }
    seenLabels.add(key);
    goals.push({
      id: `${source}:${goals.length + 1}`,
      label,
      keywords,
      source,
    });
  };

  for (const note of vaultNotes) {
    pushGoal(note.title, (note.tags || []).join(' '), 'vault-note');
  }
  for (const todo of pendingTodos) {
    pushGoal(todo.text, todo.text, 'vault-todo');
  }
  for (const thread of input.threads || []) {
    const rawTitle = String(thread.title || '');
    if (isOperationalCommandTitle(rawTitle)) {
      continue;
    }
    pushGoal(rawTitle, String(thread.summary || ''), 'thread');
  }

  return {
    goals: goals.slice(0, 4),
    vaultNotes,
    pendingTodos,
  };
}

function splitParagraphAtSentences(paragraph: string): string[] {
  const trimmed = paragraph.trim();
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    return [trimmed];
  }
  const hasCjk = /[\u4e00-\u9fa5]/.test(trimmed);
  const minSplitLen = hasCjk ? 60 : 160;
  if (trimmed.length <= minSplitLen) {
    return trimmed ? [trimmed] : [];
  }
  const sentences =
    trimmed.match(/[^。！？.!?\n]+[。！？.!?]?/g)?.map(s => s.trim()) || [];
  if (sentences.length < (hasCjk ? 3 : 3) && trimmed.length <= 160) {
    return [trimmed];
  }
  const bucketLimit = hasCjk ? 56 : 135;
  const chunks: string[] = [];
  let bucket = '';
  for (const sentence of sentences) {
    if (!sentence) {
      continue;
    }
    if (bucket && bucket.length + sentence.length > bucketLimit) {
      chunks.push(bucket.trim());
      bucket = sentence;
    } else {
      bucket = bucket ? `${bucket} ${sentence}`.replace(/([。！？]) /, '$1') : sentence;
    }
  }
  if (bucket.trim()) {
    chunks.push(bucket.trim());
  }
  return chunks.length > 0 ? chunks : [trimmed];
}

export function formatPostForReading(raw: string): {
  paragraphs: string[];
  cleanTags: string[];
  lead: string;
} {
  const text = String(raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text) {
    return {paragraphs: [], cleanTags: [], lead: ''};
  }
  const tagCandidates: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)#([^\s#]{1,32}#?)/g)) {
    const tag = match[1].replace(/\[话题\]/g, '').replace(/#+$/g, '').trim();
    if (tag && tag.length >= 2) {
      tagCandidates.push(tag);
    }
  }

  const lines = text
    .split(/\n{2,}|\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const bodyLines: string[] = [];
  for (const line of lines) {
    const withoutInlineTailTags = line
      .replace(/(?:\s*#[^\s#]{1,32}#?){2,}\s*$/g, '')
      .replace(/^(?:\s*#[^\s#]{1,32}#?\s*)+$/g, '')
      .trim();
    if (!withoutInlineTailTags) {
      continue;
    }
    bodyLines.push(withoutInlineTailTags);
  }

  const paragraphs: string[] = [];
  for (const block of bodyLines) {
    for (const part of splitParagraphAtSentences(block)) {
      if (part) {
        paragraphs.push(part);
      }
    }
  }

  const cleanTags: string[] = [];
  const seenTags = new Set<string>();
  for (const candidate of tagCandidates) {
    const normalized = candidate.toLowerCase();
    if (GENERIC_SPAM_TAGS.has(normalized) || seenTags.has(normalized)) {
      continue;
    }
    seenTags.add(normalized);
    cleanTags.push(candidate);
    if (cleanTags.length >= 4) {
      break;
    }
  }

  const lead = (paragraphs[0] || '').slice(0, 120);
  return {paragraphs, cleanTags, lead};
}

function readResourceText(resource: LearningBridgeInput): {
  title: string;
  body: string;
  rawTags: string[];
  url: string;
  author: string;
  capturedAtMs: number;
} {
  const title = String(
    resource.collection?.title || resource.title || '',
  ).trim();
  const body = String(
    resource.postText ||
      resource.collection?.postText ||
      resource.text ||
      resource.summary ||
      resource.collection?.summary ||
      resource.note ||
      resource.collection?.note ||
      '',
  ).trim();
  const rawTags = [
    ...(Array.isArray(resource.collection?.tags) ? resource.collection.tags : []),
    ...(Array.isArray(resource.tags) ? resource.tags : []),
  ]
    .map(tag => String(tag || '').replace(/^#/, '').trim())
    .filter(Boolean);
  const url = String(resource.collection?.url || resource.url || '').trim();
  const author =
    typeof resource.author === 'string'
      ? resource.author.trim()
      : String(resource.author?.name || resource.collection?.author || '').trim();
  const rawTime = resource.capturedAt ?? resource.updatedAt ?? resource.createdAt;
  const parsedTime =
    typeof rawTime === 'number'
      ? rawTime
      : rawTime
        ? Date.parse(String(rawTime))
        : 0;
  return {
    title,
    body,
    rawTags,
    url,
    author,
    capturedAtMs: Number.isFinite(parsedTime) ? parsedTime : 0,
  };
}

export function inferLearningIntent(
  resource: LearningBridgeInput,
  _ctx?: LearningGoalContext,
): LearningIntent {
  const {title, body, url} = readResourceText(resource);
  const combined = `${title}\n${body}\n${url}`.toLowerCase();
  if (
    /```|github\.com|pip install|npm |pytest|实践|动手|代码|脚本|配置|调优|复现|手推|对比\s*q/.test(
      combined,
    )
  ) {
    return 'practice';
  }
  if (
    /arxiv\.org|论文|paper|benchmark|手册|文档|api|清单|cheat\s*sheet|survey/.test(
      combined,
    )
  ) {
    return 'reference';
  }
  return 'concept';
}

const INTENT_LABELS: Record<LearningIntent, string> = {
  concept: '讲透机制',
  practice: '可动手练',
  reference: '参考资料',
};

export function enrichResourceForLearning(
  resource: LearningBridgeInput,
  ctx: LearningGoalContext,
): ResourceLearningMeta {
  const {title, body, rawTags} = readResourceText(resource);
  const reading = formatPostForReading(body);
  const intent = inferLearningIntent(resource, ctx);

  const mergedTags: string[] = [];
  const seenTagKeys = new Set<string>();
  for (const tag of [...rawTags, ...reading.cleanTags]) {
    const key = tag.toLowerCase();
    if (GENERIC_SPAM_TAGS.has(key) || seenTagKeys.has(key)) {
      continue;
    }
    seenTagKeys.add(key);
    mergedTags.push(tag);
    if (mergedTags.length >= 4) {
      break;
    }
  }

  const titleLower = title.toLowerCase();
  const bodyLower = `${body}\n${mergedTags.join(' ')}`.toLowerCase();

  let bestGoal:
    | {goal: LearningGoalItem; hits: string[]; points: number}
    | undefined;
  for (const goal of ctx.goals) {
    const hits: string[] = [];
    let points = 0;
    for (const kw of goal.keywords) {
      const inTitle = titleLower.includes(kw);
      const inBody = bodyLower.includes(kw);
      if (inTitle || inBody) {
        hits.push(kw);
        points += inTitle ? 4 : 2;
      }
    }
    if (points > 0 && (!bestGoal || points > bestGoal.points)) {
      bestGoal = {goal, hits, points};
    }
  }

  const relatedNoteTitles = ctx.vaultNotes
    .filter(note => {
      const noteKws = extractKeywords(`${note.title} ${(note.tags || []).join(' ')}`);
      return noteKws.some(kw => titleLower.includes(kw) || bodyLower.includes(kw));
    })
    .map(note => note.title)
    .slice(0, 3);

  const relatedTodo = ctx.pendingTodos.find(todo => {
    const kws = extractKeywords(todo.text);
    return kws.some(kw => titleLower.includes(kw) || bodyLower.includes(kw));
  });

  let goalMatch: ResourceLearningMeta['goalMatch'];
  if (bestGoal) {
    const sourceHint =
      bestGoal.goal.source === 'vault-note' || relatedNoteTitles.length > 0
        ? `衔接笔记《${relatedNoteTitles[0] || bestGoal.goal.label}》`
        : bestGoal.goal.source === 'vault-todo' || relatedTodo
          ? `推进待办「${(relatedTodo?.text || bestGoal.goal.label).slice(0, 22)}」`
          : `契合当前「${bestGoal.goal.label}」学习目标`;
    goalMatch = {
      goalId: bestGoal.goal.id,
      label: bestGoal.goal.label,
      reason: `${sourceHint}（${INTENT_LABELS[intent]}）`,
    };
  }

  const substanceScore =
    (reading.paragraphs.length > 0 ? 1 : 0) +
    (intent === 'practice' ? 2 : intent === 'concept' ? 2 : 1) +
    (bestGoal ? bestGoal.points * 3 : 0) +
    relatedNoteTitles.length * 3 +
    (relatedTodo ? 3 : 0);

  return {
    intent,
    intentLabel: INTENT_LABELS[intent],
    ...(goalMatch ? {goalMatch} : {}),
    paragraphs:
      reading.paragraphs.length > 0
        ? reading.paragraphs
        : title
          ? [title]
          : [],
    cleanTags: mergedTags,
    lead: reading.lead || title,
    relatedNoteTitles,
    score: substanceScore,
  };
}

export function rankResourcesForLearning<T extends LearningBridgeInput>(
  items: T[],
  ctx: LearningGoalContext,
): T[] {
  return [...items].sort((a, b) => {
    const metaA = enrichResourceForLearning(a, ctx);
    const metaB = enrichResourceForLearning(b, ctx);
    if (metaB.score !== metaA.score) {
      return metaB.score - metaA.score;
    }
    const timeA = readResourceText(a).capturedAtMs;
    const timeB = readResourceText(b).capturedAtMs;
    return timeB - timeA;
  });
}

export function buildResourceVaultMarkdown(
  resource: LearningBridgeInput,
  enrichment: ResourceLearningMeta,
): {title: string; markdown: string; tags: string[]} {
  const {title, url, author} = readResourceText(resource);
  const safeTitle = title || enrichment.lead.slice(0, 48) || '学习资料摘录';
  const wikilinks = Array.from(
    new Set([
      ...enrichment.relatedNoteTitles,
      ...(enrichment.goalMatch ? [enrichment.goalMatch.label] : []),
    ]),
  ).filter(Boolean);
  if (wikilinks.length === 0) {
    wikilinks.push('学习资源库');
  }
  const linksLine = wikilinks.map(link => `[[${link}]]`).join(' · ');
  const metaParts = [
    author ? `作者：${author}` : '',
    `定位：${enrichment.intentLabel}`,
    url ? `原文：${url}` : '',
  ].filter(Boolean);
  const bodyBlock = enrichment.paragraphs.join('\n\n') || safeTitle;
  const markdown = [
    `> ${metaParts.join(' · ')}`,
    `> 关联知识图谱：${linksLine}`,
    enrichment.goalMatch ? `> 学习关联：${enrichment.goalMatch.reason}` : '',
    '',
    '## 核心脉络',
    '',
    enrichment.lead || safeTitle,
    '',
    '## 整理正文',
    '',
    bodyBlock,
    '',
    url ? `---\n原文链接：${url}` : '',
  ]
    .filter((line, index, arr) => !(line === '' && arr[index - 1] === ''))
    .join('\n');

  return {
    title: safeTitle,
    markdown,
    tags: enrichment.cleanTags,
  };
}
