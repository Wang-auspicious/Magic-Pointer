import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventSession } from '../electron/runtime/session';
import { readAgentStatus, respondToAgent } from '../electron/runtime/agent_background';

test('an approval can be recorded after an awaiting child worker exits, then resumed explicitly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-agent-crashed-approval-'));
  const parent = await EventSession.open(root, 'parent');
  const child = await EventSession.open(root, 'child', true, parent.id);
  await parent.append('subagent/created', { childSessionId: child.id, task: 'Write result', readonly: false });
  await child.append('permission/requested', { requestId: 'write-result', pendingInput: { kind: 'permission', tool: 'Bash',
    requestId: 'write-result', question: 'Allow Bash?', options: ['once', 'grant', 'deny'], harnessPermission: true,
    action: { tool: 'Bash', arguments: { command: 'echo result>out.txt' } } } });
  await writeFile(path.join(root, 'agent-sessions', 'child.agent.json'), JSON.stringify({ id: child.id, status: 'awaiting_user', pid: 99999999 }));
  const stopped = await readAgentStatus(root, child.id);
  assert.equal(stopped?.status, 'stopped');
  assert.equal(stopped?.resumeRequired, true);
  assert.equal((stopped?.pendingInput as { requestId: string })?.requestId, 'write-result');
  const accepted = await respondToAgent(root, parent.id, child.id, 'write-result', { decision: 'once' });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.resumeRequired, true);
  await child.refresh();
  assert.equal(child.pendingInput(), null);
  assert.deepEqual(child.approvedCalls().map(call => call.name), ['Bash']);
});
