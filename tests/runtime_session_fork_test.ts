import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventSession } from '../electron/runtime/session';

test('fork rebinds consumed task input messages to the child session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-session-fork-'));
  const parent = await EventSession.open(root, 'parent');
  const taskInput = { inputId: 'input-1', taskId: 'parent', instruction: 'Use this source', sourceIds: ['source-1'], referenceUpdates: [], timeline: [] };
  await parent.enqueue(taskInput.instruction, 'next-step', taskInput, taskInput.inputId);
  await parent.claimInbox('next-step');

  const child = await parent.fork(root, 'child');
  const consumed = child.events.find(event => event.type === 'inbox/consumed');
  assert.ok(consumed);
  assert.equal((child.events.find(event => event.type === 'inbox/message')?.data.payload as typeof taskInput).taskId, 'child');
  assert.equal((consumed.data.messages as { content: string }[])[1].content.includes('"taskId":"child"'), true);
  assert.equal(child.deriveMessages()[1].content?.includes('"taskId":"child"'), true);
  assert.equal(parent.deriveMessages()[1].content?.includes('"taskId":"parent"'), true);
});
