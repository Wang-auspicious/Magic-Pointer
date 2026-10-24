import {randomUUID} from 'node:crypto';
import {readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {readJson, writeAtomic} from './learning';
import {canonicalJson} from './session';
import {runSubagentInline, stopAgent} from './agent_background';
import {ToolRegistry, type ToolPresentation} from './tools';
import type {AgentOptions, Data, PermissionMode} from './agent';

// Hard ceilings keep one submitted plan inside the same envelope as the
// subagent mechanism it runs on: at most 64 steps, four lanes (matching the
// active-subagent ceiling) and three attempts per step per run.
const MAX_WORKFLOW_STEPS = 64;
const MAX_WORKFLOW_CONCURRENCY = 4;
const DEFAULT_WORKFLOW_CONCURRENCY = 2;
const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_STEP_ATTEMPTS = 3;
const MAX_TITLE_CHARS = 200;
const MAX_STEP_INSTRUCTION_CHARS = 12000;
const MAX_RECEIPT_SUMMARY_CHARS = 600;
// A full plan may legitimately outlive any single subagent; four hours bounds
// the wall clock of one Workflow.run call without cutting off long graphs.
const WORKFLOW_RUN_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface WorkflowStep {
  id: string;
  title: string;
  instructions: string;
  depends_on: string[];
  readonly?: boolean;
  max_attempts?: number;
}

export interface WorkflowPlan {
  title: string;
  steps: WorkflowStep[];
  max_concurrency?: number;
}

export interface ParsedWorkflowPlan {
  title: string;
  steps: WorkflowStep[];
  maxConcurrency: number;
  batches: WorkflowStep[][];
}

export type WorkflowEngineOptions = Pick<
  AgentOptions,
  | 'root'
  | 'userDataDir'
  | 'workspace'
  | 'additionalFolders'
  | 'projectContext'
  | 'session'
  | 'config'
  | 'permissionMode'
  | 'allowedTools'
  | 'deniedTools'
  | 'maxTokens'
  | 'contextTokens'
>;

interface StepAttempt {
  attempt: number;
  childSessionId: string;
  childStatus: string;
  summary: string;
  startedAt: number;
  settledAt: number;
}

interface StepState {
  id: string;
  title: string;
  status: 'pending' | 'succeeded' | 'failed' | 'skipped';
  attempts: StepAttempt[];
}

interface RunJournal {
  schemaVersion: 1;
  runId: string;
  title: string;
  plan: {title: string; steps: WorkflowStep[]};
  status: 'running' | 'succeeded' | 'failed' | 'aborted';
  createdAt: string;
  updatedAt: string;
  steps: Record<string, StepState>;
}

const asRecord = (value: unknown): Data | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Data)
    : null;

function describeCycle(
  byId: Map<string, WorkflowStep>,
  unresolved: Set<string>,
): string {
  const start = [...byId.keys()].find(id => unresolved.has(id))!;
  const seen = new Map<string, number>();
  const path: string[] = [];
  let cursor = start;
  while (!seen.has(cursor)) {
    seen.set(cursor, path.length);
    path.push(cursor);
    cursor = byId
      .get(cursor)!
      .depends_on.find(dep => unresolved.has(dep))!;
  }
  return [...path.slice(seen.get(cursor)!), cursor].join(' -> ');
}

