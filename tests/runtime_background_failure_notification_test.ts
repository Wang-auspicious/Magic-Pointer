import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventSession } from '../electron/runtime/session';
import { readAgentStatus, runBackgroundAgent } from '../electron/runtime/agent_background';

test('background Agent failure reaches the parent durable inbox as a failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-agent-failure-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const parent = await EventSession.open(root, 'parent');
  const child = await EventSession.open(root, 'child', true, parent.id);
  await parent.append('subagent/created', { childSessionId: child.id, task: 'Read fixture', readonly: true });
  await child.startTurn();
  await writeFile(path.join(root, 'agent-sessions', 'child.agent.json'), JSON.stringify({
    id: child.id, status: 'starting', startedAt: Date.now(),
  }));
  try {
    await runBackgroundAgent({ root, userDataDir: root, workspace, sessionId: child.id, parentId: parent.id,
      instruction: 'Read fixture', readonly: true, permissionMode: 'safe', parentCallId: 'delegate' });
    const status = await readAgentStatus(root, child.id);
    assert.equal(status?.status, 'failed');
    assert.match(String(status?.summary), /session_busy/);
    await parent.refresh();
    const messages = parent.pendingInbox('next-step');
    assert.equal(messages.length, 1);
    assert.match(String(messages[0].text), /child failed.*session_busy/s);
    assert.equal(parent.events.filter(event => event.type === 'subagent/finished' && event.data.childSessionId === child.id && event.data.status === 'failed').length, 1);
    assert.equal(parent.events.some(event => event.type === 'subagent/finished' && event.data.status === 'completed'), false);
  } finally {
    await child.endTurn('interrupted');
  }
});
