// Pure grouping for the studio inspector's workflow-run blocks: it turns the
// flat Data.subagents list into one block per Workflow.run execution. Step
// subagents carry `wf-<runId prefix>-<stepId>-a<attempt>` ids and a
// `workflow-<runId>` (or tool-call) parentCallId; only that shape is grouped,
// everything else stays a plain background-task row for the caller.

export type WorkflowStepStatus = 'running' | 'succeeded' | 'failed' | 'pending';

export interface WorkflowStepLine {
  stepId: string;
  title: string;
  status: WorkflowStepStatus;
  attempts: number;
  tokens: number;
  subagentId: string;
}

export interface WorkflowRunBlock {
  runId: string;
  steps: WorkflowStepLine[];
  active: boolean;
}

const STEP_TASK_ID = /^wf-([A-Za-z0-9]+)-(.+)$/;
const WORKFLOW_PARENT = /^workflow-(.+)$/;
const ATTEMPT_SUFFIX = /^(.*)-a(\d+)$/;
const STEP_MARKER = /^\[workflow-step ([^\]]+)\][ \t]*(.*)$/;
const NON_TERMINAL = new Set(['running', 'awaiting_user']);

function stepStatusOf(raw: string): WorkflowStepStatus {
  if (raw === 'running') {
    return 'running';
  }
  if (raw === 'completed' || raw === 'succeeded') {
    return 'succeeded';
  }
  if (raw === 'failed' || raw === 'error') {
    return 'failed';
  }
  return 'pending';
}

function tokensOf(task: Record<string, any>): number {
  const usage =
    task.modelUsage && typeof task.modelUsage === 'object'
      ? (task.modelUsage as Record<string, unknown>)
      : {};
  const total = Number(usage.totalTokens);
  if (Number.isFinite(total) && total > 0) {
    return total;
  }
  const fallback =
    Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

function titleOf(task: Record<string, any>, stepId: string): string {
  const firstLine = String(task.description || '').split('\n')[0] || '';
  const marker = STEP_MARKER.exec(firstLine.trim());
  if (marker) {
    return marker[2]!.trim() || stepId;
  }
  return firstLine.trim() || stepId;
}

/** True for workflow step subagent ids (`wf-<run>-<step>-a<attempt>`). */
export function isWorkflowStepTaskId(id: string): boolean {
  if (!STEP_TASK_ID.test(id)) {
    return false;
  }
  return ATTEMPT_SUFFIX.test(STEP_TASK_ID.exec(id)![2]!);
}

interface StepAttemptRow {
  task: Record<string, any>;
  attempt: number;
  startedAt: number;
}

function representativeOf(rows: StepAttemptRow[]): StepAttemptRow {
  // A live retry outranks every settled row; otherwise the newest attempt is
  // the state the timeline should show.
  return [...rows].sort(
    (a, b) =>
      Number(NON_TERMINAL.has(String(b.task.status))) -
        Number(NON_TERMINAL.has(String(a.task.status))) ||
      b.attempt - a.attempt,
  )[0]!;
}

/**
 * Group workflow step subagents into one block per run. Steps keep the state
 * of their representative attempt plus the attempt count; blocks and steps are
 * ordered by earliest attempt start (oldest first) so the timeline reads in
 * plan order across refreshes. Tasks that are not workflow steps are absent
 * from the result and stay the caller's responsibility.
 */
export function groupWorkflowTasks(
  tasks: Array<Record<string, any>>,
): WorkflowRunBlock[] {
  const runs = new Map<
    string,
    {steps: Map<string, StepAttemptRow[]>; startedAt: number}
  >();
  for (const task of tasks || []) {
    const id = String(task?.id || '');
    const match = STEP_TASK_ID.exec(id);
    if (!match) {
      continue;
    }
    const attemptMatch = ATTEMPT_SUFFIX.exec(match[2]!);
    if (!attemptMatch) {
      continue;
    }
    const parent = String(task?.parentCallId || '');
    const parentMatch = WORKFLOW_PARENT.exec(parent);
    const runId = parentMatch ? parentMatch[1]! : match[1]!;
    const stepId = attemptMatch[1]!;
    const startedAt = Number(task?.startedAt) || 0;
    let run = runs.get(runId);
    if (!run) {
      run = {steps: new Map(), startedAt};
      runs.set(runId, run);
    }
    run.startedAt = Math.min(run.startedAt, startedAt);
    const rows = run.steps.get(stepId);
    const row = {task, attempt: Number(attemptMatch[2]) || 0, startedAt};
    if (rows) {
      rows.push(row);
    } else {
      run.steps.set(stepId, [row]);
    }
  }
  const blocks: Array<{block: WorkflowRunBlock; startedAt: number}> = [];
  for (const [runId, run] of runs) {
    const steps: Array<WorkflowStepLine & {startedAt: number}> = [
      ...run.steps.entries(),
    ].map(([stepId, rows]) => {
      const lead = representativeOf(rows);
      return {
        stepId,
        title: titleOf(lead.task, stepId),
        status: stepStatusOf(String(lead.task.status || '')),
        attempts: rows.length,
        tokens: tokensOf(lead.task),
        subagentId: String(lead.task.id || ''),
        startedAt: Math.min(...rows.map(row => row.startedAt)),
      };
    });
    steps.sort(
      (a, b) => a.startedAt - b.startedAt || a.stepId.localeCompare(b.stepId),
    );
    blocks.push({
      block: {
        runId,
        steps: steps.map(({startedAt: _startedAt, ...step}) => step),
        active: steps.some(step => step.status === 'running'),
      },
      startedAt: run.startedAt,
    });
  }
  return blocks
    .sort(
      (a, b) =>
        a.startedAt - b.startedAt || a.block.runId.localeCompare(b.block.runId),
    )
    .map(entry => entry.block);
}
