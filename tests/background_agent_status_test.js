const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readBackgroundAgents } = require('../electron/background_agents');
const { EventSession } = require('../electron/runtime/session');

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-agent-status-'));
  const root = path.join(data, 'agent-sessions');
  fs.mkdirSync(root);
  try {
    const child = await EventSession.open(data, 'child', true, 'parent');
    await child.append('permission/requested', { requestId: 'call', pendingInput: { requestId: 'call', kind: 'permission', tool: 'Bash',
      question: 'Allow Bash?', options: ['once', 'grant', 'deny'], harnessPermission: true,
      action: { tool: 'Bash', arguments: { command: 'echo exact>out.txt' } } } });
    fs.writeFileSync(path.join(root, 'child.agent.json'), JSON.stringify({
      id: 'child', parentSessionId: 'parent', status: 'awaiting_user', pid: process.pid,
      pendingInput: { requestId: 'call', kind: 'permission', actionPreview: 'exact command' },
    }));
    const active = await readBackgroundAgents(root, 'parent', () => true);
    assert.equal(active[0].status, 'awaiting_user');
    assert.equal(active[0].pendingInput.requestId, 'call');
    assert.equal((await readBackgroundAgents(root, 'other')).length, 0);
    const dead = await readBackgroundAgents(root, 'parent', () => false);
    assert.equal(dead[0].status, 'stopped', 'exited worker must not display Running forever');
    assert.equal(dead[0].pendingInput.requestId, 'call', 'the original request remains answerable after worker exit');
    assert.equal(dead[0].resumeRequired, true);
    await child.answer('call', { decision: 'once' });
    const answered = await readBackgroundAgents(root, 'parent', () => false);
    assert.equal(answered[0].pendingInput, null);
    assert.equal(answered[0].answerSaved, true, 'the saved answer stays visible after a GUI restart');
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