export function parseWorkflowPlan(plan: unknown): ParsedWorkflowPlan {
  const root = asRecord(plan);
  if (!root) {
    throw new Error('workflow_invalid_plan: expected an object');
  }
  const title = String(root.title ?? '').trim();
  if (!title || title.length > MAX_TITLE_CHARS) {
    throw new Error(
      `workflow_invalid_title: 1..${MAX_TITLE_CHARS} characters required`,
    );
  }
  if (!Array.isArray(root.steps)) {
    throw new Error('workflow_invalid_steps: steps must be an array');
  }
  if (!root.steps.length) {
    throw new Error('workflow_empty_plan: at least one step is required');
  }
  if (root.steps.length > MAX_WORKFLOW_STEPS) {
    throw new Error(
      `workflow_too_many_steps: ${root.steps.length} > ${MAX_WORKFLOW_STEPS}`,
    );
  }
  const steps: WorkflowStep[] = [];
  const ids = new Set<string>();
  for (const raw of root.steps) {
    const item = asRecord(raw);
    if (!item) {
      throw new Error('workflow_invalid_step: each step must be an object');
    }
    const id = String(item.id ?? '');
    if (!STEP_ID_PATTERN.test(id)) {
      throw new Error(`workflow_invalid_step_id: ${id || '(missing)'}`);
    }
    if (ids.has(id)) {
      throw new Error(`workflow_duplicate_step: ${id}`);
    }
    ids.add(id);
    const stepTitle = String(item.title ?? '').trim();
    if (!stepTitle || stepTitle.length > MAX_TITLE_CHARS) {
      throw new Error(`workflow_invalid_title: step ${id}`);
    }
    const instructions = String(item.instructions ?? '').trim();
    if (
      !instructions ||
      instructions.length > MAX_STEP_INSTRUCTION_CHARS
    ) {
      throw new Error(`workflow_invalid_instructions: step ${id}`);
    }
    if (!Array.isArray(item.depends_on)) {
      throw new Error(`workflow_invalid_dependencies: step ${id}`);
    }
    const depends_on = [
      ...new Set(item.depends_on.map(dep => String(dep))),
    ].sort();
    const maxAttempts =
      item.max_attempts === undefined
        ? DEFAULT_MAX_ATTEMPTS
        : Number(item.max_attempts);
    if (
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > MAX_STEP_ATTEMPTS
    ) {
      throw new Error(
        `workflow_bad_max_attempts: step ${id} got ${String(
          item.max_attempts,
        )}, allowed 1..${MAX_STEP_ATTEMPTS}`,
      );
    }
    steps.push({
      id,
      title: stepTitle,
      instructions,
      depends_on,
      readonly: item.readonly === true,
      max_attempts: maxAttempts,
    });
  }
  for (const step of steps) {
    for (const dep of step.depends_on) {
      if (!ids.has(dep)) {
        throw new Error(
          `workflow_unknown_dependency: step ${step.id} depends on missing ${dep}`,
        );
      }
    }
  }
  const maxConcurrency =
    root.max_concurrency === undefined
      ? DEFAULT_WORKFLOW_CONCURRENCY
      : Number(root.max_concurrency);
  if (
    !Number.isInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    maxConcurrency > MAX_WORKFLOW_CONCURRENCY
  ) {
    throw new Error(
      `workflow_bad_concurrency: got ${String(
        root.max_concurrency,
      )}, allowed 1..${MAX_WORKFLOW_CONCURRENCY}`,
    );
  }
  return {
    title,
    steps,
    maxConcurrency,
    batches: layerBatches(steps),
  };
}

function layerBatches(steps: WorkflowStep[]): WorkflowStep[][] {
  const byId = new Map(steps.map(step => [step.id, step]));
  const dependents = new Map<string, string[]>(steps.map(step => [step.id, []]));
  const remaining = new Map(
    steps.map(step => [step.id, step.depends_on.length]),
  );
  for (const step of steps) {
    for (const dep of step.depends_on) {
      dependents.get(dep)!.push(step.id);
    }
  }
  const levelOf = new Map<string, number>();
  const queue = steps.filter(step => !step.depends_on.length).map(s => s.id);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor]!;
    const deps = byId.get(id)!.depends_on;
    levelOf.set(
      id,
      deps.length
        ? 1 + Math.max(...deps.map(dep => levelOf.get(dep)!))
        : 0,
    );
    for (const next of dependents.get(id)!) {
      remaining.set(next, remaining.get(next)! - 1);
      if (!remaining.get(next)) {
        queue.push(next);
      }
    }
  }
  if (levelOf.size !== steps.length) {
    const unresolved = new Set(
      steps.map(step => step.id).filter(id => !levelOf.has(id)),
    );
    throw new Error(`workflow_cycle: ${describeCycle(byId, unresolved)}`);
  }
  const depth = Math.max(...levelOf.values());
  const batches: WorkflowStep[][] = Array.from({length: depth + 1}, () => []);
  for (const step of steps) {
    batches[levelOf.get(step.id)!]!.push(step);
  }
  return batches;
}

