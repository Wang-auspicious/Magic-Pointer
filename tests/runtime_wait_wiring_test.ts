import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runRuntime } from '../electron/runtime/index';

test('production runtime can discover and wait for an authorized file without polling the model', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mp-wait-wiring-'));
  const workspace = path.join(root, 'workspace'), plugins = path.join(root, 'data/plugins/provider');
  await mkdir(workspace); await mkdir(plugins, { recursive: true });
  await writeFile(path.join(plugins, 'plugin.json'), JSON.stringify({ main: 'plugin.cjs' }));
  await writeFile(path.join(root, 'data/harness.patch.json'), JSON.stringify({ schemaVersion: 1, patch: { 'llm-provider': { disabled: true } } }));
  await writeFile(path.join(plugins, 'plugin.cjs'), `module.exports={name:'provider',apply:async ctx=>{let turn=0;await ctx.provideUp('llm',async request=>{
    if(++turn===1)return {text:'',tool_calls:[{id:'load',name:'Tools',arguments:{names:['wait']}}]};
    if(turn===2){if(!request.tools.some(tool=>tool.name==='wait'))throw Error('wait not available');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(path.join(workspace, 'ready.txt'))},'READY'),150);return {text:'',tool_calls:[{id:'wait',name:'wait',arguments:{file_exists:'ready.txt',timeout_s:2,poll_ms:25}}]};}
    const value=JSON.parse(request.messages.at(-1).content);if(!value.satisfied||value.condition!=='file_exists')throw Error('wait did not observe file');return {text:'Ready observed',tool_calls:[]};});}}`);
  const result = await runRuntime({ question: 'Wait for ready.txt', workspaceRoot: workspace, conversationId: 'wait', permissionPreset: 'read-only' }, { root, userDataDir: root });
  assert.equal(result.answer, 'Ready observed');
  assert.equal(result.hasPendingWork, false);
});
