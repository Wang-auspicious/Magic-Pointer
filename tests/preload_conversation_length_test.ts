import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
const exposed: any[] = [], calls: any[] = [];
const source = fs.readFileSync(path.resolve(__dirname, '../electron/preload.ts'), 'utf8');
vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
  require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, api: any) => exposed.push(api) },
    ipcRenderer: { invoke: (...args: any[]) => { calls.push(args); return Promise.resolve({}); }, on() {}, removeListener() {}, send() {} } }),
  process, console, setTimeout, clearTimeout,
});
const api = exposed.find((value) => value.conversations?.send);
assert.ok(api);
api.conversations.send({ question: '中'.repeat(12000) });
assert.equal(calls.at(-1)[1].question.length, 12000, 'preload transports the complete composer input');
api.conversations.steer({ text: '中'.repeat(12000), agentSessionId: 'agent-11111111-2222-3333-4444-555555555555' });
assert.equal(calls.at(-1)[1].text.length, 12000, 'steering uses the same complete composer input');
const { planConversationSteer } = require('../electron/conversation_control');
assert.equal(planConversationSteer({ text: '中'.repeat(12000), agentSessionId: 'agent-11111111-2222-3333-4444-555555555555' }).action, 'steer');
console.log('preload_conversation_length_test: passed');
