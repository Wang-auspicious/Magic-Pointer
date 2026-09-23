import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventSession, handleSessionRead } from '../electron/runtime/session';

test('completed turn with a partial receipt remains resumable until a verified completion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-partial-completion-'));
  const session = await EventSession.open(root, 'partial');
  await session.startTurn();
  await session.append('receipt/issued', { status: 'partial', unfinished: ['check output'] });
  await session.endTurn('completed');
  const partial = await handleSessionRead({ action: 'status', sessionId: session.id }, root);
  assert.equal(partial.hasPendingWork, true);
  assert.equal(partial.lastReceiptStatus, 'partial');
  await session.startTurn();
  await session.append('receipt/issued', { status: 'succeeded', unfinished: [] });
  await session.endTurn('completed');
  const finished = await handleSessionRead({ action: 'status', sessionId: session.id }, root);
  assert.equal(finished.hasPendingWork, false);
  assert.equal(finished.lastReceiptStatus, 'succeeded');
});
