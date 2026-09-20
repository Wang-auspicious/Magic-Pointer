import assert from 'node:assert/strict';
import { createTaskWatcher } from '../electron/task_watcher';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function main() {
  let nextPoll: (() => void) | undefined;
  const patches: any[] = [];
  let phase = 'reading';
  const watcher = createTaskWatcher({
    probe: async () => ({ status: 'running', result: { steps: [{ label: 'read', note: phase, state: phase === 'reading' ? 'running' : 'done' }] } }),
    onPatch: (event) => patches.push(event.patch),
    schedule: (callback) => { nextPoll = callback; return {}; }, cancelSchedule: () => {},
  });
  watcher.watch({ taskId: 't' }); await tick();
  phase = 'complete'; nextPoll!(); await tick();
  watcher.stopAll();
  assert.equal(patches.length, 2, 'a note/state update is delivered even when step count is unchanged');
  assert.equal(patches[1].steps[0].note, 'complete');
  console.log('task_watcher_step_updates_test: passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
