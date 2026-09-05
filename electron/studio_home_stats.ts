const DAY_MS = 24 * 60 * 60 * 1000;
const HEATMAP_DAYS = 182;

interface StudioUsageLike {
  [key: string]: unknown;
}

interface StudioTurnLike {
  at?: unknown;
  question?: unknown;
  answer?: unknown;
  modelUsage?: StudioUsageLike;
  modelId?: unknown;
}

interface StudioConversationLike {
  id?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  turns?: StudioTurnLike[];
}

interface NormalizedTurn {
  sessionKey: string;
  at: number;
  dayStart: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  modelId: string;
}

export interface StudioHeatmapDay {
  date: string;
  messages: number;
  future: boolean;
}

export interface StudioDailyTokens {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  messages: number;
}

export interface StudioModelStats {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turns: number;
  share: number;
}

export interface StudioHomeStatsSlice {
  sessions: number;
  messages: number;
  totalTokens: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  peakHour: number | null;
  favoriteModel: string | null;
  heatmap: StudioHeatmapDay[];
  daily: StudioDailyTokens[];
  models: StudioModelStats[];
}

export interface StudioHomeStats extends StudioHomeStatsSlice {
  ranges: {
    all: StudioHomeStatsSlice;
    '30d': StudioHomeStatsSlice;
    '7d': StudioHomeStatsSlice;
  };
}

function finiteNonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function startOfLocalDay(value: number | Date): Date {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addLocalDays(value: Date, days: number): Date {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function localDateKey(value: number | Date): string {
  const date = new Date(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function usageBreakdown(usage: StudioUsageLike | undefined): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  if (!usage) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const inputTokens = finiteNonNegative(usage.inputTokens)
    + finiteNonNegative(usage.cacheCreationInputTokens)
    + finiteNonNegative(usage.cacheWriteTokens);
  const outputTokens = finiteNonNegative(usage.outputTokens);
  const rawTotal = Number(usage.totalTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: Number.isFinite(rawTotal)
      ? Math.max(0, rawTotal)
      : inputTokens + outputTokens,
  };
}

function streaks(dayStarts: number[], todayStart: number): {
  current: number;
  longest: number;
} {
  const unique = [...new Set(dayStarts)].sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of unique) {
    run = previous !== null && day - previous === DAY_MS ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }
  if (!unique.includes(todayStart)) return { current: 0, longest };
  let current = 1;
  let cursor = todayStart - DAY_MS;
  const set = new Set(unique);
  while (set.has(cursor)) {
    current += 1;
    cursor -= DAY_MS;
  }
  return { current, longest };
}

function normalizeTurns(
  conversations: readonly StudioConversationLike[],
  now: number,
): NormalizedTurn[] {
  const normalized: NormalizedTurn[] = [];
  conversations.forEach((conversation, conversationIndex) => {
    const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
    turns.forEach((turn) => {
      const question = String(turn.question ?? '').trim();
      const answer = String(turn.answer ?? '').trim();
      const messages = Number(Boolean(question)) + Number(Boolean(answer));
      if (messages === 0) return;
      const fallbackAt = finiteNonNegative(conversation.updatedAt)
        || finiteNonNegative(conversation.createdAt)
        || now;
      const rawAt = Number(turn.at);
      const at = Number.isFinite(rawAt) && rawAt > 0 ? rawAt : fallbackAt;
      const usage = usageBreakdown(turn.modelUsage);
      normalized.push({
        sessionKey: String(conversation.id ?? `session-${conversationIndex}`),
        at,
        dayStart: startOfLocalDay(at).getTime(),
        messages,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        modelId: String(turn.modelId ?? '').trim(),
      });
    });
  });
  return normalized;
}

function aggregateSlice(
  turns: readonly NormalizedTurn[],
  now: number,
  dayCount: number,
  options: { allTime?: boolean; sessionCount?: number; alignHeatmapWeek?: boolean } = {},
): StudioHomeStatsSlice {
  const today = startOfLocalDay(now);
  const todayStart = today.getTime();
  const lowerBound = addLocalDays(today, -(dayCount - 1)).getTime();
  const included = turns.filter((turn) => (
    turn.dayStart <= todayStart
    && (options.allTime || turn.dayStart >= lowerBound)
  ));
  const messagesByDay = new Map<string, number>();
  const dailyByDay = new Map<string, Omit<StudioDailyTokens, 'date'>>();
  const activeDayStarts: number[] = [];
  const peakHours = new Map<number, number>();
  const modelTotals = new Map<string, Omit<StudioModelStats, 'modelId' | 'share'>>();
  let messages = 0;
  let totalTokens = 0;

  for (const turn of included) {
    const dayKey = localDateKey(turn.dayStart);
    messages += turn.messages;
    totalTokens += turn.totalTokens;
    messagesByDay.set(dayKey, (messagesByDay.get(dayKey) ?? 0) + turn.messages);
    activeDayStarts.push(turn.dayStart);
    const hour = new Date(turn.at).getHours();
    peakHours.set(hour, (peakHours.get(hour) ?? 0) + 1);

    const daily = dailyByDay.get(dayKey) ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      messages: 0,
    };
    daily.inputTokens += turn.inputTokens;
    daily.outputTokens += turn.outputTokens;
    daily.totalTokens += turn.totalTokens;
    daily.messages += turn.messages;
    dailyByDay.set(dayKey, daily);

    if (turn.modelId) {
      const model = modelTotals.get(turn.modelId) ?? {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        turns: 0,
      };
      model.inputTokens += turn.inputTokens;
      model.outputTokens += turn.outputTokens;
      model.totalTokens += turn.totalTokens;
      model.turns += 1;
      modelTotals.set(turn.modelId, model);
    }
  }

  const totalModelTurns = [...modelTotals.values()]
    .reduce((total, row) => total + row.turns, 0);
  const models = [...modelTotals.entries()].map(([modelId, row]) => ({
    modelId,
    ...row,
    share: totalTokens > 0
      ? (row.totalTokens / totalTokens) * 100
      : (totalModelTurns > 0 ? (row.turns / totalModelTurns) * 100 : 0),
  })).sort((a, b) => b.totalTokens - a.totalTokens
    || b.turns - a.turns
    || a.modelId.localeCompare(b.modelId));

  const daily = Array.from({ length: dayCount }, (_, index) => {
    const date = addLocalDays(today, index - (dayCount - 1));
    const dateKey = localDateKey(date);
    return { date: dateKey, ...(dailyByDay.get(dateKey) ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      messages: 0,
    }) };
  });

  const heatmapEnd = options.alignHeatmapWeek
    ? addLocalDays(today, 6 - today.getDay())
    : today;
  const heatmapStart = addLocalDays(heatmapEnd, -(dayCount - 1));
  const heatmap = Array.from({ length: dayCount }, (_, index) => {
    const date = addLocalDays(heatmapStart, index);
    const dateKey = localDateKey(date);
    return {
      date: dateKey,
      messages: messagesByDay.get(dateKey) ?? 0,
      future: date.getTime() > todayStart,
    };
  });

  const streak = streaks(activeDayStarts, todayStart);
  const peakHour = [...peakHours.entries()].sort(
    (a, b) => b[1] - a[1] || a[0] - b[0],
  )[0]?.[0] ?? null;

  return {
    sessions: options.sessionCount
      ?? new Set(included.map((turn) => turn.sessionKey)).size,
    messages,
    totalTokens,
    activeDays: new Set(activeDayStarts).size,
    currentStreak: streak.current,
    longestStreak: streak.longest,
    peakHour,
    favoriteModel: models[0]?.modelId ?? null,
    heatmap,
    daily,
    models,
  };
}

export function projectStudioHomeStats(
  conversations: readonly StudioConversationLike[],
  now: number = Date.now(),
): StudioHomeStats {
  const turns = normalizeTurns(conversations, now);
  const all = aggregateSlice(turns, now, HEATMAP_DAYS, {
    allTime: true,
    sessionCount: conversations.length,
    alignHeatmapWeek: true,
  });
  const thirtyDays = aggregateSlice(turns, now, 30);
  const sevenDays = aggregateSlice(turns, now, 7);
  return {
    ...all,
    ranges: {
      all,
      '30d': thirtyDays,
      '7d': sevenDays,
    },
  };
}
