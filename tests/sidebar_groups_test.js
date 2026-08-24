'use strict';

// 侧栏分组纯函数：今天/昨天/近 7 天/更早，新→旧，搜索本地过滤。

const assert = require('assert');
const { groupConversations, filterConversations } = require('../electron/renderer/sidebar_groups');

const NOW = new Date('2026-08-16T15:00:00').getTime();
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetDays, hour = 10) => new Date(new Date(NOW).setHours(hour, 0, 0, 0)).getTime() - offsetDays * DAY;

const rows = [
  { id: 'a', title: '昨天的微信', updatedAt: at(1) },
  { id: 'b', title: '今天的记事本', updatedAt: at(0) },
  { id: 'c', title: '五天前的浏览器', updatedAt: at(5) },
  { id: 'd', title: '一个月前的终端', updatedAt: at(31) },
  { id: 'e', title: '今天清晨', updatedAt: new Date(NOW).setHours(1, 0, 0, 0) },
];

const groups = groupConversations(rows, NOW);
assert.deepStrictEqual(groups.map(g => [g.key, g.items.map(i => i.id)]), [
  ['today', ['b', 'e']],
  ['yesterday', ['a']],
  ['week', ['c']],
  ['earlier', ['d']],
], '四档分组、组内新→旧');

assert.deepStrictEqual(groupConversations([], NOW), [], '空列表不出空组');
assert.deepStrictEqual(
  groupConversations([{ id: 'x', title: '无时间' }], NOW)[0].key, 'earlier',
  '缺 updatedAt（按 0 处理）落「更早」，不炸不丢');

const filtered = filterConversations(rows, '微信');
assert.deepStrictEqual(filtered.map(i => i.id), ['a']);
assert.deepStrictEqual(filterConversations(rows, '').length, 5, '空关键词不过滤');
assert.deepStrictEqual(filterConversations(rows, '浏览器').map(i => i.id), ['c'], '副标题也能命中');

// ---- Codex WorkspaceBrowser：会话按线程工作区分组（文件夹名做组头） ----
const { groupByWorkspace } = require('../electron/renderer/sidebar_groups');
const wsRows = [
  { id: 'w1', title: 'alpha 里的一问', updatedAt: at(0), workspaceRoot: 'C:/repos/alpha' },
  { id: 'w2', title: 'alpha 里的二问', updatedAt: at(1), workspaceRoot: 'C:/repos/alpha' },
  { id: 'w3', title: 'beta 里的一问', updatedAt: at(2), workspaceRoot: 'C:/repos/beta' },
  { id: 'w4', title: '没绑工作区的旧会话', updatedAt: at(3) },
];
const wsGroups = groupByWorkspace(wsRows);
assert.deepStrictEqual(wsGroups.map(g => g.label), ['alpha', 'beta'], '组头只来自真实项目；未绑定记录不进入 Studio');
assert.deepStrictEqual(
  wsGroups.map(g => [g.workspaceRoot, g.items.map(i => i.id)]),
  [
    ['C:/repos/alpha', ['w1', 'w2']],
    ['C:/repos/beta', ['w3']],
  ],
  '组内新→旧，root 原样携带；无项目记录不进入 Studio',
);
assert.deepStrictEqual(groupByWorkspace([]), [], '空列表不出空组');
// 单工作区也要出组头——侧栏「工作区」区必须说真话。
assert.strictEqual(groupByWorkspace([{ id: 's1', title: 'x', updatedAt: NOW, workspaceRoot: 'D:/only' }]).length, 1);

console.log('sidebar groups test ok');
