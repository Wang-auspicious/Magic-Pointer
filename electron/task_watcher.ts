'use strict';


function pollDelayMs(elapsedMs: number): number {
  if (elapsedMs < 10_000) return 1000;
  if (elapsedMs < 60_000) return 2000;
  if (elapsedMs < 5 * 60_000) return 4000;
  return 8000;
}

const IDLE_DELAY_MS = 15_000;

const KICK_STAGGER_MS = 200;

const TERMINAL = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'paused_target_mismatch',
]);

function isTerminal(status: unknown): boolean {
  return TERMINAL.has(String(status || ''));
}

interface StatusShape {
  state: 'running' | 'done' | 'failed';
  stage?: string;
  error?: string;
  needsConfirm?: boolean;
}

const STATUS_CARD: Readonly<Record<string, StatusShape>> = Object.freeze({
  queued: { state: 'running', stage: '排队中' },
  running: { state: 'running', stage: '' },
  cancelling: { state: 'running', stage: '正在停下来' },
  succeeded: { state: 'done' },
  failed: { state: 'failed' },
  cancelled: { state: 'failed', error: '这次被取消了。已完成的部分记录在会话里，不会再有新动作。' },
  interrupted: { state: 'failed', error: '执行的进程中断了。已完成的部分保留，未完成的没有生效。' },
  pausing_target_mismatch: { state: 'running', stage: '目标窗口变了，正在停下来' },
  paused_target_mismatch: {
    state: 'running',
    stage: '目标窗口被切走了，停下来等你确认',
    needsConfirm: true,
  },
});

function toDisplaySrc(rawPath: unknown): string {
  const value = String(rawPath || '').trim();
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^data:/i.test(value)) return value;
  const slashed = value.split('\\').join('/');
  return slashed.startsWith('/') ? `file://${slashed}` : `file:///${slashed}`;
}

interface TaskStepInput {
  phase?: unknown;
  label?: unknown;
  note?: unknown;
  ms?: unknown;
  state?: unknown;
}

interface TaskResult {
  steps?: unknown;
  progress?: unknown;
  imagePath?: unknown;
  image?: unknown;
  width?: unknown;
  height?: unknown;
  caption?: unknown;
  artifact?: unknown;
}

interface WatchedTask {
  status?: unknown;
  result?: TaskResult | null;
  error?: unknown;
  summary?: unknown;
}

interface CardStep {
  phase?: unknown;
  label: unknown;
  note?: unknown;
  ms?: unknown;
  state: unknown;
}

interface CardPatch {
  state: StatusShape['state'];
  stage?: string;
  needsConfirm?: boolean;
  steps?: CardStep[];
  progress?: number;
  error?: string;
  kind?: 'image';
  src?: string;
  w?: number;
  h?: number;
  caption?: string;
  answer?: string;
  actions?: Array<{ id: string; label: string }>;
}

function cardPatchFromTask(task: WatchedTask = {}, CardModel?: unknown): CardPatch {
  const status = String(task.status || '');
  const shape = STATUS_CARD[status] || { state: 'running', stage: '' };
  const patch: CardPatch = { state: shape.state };
  if (shape.stage) patch.stage = shape.stage;
  if (shape.needsConfirm) patch.needsConfirm = true;

  const result: TaskResult = task.result && typeof task.result === 'object' ? task.result : {};
  const steps = Array.isArray(result.steps)
    ? (result.steps as Array<string | TaskStepInput>)
        .map((step): CardStep =>
          typeof step === 'string'
            ? { label: step, state: 'done' }
            : {
                phase: step.phase,
                label: step.label || step.phase,
                note: step.note || '',
                ms: step.ms,
                state: step.state || 'done',
              },
        )
        .filter((step) => Boolean(step.label))
    : [];
  if (steps.length) patch.steps = steps;
  if (typeof result.progress === 'number' && Number.isFinite(result.progress)) {
    patch.progress = result.progress;
  }

  if (shape.state === 'failed' && !patch.error) {
    patch.error = String(task.error || shape.error || '这次没能完成。');
  }

  if (shape.state === 'done') {
    const image = String(result.imagePath || result.image || '');
    if (image) {
      patch.kind = 'image';
      patch.src = toDisplaySrc(image);
      if (typeof result.width === 'number' && Number.isFinite(result.width)) {
        patch.w = result.width;
      }
      if (typeof result.height === 'number' && Number.isFinite(result.height)) {
        patch.h = result.height;
      }
      patch.caption = String(task.summary || result.caption || '');
    } else if (task.summary) {
      patch.answer = String(task.summary);
    }
    if (CardModel && result.artifact) {
      patch.actions = [{ id: `open-artifact:${result.artifact}`, label: '打开产物' }];
    }
  }
  return patch;
}

