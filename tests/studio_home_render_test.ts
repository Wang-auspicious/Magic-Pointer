const assert = require('node:assert');
const {
  renderStatsCard,
  selectAttentionItems,
} = require('../electron/renderer/studio_home');

const attention = selectAttentionItems([
  { id: 'done', updatedAt: 2, state: 'ready' },
  { id: 'ask', updatedAt: 1, state: 'awaiting' },
  { id: 'run', updatedAt: 3, state: 'running' },
]);
assert.deepStrictEqual(attention.map((item: { id: string }) => item.id), [
  'ask',
  'run',
  'done',
]);

const html = renderStatsCard({
  sessions: 2,
  messages: 4,
  totalTokens: 10,
  activeDays: 1,
  currentStreak: 1,
  longestStreak: 1,
  peakHour: 16,
  favoriteModel: 'm1',
  heatmap: [],
});
assert(html.includes('会话') && html.includes('消息') && html.includes('10'));
assert(!html.includes('undefined') && !html.includes('NaN'));
assert(renderStatsCard(null).includes('统计暂不可用'));

console.log('studio home render test ok');
