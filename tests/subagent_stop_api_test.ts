import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = fs.readFileSync('electron/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const node = ast.statements.find(node => node.getText(ast).startsWith("ipcMain.handle('conversations:stop-subagent'"));
assert.ok(node, 'a child needs its own stop channel');
async function main() {
  let invoke: any; let payload: any;
  const sandbox = { ipcMain: { handle: (_: string, callback: any) => { invoke = callback; } },
    dashboardWindow: null, companionWindow: null, isConversationSender: () => true,
    conversations: () => ({ get: (id: string) => id === 'conversation' ? { agentSessionId: 'real-parent' } : null }),
    runRuntimeBridgePromise: async (value: any) => { payload = value; return { ok: true, sessionId: value.sessionId, turn: 2 }; },
  };
  vm.runInNewContext(ts.transpileModule(node!.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  assert.equal((await invoke({}, { conversationId: 'missing', subagentId: 'child' })).ok, false);
  assert.equal(payload, undefined);
  const result = await invoke({}, { conversationId: 'conversation', subagentId: 'child', parentSessionId: 'spoofed' });
  assert.equal(result.ok, true);
  assert.equal((payload as any).action, 'cancel');
  assert.equal((payload as any).sessionId, 'child');
  assert.equal((payload as any).parentSessionId, 'real-parent', 'ownership comes from the saved task, never renderer claims');
  let transported: any;
  const dataContext: any = { window: { magicPointerDashboard: { conversations: { stopSubagent: async (value: any) => { transported = value; return result; } } } }, console };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('electron/renderer/data.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\nglobalThis.dataApi = Data;', dataContext);
  const answer = await dataContext.dataApi.stopSubagent({ conversationId: 'conversation', subagentId: 'child' });
  assert.equal(answer.ok, true);
  assert.equal(transported.subagentId, 'child');
  console.log('Subagent stop API binding passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
