'use strict';

const fs = require('node:fs');
const path = require('node:path');

type TimerHandle = ReturnType<typeof setTimeout> | number;

type FileObservationEntry = {
  exists: boolean;
  kind?: 'file' | 'directory' | 'other';
  size?: number;
  mtimeMs?: number;
};

type FileObservation = {
  observedAtMs: number;
  entries: Record<string, FileObservationEntry>;
};

type FilesystemTrigger = {
  kind: 'filesystem';
  paths: string[];
  debounceMs: number;
};

type ScheduleTrigger = {
  kind: 'schedule';
  startAtMs: number;
  everyMs: number;
};

type ContextTracker = {
  trackerId: string;
  task: string;
  sourceIds: string[];
  folderRoot: string;
  trigger: FilesystemTrigger | ScheduleTrigger;
  outputType: 'draft' | 'report';
  enabled: boolean;
  lastObserved: FileObservation | null;
  lastRun: {
    startedAtMs: number;
    finishedAtMs: number;
    ok: boolean;
    triggerKind: 'filesystem' | 'schedule';
    dueThroughMs?: number;
    conversationId?: string;
    error?: string;
  } | null;
  authorizationRevision: number;
};

type TrackerTaskRequest = {
  trackerId: string;
  task: string;
  sourceIds: string[];
  folderRoot: string;
  outputType: 'draft' | 'report';
  permissionPreset: 'read-only';
  authorizationRevision: number;
  conversationId?: string;
  change: Record<string, unknown>;
};

type WatchHandle = { close: () => void };

function cleanText(value: unknown, maximum: number): string {
  return String(value == null ? '' : value).trim().slice(0, maximum);
}

function cleanPath(value: unknown): string {
  const text = cleanText(value, 4096).replace(/\\/g, '/');
  if (!text) return '';
  if (/^[A-Za-z]:\/$/.test(text) || text === '/') return text;
  return text.replace(/\/+$/, '');
}

function uniqueStrings(values: unknown, maximum: number, normalizer = (value: unknown) => cleanText(value, 4096)) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(normalizer).filter(Boolean))].slice(0, maximum);
}

function normalizedObservation(value: unknown): FileObservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const rawEntries = raw.entries;
  if (!rawEntries || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) return null;
  const entries: Record<string, FileObservationEntry> = {};
  for (const [rawPath, rawEntry] of Object.entries(rawEntries)) {
    const observedPath = cleanPath(rawPath);
    if (!observedPath || !rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
    const item = rawEntry as Record<string, unknown>;
    const exists = item.exists === true;
    const kind = ['file', 'directory', 'other'].includes(String(item.kind || ''))
      ? String(item.kind) as FileObservationEntry['kind']
      : undefined;
    const size = Number(item.size);
    const mtimeMs = Number(item.mtimeMs);
    entries[observedPath] = {
      exists,
      ...(kind ? { kind } : {}),
      ...(Number.isFinite(size) ? { size } : {}),
      ...(Number.isFinite(mtimeMs) ? { mtimeMs } : {}),
    };
  }
  return {
    observedAtMs: Math.max(0, Number(raw.observedAtMs) || 0),
    entries,
  };
}

