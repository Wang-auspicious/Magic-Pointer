/** Pure model for the Workflow.run chat tool-row card. No DOM in this module. */

export type WorkflowStepStatus =
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'pending'
  | 'running';

export type WorkflowRunStatus = 'running' | 'succeeded' | 'failed' | 'aborted';

export interface WorkflowSnapshotStep {
  id: string;
  title: string;
  status: WorkflowStepStatus;
  attempts: number;
}

/** One engine state transition, accumulated at the tail of a row's progressText. */
export interface WorkflowSnapshot {
  runId: string;
  title: string;
  status: string;
  tokens: number;
  steps: readonly WorkflowSnapshotStep[];
}

export interface WorkflowCardStep {
  id: string;
  title: string;
  status: WorkflowStepStatus;
  attempts: number;
  depends_on: string[];
  readonly: boolean;
  summary?: string;
}

export interface WorkflowStation {
  stepId: string;
  title: string;
  index: number;
  status: WorkflowStepStatus;
}

export interface WorkflowArc {
  fromIndex: number;
  toIndex: number;
}

export interface WorkflowCardModel {
  runId: string;
  title: string;
  status: WorkflowRunStatus;
  tokens: number;
  doneCount: number;
  total: number;
  steps: readonly WorkflowCardStep[];
  stations: readonly WorkflowStation[];
  arcs: readonly WorkflowArc[];
}

const STEP_STATUSES: readonly string[] = [
  'succeeded',
  'failed',
  'skipped',
  'pending',
  'running',
];

const TERMINAL_RUN_STATUSES: readonly string[] = [
  'succeeded',
  'failed',
  'aborted',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stepStatus(value: unknown): WorkflowStepStatus {
  return typeof value === 'string' && STEP_STATUSES.includes(value)
    ? (value as WorkflowStepStatus)
    : 'pending';
}

function runStatus(value: unknown): WorkflowRunStatus {
  if (value === 'running') {
    return 'running';
  }
  return typeof value === 'string' &&
    TERMINAL_RUN_STATUSES.includes(value)
    ? (value as WorkflowRunStatus)
    : 'failed';
}

function attemptCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : null;
}

function snapshotFromRecord(record: Record<string, unknown>): WorkflowSnapshot | null {
  const runId = textOrNull(record.runId);
  if (runId === null || !Array.isArray(record.steps)) {
    return null;
  }
  const steps: WorkflowSnapshotStep[] = [];
  for (const raw of record.steps) {
    if (!isRecord(raw)) {
      continue;
    }
    const id = textOrNull(raw.id);
    if (id === null) {
      continue;
    }
    const title = textOrNull(raw.title) ?? id;
    steps.push({
      id,
      title,
      status: stepStatus(raw.status),
      attempts: attemptCount(raw.attempts),
    });
  }
  return {
    runId,
    title: textOrNull(record.title) ?? runId,
    status: typeof record.status === 'string' ? record.status : '',
    tokens: tokenCount(record.tokens),
    steps,
  };
}

/**
 * The index of the `{` matching the `}` at `close`, or -1. Walking backward
 * only: snapshots are concatenated without separators and the 4000-char
 * progress window can cut the head mid-string, so forward scanning cannot know
 * the string parity at the start of the text. String literals and escapes are
 * still honored so braces inside step titles do not end an object early.
 */
function matchingOpenBrace(text: string, close: number): number {
  let depth = 0;
  let inString = false;
  for (let i = close; i >= 0; i--) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '"') {
        let slashes = 0;
        for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) {
          slashes++;
        }
        if (slashes % 2 === 0) {
          inString = false;
        }
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '}') {
      depth++;
    } else if (ch === '{') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function snapshotFromText(candidate: string): WorkflowSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  return isRecord(parsed) ? snapshotFromRecord(parsed) : null;
}

/** The last complete run snapshot in a row's accumulated progress text, if any. */
export function parseWorkflowSnapshot(
  progressText: string,
): WorkflowSnapshot | null {
  if (typeof progressText !== 'string' || !progressText) {
    return null;
  }
  let end = progressText.length;
  while (end > 0) {
    const close = progressText.lastIndexOf('}', end - 1);
    if (close === -1) {
      break;
    }
    const start = matchingOpenBrace(progressText, close);
    if (start === -1) {
      end = close;
      continue;
    }
    const snapshot = snapshotFromText(progressText.slice(start, close + 1));
    if (snapshot !== null) {
      return snapshot;
    }
    end = start;
  }
  return null;
}

interface PresentationStep extends WorkflowCardStep {}

function presentationSteps(value: unknown): PresentationStep[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const steps: PresentationStep[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) {
      return null;
    }
    const id = textOrNull(raw.id);
    const title = textOrNull(raw.title);
    if (id === null || title === null) {
      return null;
    }
    const summary = textOrNull(raw.summary);
    steps.push({
      id,
      title,
      status: stepStatus(raw.status),
      attempts: attemptCount(raw.attempts),
      depends_on: Array.isArray(raw.depends_on)
        ? raw.depends_on.filter((dep): dep is string => typeof dep === 'string')
        : [],
      readonly: raw.readonly === true,
      ...(summary !== null ? {summary} : {}),
    });
  }
  return steps;
}

/**
 * Kahn layering by longest dependency depth: a step sits one layer below its
 * deepest dependency, and same-layer steps keep declaration order. A cycle
 * (which validated plans never contain) parks its leftovers on one extra layer
 * in declaration order rather than looping forever.
 */
