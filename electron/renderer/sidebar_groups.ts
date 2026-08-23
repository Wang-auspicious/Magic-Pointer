'use strict';

/* 侧栏会话分组（DSH ui-workspace 浏览器的 MP 等价物：无 workspace，按时间分组）。
   纯函数：分组 + 本地搜索过滤，供 Node 测试直接钉。 */

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

/** DSH 会话列表的展示顺序：新→旧；组内同样。 */
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

/** 本地搜索：标题/副标题大小写不敏感子串；空关键词不过滤。 */
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

/** Codex WorkspaceBrowser：会话按线程工作区分组，组头是文件夹名。
 *  未绑定工作区的落「默认工作区」组；组内新→旧；root 原样携带。 */
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
  for (const item of sorted) {
    const root = String(item.workspaceRoot || '').trim().replace(/\\/g, '/');
    const key = root || '__default__';
    let group = groups.get(key);
    if (!group) {
      const segments = root.split('/').filter(Boolean);
      group = {
        key,
        label: segments[segments.length - 1] || '默认工作区',
        workspaceRoot: root,
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  // 默认组永远排最后；其余按组内最新一条的时序（sorted 已保证首次出现序）。
  return [...groups.values()].sort((a, b) => {
    if (a.key === '__default__') return 1;
    if (b.key === '__default__') return -1;
    return 0;
  });
}

const SidebarGroups = { groupConversations, filterConversations, groupByWorkspace };
if (typeof module !== 'undefined' && module.exports) module.exports = SidebarGroups;
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { SidebarGroups?: typeof SidebarGroups }).SidebarGroups = SidebarGroups;
}
