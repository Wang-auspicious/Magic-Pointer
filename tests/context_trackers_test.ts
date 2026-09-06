'use strict';

const assert = require('node:assert/strict');
const {
  buildContextTrackerConversationRequest,
  createMaterialTracker,
  createContextTrackerRuntime,
} = require('../electron/context_trackers');
const { defaultSettings, validate: validateSettings } = require('../electron/settings_store');

function fakeClock(initialNow: number) {
  let current = initialNow;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();

  function setTimer(callback: () => void, delayMs: number) {
    const id = nextId++;
    timers.set(id, { at: current + Math.max(0, delayMs), callback });
    return id;
  }

  function clearTimer(id: number) {
    timers.delete(id);
  }

  function runDue() {
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= current)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
      if (!due.length) return;
      const [id, timer] = due[0];
      timers.delete(id);
      timer.callback();
    }
  }

  return {
    now: () => current,
    setTimer,
    clearTimer,
    advance(ms: number) {
      current += ms;
      runDue();
    },
    runDue,
  };
}

function fileTracker(overrides: Record<string, unknown> = {}) {
  return {
    trackerId: 'tracker:file:brief',
    task: '材料变化后，核对变化并生成一份更新草稿。',
    sourceIds: ['source:attachment:D:/work/brief.pptx'],
    folderRoot: 'D:/work',
    trigger: {
      kind: 'filesystem',
      paths: ['D:/work/brief.pptx'],
      debounceMs: 200,
    },
    outputType: 'draft',
    enabled: true,
    lastObserved: {
      observedAtMs: 900,
      entries: {
        'D:/work/brief.pptx': { exists: true, size: 100, mtimeMs: 900 },
      },
    },
    lastRun: null,
    ...overrides,
  };
}

async function fileEventsFromOneSaveLaunchOneScopedTask() {
  const clock = fakeClock(1000);
  const watchers = new Map<string, (event: { eventType: string; filename?: string }) => void>();
  const runs: Array<Record<string, any>> = [];
  let revision = 1;
  const runtime = createContextTrackerRuntime({
    loadTrackers: () => [fileTracker()],
    persistTrackers: () => {},
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    watchPath: (watchedPath: string, onEvent: (event: { eventType: string; filename?: string }) => void) => {
      watchers.set(watchedPath, onEvent);
      return { close: () => watchers.delete(watchedPath) };
    },
    readObservation: async (paths: string[]) => ({
      observedAtMs: clock.now(),
      entries: Object.fromEntries(paths.map((item) => [item, {
        exists: true,
        size: 100 + revision,
        mtimeMs: 1000 + revision,
      }])),
    }),
    runTask: async (request: Record<string, any>) => {
      runs.push(request);
      return { ok: true, conversationId: 'conversation:tracker:file' };
    },
  });

  await runtime.start();
  const emit = watchers.get('D:/work/brief.pptx');
  assert.ok(emit, 'an enabled filesystem tracker must register its selected path');
  revision = 2;
  emit!({ eventType: 'change', filename: 'brief.pptx' });
  emit!({ eventType: 'rename', filename: 'brief.pptx' });
  emit!({ eventType: 'change', filename: 'brief.pptx' });
  clock.advance(199);
  await runtime.idle();
  assert.strictEqual(runs.length, 0, 'save events must wait for the coalescing window');
  clock.advance(1);
  await runtime.idle();

  assert.strictEqual(runs.length, 1, 'one editor save must not create three Agent tasks');
  assert.deepStrictEqual(runs[0].sourceIds, ['source:attachment:D:/work/brief.pptx']);
  assert.strictEqual(runs[0].folderRoot, 'D:/work');
  assert.strictEqual(runs[0].outputType, 'draft');
  assert.strictEqual(runs[0].permissionPreset, 'read-only');
  assert.strictEqual(runs[0].change.kind, 'filesystem');
  assert.strictEqual(runs[0].change.eventCount, 3);
  assert.strictEqual(runs[0].change.previous.entries['D:/work/brief.pptx'].size, 100);
  assert.strictEqual(runs[0].change.current.entries['D:/work/brief.pptx'].size, 102);
  await runtime.stop();
}

async function sleepRecoveryMergesMissedOccurrences() {
  const clock = fakeClock(10_500);
  const runs: Array<Record<string, any>> = [];
  const runtime = createContextTrackerRuntime({
    loadTrackers: () => [{
      trackerId: 'tracker:schedule:daily-report',
      task: '按时整理当前材料变化并生成报告。',
      sourceIds: ['source:attachment:D:/work/status.xlsx'],
      folderRoot: 'D:/work',
      trigger: { kind: 'schedule', startAtMs: 1000, everyMs: 1000 },
      outputType: 'report',
      enabled: true,
      lastObserved: null,
      lastRun: null,
    }],
    persistTrackers: () => {},
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    watchPath: () => { throw new Error('schedule trackers must not create file watchers'); },
    readObservation: async () => ({ observedAtMs: clock.now(), entries: {} }),
    runTask: async (request: Record<string, any>) => {
      runs.push(request);
      return { ok: true };
    },
  });

  await runtime.start();
  clock.runDue();
  await runtime.idle();
  assert.strictEqual(runs.length, 1, 'resume must merge missed times instead of replaying each one');
  assert.deepStrictEqual(runs[0].change, {
    kind: 'schedule',
    missedCount: 10,
    missedFromMs: 1000,
    missedToMs: 10_000,
    observedAtMs: 10_500,
  });
  assert.deepStrictEqual(runs[0].sourceIds, ['source:attachment:D:/work/status.xlsx']);
  assert.strictEqual(runs[0].folderRoot, 'D:/work');
  assert.strictEqual(runs[0].outputType, 'report');
  await runtime.stop();
}

