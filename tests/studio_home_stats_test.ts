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

console.log('studio home stats test ok');
