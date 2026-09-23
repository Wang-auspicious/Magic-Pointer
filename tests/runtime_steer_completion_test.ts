import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../electron/runtime/agent';
import { EventSession } from '../electron/runtime/session';
import { ToolRegistry } from '../electron/runtime/tools';

test('a correction arriving during a final model reply runs before completion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-final-steer-'));
  const session = await EventSession.open(root, 'final-steer');
  let started!: () => void, release!: () => void, requests = 0;
  const firstRequest = new Promise<void>(resolve => { started = resolve; });
  const continueFirst = new Promise<void>(resolve => { release = resolve; });
  const running = runAgent({ root, userDataDir: root, session, registry: new ToolRegistry(), instruction: 'Use target A',
    model: async request => {
      requests++;
      if (requests === 1) { started(); await continueFirst; return { text: 'Finished target A', tool_calls: [] }; }
      assert.ok(request.messages.some(message => String(message.content).includes('Use target B')));
      return { text: 'Finished target B', tool_calls: [] };
    } });
  await firstRequest;
  await session.enqueue('Correction: Use target B', 'next-step');
  release();
  const result = await running;
  assert.equal(result.reason, 'completed');
  assert.equal(result.message, 'Finished target B');
  assert.equal(requests, 2);
  assert.equal(session.pendingInbox('next-step').length, 0);
});