function normalizeContextTracker(value: unknown): ContextTracker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('context tracker must be an object');
  }
  const raw = value as Record<string, any>;
  const trackerId = cleanText(raw.trackerId, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(trackerId)) {
    throw new Error('context tracker trackerId is invalid');
  }
  const task = cleanText(raw.task, 4000);
  if (!task) throw new Error('context tracker task is required');
  const sourceIds = uniqueStrings(raw.sourceIds, 64, (item) => cleanText(item, 1024));
  const folderRoot = cleanPath(raw.folderRoot);
  if (!sourceIds.length && !folderRoot) {
    throw new Error('context tracker requires sourceIds or folderRoot');
  }
  const outputType = cleanText(raw.outputType, 20).toLowerCase();
  if (!['draft', 'report'].includes(outputType)) {
    throw new Error('context tracker outputType must be draft or report');
  }
  const inputTrigger = raw.trigger;
  if (!inputTrigger || typeof inputTrigger !== 'object' || Array.isArray(inputTrigger)) {
    throw new Error('context tracker trigger is required');
  }
  let trigger: FilesystemTrigger | ScheduleTrigger;
  if (inputTrigger.kind === 'filesystem') {
    const paths = uniqueStrings(inputTrigger.paths, 32, cleanPath);
    if (!paths.length) throw new Error('filesystem tracker requires a selected path');
    const debounceMs = Math.max(50, Math.min(5000, Number(inputTrigger.debounceMs) || 500));
    trigger = { kind: 'filesystem', paths, debounceMs };
  } else if (inputTrigger.kind === 'schedule') {
    const startAtMs = Number(inputTrigger.startAtMs);
    const everyMs = Number(inputTrigger.everyMs);
    if (!Number.isFinite(startAtMs) || startAtMs < 0) {
      throw new Error('schedule tracker startAtMs is invalid');
    }
    if (!Number.isFinite(everyMs) || everyMs <= 0) {
      throw new Error('schedule tracker everyMs is invalid');
    }
    trigger = { kind: 'schedule', startAtMs, everyMs };
  } else {
    throw new Error('context tracker trigger kind is unsupported');
  }
  const rawLastRun = raw.lastRun && typeof raw.lastRun === 'object' && !Array.isArray(raw.lastRun)
    ? raw.lastRun as Record<string, unknown>
    : null;
  const lastRun = rawLastRun ? {
    startedAtMs: Math.max(0, Number(rawLastRun.startedAtMs) || 0),
    finishedAtMs: Math.max(0, Number(rawLastRun.finishedAtMs) || 0),
    ok: rawLastRun.ok === true,
    triggerKind: rawLastRun.triggerKind === 'schedule' ? 'schedule' as const : 'filesystem' as const,
    ...(Number.isFinite(Number(rawLastRun.dueThroughMs))
      ? { dueThroughMs: Math.max(0, Number(rawLastRun.dueThroughMs)) }
      : {}),
    ...(cleanText(rawLastRun.conversationId, 160)
      ? { conversationId: cleanText(rawLastRun.conversationId, 160) }
      : {}),
    ...(cleanText(rawLastRun.error, 1000) ? { error: cleanText(rawLastRun.error, 1000) } : {}),
  } : null;
  return {
    trackerId,
    task,
    sourceIds,
    folderRoot,
    trigger,
    outputType: outputType as 'draft' | 'report',
    enabled: raw.enabled !== false,
    lastObserved: normalizedObservation(raw.lastObserved),
    lastRun,
    authorizationRevision: Math.max(1, Math.floor(Number(raw.authorizationRevision) || 1)),
  };
}

function observationsEqual(left: FileObservation | null, right: FileObservation | null): boolean {
  if (!left || !right) return left === right;
  return JSON.stringify(left.entries) === JSON.stringify(right.entries);
}

function createMaterialTracker({ source, task, cadence, nowMs = Date.now(), trackerId, isDirectory = false }: {
  source: { identity: Record<string, unknown> };
  task: string;
  cadence: 'filesystem' | 'daily';
  nowMs?: number;
  trackerId: string;
  isDirectory?: boolean;
}): ContextTracker {
  const materialPath = cleanPath(source.identity.absolutePath);
  if (!materialPath || !path.isAbsolute(materialPath)) throw new Error('请选择本机文件或文件夹。');
  if (!['filesystem', 'daily'].includes(cadence)) throw new Error('请选择材料变化或每天关注。');
  return normalizeContextTracker({
    trackerId, task,
    sourceIds: isDirectory ? [] : [`source:attachment:${materialPath}`],
    folderRoot: isDirectory ? materialPath : '',
    trigger: cadence === 'filesystem'
      ? { kind: 'filesystem', paths: [materialPath], debounceMs: 500 }
      : { kind: 'schedule', startAtMs: nowMs + 86_400_000, everyMs: 86_400_000 },
    outputType: 'draft', enabled: true,
  });
}

