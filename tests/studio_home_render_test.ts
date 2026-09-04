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
assert(html.includes('Sessions') && html.includes('Messages') && html.includes('10'));
assert(!html.includes('undefined') && !html.includes('NaN'));
const referenceStats = renderStatsCard({
  sessions: 231,
  messages: 52_275,
  totalTokens: 2_500_000_000,
  activeDays: 157,
  currentStreak: 1,
  longestStreak: 132,
  peakHour: 16,
  favoriteModel: 'Opus 5',
  heatmap: [],
});
assert(referenceStats.includes('>52,275<'), 'messages keep the exact reference comma formatting');
assert(referenceStats.includes('>2.5B<'), 'large token totals use the compact reference notation');
assert(renderStatsCard(null).includes('Stats unavailable'));

console.log('studio home render test ok');