function stationOrder(steps: readonly WorkflowCardStep[]): number[] {
  const layerOf = new Array<number>(steps.length).fill(-1);
  const indexOf = new Map<string, number>();
  for (const [index, step] of steps.entries()) {
    if (!indexOf.has(step.id)) {
      indexOf.set(step.id, index);
    }
  }
  let assigned = 0;
  let progressed = true;
  while (progressed && assigned < steps.length) {
    progressed = false;
    for (let i = 0; i < steps.length; i++) {
      if (layerOf[i]! !== -1) {
        continue;
      }
      let depth = 0;
      let ready = true;
      for (const dep of steps[i]!.depends_on) {
        const j = indexOf.get(dep);
        // A dependency the plan does not declare is nothing to wait for.
        if (j === undefined) {
          continue;
        }
        if (layerOf[j]! === -1) {
          ready = false;
          break;
        }
        depth = Math.max(depth, layerOf[j]! + 1);
      }
      if (ready) {
        layerOf[i] = depth;
        assigned++;
        progressed = true;
      }
    }
  }
  if (assigned < steps.length) {
    const extra = Math.max(0, ...layerOf) + 1;
    for (let i = 0; i < steps.length; i++) {
      if (layerOf[i]! === -1) {
        layerOf[i] = extra;
      }
    }
  }
  return layerOf
    .map((layer, index) => ({layer, index}))
    .sort((a, b) => a.layer - b.layer || a.index - b.index)
    .map(entry => entry.index);
}

export function buildWorkflowCardModel(
  presentation: unknown,
  snapshot: WorkflowSnapshot | null,
): WorkflowCardModel | null {
  let record: Record<string, unknown> | null = null;
  if (typeof presentation === 'string') {
    try {
      const parsed: unknown = JSON.parse(presentation);
      record = isRecord(parsed) ? parsed : null;
    } catch {
      record = null;
    }
  } else {
    record = isRecord(presentation) ? presentation : null;
  }

  let runId = '';
  let title = '';
  let statusSource = '';
  let tokens = 0;
  let steps: WorkflowCardStep[] | null = null;
  if (record !== null && record.kind === 'workflow_run') {
    runId = textOrNull(record.runId) ?? '';
    title = textOrNull(record.title) ?? runId;
    statusSource = typeof record.status === 'string' ? record.status : '';
    tokens = tokenCount(record.tokens);
    steps = presentationSteps(record.steps);
    if (runId === '' || steps === null) {
      return null;
    }
  } else if (record !== null) {
    return null;
  }

  // A row mid-flight has no presentation yet; the latest snapshot carries the
  // card until the result lands.
  if (steps === null) {
    if (snapshot === null) {
      return null;
    }
    runId = snapshot.runId;
    title = snapshot.title || snapshot.runId;
    statusSource = snapshot.status;
    tokens = snapshot.tokens;
    steps = snapshot.steps.map(step => ({
      id: step.id,
      title: step.title,
      status: step.status,
      attempts: step.attempts,
      depends_on: [],
      readonly: false,
    }));
  } else if (snapshot !== null) {
    const live = new Map(snapshot.steps.map(step => [step.id, step]));
    for (const step of steps) {
      const override = live.get(step.id);
      if (override === undefined) {
        continue;
      }
      step.status = override.status;
      step.attempts = override.attempts;
    }
    tokens = snapshot.tokens;
  }

  const order = stationOrder(steps);
  const positionOf = new Map<string, number>();
  const stations: WorkflowStation[] = order.map((stepIndex, position) => {
    const step = steps![stepIndex]!;
    positionOf.set(step.id, position);
    return {
      stepId: step.id,
      title: step.title,
      index: position,
      status: step.status,
    };
  });

  // Adjacent dependencies are already drawn as the track between neighbours.
  const arcs: WorkflowArc[] = [];
  for (const step of steps) {
    const to = positionOf.get(step.id);
    if (to === undefined) {
      continue;
    }
    for (const dep of step.depends_on) {
      const from = positionOf.get(dep);
      if (from === undefined || from === to || to - from === 1) {
        continue;
      }
      arcs.push({fromIndex: from, toIndex: to});
    }
  }

  const running = snapshot !== null && snapshot.status === 'running';
  return {
    runId,
    title,
    status: running ? 'running' : runStatus(statusSource),
    tokens,
    doneCount: steps.filter(
      step => step.status !== 'pending' && step.status !== 'running',
    ).length,
    total: steps.length,
    steps,
    stations,
    arcs,
  };
}

export interface WorkflowArcLayout extends WorkflowArc {
  /** 1-based lane above the track; overlapping arcs never share a lane. */
  level: number;
}

/**
 * Lane assignment for the elbow arcs: two arcs whose horizontal spans overlap
 * (nested or sharing an origin) are stacked one lane apart.
 */
export function layoutWorkflowArcs(
  arcs: readonly WorkflowArc[],
): WorkflowArcLayout[] {
  const lanes: Array<Array<[number, number]>> = [];
  const result: WorkflowArcLayout[] = [];
  for (const arc of arcs) {
    const start = Math.min(arc.fromIndex, arc.toIndex);
    const end = Math.max(arc.fromIndex, arc.toIndex);
    let level = lanes.findIndex(
      spans => spans.every(([s, e]) => end < s || start > e),
    );
    if (level === -1) {
      lanes.push([]);
      level = lanes.length - 1;
    }
    lanes[level]!.push([start, end]);
    result.push({...arc, level: level + 1});
  }
  return result;
}
