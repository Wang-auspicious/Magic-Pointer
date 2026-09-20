import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { createContextTrackerRuntime, readFileObservation, observationsEqual } = require('../electron/context_trackers');
async function main() {
  let runs = 0;
  const tracker = createContextTrackerRuntime({
    loadTrackers: () => [{ trackerId: 'restart', task: 'read changes', sourceIds: ['source:attachment:D:/work/a.txt'], folderRoot: '', outputType: 'draft', enabled: true, trigger: { kind: 'filesystem', paths: ['D:/work/a.txt'], debounceMs: 200 }, lastObserved: { observedAtMs: 1, entries: { 'D:/work/a.txt': { exists: true, size: 1, mtimeMs: 1 } } }, lastRun: null }],
    persistTrackers: () => {}, watchPath: () => ({ close() {} }),
    readObservation: async () => ({ observedAtMs: 2, entries: { 'D:/work/a.txt': { exists: true, size: 2, mtimeMs: 2 } } }),
    runTask: async () => { runs += 1; return { ok: true }; },
  });
  await tracker.start(); await tracker.idle(); await tracker.stop();
  assert.equal(runs, 1, 'restart catches the change made while the app was stopped');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-tracker-nested-'));
  try {
    const missing = path.join(root, 'deleted.txt');
    fs.writeFileSync(missing, 'original');
    const lastObserved = await readFileObservation([missing]);
    fs.unlinkSync(missing);
    let deletedRuns = 0;
    const restarted = createContextTrackerRuntime({
      loadTrackers: () => [{ trackerId: 'deleted', task: 'read changes', enabled: true, outputType: 'draft', folderRoot: '', lastRun: null, sourceIds: [`source:attachment:${missing}`],
        trigger: { kind: 'filesystem', paths: [missing], debounceMs: 200 }, lastObserved }],
      persistTrackers: () => {}, runTask: async () => { deletedRuns += 1; return { ok: true }; },
    });
    await restarted.start(); await restarted.idle(); await restarted.stop();
    assert.equal(deletedRuns, 1, 'an offline deletion is observed even though the file no longer exists to watch');
    fs.mkdirSync(path.join(root, 'sub'));
    const file = path.join(root, 'sub', 'a.txt');
    fs.writeFileSync(file, 'old');
    const before = await readFileObservation([root]);
    fs.writeFileSync(file, 'longer new content');
    const after = await readFileObservation([root]);
    assert.equal(observationsEqual(before, after), false, 'editing a nested file changes the selected folder observation');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('context_tracker_restart_nested_test: passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
