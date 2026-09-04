'use strict';

(() => {
  interface SubagentStep {
    index: number;
    tool: string;
    status: string;
    usedBackend?: string;
    latencyMs?: number;
  }

  interface SubagentTask {
    id: string;
    parentCallId: string;
    description: string;
    status: string;
    stepCount: number;
    currentTool: string;
    summary: string;
    readonly: boolean;
    steps: SubagentStep[];
    startedAt: number;
    completedAt: number;
  }

  interface LiveSubagentLike extends Partial<SubagentTask> {
    id?: string;
    parentCallId?: string;
  }

  const AGENT_NAMES = new Set(['Agent', 'delegate_task']);
  const HEADER = /^\[subagent id=([^\s\]]+) status=([^\s\]]+) steps=(\d+)\]\s*/;

  function objectOf(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  function clean(value: unknown): string {
    return String(value ?? '').trim();
  }

  function finite(value: unknown): number {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function normalizedStatus(value: unknown): string {
    switch (clean(value).toLocaleLowerCase()) {
      case 'running': return 'running';
      case 'completed': return 'completed';
      case 'error':
      case 'failed':
      case 'budget_exhausted':
      case 'provider_unavailable':
      case 'awaiting_user':
      case 'stalled':
      case 'invariant_failed': return 'failed';
      case 'stopped':
      case 'cancelled':
      case 'canceled':
      case 'user_interrupt':
      case 'stop_hook': return 'stopped';
      default: return 'completed';
    }
  }

  function activeSubagentParentCallId(records: ReadonlyArray<Record<string, unknown>>): string {
    let active = '';
    for (const record of records || []) {
      if (clean(record.phase) !== 'tool_call') continue;
      const fields = objectOf(record.fields);
      if (!AGENT_NAMES.has(clean(fields.name || record.name))) continue;
      const callId = clean(fields.id || fields.callId || record.callId || record.id);
      if (callId) active = callId;
    }
    return active;
  }

  function taskFromRecord(record: Record<string, unknown>, fallbackIndex: number): SubagentTask | null {
    const name = clean(record.name || record.tool);
    if (!AGENT_NAMES.has(name)) return null;
    const args = objectOf(record.text ?? record.arguments);
    const result = clean(record.result);
    const header = HEADER.exec(result);
    const parentCallId = clean(record.callId || record.id) || `agent-${fallbackIndex}`;
    const id = header?.[1] || `parent:${parentCallId}`;
    const state = header?.[2] || record.state;
    const description = clean(args.task || args.description || args.context) || '子任务';
    const summary = header ? result.slice(header[0].length).trim() : result;
    return {
      id,
      parentCallId,
      description,
      status: normalizedStatus(state),
      stepCount: header ? Number(header[3]) : finite(record.stepCount),
      currentTool: clean(record.currentTool),
      summary,
      readonly: args.readonly === true,
      steps: Array.isArray(record.steps) ? record.steps as SubagentStep[] : [],
      startedAt: finite(record.startedAt),
      completedAt: finite(record.completedAt),
    };
  }

  function mergeLive(base: SubagentTask | undefined, live: LiveSubagentLike, index: number): SubagentTask {
    const steps = Array.isArray(live.steps) ? live.steps as SubagentStep[] : base?.steps || [];
    const id = clean(live.id) || base?.id || `live-agent-${index}`;
    return {
      id,
      parentCallId: clean(live.parentCallId) || base?.parentCallId || '',
      description: clean(live.description) || base?.description || '子任务',
      status: normalizedStatus(live.status || base?.status || 'running'),
      stepCount: Math.max(finite(live.stepCount), steps.length, base?.stepCount || 0),
      currentTool: clean(live.currentTool) || base?.currentTool || '',
      summary: clean(live.summary) || base?.summary || '',
      readonly: live.readonly === true || base?.readonly === true,
      steps,
      startedAt: finite(live.startedAt) || base?.startedAt || 0,
      completedAt: finite(live.completedAt) || base?.completedAt || 0,
    };
  }

  function projectSubagentTasks(
    turns: ReadonlyArray<Record<string, unknown>>,
    live: ReadonlyArray<LiveSubagentLike> = [],
  ): SubagentTask[] {
    const byId = new Map<string, SubagentTask>();
    const byParent = new Map<string, string>();
    let index = 0;
    for (const turn of turns || []) {
      const records = Array.isArray(turn.trajectory)
        ? turn.trajectory as Record<string, unknown>[]
        : Array.isArray(turn.events) ? turn.events as Record<string, unknown>[] : [];
      for (const record of records) {
        const task = taskFromRecord(record, index++);
        if (!task) continue;
        byId.set(task.id, task);
        if (task.parentCallId) byParent.set(task.parentCallId, task.id);
      }
    }
    live.forEach((entry, liveIndex) => {
      const entryId = clean(entry.id);
      const parentId = clean(entry.parentCallId);
      const existingId = entryId && byId.has(entryId) ? entryId : byParent.get(parentId);
      const merged = mergeLive(existingId ? byId.get(existingId) : undefined, entry, liveIndex);
      if (existingId && existingId !== merged.id) byId.delete(existingId);
      byId.set(merged.id, merged);
      if (merged.parentCallId) byParent.set(merged.parentCallId, merged.id);
    });
    const rank: Record<string, number> = { running: 0, failed: 1, stopped: 2, completed: 3 };
    return [...byId.values()].sort((a, b) => (rank[a.status] ?? 4) - (rank[b.status] ?? 4)
      || (b.startedAt || b.completedAt) - (a.startedAt || a.completedAt)
      || a.id.localeCompare(b.id));
  }

  const StudioSubagents = { activeSubagentParentCallId, projectSubagentTasks };
  if (typeof module !== 'undefined' && module.exports) module.exports = StudioSubagents;
  if (typeof globalThis !== 'undefined') {
    (globalThis as typeof globalThis & { StudioSubagents?: typeof StudioSubagents }).StudioSubagents = StudioSubagents;
  }
})();