function describePlanChange(
  saved: WorkflowStep[],
  next: WorkflowStep[],
): string {
  const changes: string[] = [];
  const savedById = new Map(saved.map(step => [step.id, step]));
  for (const step of next) {
    const before = savedById.get(step.id);
    if (!before) {
      changes.push(`+${step.id}`);
    } else if (canonicalJson(before) !== canonicalJson(step)) {
      changes.push(step.id);
    }
  }
  const nextIds = new Set(next.map(step => step.id));
  for (const step of saved) {
    if (!nextIds.has(step.id)) {
      changes.push(`-${step.id}`);
    }
  }
  return changes.join(', ') || 'plan differs from the journal';
}

function receiptOf(attempt: StepAttempt): Data {
  return {
    childStatus: attempt.childStatus,
    summary: attempt.summary,
    childSessionId: attempt.childSessionId,
    elapsedMs: attempt.settledAt - attempt.startedAt,
  };
}

function composeInstruction(
  step: WorkflowStep,
  journal: RunJournal,
): string {
  const parts = [
    `[workflow-step ${step.id}] ${step.title}`,
    step.instructions,
    // Steps report facts to the parent run; the parent agent decides what
    // the user sees. Steps never address the user directly.
    'Report concrete results with paths, numbers and remaining limitations. You are reporting to the coordinating agent, not to the user; do not ask questions and do not announce progress.',
  ];
  const upstream = step.depends_on
    .map(dep => journal.steps[dep])
    .filter(
      state =>
        state && state.status === 'succeeded' && state.attempts.length > 0,
    )
    .map(state => `- [${state!.id}] ${state!.attempts.at(-1)!.summary}`);
  if (upstream.length) {
    parts.push(`Upstream step results:\n${upstream.join('\n')}`);
  }
  const last = journal.steps[step.id]!.attempts.at(-1);
  if (last && last.childStatus !== 'completed') {
    parts.push(
      `Previous attempt ${last.attempt} did not succeed: ${last.summary}\nRetry this step and avoid repeating that failure.`,
    );
  }
  return parts.join('\n\n');
}

async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({length: Math.min(limit, items.length)}, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) {
          return;
        }
        await worker(items[index]!);
      }
    }),
  );
}

const activeRuns = new Set<string>();

/**
 * Rewrite a `/workflow <task>` composer command into an instruction that has
 * the agent author a plan and execute it through the Workflow.run tool.
 * Returns null when the instruction is not a workflow command with a task.
 */
export function expandWorkflowCommand(instruction: string): string | null {
  const match = /^\/workflow[ \t]+([\s\S]+)$/.exec(instruction.trim());
  if (!match) {
    return null;
  }
  return [
    '用户通过 /workflow 命令发起编排任务。先用 Tools 工具加载 Workflow.run，把下面的任务设计成步骤计划：依赖关系明确、每步独立可验证、只读步骤标 readonly，常规任务 2-6 步，不要拆得过细。然后用 Workflow.run 执行该计划，执行中依据步骤回执汇报进展，全部结束后汇总各步结果与遗留缺口。',
    `任务：${match[1]!.trim()}`,
  ].join('\n\n');
}

/** Write the stop marker a running engine polls to abort its run. */
export async function requestWorkflowStop(
  userDataDir: string,
  runId: string,
): Promise<void> {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`workflow_invalid_run_id: ${runId}`);
  }
  const file = path.join(
    userDataDir,
    'workflow-runs',
    runId,
    'stop',
  );
  await writeAtomic(file, 'stop');
}

export class WorkflowEngine {
  private readonly options: WorkflowEngineOptions;

  constructor(options: WorkflowEngineOptions) {
    this.options = options;
  }

  private journalFile(runId: string): string {
    return path.join(
      this.options.userDataDir,
      'workflow-runs',
      runId,
      'run.json',
    );
  }

  private save(file: string, journal: RunJournal): void {
    journal.updatedAt = new Date().toISOString();
    writeAtomic(file, journal);
  }