async function readFileObservation(paths: string[], now = Date.now): Promise<FileObservation> {
  const entries: Record<string, FileObservationEntry> = {};
  for (const watchedPath of paths) {
    try {
      const info = await fs.promises.stat(watchedPath);
      entries[watchedPath] = {
        exists: true,
        kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
      if (info.isDirectory()) {
        const children = (await fs.promises.readdir(watchedPath, { withFileTypes: true }))
          .slice(0, 4096);
        for (const child of children) {
          const childPath = cleanPath(path.join(watchedPath, child.name));
          try {
            const childInfo = await fs.promises.stat(childPath);
            entries[childPath] = {
              exists: true,
              kind: childInfo.isFile() ? 'file' : childInfo.isDirectory() ? 'directory' : 'other',
              size: childInfo.size,
              mtimeMs: childInfo.mtimeMs,
            };
          } catch (_) {
            entries[childPath] = { exists: false };
          }
        }
      }
    } catch (_) {
      entries[watchedPath] = { exists: false };
    }
  }
  return { observedAtMs: now(), entries };
}

function watchFilePath(watchedPath: string, onEvent: (event: { eventType: string; filename?: string }) => void): WatchHandle {
  const watcher = fs.watch(watchedPath, { persistent: false }, (eventType: string, filename: string | Buffer | null) => {
    onEvent({ eventType, ...(filename ? { filename: String(filename) } : {}) });
  });
  return { close: () => watcher.close() };
}

function configIdentity(tracker: ContextTracker): string {
  return JSON.stringify({
    task: tracker.task,
    sourceIds: tracker.sourceIds,
    folderRoot: tracker.folderRoot,
    trigger: tracker.trigger,
    outputType: tracker.outputType,
  });
}

function changedObservationEntries(change: Record<string, any>) {
  if (change.kind !== 'filesystem') return [];
  const before = change.previous?.entries && typeof change.previous.entries === 'object'
    ? change.previous.entries as Record<string, unknown>
    : {};
  const after = change.current?.entries && typeof change.current.entries === 'object'
    ? change.current.entries as Record<string, unknown>
    : {};
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((item) => JSON.stringify(before[item] ?? null) !== JSON.stringify(after[item] ?? null))
    .slice(0, 100)
    .map((item) => ({ path: item, before: before[item] ?? null, after: after[item] ?? null }));
}

function buildContextTrackerConversationRequest(request: TrackerTaskRequest, capturedAtMs = Date.now()) {
  const trackerId = cleanText(request?.trackerId, 160);
  const task = cleanText(request?.task, 4000);
  const sourceIds = uniqueStrings(request?.sourceIds, 64, (item) => cleanText(item, 1024));
  const folderRoot = cleanPath(request?.folderRoot);
  const outputType = request?.outputType === 'report' ? 'report' : 'draft';
  const outputLabel = outputType === 'report' ? '报告' : '草稿';
  const change = request?.change && typeof request.change === 'object' ? request.change : {};
  const changeSummary = change.kind === 'filesystem'
    ? {
        kind: 'filesystem',
        eventCount: Number(change.eventCount) || 0,
        eventFromMs: Number(change.eventFromMs) || 0,
        eventToMs: Number(change.eventToMs) || 0,
        changedEntries: changedObservationEntries(change),
      }
    : {
        kind: 'schedule',
        missedCount: Math.max(1, Number(change.missedCount) || 1),
        missedFromMs: Number(change.missedFromMs) || 0,
        missedToMs: Number(change.missedToMs) || 0,
        observedAtMs: Number(change.observedAtMs) || capturedAtMs,
      };
  const scope = { sourceIds, folderRoot: folderRoot || null };
  const question = [
    '这是用户明确创建的材料关注任务。',
    `原始任务：${task}`,
    `输出要求：只生成可预览的${outputLabel}；不要发送消息、提交内容、删除材料或执行其他外部动作。`,
    `授权材料范围：${JSON.stringify(scope)}`,
    `本次变化：${JSON.stringify(changeSummary)}`,
    '请基于授权材料核对真实变化；证据不足时明确指出缺口。',
  ].join('\n').slice(0, 4000);
  const attachments = sourceIds
    .filter((sourceId) => sourceId.startsWith('source:attachment:'))
    .map((sourceId) => cleanPath(sourceId.slice('source:attachment:'.length)))
    .filter(Boolean);
  return {
    ...(cleanText(request?.conversationId, 160)
      ? { conversationId: cleanText(request.conversationId, 160) }
      : {}),
    question,
    attachments,
    taskInput: {
      inputId: `input:tracker:${trackerId}:${capturedAtMs}`,
      taskId: `tracker:${trackerId}`,
      target: 'next-step',
      instruction: question,
      referenceUpdates: [],
      sourceIds,
      timeline: [],
      capturedAtMs,
    },
    permissionPreset: 'read-only',
    effort: 'high',
    requestId: `tracker:${trackerId}:${capturedAtMs}`,
    ...(folderRoot ? { workspaceRoot: folderRoot } : {}),
  };
}

function createContextTrackerRuntime({
  loadTrackers = () => [],
  persistTrackers = () => {},
  watchPath = watchFilePath,
  readObservation = (paths: string[]) => readFileObservation(paths, now),
  runTask,
  now = Date.now,
  setTimer = (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimer = (handle: TimerHandle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  onError = () => {},
}: {
  loadTrackers?: () => unknown[];
  persistTrackers?: (trackers: ContextTracker[]) => void;
  watchPath?: (watchedPath: string, onEvent: (event: { eventType: string; filename?: string }) => void) => WatchHandle;
  readObservation?: (paths: string[]) => Promise<FileObservation>;
  runTask: (request: TrackerTaskRequest) => Promise<Record<string, unknown>>;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  onError?: (error: unknown, trackerId: string) => void;
}) {
  if (typeof runTask !== 'function') throw new Error('context tracker runTask is required');
  const trackers = new Map<string, ContextTracker>();
  const resources = new Map<string, {
    watchers: WatchHandle[];
    timer: TimerHandle | null;
    eventCount: number;
    eventFromMs: number;
    eventToMs: number;
  }>();
  const inFlight = new Set<Promise<unknown>>();
  const running = new Set<string>();
  let started = false;

  for (const raw of loadTrackers() || []) {
    const tracker = normalizeContextTracker(raw);
    if (trackers.has(tracker.trackerId)) throw new Error(`duplicate context tracker: ${tracker.trackerId}`);
    trackers.set(tracker.trackerId, tracker);
  }

  function clonedTrackers(): ContextTracker[] {
    return [...trackers.values()].map((tracker) => JSON.parse(JSON.stringify(tracker)));
  }

  function persist() {
    persistTrackers(clonedTrackers());
  }

  function clearResources(trackerId: string) {
    const resource = resources.get(trackerId);
    if (!resource) return;
    if (resource.timer != null) clearTimer(resource.timer);
    for (const watcher of resource.watchers) {
      try { watcher.close(); } catch (_) {}
    }
    resources.delete(trackerId);
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    inFlight.add(promise);
    void promise.then(
      () => inFlight.delete(promise),
      (error) => { inFlight.delete(promise); onError(error, ''); },
    );
    return promise;
  }

  async function executeTask(trackerId: string, change: Record<string, unknown>, dueThroughMs?: number) {
    const tracker = trackers.get(trackerId);
    if (!tracker?.enabled) return;
    const startedAtMs = now();
    let result: Record<string, unknown> = {};
    let errorText = '';
    try {
      result = await runTask({
        trackerId: tracker.trackerId,
        task: tracker.task,
        sourceIds: [...tracker.sourceIds],
        folderRoot: tracker.folderRoot,
        outputType: tracker.outputType,
        permissionPreset: 'read-only',
        authorizationRevision: tracker.authorizationRevision,
        ...(tracker.lastRun?.conversationId ? { conversationId: tracker.lastRun.conversationId } : {}),
        change,
      });
      if (result?.ok === false) errorText = cleanText(result.error, 1000) || 'tracker_task_failed';
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
      onError(error, trackerId);
    }
    const current = trackers.get(trackerId);
    if (current !== tracker) return;
    current.lastRun = {
      startedAtMs,
      finishedAtMs: now(),
      ok: !errorText,
      triggerKind: change.kind === 'schedule' ? 'schedule' : 'filesystem',
      ...(dueThroughMs == null ? {} : { dueThroughMs }),
      ...(cleanText(result?.conversationId, 160)
        ? { conversationId: cleanText(result.conversationId, 160) }
        : {}),
      ...(errorText ? { error: errorText } : {}),
    };
    persist();
  }

  function scheduleNext(trackerId: string) {
    const tracker = trackers.get(trackerId);
    if (!started || !tracker?.enabled || tracker.trigger.kind !== 'schedule') return;
    const resource = resources.get(trackerId) || {
      watchers: [], timer: null, eventCount: 0, eventFromMs: 0, eventToMs: 0,
    };
    if (resource.timer != null) clearTimer(resource.timer);
    resources.set(trackerId, resource);
    const lastDue = tracker.lastRun?.triggerKind === 'schedule'
      ? Number(tracker.lastRun.dueThroughMs)
      : Number.NaN;
    const firstDue = Number.isFinite(lastDue)
      ? lastDue + tracker.trigger.everyMs
      : tracker.trigger.startAtMs;
    const delayMs = Math.max(0, firstDue - now());
    resource.timer = setTimer(() => {
      resource.timer = null;
      const current = trackers.get(trackerId);
      if (!started || !current?.enabled || current.trigger.kind !== 'schedule') return;
      const observedAtMs = now();
      const priorDue = current.lastRun?.triggerKind === 'schedule'
        ? Number(current.lastRun.dueThroughMs)
        : Number.NaN;
      const missedFromMs = Number.isFinite(priorDue)
        ? priorDue + current.trigger.everyMs
        : current.trigger.startAtMs;
      if (observedAtMs < missedFromMs) {
        scheduleNext(trackerId);
        return;
      }
      const missedCount = Math.floor((observedAtMs - missedFromMs) / current.trigger.everyMs) + 1;
      const missedToMs = missedFromMs + (missedCount - 1) * current.trigger.everyMs;
      const promise = executeTask(trackerId, {
        kind: 'schedule',
        missedCount,
        missedFromMs,
        missedToMs,
        observedAtMs,
      }, missedToMs).finally(() => scheduleNext(trackerId));
      track(promise);
    }, delayMs);
  }

  async function fireFilesystem(trackerId: string) {
    const tracker = trackers.get(trackerId);
    const resource = resources.get(trackerId);
    if (!started || !tracker?.enabled || tracker.trigger.kind !== 'filesystem' || !resource) return;
    if (running.has(trackerId)) return;
    running.add(trackerId);
    try {
      const eventCount = resource.eventCount;
      const eventFromMs = resource.eventFromMs;
      const eventToMs = resource.eventToMs;
      resource.eventCount = 0;
      resource.eventFromMs = 0;
      resource.eventToMs = 0;
      const previous = tracker.lastObserved;
      const current = normalizedObservation(await readObservation(tracker.trigger.paths));
      if (!current || !started || trackers.get(trackerId) !== tracker || !tracker.enabled) return;
      tracker.lastObserved = current;
      persist();
      if (observationsEqual(previous, current)) return;
      await executeTask(trackerId, {
        kind: 'filesystem',
        eventCount,
        eventFromMs,
        eventToMs,
        previous,
        current,
      });
    } finally {
      running.delete(trackerId);
      if (started && resources.get(trackerId) === resource && tracker.enabled && resource.eventCount > 0) {
        if (resource.timer != null) clearTimer(resource.timer);
        resource.timer = setTimer(() => {
          resource.timer = null;
          track(fireFilesystem(trackerId));
        }, tracker.trigger.debounceMs);
      }
    }
  }

  function onFilesystemEvent(trackerId: string) {
    const tracker = trackers.get(trackerId);
    const resource = resources.get(trackerId);
    if (!started || !tracker?.enabled || tracker.trigger.kind !== 'filesystem' || !resource) return;
    const observedAtMs = now();
    resource.eventCount += 1;
    resource.eventFromMs = resource.eventFromMs || observedAtMs;
    resource.eventToMs = observedAtMs;
    if (resource.timer != null) clearTimer(resource.timer);
    resource.timer = setTimer(() => {
      resource.timer = null;
      track(fireFilesystem(trackerId));
    }, tracker.trigger.debounceMs);
  }

  async function armTracker(trackerId: string) {
    clearResources(trackerId);
    const tracker = trackers.get(trackerId);
    if (!started || !tracker?.enabled) return;
    const resource = {
      watchers: [] as WatchHandle[],
      timer: null as TimerHandle | null,
      eventCount: 0,
      eventFromMs: 0,
      eventToMs: 0,
    };
    resources.set(trackerId, resource);
    if (tracker.trigger.kind === 'schedule') {
      scheduleNext(trackerId);
      return;
    }
    if (!tracker.lastObserved) {
      tracker.lastObserved = normalizedObservation(await readObservation(tracker.trigger.paths));
      persist();
    }
    if (!started || trackers.get(trackerId) !== tracker || !tracker.enabled) return;
    try {
      resource.watchers = tracker.trigger.paths.map((watchedPath) => watchPath(
        watchedPath,
        () => onFilesystemEvent(trackerId),
      ));
    } catch (error) {
      clearResources(trackerId);
      onError(error, trackerId);
    }
  }

  async function start() {
    if (started) return;
    started = true;
    await Promise.all([...trackers.keys()].map((trackerId) => armTracker(trackerId)));
  }

  async function stop() {
    started = false;
    for (const trackerId of [...resources.keys()]) clearResources(trackerId);
    await idle();
  }

  function list(): ContextTracker[] {
    return clonedTrackers();
  }

  function upsert(raw: unknown): ContextTracker {
    const normalized = normalizeContextTracker(raw);
    const existing = trackers.get(normalized.trackerId);
    if (existing && configIdentity(existing) !== configIdentity(normalized)) {
      normalized.authorizationRevision = existing.authorizationRevision + 1;
      normalized.lastRun = null;
      if (existing.trigger.kind !== normalized.trigger.kind
          || JSON.stringify(existing.trigger) !== JSON.stringify(normalized.trigger)) {
        normalized.lastObserved = null;
      }
    } else if (existing) {
      normalized.authorizationRevision = existing.authorizationRevision;
    }
    trackers.set(normalized.trackerId, normalized);
    persist();
    if (started) track(armTracker(normalized.trackerId));
    return JSON.parse(JSON.stringify(normalized));
  }

  function setEnabled(trackerId: string, enabled: boolean): ContextTracker | null {
    const tracker = trackers.get(cleanText(trackerId, 160));
    if (!tracker) return null;
    tracker.enabled = enabled === true;
    persist();
    clearResources(tracker.trackerId);
    if (started && tracker.enabled) track(armTracker(tracker.trackerId));
    return JSON.parse(JSON.stringify(tracker));
  }

  function remove(trackerId: string): boolean {
    const cleanId = cleanText(trackerId, 160);
    clearResources(cleanId);
    const removed = trackers.delete(cleanId);
    if (removed) persist();
    return removed;
  }

  async function idle() {
    while (inFlight.size) await Promise.allSettled([...inFlight]);
  }

  return { start, stop, list, upsert, setEnabled, remove, idle };
}

module.exports = {
  buildContextTrackerConversationRequest,
  createMaterialTracker,
  createContextTrackerRuntime,
  normalizeContextTracker,
  observationsEqual,
  readFileObservation,
};
