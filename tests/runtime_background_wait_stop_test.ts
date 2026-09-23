import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventSession } from '../electron/runtime/session';
import { readAgentStatus, runBackgroundAgent, stopAgent } from '../electron/runtime/agent_background';

test('stopping a child waiting for approval settles the parent task', { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-agent-wait-stop-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const parent = await EventSession.open(root, 'parent');
  const child = await EventSession.open(root, 'child', true, parent.id);
  await parent.append('subagent/created', { childSessionId: child.id, task: 'Request a write', readonly: false });
  await writeFile(path.join(root, 'agent-sessions', 'child.agent.json'), JSON.stringify({ id: child.id, status: 'starting', startedAt: Date.now() }));
  const pluginDir = path.join(root, 'data', 'plugins', 'wait-stop');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({ main: 'entry.cjs' }));
  await writeFile(path.join(pluginDir, 'entry.cjs'), `module.exports={name:'wait-stop',async apply(ctx){
    ctx.get('tools').register({name:'FixtureWrite',description:'Fixture write',effect:'local_irreversible',input_schema:{type:'object',properties:{},required:[]},execute:()=>({ok:true})});
    await ctx.provideUp('llm',async()=>({text:'',tool_calls:[{id:'write-request',name:'FixtureWrite',arguments:{}}],usedBackend:'fixture.wait-stop'}));
  }}`);
  await writeFile(path.join(root, 'data', 'harness.patch.json'), JSON.stringify({ schemaVersion: 1, patch: { 'llm-provider': { disabled: true } } }));
  const running = runBackgroundAgent({ root, userDataDir: root, workspace, sessionId: child.id, parentId: parent.id,
    instruction: 'Request a write', readonly: false, permissionMode: 'default', parentCallId: 'delegate', config: { model: 'fixture' } });
  let status;
  for (let i = 0; i < 100; i++) {
    status = await readAgentStatus(root, child.id);
    if (status?.status === 'awaiting_user') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(status?.status, 'awaiting_user');
  await stopAgent(root, parent.id, child.id);
  await running;
  await parent.refresh();
  await child.refresh();
  assert.equal(child.pendingInput(), null, 'Stop cancels the old approval before a later resume');
  assert.equal(child.approvedCalls().length, 0);
  assert.equal((await readAgentStatus(root, child.id))?.status, 'user_interrupt');
  assert.equal(parent.events.filter(event => event.type === 'subagent/finished' && event.data.childSessionId === child.id && event.data.status === 'user_interrupt').length, 1);
  assert.equal(parent.pendingInbox('next-step').filter(item => String(item.text).includes('child user_interrupt')).length, 1);
});
