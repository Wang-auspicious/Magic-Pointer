import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalActivityService} from '../electron/personal_activity_service';

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'mp-report-freshness-'));
  let now = new Date(2026, 8, 29, 20, 0).getTime();
  const notifications: string[] = [];
  const service = new PersonalActivityService(directory, {
    now: () => now,
    createNative: callbacks => ({
      start: async () => callbacks.onStatus('running'),
      stop: async () => {},
      flush: async () => {},
    }),
    onReport: report => notifications.push(report.date),
  });
  try {
    await service.start();
    await service.configure({
      enabled: true,
      screenEnabled: false,
      reportTime: '21:00',
      roots: [],
    });
    await service.store.recordKeyboardBatch({
      at: new Date(now).toISOString(),
      counts: {Enter: 2},
    });
    now = new Date(2026, 9, 21, 22, 0).getTime();
    await service.tick();
    assert.ok(
      (
        await readFile(join(directory, 'reports', '2026-09-29.md'), 'utf8')
      ).includes('2026-09-29'),
      'Historical reports remain available locally',
    );
    assert.deepEqual(
      [...notifications].sort(),
      [],
      'An old September report must not reappear as a new October desktop notification',
    );
    await service.store.recordKeyboardBatch({
      at: new Date(2026, 9, 20, 20, 0).toISOString(),
      counts: {Enter: 1},
    });
    await service.store.recordKeyboardBatch({
      at: new Date(now).toISOString(),
      counts: {Enter: 1},
    });
    await service.tick();
    assert.deepEqual(
      [...notifications].sort(),
      ['2026-10-20', '2026-10-21'],
      'Yesterday and today remain eligible for a timely reminder',
    );
    await service.tick();
    assert.equal(
      notifications.length,
      2,
      'Report refresh must not duplicate a desktop reminder',
    );
  } finally {
    await service.stop();
    await rm(directory, {recursive: true, force: true});
  }
  console.log(
    'Historical report backfill stays local without stale desktop notifications',
  );
}
void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
