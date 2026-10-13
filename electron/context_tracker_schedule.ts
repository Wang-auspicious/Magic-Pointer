export interface ScheduleTrigger {
  kind: 'schedule';
  startAtMs: number;
  everyMs?: number;
  calendar?: 'daily' | 'weekly' | 'monthly';
}

export function normalizeScheduleTrigger(
  raw: Record<string, unknown>,
): ScheduleTrigger {
  const startAtMs = Number(raw.startAtMs);
  if (
    !Number.isFinite(startAtMs) ||
    startAtMs < 0 ||
    !Number.isFinite(new Date(startAtMs).getTime())
  ) {
    throw new Error('schedule tracker startAtMs is invalid');
  }
  if (raw.calendar !== undefined) {
    if (!['daily', 'weekly', 'monthly'].includes(String(raw.calendar))) {
      throw new Error('schedule tracker calendar is invalid');
    }
    return {
      kind: 'schedule',
      startAtMs,
      calendar: raw.calendar as ScheduleTrigger['calendar'],
    };
  }
  const everyMs = Number(raw.everyMs);
  if (!Number.isFinite(everyMs) || everyMs <= 0) {
    throw new Error('schedule tracker everyMs is invalid');
  }
  return {kind: 'schedule', startAtMs, everyMs};
}

export function scheduleOccurrence(
  trigger: ScheduleTrigger,
  index: number,
): number {
  if (!trigger.calendar) {
    return trigger.startAtMs + index * trigger.everyMs!;
  }
  const anchor = new Date(trigger.startAtMs);
  const due = new Date(trigger.startAtMs);
  if (trigger.calendar === 'monthly') {
    due.setDate(1);
    due.setMonth(anchor.getMonth() + index);
    const lastDay = new Date(
      due.getFullYear(),
      due.getMonth() + 1,
      0,
    ).getDate();
    due.setDate(Math.min(anchor.getDate(), lastDay));
  } else {
    due.setDate(
      anchor.getDate() + index * (trigger.calendar === 'weekly' ? 7 : 1),
    );
  }
  return due.getTime();
}

function occurrenceIndex(trigger: ScheduleTrigger, atMs: number): number {
  if (atMs < trigger.startAtMs) {
    return -1;
  }
  if (!trigger.calendar) {
    return Math.floor((atMs - trigger.startAtMs) / trigger.everyMs!);
  }
  const start = new Date(trigger.startAtMs);
  const at = new Date(atMs);
  const days =
    (Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) -
      Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) /
    86_400_000;
  let index =
    trigger.calendar === 'monthly'
      ? (at.getFullYear() - start.getFullYear()) * 12 +
        at.getMonth() -
        start.getMonth()
      : Math.floor(days / (trigger.calendar === 'weekly' ? 7 : 1));
  while (index >= 0 && scheduleOccurrence(trigger, index) > atMs) {
    index -= 1;
  }
  while (scheduleOccurrence(trigger, index + 1) <= atMs) {
    index += 1;
  }
  return index;
}

export function dueSchedule(
  trigger: ScheduleTrigger,
  lastDue: number | null,
  nowMs: number,
) {
  const first = lastDue === null ? 0 : occurrenceIndex(trigger, lastDue) + 1;
  const last = occurrenceIndex(trigger, nowMs);
  return {
    nextAtMs: scheduleOccurrence(trigger, first),
    missedCount: Math.max(0, last - first + 1),
    missedFromMs: scheduleOccurrence(trigger, first),
    missedToMs: last >= first ? scheduleOccurrence(trigger, last) : null,
  };
}
