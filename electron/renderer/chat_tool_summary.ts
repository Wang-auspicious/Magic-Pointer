export type SummaryOutcome = 'succeeded' | 'failed' | 'blocked' | 'pending';
export type SummaryLocale = 'en' | 'zh-CN';

export interface SummaryCall {
  category?: string;
  key: string;
  filePath?: string;
  outcome?: SummaryOutcome;
  writeAs?: 'create' | 'update';
  canLinkFile: boolean;
}

export interface SummaryPart {
  verb: string;
  meta?: string;
  count: number;
  failed?: number;
  blocked?: number;
  isError?: boolean;
  file?: {path: string; preferDiff: boolean};
  rest?: boolean;
}

const WORDS = {
  read: ['read', 'a file', '# files'],
  view: ['viewed', 'a file', '# files'],
  write: ['created', 'a file', '# files'],
  edit: ['edited', 'a file', '# files'],
  notebook_edit: ['edited', 'a notebook', '# notebooks'],
  delete_file: ['deleted', 'a file', '# files'],
  bash: ['ran', 'a command', '# commands'],
  code: ['ran', 'code'],
  grep: ['searched', 'code'],
  glob: ['found', 'files'],
  web: ['browsed', 'the web'],
  web_fetch: ['fetched', 'a page', '# pages'],
  task: ['ran', 'an agent', '# agents'],
  todo: ['updated', 'todos'],
  plan: ['updated', 'todos'],
  exit_plan_mode: ['proposed', 'a plan'],
  artifact_read: ['read', 'an artifact', '# artifacts'],
  artifact_write: ['updated', 'an artifact', '# artifacts'],
  worktree_enter: ['moved to', 'a worktree', '# worktrees'],
  worktree_exit: ['left', 'the worktree', '# worktrees'],
  peer_message: ['messaged', 'another session', '# other sessions'],
  push_notification: ['sent', 'a notification', '# notifications'],
  started_session: ['started', 'a session', '# sessions'],
  slack_post: ['used', 'a tool', '# tools'],
  uncategorized: ['used', 'a tool', '# tools'],
} as const;
type Category = keyof typeof WORDS;
type OutcomeMap = Map<string, SummaryOutcome | undefined>;
const FILE_CATEGORIES = new Set<Category>([
  'read',
  'view',
  'write',
  'edit',
  'notebook_edit',
  'delete_file',
]);
const EDIT_CATEGORIES = new Set<Category>(['write', 'edit', 'notebook_edit']);

type WordEntry = readonly [string, string, string?];

const ZH_WORDS: Record<Category, WordEntry> = {
  read: ['读取了', '1 个文件', '# 个文件'],
  view: ['查看了', '1 个文件', '# 个文件'],
  write: ['创建了', '1 个文件', '# 个文件'],
  edit: ['编辑了', '1 个文件', '# 个文件'],
  notebook_edit: ['编辑了', '1 个笔记本', '# 个笔记本'],
  delete_file: ['删除了', '1 个文件', '# 个文件'],
  bash: ['执行了', '1 条命令', '# 条命令'],
  code: ['运行了', '代码'],
  grep: ['搜索了', '代码'],
  glob: ['查找了', '文件'],
  web: ['搜索了', '网页'],
  web_fetch: ['读取了', '1 个网页', '# 个网页'],
  task: ['运行了', '1 个子任务', '# 个子任务'],
  todo: ['更新了', '计划'],
  plan: ['更新了', '计划'],
  exit_plan_mode: ['提出了', '方案'],
  artifact_read: ['读取了', '1 个产物', '# 个产物'],
  artifact_write: ['更新了', '1 个产物', '# 个产物'],
  worktree_enter: ['进入了', '1 个工作区', '# 个工作区'],
  worktree_exit: ['离开了', '工作区', '# 个工作区'],
  peer_message: ['联系了', '其他会话', '# 个其他会话'],
  push_notification: ['发送了', '1 条通知', '# 条通知'],
  started_session: ['启动了', '1 个会话', '# 个会话'],
  slack_post: ['调用了', '1 个工具', '# 个工具'],
  uncategorized: ['调用了', '1 个工具', '# 个工具'],
};