interface PatchEvent {
  taskId: string;
  cardId: string;
  selectionSessionToken: string;
  patch: CardPatch;
}

interface ScheduleHandle {
  unref?(): void;
}

interface WatcherDependencies {
  probe?: (taskId: string) => WatchedTask | null | Promise<WatchedTask | null>;
  onPatch?: (event: PatchEvent) => void;
  log?: (message: string) => void;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => ScheduleHandle;
  cancelSchedule?: (handle: ScheduleHandle) => void;
  CardModel?: unknown;
  probeEnabled?: () => boolean;
  idleDelayMs?: number;
}

interface WatchEntry {
  cardId: string;
  sessionToken: string;
  startedAt: number;
  handle: ScheduleHandle | null;
  lastSignature: string;
}

interface WatchInput {
  taskId?: unknown;
  cardId?: unknown;
  selectionSessionToken?: unknown;
}

interface TaskWatcher {
  watch(input: WatchInput): boolean;
  stop(taskId: string): void;
  stopAll(): void;
  watching(): string[];
  kick(): void;
}

function errorDetails(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function createTaskWatcher({
  probe,
  onPatch = () => {},
  log = () => {},
  now = () => Date.now(),
  schedule = (callback, ms) => setTimeout(callback, ms),
  cancelSchedule = (handle) => clearTimeout(handle as NodeJS.Timeout),
  CardModel = null,
  probeEnabled = () => true,
  idleDelayMs = IDLE_DELAY_MS,
}: WatcherDependencies = {}): TaskWatcher {
  const watching = new Map<string, WatchEntry>();

  function stop(taskId: string): void {
    const entry = watching.get(taskId);
    if (!entry) return;
    if (entry.handle) cancelSchedule(entry.handle);
    watching.delete(taskId);
  }

  function reschedule(taskId: string, delayMs: number): void {
    const entry = watching.get(taskId);
    if (!entry) return;
    entry.handle = schedule(() => {
      void tick(taskId);
    }, delayMs);
    entry.handle?.unref?.();
  }

  async function tick(taskId: string): Promise<void> {
    const entry = watching.get(taskId);
    if (!entry) return;
    entry.handle = null;

    let enabled = true;
    try {
      enabled = probeEnabled() !== false;
    } catch (error) {
      log(`task watch gate failed task=${taskId} ${errorDetails(error)}`);
    }
    if (!enabled) {
      reschedule(taskId, idleDelayMs);
      return;
    }

    let task = null;
    try {
      task = (await probe?.(taskId)) || null;
    } catch (error) {
      log(`task watch probe failed task=${taskId} ${errorDetails(error)}`);
    }

    if (task) {
      const status = String(task.status || '');
      const patch = cardPatchFromTask(task, CardModel);
      const signature = JSON.stringify(patch);
      if (signature !== entry.lastSignature) {
        entry.lastSignature = signature;
        onPatch({
          taskId,
          cardId: entry.cardId,
          selectionSessionToken: entry.sessionToken,
          patch,
        });
      }
      if (isTerminal(status)) {
        log(`task watch done task=${taskId} status=${status}`);
        stop(taskId);
        return;
      }
    }

    reschedule(taskId, pollDelayMs(now() - entry.startedAt));
  }

  return {
    watch({ taskId, cardId, selectionSessionToken }: WatchInput): boolean {
      const id = String(taskId || '');
      if (!id || watching.has(id)) return false;
      watching.set(id, {
        cardId: String(cardId || ''),
        sessionToken: String(selectionSessionToken || ''),
        startedAt: now(),
        handle: null,
        lastSignature: '',
      });
      log(`task watch + ${id} card=${cardId || '—'}`);
      void tick(id);
      return true;
    },
    stop,
    stopAll(): void {
      for (const id of [...watching.keys()]) stop(id);
    },
    watching(): string[] {
      return [...watching.keys()];
    },
    kick(): void {
      let index = 0;
      for (const [taskId, entry] of watching) {
        const delayMs = index * KICK_STAGGER_MS;
        index += 1;
        if (entry.handle) cancelSchedule(entry.handle);
        entry.handle = null;
        if (delayMs === 0) {
          void tick(taskId);
          continue;
        }
        reschedule(taskId, delayMs);
      }
    },
  };
}

export { createTaskWatcher, cardPatchFromTask, toDisplaySrc, pollDelayMs, isTerminal, STATUS_CARD };
