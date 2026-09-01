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

export interface StudioHeatmapDay {
  date: string;
  messages: number;
  future: boolean;
}

export interface StudioHomeStats {
  sessions: number;
  messages: number;
  totalTokens: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  peakHour: number | null;
  favoriteModel: string | null;
  heatmap: StudioHeatmapDay[];
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

function usageTokens(usage: StudioUsageLike | undefined): number {
  if (!usage) return 0;
  const rawTotal = Number(usage.totalTokens);
  if (Number.isFinite(rawTotal)) return Math.max(0, rawTotal);
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheCreationInputTokens,
    usage.cacheWriteTokens,
  ].reduce<number>((total, value) => total + finiteNonNegative(value), 0);
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

export function projectStudioHomeStats(
  conversations: readonly StudioConversationLike[],
  now: number = Date.now(),
): StudioHomeStats {
  const today = startOfLocalDay(now);
  const endOfWeek = addLocalDays(today, 6 - today.getDay());
  const heatmapStart = addLocalDays(endOfWeek, -(HEATMAP_DAYS - 1));
  const messagesByDay = new Map<string, number>();
  const activeDayStarts: number[] = [];
  const peakHours = new Map<number, number>();
  const modelTotals = new Map<string, { tokens: number; turns: number }>();
  let messages = 0;
  let totalTokens = 0;

  for (const conversation of conversations) {
    const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
    for (const turn of turns) {
      const question = String(turn.question ?? '').trim();
      const answer = String(turn.answer ?? '').trim();
      const turnMessages = Number(Boolean(question)) + Number(Boolean(answer));
      if (turnMessages === 0) continue;
      const fallbackAt = finiteNonNegative(conversation.updatedAt)
        || finiteNonNegative(conversation.createdAt)
        || now;
      const rawAt = Number(turn.at);
      const at = Number.isFinite(rawAt) && rawAt > 0 ? rawAt : fallbackAt;
      const day = startOfLocalDay(at);
      const dayKey = localDateKey(day);
      messages += turnMessages;
      messagesByDay.set(dayKey, (messagesByDay.get(dayKey) ?? 0) + turnMessages);
      activeDayStarts.push(day.getTime());
      const hour = new Date(at).getHours();
      peakHours.set(hour, (peakHours.get(hour) ?? 0) + 1);

      const tokens = usageTokens(turn.modelUsage);
      totalTokens += tokens;
      const modelId = String(turn.modelId ?? '').trim();
      if (modelId) {
        const aggregate = modelTotals.get(modelId) ?? { tokens: 0, turns: 0 };
        aggregate.tokens += tokens;
        aggregate.turns += 1;
        modelTotals.set(modelId, aggregate);
      }
    }
  }

  const streak = streaks(activeDayStarts, today.getTime());
  const peakHour = [...peakHours.entries()].sort(
    (a, b) => b[1] - a[1] || a[0] - b[0],
  )[0]?.[0] ?? null;
  const favoriteModel = [...modelTotals.entries()].sort(
    (a, b) => b[1].tokens - a[1].tokens
      || b[1].turns - a[1].turns
      || a[0].localeCompare(b[0]),
  )[0]?.[0] ?? null;
  const heatmap = Array.from({ length: HEATMAP_DAYS }, (_, index) => {
    const date = addLocalDays(heatmapStart, index);
    return {
      date: localDateKey(date),
      messages: messagesByDay.get(localDateKey(date)) ?? 0,
      future: date.getTime() > today.getTime(),
    };
  });

  return {
    sessions: conversations.length,
    messages,
    totalTokens,
    activeDays: new Set(activeDayStarts).size,
    currentStreak: streak.current,
    longestStreak: streak.longest,
    peakHour,
    favoriteModel,
    heatmap,
  };
}
