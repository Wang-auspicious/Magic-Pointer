export type StudioSearchKind = 'conversation' | 'project' | 'command' | 'skill' | 'route';

export interface StudioSearchItem {
  kind: StudioSearchKind;
  key: string;
  label: string;
  detail: string;
  keywords: string[];
  target: Record<string, unknown>;
  recency: number;
}

interface StudioSearchSources {
  conversations?: ReadonlyArray<{
    id?: unknown;
    title?: unknown;
    subtitle?: unknown;
    workspaceRoot?: unknown;
    updatedAt?: unknown;
  }>;
  projects?: ReadonlyArray<{
    root?: unknown;
    name?: unknown;
    lastOpenedAt?: unknown;
  }>;
  commands?: ReadonlyArray<{ name?: unknown; description?: unknown }>;
  skills?: ReadonlyArray<{ name?: unknown; description?: unknown }>;
  routes?: ReadonlyArray<{ id?: unknown; label?: unknown; keywords?: unknown }>;
}

const LIMITS = {
  conversation: 500,
  project: 100,
  command: 200,
  skill: 200,
  route: 50,
} as const;

function clean(value: unknown): string {
  return String(value ?? '').trim();
}

function normalized(value: unknown): string {
  return clean(value).toLocaleLowerCase();
}

function finiteRecency(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function keywordList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  const text = clean(value);
  return text ? [text] : [];
}

export function buildStudioSearchIndex(sources: StudioSearchSources): StudioSearchItem[] {
  const items: StudioSearchItem[] = [];
  for (const conversation of (sources.conversations ?? []).slice(0, LIMITS.conversation)) {
    const id = clean(conversation.id);
    if (!id) continue;
    const label = clean(conversation.title) || '未命名对话';
    const detail = clean(conversation.subtitle);
    items.push({
      kind: 'conversation',
      key: `conversation:${id}`,
      label,
      detail,
      keywords: [detail, clean(conversation.workspaceRoot)].filter(Boolean),
      target: { conversationId: id },
      recency: finiteRecency(conversation.updatedAt),
    });
  }
  for (const project of (sources.projects ?? []).slice(0, LIMITS.project)) {
    const root = clean(project.root);
    if (!root) continue;
    items.push({
      kind: 'project',
      key: `project:${root}`,
      label: clean(project.name) || root,
      detail: root,
      keywords: [root],
      target: { workspaceRoot: root },
      recency: finiteRecency(project.lastOpenedAt),
    });
  }
  for (const command of (sources.commands ?? []).slice(0, LIMITS.command)) {
    const name = clean(command.name);
    if (!name) continue;
    const description = clean(command.description);
    items.push({
      kind: 'command',
      key: `command:${name}`,
      label: `/${name}`,
      detail: description,
      keywords: [name, description].filter(Boolean),
      target: { command: name },
      recency: 0,
    });
  }
  for (const skill of (sources.skills ?? []).slice(0, LIMITS.skill)) {
    const name = clean(skill.name);
    if (!name) continue;
    const description = clean(skill.description);
    items.push({
      kind: 'skill',
      key: `skill:${name}`,
      label: name,
      detail: description,
      keywords: [description].filter(Boolean),
      target: { skill: name },
      recency: 0,
    });
  }
  for (const route of (sources.routes ?? []).slice(0, LIMITS.route)) {
    const id = clean(route.id);
    const label = clean(route.label);
    if (!id || !label) continue;
    items.push({
      kind: 'route',
      key: `route:${id}`,
      label,
      detail: '',
      keywords: keywordList(route.keywords),
      target: { view: id },
      recency: 0,
    });
  }
  return items;
}

function matchRank(item: StudioSearchItem, query: string): number | null {
  const label = normalized(item.label);
  const fields = item.keywords.map(normalized).filter(Boolean);
  if (label === query || fields.includes(query)) return 0;
  if (label.startsWith(query) || fields.some((field) => field.startsWith(query))) return 1;
  const tokens = [label, ...fields].flatMap((field) => field.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean));
  if (tokens.some((token) => token.startsWith(query))) return 2;
  if (label.includes(query) || fields.some((field) => field.includes(query))) return 3;
  return null;
}

export function searchStudioIndex(
  index: readonly StudioSearchItem[],
  rawQuery: unknown,
  limit = 20,
): StudioSearchItem[] {
  const query = normalized(rawQuery);
  if (!query) return [];
  return index
    .map((item) => ({ item, rank: matchRank(item, query) }))
    .filter((entry): entry is { item: StudioSearchItem; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank
      || b.item.recency - a.item.recency
      || a.item.label.localeCompare(b.item.label))
    .slice(0, Math.max(0, Math.min(20, Number(limit) || 20)))
    .map((entry) => entry.item);
}
