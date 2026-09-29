import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalActivityService } from '../electron/personal_activity_service';

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'mp-personal-service-'));
  let now = new Date(2026, 8, 29, 20, 59).getTime();
  let starts = 0, stops = 0;
  let nativeCallbacks: any;
  const reports: string[] = [];
  const service = new PersonalActivityService(directory, {
    now: () => now, defaultRoots: [],
    createNative: callbacks => { nativeCallbacks = callbacks; return { start: async () => { starts++; callbacks.onStatus('running'); }, stop: async () => { stops++; callbacks.onStatus('stopped'); }, flush: async () => {} }; },
    onReport: report => { reports.push(report.date); },
  });
  try {
    await service.start();
    assert.equal(starts, 0, 'recording starts only after the saved setting enables it');
    await service.configure({ enabled: true, screenEnabled: false, reportTime: '21:00' });
    assert.equal(starts, 1);
    await service.store.recordKeyboardBatch({ at: new Date(now).toISOString(), counts: { Enter: 13 } });
    now = new Date(2026, 8, 29, 21, 0).getTime();
    await service.tick();
    assert.deepEqual(reports, ['2026-09-29']);
    assert.match(await readFile(join(directory, 'reports', '2026-09-29.md'), 'utf8'), /Enter.*13/);
    await service.tick();
    assert.equal(reports.length, 1, 'repeated scheduler ticks must not notify the same report again');
    await service.configure({ paused: true });
    assert.equal(stops, 1, 'pause stops the native hook rather than just hiding its result');
    await service.configure({ paused: false });
    assert.equal(starts, 2);
    nativeCallbacks.onStatus('error'); nativeCallbacks.onError(new Error('collector exited'));
    now += 60000;
    await service.tick();
    assert.equal(starts, 3, 'an exited collector should recover on the next normal scheduler tick');
    assert.ok((await service.store.getStatus()).gaps.some(gap => gap.reason === 'collector_unavailable' && gap.to !== null), 'collector downtime must remain visible after recovery');
    await service.configure({ roots: [] });
    await service.stop();
    const resumed = new PersonalActivityService(directory, {
      now: () => now, defaultRoots: [join(directory, 'new-root')],
      createNative: () => ({ start: async () => {}, stop: async () => {}, flush: async () => {} }),
    });
    try {
      await resumed.start();
      assert.deepEqual((await resumed.store.getStatus()).roots, [], 'removing every watched root must survive restart');
    } finally { await resumed.stop(); }
  } finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
  console.log('personal activity lifecycle and daily reporting passed');
}
void main();
