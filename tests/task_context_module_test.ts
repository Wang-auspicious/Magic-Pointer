import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventSession} from '../electron/runtime/session';
import {taskContextModule} from '../electron/runtime/task_context_module';

test('a resumed task does not display its previous success as the current running result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-module-task-'));
  try {
    const session = await EventSession.open(root, 'agent-context-turns');
    const first = await session.startTurn();
    await session.append('receipt/issued', {turn: first, status: 'succeeded'});
    await session.endTurn('completed');
    const module = taskContextModule(session);
    const finished = await module.panels![0].render();
    assert.equal(finished.status.label, 'succeeded');
    await session.startTurn();
    const running = await module.panels![0].render();
    assert.equal(running.status.state, 'running');
    assert.equal(running.status.label, 'Running');
    assert.equal(running.status.detail, 'Previous result: succeeded');
    await session.endTurn('cancelled');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
