'use strict';

// ============================================================================
// 后台任务观察器
// ----------------------------------------------------------------------------
// 「进度条一直到 100% 以后就返图」这类活要几十秒到几分钟。底层早就齐了——
// 任务落盘、状态可查、进程存活可验（app/fabric/task_store.py）——缺的整个一环
// 是 Electron 这边没有任何人在看它。任务起来之后那张卡就静止在那儿，
// 直到用户重新打开界面才知道结果。
//
// 这一份就是那个看的人。三条判断：
//
// 1. **进度是推出来的，不是编出来的。** 任务自己报到哪一步就是哪一步；
//    只知道「在跑」的时候，卡上是不定量条 + 真实秒数，不是一条假的百分比。
// 2. **退避轮询。** 刚起来的任务变化快，跑了十分钟的任务变化慢。固定 1 秒
//    轮询一个跑二十分钟的任务是白烧 1200 次进程启动。
// 3. **结束就停。** 终态之后不再轮询——也不再接受补丁，那条规矩在 cards.js。
// ============================================================================

// 退避梯度：头 10 秒每秒看一次（这时候最可能出错），之后逐步放慢。
// 上限 8 秒——再慢用户就会觉得界面卡住了。
function pollDelayMs(elapsedMs: number): number {
  if (elapsedMs < 10_000) return 1000;
  if (elapsedMs < 60_000) return 2000;
  if (elapsedMs < 5 * 60_000) return 4000;
  return 8000;
}

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

// 任务状态 → 卡片补丁。
//
// 这里是唯一把「后台任务说了什么」翻成「卡上显示什么」的地方。翻译要诚实：
// paused_target_mismatch 是「停下来等你确认」，不是失败，也不是还在跑——
// 把它归到任何一头都会让用户误判。
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

// 本地路径 → 渲染层能加载的来源。
//
// 注意不能用 /^[a-z]+:/ 判断「已经是 URL 了」：`C:\Users\…` 的盘符正好长得
// 像一个 scheme，于是 Windows 上每一张出好的图都会原样交给 <img> 而加载不出来。
// 真正的 scheme 后面跟着 `//`（或者是 data:）。
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

  // 任务自己报的阶段。有就用，没有就让卡片显示不定量条——不编一个数字。
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
    // 产物落在哪里由任务说。图就显示图，别的就显示一句话加一个打开按钮。
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

// ---------------------------------------------------------------------------
// 观察器本体。probe 由主进程给（跑 agent_bridge.py status），
// 这里不碰子进程，所以它可测。
// ---------------------------------------------------------------------------
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
}: WatcherDependencies = {}): TaskWatcher {
  const watching = new Map<string, WatchEntry>();

  function stop(taskId: string): void {
    const entry = watching.get(taskId);
    if (!entry) return;
    if (entry.handle) cancelSchedule(entry.handle);
    watching.delete(taskId);
  }

  async function tick(taskId: string): Promise<void> {
    const entry = watching.get(taskId);
    if (!entry) return;
    entry.handle = null;

    let task = null;
    try {
      task = (await probe?.(taskId)) || null;
    } catch (error) {
      // 一次查询失败不算任务失败——可能只是解释器启动慢了。接着看。
      log(`task watch probe failed task=${taskId} ${errorDetails(error)}`);
    }

    if (task) {
      const status = String(task.status || '');
      const patch = cardPatchFromTask(task, CardModel);
      // 状态没变、也没有新步骤时不重复推——每一次推都会让界面重画。
      const signature = `${status}|${(patch.steps || []).length}|${patch.progress ?? ''}`;
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

    const elapsed = now() - entry.startedAt;
    entry.handle = schedule(() => {
      void tick(taskId);
    }, pollDelayMs(elapsed));
    entry.handle?.unref?.();
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
      // 立刻看一次：任务可能已经在我们开始看之前就跑完了
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
  };
}

export { createTaskWatcher, cardPatchFromTask, toDisplaySrc, pollDelayMs, isTerminal, STATUS_CARD };
