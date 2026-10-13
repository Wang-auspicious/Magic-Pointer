'use strict';

// Tracker run history: bounded, migrated from lastRun, newest-first.

const assert = require('node:assert/strict');
const {normalizeContextTracker, createContextTrackerRuntime} = require('../electron/context_trackers');

function base(overrides = {}) {
  return {
    trackerId: 'tracker-1',
    task: 'watch the folder',
    sourceIds: ['source-1'],
    folderRoot: 'D:/data',
    trigger: {kind: 'filesystem', paths: ['D:/data']},
    outputType: 'report',
    enabled: true,
    ...overrides,
  };
}

const run = (startedAtMs, ok = true) => ({
  startedAtMs,
  finishedAtMs: startedAtMs + 1000,
  ok,
  triggerKind: 'schedule',
});

// A legacy record with only lastRun migrates into a one-entry history.
{
  const tracker = normalizeContextTracker(
    base({lastRun: run(1000, false)}),
  );
  assert.equal(tracker.runHistory.length, 1);
  assert.equal(tracker.runHistory[0].ok, false);
  assert.equal(tracker.lastRun, tracker.runHistory[0]);
}

// An explicit history wins; lastRun follows the newest entry.
{
  const tracker = normalizeContextTracker(
    base({lastRun: run(1000), runHistory: [run(3000), run(2000)]}),
  );
  assert.equal(tracker.runHistory.length, 2);
  assert.equal(tracker.runHistory[0].startedAtMs, 3000);
  assert.equal(tracker.lastRun.startedAtMs, 3000);
}

// History is bounded; non-object entries are dropped, not kept.
{
  const history = Array.from({length: 25}, (_, i) => run(1000 + i));
  history.push(null, 'nope');
  const tracker = normalizeContextTracker(base({runHistory: history}));
  assert.equal(tracker.runHistory.length, 20);
  assert.equal(tracker.runHistory[0].startedAtMs, 1000 + 24);
}

// Failure reasons survive normalization for the library UI.
{
  const tracker = normalizeContextTracker(
    base({runHistory: [run(5000, false), {...run(4000, false), error: 'boom'}]}),
  );
  assert.equal(tracker.runHistory[0].error, undefined);
  assert.equal(tracker.runHistory[1].error, 'boom');
}

console.log('context tracker history test ok');

async function waitingRunsStayActionable() {
  const notifications: string[] = [];
  const runtime = createContextTrackerRuntime({
    onRun: (_tracker: unknown, finished: {status: string}) => notifications.push(finished.status),
    runTask: async () => ({ok: true, awaitingUserInput: true, hasPendingWork: true, conversationId: 'needs-answer'}),
  });
  runtime.upsert(base({enabled: false, trigger: {kind: 'schedule', startAtMs: Date.now(), everyMs: 60_000}}));
  await runtime.runNow('tracker-1');
  assert.equal(runtime.list()[0].lastRun.status, 'waiting', 'a model question is not a completed routine');
  assert.equal((await runtime.runNow('tracker-1')).error, 'routine_requires_attention');
  runtime.reconcileConversation({conversationId: 'needs-answer', ok: true, hasPendingWork: false, artifacts: [{artifactId: 'report', revision: 1}]});
  assert.equal(runtime.list()[0].lastRun.status, 'completed');
  assert.equal(runtime.list()[0].enabled, false, 'answering must not change the user’s paused preference');
  assert.equal(runtime.list()[0].runHistory.length, 1, 'continuing resolves the same run rather than inventing another occurrence');
  assert.deepEqual(notifications, ['waiting', 'completed']);
  runtime.reconcileConversation({conversationId: 'needs-answer', ok: true, hasPendingWork: false});
  assert.equal(notifications.length, 2, 'ordinary future chat turns do not repeat a routine notification');
  console.log('context tracker waiting and continuation test ok');
}
void waitingRunsStayActionable().catch(error => {console.error(error); process.exitCode = 1;});