  async run(
    plan: unknown,
    options: {
      runId?: string;
      signal?: AbortSignal;
      parentCallId?: string;
      onStep?: (snapshot: Data) => void;
    } = {},
  ): Promise<Data> {
    const parsed = parseWorkflowPlan(plan);
    const runId = options.runId ?? randomUUID();
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error(`workflow_invalid_run_id: ${runId}`);
    }
    if (activeRuns.has(runId)) {
      throw new Error(`workflow_run_active: ${runId}`);
    }
    const file = this.journalFile(runId);
    const normalizedPlan = {title: parsed.title, steps: parsed.steps};
    const saved = readJson(file, null) as RunJournal | null;
    let journal: RunJournal;
    let resumed = false;
    if (saved) {
      resumed = true;
      if (canonicalJson(saved.plan) !== canonicalJson(normalizedPlan)) {
        throw new Error(
          `workflow_plan_changed: ${describePlanChange(
            saved.plan.steps,
            parsed.steps,
          )}`,
        );
      }
      journal = saved;
      journal.status = 'running';
      for (const state of Object.values(journal.steps)) {
        if (state.status !== 'succeeded') {
          state.status = 'pending';
        }
      }
    } else {
      const now = new Date().toISOString();
      journal = {
        schemaVersion: 1,
        runId,
        title: parsed.title,
        plan: normalizedPlan,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        steps: Object.fromEntries(
          parsed.steps.map(step => [
            step.id,
            {
              id: step.id,
              title: step.title,
              status: 'pending' as const,
              attempts: [],
            },
          ]),
        ),
      };
    }
    const stopController = new AbortController();
    const signal: AbortSignal | undefined = options.signal
      ? AbortSignal.any([options.signal, stopController.signal])
      : stopController.signal;
    const session = this.options.session;
    const activeChildren = new Map<string, string>();
    const tokens = {value: 0};
    const emitSnapshot = (status: string) => {
      options.onStep?.({
        runId,
        title: parsed.title,
        status,
        tokens: tokens.value,
        steps: parsed.steps.map(step => {
          const state = journal.steps[step.id]!;
          return {
            id: state.id,
            title: state.title,
            status: state.status,
            attempts: state.attempts.length,
          };
        }),
      });
    };
    let stopped = false;
    const stopChildren = () => {
      stopped = true;
      for (const childId of activeChildren.values()) {
        void stopAgent(this.options.userDataDir, session.id, childId).catch(
          () => {},
        );
      }
    };
    signal?.addEventListener('abort', stopChildren, {once: true});
    const replayedSteps: string[] = [];
    activeRuns.add(runId);
    const stopMarker = path.join(
      this.options.userDataDir,
      'workflow-runs',
      runId,
      'stop',
    );
    await rm(stopMarker, {force: true}).catch(() => {});
    const stopWatch = setInterval(() => {
      readFile(stopMarker)
        .then(() => stopController.abort(new Error('workflow_stopped')))
        .catch(() => {});
    }, 500);
    emitSnapshot('running');
    try {
      await session.refresh();
      const mode = session.permissionMode(
        this.options.permissionMode ?? 'default',
      );
      const permissionMode = (mode === 'plan' ? 'plan' : mode) as PermissionMode;
      await session.append('workflow/run_started', {
        runId,
        title: parsed.title,
        stepCount: parsed.steps.length,
        resumed,
        maxConcurrency: parsed.maxConcurrency,
      });
      this.save(file, journal);
      for (const step of parsed.steps) {
        const state = journal.steps[step.id]!;
        if (state.status !== 'succeeded') {
          continue;
        }
        const last = state.attempts.at(-1)!;
        replayedSteps.push(step.id);
        await session.append('workflow/step_settled', {
          runId,
          stepId: step.id,
          attempt: last.attempt,
          status: 'succeeded',
          replayed: true,
          receipt: receiptOf(last),
        });
      }
      for (const batch of parsed.batches) {
        if (stopped || signal?.aborted) {
          break;
        }
        const runnable = batch.filter(
          step => journal.steps[step.id]!.status === 'pending',
        );
        if (runnable.length) {
          await runPool(runnable, parsed.maxConcurrency, async step => {
            if (stopped || signal?.aborted) {
              return;
            }
            await this.executeStep(
              step,
              journal,
              file,
              runId,
              activeChildren,
              signal,
              permissionMode,
              options.parentCallId,
              tokens,
            );
          });
        }
        if (stopped || signal?.aborted) {
          break;
        }
        emitSnapshot('running');
        for (const step of parsed.steps) {
          const state = journal.steps[step.id]!;
          if (state.status !== 'pending') {
            continue;
          }
          if (
            step.depends_on.some(dep =>
              ['failed', 'skipped'].includes(journal.steps[dep]!.status),
            )
          ) {
            state.status = 'skipped';
          }
        }
        this.save(file, journal);
      }
      const aborted = stopped || signal?.aborted === true;
      const failedSteps = parsed.steps
        .filter(step => journal.steps[step.id]!.status === 'failed')
        .map(step => step.id);
      const skippedSteps = parsed.steps
        .filter(step => journal.steps[step.id]!.status === 'skipped')
        .map(step => step.id);
      const status = aborted
        ? 'aborted'
        : failedSteps.length || skippedSteps.length
          ? 'failed'
          : 'succeeded';
      journal.status = status;
      this.save(file, journal);
      await session.refresh();
      await session.append('workflow/run_settled', {
        runId,
        status,
        succeeded: parsed.steps.filter(
          step => journal.steps[step.id]!.status === 'succeeded',
        ).length,
        failed: failedSteps.length,
        skipped: skippedSteps.length,
        replayed: replayedSteps.length,
      });
      emitSnapshot(status);
      if (aborted) {
        throw signal?.reason ?? new Error('workflow_aborted');
      }
      const steps = parsed.steps.map(step => {
        const state = journal.steps[step.id]!;
        return {
          id: state.id,
          title: state.title,
          status: state.status,
          attempts: state.attempts.length,
          depends_on: step.depends_on,
          readonly: step.readonly === true,
          ...(replayedSteps.includes(step.id) ? {replayed: true} : {}),
          ...(state.attempts.length
            ? {summary: state.attempts.at(-1)!.summary}
            : {}),
        };
      });
      return {
        ok: status === 'succeeded',
        runId,
        title: parsed.title,
        status,
        resumed,
        replayedSteps,
        tokens: tokens.value,
        steps,
        failedSteps,
        skippedSteps,
        presentation: {
          kind: 'workflow_run',
          runId,
          title: parsed.title,
          status,
          tokens: tokens.value,
          steps,
        },
      };
    } finally {
      clearInterval(stopWatch);
      signal?.removeEventListener('abort', stopChildren);
      activeRuns.delete(runId);
    }
  }

  private async executeStep(
    step: WorkflowStep,
    journal: RunJournal,
    file: string,
    runId: string,
    activeChildren: Map<string, string>,
    signal: AbortSignal | undefined,
    permissionMode: PermissionMode,
    parentCallId: string | undefined,
    tokens: {value: number},
  ): Promise<void> {
    const state = journal.steps[step.id]!;
    const session = this.options.session;
    const baseAttempts = state.attempts.length;
    const maxAttempts = step.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
    for (let local = 1; local <= maxAttempts; local++) {
      if (signal?.aborted) {
        break;
      }
      const attempt = baseAttempts + local;
      const childSessionId = `wf-${runId.slice(0, 8)}-${step.id}-a${attempt}`;
      const instruction = composeInstruction(step, journal);
      const readonly = step.readonly === true;
      activeChildren.set(step.id, childSessionId);
      const startedAt = Date.now();
      await session.append('workflow/step_started', {
        runId,
        stepId: step.id,
        attempt,
        childSessionId,
        readonly,
      });
      let childStatus = 'failed';
      let summary = '';
      try {
        const status = await runSubagentInline({
          root: this.options.root,
          userDataDir: this.options.userDataDir,
          workspace: this.options.workspace || '',
          additionalFolders: this.options.additionalFolders,
          projectContext: this.options.projectContext,
          sessionId: childSessionId,
          parentId: session.id,
          instruction,
          readonly,
          permissionMode,
          parentCallId: parentCallId || `workflow-${runId}`,
          config: this.options.config,
          allowedTools: this.options.allowedTools
            ? [...this.options.allowedTools]
            : undefined,
          deniedTools: this.options.deniedTools,
          maxTokens: this.options.maxTokens,
          contextTokens: this.options.contextTokens,
        });
        childStatus = String(status.status ?? 'failed');
        tokens.value +=
          Number(
            (status.modelUsage as Record<string, unknown> | undefined)
              ?.totalTokens,
          ) || 0;
        summary = String(status.summary ?? '').slice(
          0,
          MAX_RECEIPT_SUMMARY_CHARS,
        );
      } catch (error) {
        summary = String((error as Error).message ?? error).slice(
          0,
          MAX_RECEIPT_SUMMARY_CHARS,
        );
      } finally {
        activeChildren.delete(step.id);
      }
      const record: StepAttempt = {
        attempt,
        childSessionId,
        childStatus,
        summary,
        startedAt,
        settledAt: Date.now(),
      };
      state.attempts.push(record);
      const succeeded = childStatus === 'completed';
      state.status = succeeded
        ? 'succeeded'
        : signal?.aborted
          ? 'pending'
          : 'failed';
      this.save(file, journal);
      await session.append('workflow/step_settled', {
        runId,
        stepId: step.id,
        attempt,
        status: succeeded ? 'succeeded' : 'failed',
        receipt: receiptOf(record),
      });
      if (succeeded) {
        return;
      }
    }
  }
}

