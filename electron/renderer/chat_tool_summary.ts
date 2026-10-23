export type SummaryOutcome = 'succeeded' | 'failed' | 'blocked' | 'pending';

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

function words(category: Category, count: number): SummaryPart {
  const [verb, one, many] = WORDS[category] as readonly [
    string,
    string,
    string?,
  ];
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
): SummaryPart {
  if (!failed && !blocked) {
    return part;
  }
  const annotation = [
    ...(failed ? [failed + ' failed'] : []),
    ...(blocked ? [blocked + ' blocked'] : []),
  ].join(', ');
  return {
    ...part,
    meta: part.meta ? part.meta + ' (' + annotation + ')' : undefined,
    ...(failed ? {failed} : {}),
    ...(blocked ? {blocked} : {}),
    ...(failed >= part.count ? {isError: true} : {}),
  };
}

function conjunction(values: string[]): string {
  return new Intl.ListFormat('en', {type: 'conjunction'}).format(values);
}

export function summarizeToolCalls(
  calls: readonly SummaryCall[],
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
    const verb = words(category, 1).verb;
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
        verb: conjunction([...verbs.keys()]),
        meta: path.split(/[\\/]/).pop(),
        count: verbs.size,
      },
      failed,
      blocked,
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
          words(category, entries.size),
          outcomeCount(entries, 'failed'),
          outcomeCount(entries, 'blocked'),
        ),
      );
    }
  }
  if (unknownCount) {
    parts.push(
      withOutcomes(
        words('uncategorized', unknownCount),
        unknownFailed,
        unknownBlocked,
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
      meta: 'and ' + count + ' more action' + (count === 1 ? '' : 's'),
      count,
    },
    failed,
    blocked,
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

export function summaryText(parts: readonly SummaryPart[]): string {
  return parts
    .map((part, index) => {
      const verb =
        index === 0
          ? part.verb.charAt(0).toUpperCase() + part.verb.slice(1)
          : part.verb;
      return verb + (part.meta ? ' ' + part.meta : '');
    })
    .join(', ');
}