function categoryOf(value?: string): Category {
  return value && Object.hasOwn(WORDS, value)
    ? (value as Category)
    : 'uncategorized';
}

function latest(previous: SummaryOutcome | undefined, next?: SummaryOutcome) {
  return next === undefined ? previous : next === 'pending' ? undefined : next;
}

function outcomeCount(entries: OutcomeMap, outcome: SummaryOutcome): number {
  return [...entries.values()].filter(value => value === outcome).length;
}

function words(
  category: Category,
  count: number,
  locale: SummaryLocale = 'en',
): SummaryPart {
  const table = locale === 'zh-CN' ? ZH_WORDS : WORDS;
  const [verb, one, many] = table[category] as WordEntry;
  return {
    verb,
    meta: (count === 1 || !many ? one : many).replace('#', String(count)),
    count,
  };
}

function withOutcomes(
  part: SummaryPart,
  failed: number,
  blocked: number,
  locale: SummaryLocale = 'en',
): SummaryPart {
  if (!failed && !blocked) {
    return part;
  }
  const annotation =
    locale === 'zh-CN'
      ? [
          ...(failed ? [`${failed} 个失败`] : []),
          ...(blocked ? [`${blocked} 个被拦截`] : []),
        ].join('，')
      : [
          ...(failed ? [failed + ' failed'] : []),
          ...(blocked ? [blocked + ' blocked'] : []),
        ].join(', ');
  const suffix =
    locale === 'zh-CN' ? `（${annotation}）` : ` (${annotation})`;
  return {
    ...part,
    meta: part.meta ? part.meta + suffix : undefined,
    ...(failed ? {failed} : {}),
    ...(blocked ? {blocked} : {}),
    ...(failed >= part.count ? {isError: true} : {}),
  };
}

function conjunction(values: string[], locale: SummaryLocale = 'en'): string {
  if (locale === 'zh-CN') {
    if (values.length <= 1) {
      return values[0] ?? '';
    }
    return values.join('并');
  }
  return new Intl.ListFormat('en', {type: 'conjunction'}).format(values);
}

