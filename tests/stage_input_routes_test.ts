import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = fs.readFileSync('electron/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const nodes = ast.statements.filter(node => (ts.isFunctionDeclaration(node) && node.name?.text === 'conversationForSelection')
  || node.getText(ast).startsWith("ipcMain.handle('stage:respond-input'")
  || node.getText(ast).startsWith("ipcMain.handle('stage:open-artifact'"));
assert.equal(nodes.length, 3, 'Stage answers and artifact opening must bind to the captured task');
async function main() {
  const handlers = new Map<string, any>(); let shown: any; let response: any; let read: any;
  const context = { ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn) },
    isSurfaceSender: () => true, resultTargetWindow: null, activeSessionAgentIds: new Map(), stageLiveTurns: new Map(),
    selectionSessions: { get: (token: string) => token === 'scene-1' ? { taskId: 'agent-captured' } : null },
    conversations: () => ({ list: () => [{ id: 'conv-other', agentSessionId: 'agent-other' }, { id: 'conv-captured', agentSessionId: 'agent-captured' }],
      get: (id: string) => ({ id }) }),
    respondConversation: async (payload: any) => { response = payload; return { ok: true, accepted: true, conversationId: payload.conversationId }; },
    artifactCommands: () => ({ read: async (payload: any) => { read = payload; return payload.artifactId === 'ours' ? { ok: true } : { ok: false, error: 'artifact_not_found' }; } }),
    showDashboard: (payload: any) => { shown = payload; },
  };
  vm.runInNewContext(ts.transpileModule(nodes.map(node => node.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  assert.equal((await handlers.get('stage:respond-input')({}, { selectionSessionToken: 'expired' })).accepted, false);
  await handlers.get('stage:respond-input')({ sender: {} }, { selectionSessionToken: 'scene-1', conversationId: 'wrong', requestId: 'ask-1' });
  assert.equal(response.conversationId, 'conv-captured');
  assert.equal((await handlers.get('stage:open-artifact')({}, { selectionSessionToken: 'scene-1', artifactId: 'other-task' })).ok, false);
  assert.equal(shown, undefined);
  await handlers.get('stage:open-artifact')({}, { selectionSessionToken: 'scene-1', artifactId: 'ours' });
  assert.equal(read.conversationId, 'conv-captured');
  assert.equal((shown as any).conversationId, 'conv-captured');
  assert.equal((shown as any).artifactId, 'ours');
  console.log('Stage bound input and artifact routes passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
