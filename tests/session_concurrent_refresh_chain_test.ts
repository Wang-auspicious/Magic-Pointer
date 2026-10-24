import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventSession} from '../electron/runtime/session';

/**
 * Two session instances over one journal: one polls with the unlocked
 * refresh paths (consumeCancel — the runAgent 400ms interval does exactly
 * this) while the other appends under the lock. A refresh that snapshots
 * size after reading adopts a size it never parsed; its next append then
 * writes a duplicate seq and every other reader fails the chain check.
 */
test('concurrent unlocked refresh and locked append never corrupt the chain', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mp-chain-stress-'));
  const a = await EventSession.open(dir, 'stress');
  const b = await EventSession.open(dir, 'stress');
  for (let round = 0; round < 300; round++) {
    await Promise.all([
      b.consumeCancel().catch(error => {
        assert.fail(`round ${round} consumeCancel: ${error.message}`);
      }),
      a.append('stress/tick', {round}).catch(error => {
        assert.fail(`round ${round} append: ${error.message}`);
      }),
    ]);
  }
  await a.refresh();
  await b.refresh();
  assert.equal(a.events.length, b.events.length);
  assert.equal(a.events.filter(event => event.seq >= 0).length, a.events.length);
  const seqs = a.events.map(event => event.seq);
  assert.deepEqual(seqs, seqs.map((_, index) => index));
});

test('a second reader instance always adopts every appended event', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mp-chain-stress-'));
  const a = await EventSession.open(dir, 'stress');
  const b = await EventSession.open(dir, 'stress');
  for (let round = 0; round < 200; round++) {
    await Promise.all([
      (round % 2 ? b : a).consumeCancel().catch(() => {}),
      (round % 2 ? a : b).append('stress/tick', {round}).catch(() => {}),
    ]);
  }
  for (const session of [a, b]) {
    await session.refresh();
    const seqs = session.events.map(event => event.seq);
    assert.deepEqual(
      seqs,
      seqs.map((_, index) => index),
      `${session === a ? 'a' : 'b'} diverged`,
    );
  }
  assert.equal(a.events.length, b.events.length);
});
