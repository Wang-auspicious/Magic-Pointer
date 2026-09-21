import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync('electron/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const handler = ast.statements.find(node => node.getText(ast).startsWith("ipcMain.handle('conversations:recovery'"));
assert.ok(handler);
const compiled = ts.transpileModule(handler.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

async function main() {
  let invoke!: (event: unknown, payload: any) => Promise<any>;
  let exists = false; let mtimeMs = 1; let bridgeCalls = 0; let failure = '';
  const sandbox: any = {
    ipcMain: { handle: (_: string, callback: typeof invoke) => { invoke = callback; } },
    isDashboardSender: () => true,
    conversations: () => ({ get: (id: string) => ({ id, agentSessionId: `agent-${id}` }) }),
    fs: { promises: { stat: async () => {
      if (!exists) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { mtimeMs };
    } } }, path, FABRIC_DATA_DIR: 'fixture', conversationRecoveryQueries: new Map(),
    notifyConversationChanged() {},
    runPythonBridgePromise: async () => {
      bridgeCalls++;
      if (!exists) throw new Error('session_not_found');
      if (failure) throw new Error(failure);
      return { ok: true, pendingRecovery: [] };
    },
  };
  vm.runInNewContext(compiled, sandbox);
  const missing = await invoke({}, { conversationId: 'missing' });
  assert.equal(missing.error, 'session_not_found', 'missing runtime evidence is reported honestly without rejecting IPC');
  assert.equal(bridgeCalls, 0, 'an absent session must not start a Python process on every historical open');
  exists = true;
  await Promise.all([invoke({}, { conversationId: 'one' }), invoke({}, { conversationId: 'one' })]);
  assert.equal(bridgeCalls, 1, 'concurrent reads of the same durable session must share one status query');
  await invoke({}, { conversationId: 'one' });
  assert.equal(bridgeCalls, 1, 'unchanged durable state must not launch another status process');
  await invoke({}, { conversationId: 'two' });
  assert.equal(bridgeCalls, 2, 'different task sessions never share a query');
  mtimeMs++;
  await invoke({}, { conversationId: 'one' });
  assert.equal(bridgeCalls, 3, 'new durable events invalidate the status result');
  await invoke({}, { conversationId: 'one', action: 'resolve', confirmed: true });
  await invoke({}, { conversationId: 'one' });
  assert.equal(bridgeCalls, 5, 'resolving recovery bypasses and invalidates the read cache');
  mtimeMs++; failure = 'bridge_no_output';
  const failed = await invoke({}, { conversationId: 'one' });
  assert.equal(failed.error, 'bridge_no_output');
  failure = '';
  await invoke({}, { conversationId: 'one' });
  assert.equal(bridgeCalls, 7, 'failed status queries can be retried');
  console.log('Conversation recovery queries passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
