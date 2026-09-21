const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readBackgroundAgents } = require('../electron/background_agents');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-agent-status-'));
  try {
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
    assert.equal(dead[0].pendingInput, undefined, 'an exited worker cannot consume an answer');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