export const WORKFLOW_RUN_TOOL = 'Workflow.run';

export function registerWorkflowRunTool(
  registry: ToolRegistry,
  options: WorkflowEngineOptions,
): void {
  const engine = new WorkflowEngine(options);
  registry.register({
    name: WORKFLOW_RUN_TOOL,
    description:
      'Submit a WorkflowPlan once instead of orchestrating turns by hand. ' +
      'The engine validates the dependency graph, schedules steps layer by ' +
      'layer with bounded concurrency, runs every step as an independent ' +
      'subagent (readonly steps stay read-only), retries failed steps with ' +
      'the previous failure summary, journals each attempt as workflow ' +
      'events plus a durable run file, replays succeeded steps when ' +
      're-submitted with the same run_id, and resumes unfinished steps ' +
      'after an interruption.',
    input_schema: {
      type: 'object',
      properties: {
        title: {type: 'string', minLength: 1, maxLength: MAX_TITLE_CHARS},
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_WORKFLOW_STEPS,
          items: {
            type: 'object',
            properties: {
              id: {type: 'string', pattern: STEP_ID_PATTERN.source},
              title: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_TITLE_CHARS,
              },
              instructions: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_STEP_INSTRUCTION_CHARS,
              },
              depends_on: {
                type: 'array',
                items: {type: 'string'},
                maxItems: MAX_WORKFLOW_STEPS - 1,
              },
              readonly: {type: 'boolean'},
              max_attempts: {
                type: 'integer',
                minimum: 1,
                maximum: MAX_STEP_ATTEMPTS,
              },
            },
            required: ['id', 'title', 'instructions', 'depends_on'],
          },
        },
        max_concurrency: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_WORKFLOW_CONCURRENCY,
        },
        run_id: {type: 'string', pattern: RUN_ID_PATTERN.source},
      },
      required: ['title', 'steps'],
    },
    effect: 'reversible_write',
    effect_for: args => {
      const steps = Array.isArray(args.steps) ? args.steps : [];
      return steps.every(step => asRecord(step)?.readonly === true)
        ? 'read'
        : 'reversible_write';
    },
    deferred: true,
    timeout_ms: WORKFLOW_RUN_TIMEOUT_MS,
    used_backend: 'workflow_engine',
    execute: async (args, context) => {
      const result = await engine.run(args, {
        runId: args.run_id === undefined ? undefined : String(args.run_id),
        signal: context.signal,
        parentCallId: context.tool_call_id,
        onStep: snapshot =>
          context.on_progress?.(JSON.stringify(snapshot)),
      });
      const presentation = result.presentation as ToolPresentation | undefined;
      const value = {...result} as Partial<typeof result>;
      delete value.presentation;
      if (presentation) {
        context.present?.(presentation);
      }
      return value as typeof result;
    },
  });
}
