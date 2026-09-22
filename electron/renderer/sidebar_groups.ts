'use strict';


interface SidebarConversationLike {
  id?: string;
  title?: string;
  subtitle?: string;
  updatedAt?: number;
  workspaceRoot?: string;
}

interface SidebarGroup {
  key: string;
  label: string;
  items: SidebarConversationLike[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function groupConversations(
  conversations: readonly SidebarConversationLike[],
  now: number = Date.now(),
): SidebarGroup[] {
  const sorted = [...conversations].sort(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
  const groups: SidebarGroup[] = [
    { key: 'today', label: '今天', items: [] },
    { key: 'yesterday', label: '昨天', items: [] },
    { key: 'week', label: '近 7 天', items: [] },
    { key: 'earlier', label: '更早', items: [] },
  ];
  const byKey = new Map(groups.map(group => [group.key, group]));
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  for (const item of sorted) {
    const at = item.updatedAt ?? 0;
    if (at >= startOfToday) byKey.get('today')!.items.push(item);
    else if (at >= startOfToday - DAY_MS) byKey.get('yesterday')!.items.push(item);
    else if (at >= startOfToday - 6 * DAY_MS) byKey.get('week')!.items.push(item);
    else byKey.get('earlier')!.items.push(item);
  }
  return groups.filter(group => group.items.length > 0);
}

function filterConversations(
  conversations: readonly SidebarConversationLike[],
  query: string,
): SidebarConversationLike[] {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [...conversations];
  return conversations.filter(item =>
    String(item.title || '').toLowerCase().includes(needle)
    || String(item.subtitle || '').toLowerCase().includes(needle));
}

function groupByWorkspace(
  conversations: readonly (SidebarConversationLike & { workspaceRoot?: string })[],
): Array<{ key: string; label: string; workspaceRoot: string; items: SidebarConversationLike[] }> {
  const sorted = [...conversations].sort(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
  const groups = new Map<
    string,
    { key: string; label: string; workspaceRoot: string; items: SidebarConversationLike[] }
  >();
  const localItems: SidebarConversationLike[] = [];
  for (const item of sorted) {
    const root = String(item.workspaceRoot || '').trim().replace(/\\/g, '/');
    if (!root) {
      localItems.push(item);
      continue;
    }
    const key = root;
    let group = groups.get(key);
    if (!group) {
      const segments = root.split('/').filter(Boolean);
      group = {
        key,
        label: segments[segments.length - 1] || root,
        workspaceRoot: root,
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  const result = [...groups.values()];
  if (localItems.length) {
    result.push({
      key: '__local__',
      label: 'Chats',
      workspaceRoot: '',
      items: localItems,
    });
  }
  return result;
}

const SidebarGroups = { groupConversations, filterConversations, groupByWorkspace };
if (typeof module !== 'undefined' && module.exports) module.exports = SidebarGroups;
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { SidebarGroups?: typeof SidebarGroups }).SidebarGroups = SidebarGroups;
}