export function summarizeToolCalls(
  calls: readonly SummaryCall[],
  locale: SummaryLocale = 'en',
): SummaryPart[] {
  const artifactWrites = new Set(
    calls
      .filter(call => call.category === 'artifact_write')
      .map(call => call.key),
  );
  const firstWrite = new Map<string, 'create' | 'update'>();
  for (const call of calls) {
    if (call.writeAs && !firstWrite.has(call.key)) {
      firstWrite.set(call.key, call.writeAs);
    }
  }
  const groups = new Map<Category, OutcomeMap>();
  const fileCalls: Array<{
    category: Category;
    path?: string;
    outcome?: SummaryOutcome;
  }> = [];
  const paths = new Set<string>();
  let missingPath = false;
  let canLink = true;
  let unknownCount = 0;
  let unknownFailed = 0;
  let unknownBlocked = 0;
  for (const call of calls) {
    let category = categoryOf(call.category);
    const promoted =
      category === 'artifact_read' && artifactWrites.has(call.key);
    if (promoted) {
      category = 'artifact_write';
    }
    if (category === 'write' && firstWrite.get(call.key) === 'update') {
      category = 'edit';
    }
    if (category === 'uncategorized') {
      unknownCount++;
      unknownFailed += Number(call.outcome === 'failed');
      unknownBlocked += Number(call.outcome === 'blocked');
      continue;
    }
    let entries = groups.get(category);
    if (!entries) {
      entries = new Map();
      groups.set(category, entries);
    }
    const outcome = promoted ? undefined : call.outcome;
    entries.set(call.key, latest(entries.get(call.key), outcome));
    if (FILE_CATEGORIES.has(category)) {
      fileCalls.push({category, path: call.filePath, outcome});
      canLink &&= call.canLinkFile;
      if (call.filePath === undefined) {
        missingPath = true;
      } else {
        paths.add(call.filePath);
      }
    }
  }

  const verbs = new Map<string, Category[]>();
  for (const category of groups.keys()) {
    if (!FILE_CATEGORIES.has(category)) {
      continue;
    }
    const verb = words(category, 1, locale).verb;
    verbs.set(verb, [...(verbs.get(verb) ?? []), category]);
  }
  for (const categories of verbs.values()) {
    if (categories.length < 2) {
      continue;
    }
    const shared: OutcomeMap = new Map();
    for (const call of fileCalls) {
      if (call.path !== undefined && categories.includes(call.category)) {
        shared.set(call.path, latest(shared.get(call.path), call.outcome));
      }
    }
    for (const category of categories) {
      const entries = groups.get(category)!;
      for (const [path, outcome] of shared) {
        if (entries.has(path)) {
          entries.set(path, outcome);
        }
      }
    }
  }

  const path = !missingPath && paths.size === 1 ? [...paths][0] : undefined;
  let filePart: SummaryPart | undefined;
  if (path && verbs.size) {
    const failed = [...verbs.values()].filter(categories =>
      categories.some(
        category => outcomeCount(groups.get(category)!, 'failed') > 0,
      ),
    ).length;
    const blocked = [...verbs.values()].filter(categories =>
      categories.some(
        category => outcomeCount(groups.get(category)!, 'blocked') > 0,
      ),
    ).length;
    filePart = withOutcomes(
      {
        verb: conjunction([...verbs.keys()], locale),
        meta: path.split(/[\\/]/).pop(),
        count: verbs.size,
      },
      failed,
      blocked,
      locale,
    );
    if (!filePart.isError && canLink) {
      filePart.file = {
        path,
        preferDiff: fileCalls.some(
          call =>
            EDIT_CATEGORIES.has(call.category) && call.outcome === 'succeeded',
        ),
      };
    }
  }
  const parts: SummaryPart[] = [];
  for (const [category, entries] of groups) {
    if (filePart && FILE_CATEGORIES.has(category)) {
      if (!parts.includes(filePart)) {
        parts.push(filePart);
      }
    } else {
      parts.push(
        withOutcomes(
          words(category, entries.size, locale),
          outcomeCount(entries, 'failed'),
          outcomeCount(entries, 'blocked'),
          locale,
        ),
      );
    }
  }
  if (unknownCount) {
    parts.push(
      withOutcomes(
        words('uncategorized', unknownCount, locale),
        unknownFailed,
        unknownBlocked,
        locale,
      ),
    );
  }
  if (parts.length < 5) {
    return parts;
  }
  const remaining = parts.slice(3);
  const count = remaining.reduce((total, part) => total + part.count, 0);
  const failed = remaining.reduce(
    (total, part) => total + (part.failed ?? 0),
    0,
  );
  const blocked = remaining.reduce(
    (total, part) => total + (part.blocked ?? 0),
    0,
  );
  const tail = withOutcomes(
    {
      verb: '',
      meta:
        locale === 'zh-CN'
          ? `等 ${count} 项操作`
          : 'and ' + count + ' more action' + (count === 1 ? '' : 's'),
      count,
    },
    failed,
    blocked,
    locale,
  );
  return [
    ...parts.slice(0, 3),
    {
      ...tail,
      verb: tail.meta!,
      meta: undefined,
      isError: undefined,
      rest: true,
    },
  ];
}

export function summaryText(
  parts: readonly SummaryPart[],
  locale: SummaryLocale = 'en',
): string {
  const sep = locale === 'zh-CN' ? '、' : ', ';
  return parts
    .map((part, index) => {
      const verb =
        locale === 'zh-CN'
          ? part.verb
          : index === 0
            ? part.verb.charAt(0).toUpperCase() + part.verb.slice(1)
            : part.verb;
      return verb + (part.meta ? ' ' + part.meta : '');
    })
    .join(sep);
}
