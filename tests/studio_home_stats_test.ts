const assert = require('node:assert');
const { projectStudioHomeStats } = require('../electron/studio_home_stats');

const now = new Date('2026-09-01T12:00:00+08:00').getTime();
const day = 86_400_000;
const stats = projectStudioHomeStats([
  {
    id: 'a',
    createdAt: now - day,
    updatedAt: now,
    turns: [
      {
        question: 'q1',
        answer: 'a1',
        at: now - day,
        modelUsage: { inputTokens: 10, outputTokens: 5 },
        modelId: 'm1',
      },
      {
        question: 'q2',
        answer: 'a2',
        at: now,
        modelUsage: { totalTokens: 20 },
        modelId: 'm1',
      },
    ],
  },
  {
    id: 'b',
    createdAt: now,
    updatedAt: now,
    turns: [{
      question: 'q3',
      answer: 'a3',
      at: now,
      modelUsage: { totalTokens: 'bad' },
      modelId: 'm2',
    }],
  },
], now);

assert.strictEqual(stats.sessions, 2);
assert.strictEqual(stats.messages, 6);
assert.strictEqual(stats.totalTokens, 35);
assert.strictEqual(stats.activeDays, 2);
assert.strictEqual(stats.currentStreak, 2);
assert.strictEqual(stats.longestStreak, 2);
assert.strictEqual(stats.peakHour, 12);
assert.strictEqual(stats.favoriteModel, 'm1');
assert.strictEqual(stats.heatmap.length, 182);
assert.strictEqual(
  stats.heatmap.find((day: { date: string; messages: number }) => day.date === '2026-09-01').messages,
  4,
);
assert.strictEqual(stats.heatmap.at(-1).future, true);

const empty = projectStudioHomeStats([], now);
assert.strictEqual(empty.favoriteModel, null);
assert.strictEqual(empty.peakHour, null);
assert.strictEqual(empty.heatmap.length, 182);

const ranged = projectStudioHomeStats([{
  id: 'range-a',
  createdAt: now - 40 * day,
  updatedAt: now,
  turns: [
    {
      question: 'old question',
      answer: 'old answer',
      at: now - 40 * day,
      modelUsage: { inputTokens: 40, outputTokens: 10 },
      modelId: 'model-old',
    },
    {
      question: 'month question',
      answer: 'month answer',
      at: now - 20 * day,
      modelUsage: { inputTokens: 20, outputTokens: 10 },
      modelId: 'model-new',
    },
    {
      question: 'week question',
      answer: 'week answer',
      at: now - 2 * day,
      modelUsage: { inputTokens: 5, outputTokens: 5 },
      modelId: 'model-new',
    },
  ],
}], now);

assert.strictEqual(ranged.ranges.all.messages, 6);
assert.strictEqual(ranged.ranges['30d'].messages, 4);
assert.strictEqual(ranged.ranges['7d'].messages, 2);
assert.strictEqual(ranged.ranges.all.daily.length, 182);
assert.strictEqual(ranged.ranges['30d'].daily.length, 30);
assert.strictEqual(ranged.ranges['7d'].daily.length, 7);
assert.strictEqual(ranged.ranges['30d'].totalTokens, 40);
assert.strictEqual(ranged.ranges['7d'].totalTokens, 10);

const allOld = ranged.ranges.all.models.find((row: { modelId: string }) => row.modelId === 'model-old');
const allNew = ranged.ranges.all.models.find((row: { modelId: string }) => row.modelId === 'model-new');
assert.deepStrictEqual(
  { input: allOld.inputTokens, output: allOld.outputTokens, total: allOld.totalTokens, turns: allOld.turns },
  { input: 40, output: 10, total: 50, turns: 1 },
);
assert.deepStrictEqual(
  { input: allNew.inputTokens, output: allNew.outputTokens, total: allNew.totalTokens, turns: allNew.turns },
  { input: 25, output: 15, total: 40, turns: 2 },
);
assert(Math.abs(allOld.share - (50 / 90) * 100) < 0.001);
assert(!ranged.ranges['30d'].models.some((row: { modelId: string }) => row.modelId === 'model-old'));
assert.strictEqual(ranged.messages, ranged.ranges.all.messages, 'top-level compatibility is the all projection');
assert.strictEqual(ranged.totalTokens, ranged.ranges.all.totalTokens);

console.log('studio home stats test ok');