async function disabledTrackerNeverTriggers() {
  const clock = fakeClock(2000);
  const callbacks: Array<(event: { eventType: string }) => void> = [];
  const runs: unknown[] = [];
  const runtime = createContextTrackerRuntime({
    loadTrackers: () => [fileTracker()],
    persistTrackers: () => {},
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    watchPath: (_path: string, onEvent: (event: { eventType: string }) => void) => {
      callbacks.push(onEvent);
      return { close: () => {} };
    },
    readObservation: async () => ({
      observedAtMs: clock.now(),
      entries: { 'D:/work/brief.pptx': { exists: true, size: 200, mtimeMs: 2000 } },
    }),
    runTask: async (request: unknown) => { runs.push(request); return { ok: true }; },
  });

  await runtime.start();
  assert.strictEqual(callbacks.length, 1);
  runtime.setEnabled('tracker:file:brief', false);
  callbacks[0]({ eventType: 'change' });
  clock.advance(1000);
  await runtime.idle();
  assert.deepStrictEqual(runs, [], 'a stale fs callback cannot revive a disabled tracker');
  assert.strictEqual(runtime.list()[0].enabled, false);
  await runtime.stop();
}

function persistedSettingsAndNormalRuntimeRequestStayNarrow() {
  const settings = defaultSettings();
  assert.deepStrictEqual(settings.context_trackers, []);
  const legacySettings = defaultSettings() as Record<string, unknown>;
  delete legacySettings.context_trackers;
  assert.deepStrictEqual(validateSettings(legacySettings).context_trackers, [],
    'existing 1.0.33 settings must migrate without discarding the rest of the file');
  settings.context_trackers = [fileTracker()];
  const validated = validateSettings(settings);
  assert.strictEqual(validated.context_trackers.length, 1);
  assert.strictEqual(validated.context_trackers[0].trackerId, 'tracker:file:brief');

  const request = buildContextTrackerConversationRequest({
    trackerId: 'tracker:file:brief',
    task: '材料变化后，核对变化并生成一份更新草稿。',
    sourceIds: ['source:attachment:D:/work/brief.pptx'],
    folderRoot: 'D:/work',
    outputType: 'draft',
    permissionPreset: 'read-only',
    authorizationRevision: 3,
    conversationId: 'conversation:prior-run',
    change: {
      kind: 'filesystem',
      eventCount: 2,
      eventFromMs: 1200,
      eventToMs: 1250,
      previous: { observedAtMs: 1000, entries: { 'D:/work/brief.pptx': { exists: true, size: 100 } } },
      current: { observedAtMs: 1250, entries: { 'D:/work/brief.pptx': { exists: true, size: 140 } } },
    },
  }, 1300);
  assert.strictEqual(request.conversationId, 'conversation:prior-run');
  assert.strictEqual(request.permissionPreset, 'read-only');
  assert.strictEqual(request.workspaceRoot, 'D:/work');
  assert.deepStrictEqual(request.attachments, ['D:/work/brief.pptx']);
  assert.deepStrictEqual(request.taskInput.sourceIds, ['source:attachment:D:/work/brief.pptx']);
  assert.strictEqual(request.taskInput.instruction, request.question);
  assert.match(request.question, /只生成可预览的草稿/);
  assert.match(request.question, /eventCount/);
  assert.ok(!('permissionGrant' in request));
  assert.ok(!('permissionGrantOnce' in request));
}

async function main() {
  await savesDuringOneRunAreCoalesced();
  const material = createMaterialTracker({
    source: { sourceId: 'selected-ppt', identity: { absolutePath: 'D:/work/brief.pptx' } },
    task: '核对更新', cadence: 'filesystem', nowMs: 1000, trackerId: 'selected-tracker',
  });
  assert.strictEqual(material.folderRoot, '', 'following one file must not authorize its containing folder');
  assert.deepStrictEqual(material.sourceIds, ['source:attachment:D:/work/brief.pptx']);
  assert.deepStrictEqual(material.trigger.paths, ['D:/work/brief.pptx']);
  await fileEventsFromOneSaveLaunchOneScopedTask();
  await sleepRecoveryMergesMissedOccurrences();
  await disabledTrackerNeverTriggers();
  persistedSettingsAndNormalRuntimeRequestStayNarrow();
  console.log('context trackers test ok');
}

async function savesDuringOneRunAreCoalesced() {
  const clock = fakeClock(1000);
  let emit: () => void = () => {};
  let revision = 1;
  const runs: Array<Record<string, any>> = [];
  let finish: () => void = () => {};
  const runtime = createContextTrackerRuntime({
    loadTrackers: () => [fileTracker()],
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    watchPath: (_path: string, callback: () => void) => { emit = callback; return { close() {} }; },
    readObservation: async () => ({ observedAtMs: clock.now(), entries: {
      'D:/work/brief.pptx': { exists: true, size: revision, mtimeMs: revision },
    } }),
    runTask: async (request: Record<string, any>) => {
      runs.push(request);
      if (runs.length === 1) await new Promise<void>((resolve) => { finish = resolve; });
      return { ok: true, conversationId: 'tracked-result' };
    },
  });
  await runtime.start();
  emit(); clock.advance(200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(runs.length, 1);
  revision = 2; emit(); clock.advance(200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(runs.length, 1, 'saving while the model works must not start a competing task');
  revision = 3; emit(); clock.advance(200);
  finish(); await runtime.idle();
  clock.advance(200); await runtime.idle();
  assert.strictEqual(runs.length, 2, 'all saves during the first run become one follow-up');
  assert.strictEqual(runs[1].change.current.entries['D:/work/brief.pptx'].size, 3);
  assert.strictEqual(runs[1].conversationId, 'tracked-result');
  await runtime.stop();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
