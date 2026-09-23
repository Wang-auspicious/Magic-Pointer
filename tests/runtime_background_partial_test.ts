import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventSession } from '../electron/runtime/session';
import { readAgentStatus, runBackgroundAgent } from '../electron/runtime/agent_background';

test('background child with unfinished receipt reports partial to its parent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-agent-partial-')), workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const parent = await EventSession.open(root, 'parent'), child = await EventSession.open(root, 'child', true, parent.id);
  await parent.append('subagent/created', { childSessionId: child.id, task: 'Prepare and verify', readonly: true });
  await writeFile(path.join(root, 'agent-sessions', 'child.agent.json'), JSON.stringify({ id: child.id, status: 'starting', startedAt: Date.now() }));
  const plugin = path.join(root, 'data', 'plugins', 'partial'); await mkdir(plugin, { recursive: true });
  await writeFile(path.join(plugin, 'plugin.json'), JSON.stringify({ main: 'entry.cjs' }));
  const schemasFile = path.join(root, 'child-schemas.json');
  await writeFile(path.join(plugin, 'entry.cjs'), `module.exports={name:'partial',async apply(ctx){let calls=0;await ctx.provideUp('llm',async request=>{if(++calls===1)require('node:fs').writeFileSync(${JSON.stringify(schemasFile)},JSON.stringify(request.tools.map(tool=>tool.name)));return calls===1?{text:'',tool_calls:[{id:'todo',name:'Todo',arguments:{todos:[{content:'Verify result',status:'in_progress'}]}}],usedBackend:'fixture.partial'}:{text:'Draft ready',tool_calls:[],usedBackend:'fixture.partial'}})}}`);
  await writeFile(path.join(root, 'data', 'harness.patch.json'), JSON.stringify({ schemaVersion: 1, patch: { 'llm-provider': { disabled: true } } }));
  await runBackgroundAgent({ root, userDataDir: root, workspace, sessionId: child.id, parentId: parent.id,
    instruction: 'Prepare and verify', readonly: true, permissionMode: 'safe', parentCallId: 'delegate', config: { model: 'fixture' } });
  await child.refresh();
  const toolNames = JSON.parse(await readFile(schemasFile, 'utf8')) as string[];
  assert.ok(toolNames.includes('ToolResult.read'));
  assert.ok(toolNames.includes('Read'));
  assert.ok(toolNames.includes('Tools'));
  assert.ok(!toolNames.includes('Bash'));
  assert.equal([...child.events].reverse().find(event => event.type === 'receipt/issued')?.data.status, 'partial');
  const status = await readAgentStatus(root, child.id);
  assert.equal(status?.status, 'partial');
  await parent.refresh();
  assert.equal(parent.events.find(event => event.type === 'subagent/finished')?.data.status, 'partial');
});
