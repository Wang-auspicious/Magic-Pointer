const assert = require('node:assert');
const {
  renderModelsCard,
  renderStatsCard,
  selectAttentionItems,
} = require('../electron/renderer/studio_home');
const fs = require('node:fs');

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

const interactiveHeatmap = renderStatsCard({
  sessions: 1,
  messages: 2,
  totalTokens: 30,
  activeDays: 1,
  currentStreak: 1,
  longestStreak: 1,
  peakHour: 9,
  favoriteModel: 'reasoning-model',
  heatmap: [{ date: '2026-09-01', messages: 2, future: false }],
  daily: [{ date: '2026-09-01', inputTokens: 20, outputTokens: 10, totalTokens: 30 }],
  models: [{
    modelId: 'reasoning-model', inputTokens: 20, outputTokens: 10,
    totalTokens: 30, turns: 1, share: 100,
  }],
});
assert(interactiveHeatmap.includes('class="mp-home-heatmap-cell"'));
assert(interactiveHeatmap.includes('tabindex="0"'));
assert(interactiveHeatmap.includes('data-home-tooltip="2026-09-01 · 2 messages"'));
assert(!interactiveHeatmap.includes('href='), 'heatmap cells are informative controls, not fake links');

const modelsMarkup = renderModelsCard({
  sessions: 1,
  messages: 2,
  totalTokens: 30,
  activeDays: 1,
  currentStreak: 1,
  longestStreak: 1,
  peakHour: 9,
  favoriteModel: 'reasoning-model',
  heatmap: [],
  daily: [
    { date: '2026-08-31', inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    { date: '2026-09-01', inputTokens: 20, outputTokens: 10, totalTokens: 30 },
  ],
  models: [{
    modelId: 'reasoning-model', inputTokens: 25, outputTokens: 15,
    totalTokens: 40, turns: 2, share: 100,
  }],
});
assert(modelsMarkup.includes('mp-home-model-chart'));
assert(modelsMarkup.includes('mp-home-model-day'));
assert(modelsMarkup.includes('mp-home-model-row'));
assert(modelsMarkup.includes('reasoning-model'));
assert(modelsMarkup.includes('25 input') && modelsMarkup.includes('15 output'));

const shellHtml = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const homeSource = fs.readFileSync('electron/renderer/studio_home.ts', 'utf8');
const shellCss = fs.readFileSync('electron/renderer/claude_shell.css', 'utf8');
for (const value of ['overview', 'models']) {
  assert(shellHtml.includes(`role="tab" data-home-view="${value}"`));
}
for (const value of ['all', '30d', '7d']) {
  assert(shellHtml.includes(`role="tab" data-home-range="${value}"`));
}
assert(shellHtml.includes('id="studio-home-tooltip"'));
assert(homeSource.includes("let homeView: HomeView = 'overview'"));
assert(homeSource.includes("let homeRange: HomeRange = 'all'"));
assert(homeSource.includes("button.setAttribute('aria-selected'"));
assert(homeSource.includes("addEventListener('click'"));
assert.match(shellCss, /\.mp-home-heatmap\s*\{[^}]*grid-auto-columns:\s*14px[^}]*grid-template-rows:\s*repeat\(7,\s*14px\)/s,
  'short ranges retain Claude-sized heat cells instead of stretching into giant tiles');

console.log('studio home render test ok');
