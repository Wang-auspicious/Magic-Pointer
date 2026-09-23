import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventSession, resumeSourceAvailability } from '../electron/runtime/session';
import { fileSource, registerSource } from '../electron/runtime/context';

test('resume distinguishes available, changed and missing disk sources from live sources', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-resume-sources-'));
  const session = await EventSession.open(root, 'sources');
  const original = path.join(root, 'original.txt'), missing = path.join(root, 'missing.txt');
  await writeFile(original, 'before'); await writeFile(missing, 'disappears');
  const disk = fileSource(session.id, original), lost = fileSource(session.id, missing);
  disk.sourceId = 'original'; lost.sourceId = 'missing';
  const originalStat = await stat(original), missingStat = await stat(missing);
  disk.revision = { authority: 'disk', mtimeMs: originalStat.mtimeMs, size: originalStat.size };
  lost.revision = { authority: 'disk', mtimeMs: missingStat.mtimeMs, size: missingStat.size };
  await registerSource(session, disk); await registerSource(session, lost);
  await registerSource(session, { sourceId: 'live', taskId: session.id, kind: 'document', title: 'Current Word document',
    identity: { host: 'word', hwnd: 123, pid: 456 }, revision: { authority: 'live' }, capabilities: ['read'], origin: 'task-discovered', parentSourceId: null });
  const missingFrame = path.join(root, 'lost-frame.png');
  for (const [sourceId, content] of [['text-frame', 'Saved text'], ['image-frame', '']])
    await registerSource(session, { sourceId, taskId: session.id, kind: 'capture', title: sourceId,
      identity: { content, frameLease: { localArtifact: { path: missingFrame } } }, revision: { authority: 'historical' },
      capabilities: ['read'], origin: 'user-pointed', parentSourceId: null });
  assert.deepEqual((await resumeSourceAvailability(session.events)).map(item => [item.sourceId, item.availability]),
    [['original', 'available'], ['missing', 'available'], ['live', 'reacquire_required'], ['text-frame', 'historical_only'], ['image-frame', 'missing']]);
  assert.equal((await resumeSourceAvailability(session.events)).find(item => item.sourceId === 'text-frame')?.pixelAvailable, false);
  await writeFile(original, 'changed since the task paused'); await unlink(missing);
  assert.deepEqual((await resumeSourceAvailability(session.events)).map(item => [item.sourceId, item.availability]),
    [['original', 'changed'], ['missing', 'missing'], ['live', 'reacquire_required'], ['text-frame', 'historical_only'], ['image-frame', 'missing']]);
});
