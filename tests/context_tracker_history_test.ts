'use strict';

// Tracker run history: bounded, migrated from lastRun, newest-first.

const assert = require('node:assert/strict');
const {normalizeContextTracker} = require('../electron/context_trackers');

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
