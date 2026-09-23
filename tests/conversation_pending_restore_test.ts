import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const source = fs.readFileSync('electron/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'restoreConversationContext');
assert.ok(node);
async function main() {
  let pending: any = { requestId: 'real-ask', question: 'Format?', options: ['Brief', 'Full'] };
  let persisted: any;
  const context = { path, FABRIC_DATA_DIR: 'fixture', restoredContextUsage: new Map(),
    fs: { promises: { stat: async () => ({ mtimeMs: 1 }) } },
    conversations: () => ({ updateTurn: (value: any) => { persisted = value; }, flush() {} }),
    handleSessionRead: async () => ({ ok: true, pendingInput: pending, lastInputAnswer: pending ? null : {
      requestId: 'real-ask', message: { content: '{"answered":true,"awaitingUserInput":false}' },
    } }),
  };
  vm.runInNewContext(ts.transpileModule(node!.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const conversation = { id: 'conv-1', agentSessionId: 'agent-studio-new-1', turns: [{ pendingInput: { question: 'Format?' }, modelUsage: { contextTokens: 20 },
    trajectory: [{ kind: 'tool', callId: 'real-ask', result: '{"awaitingUserInput":true}' }],
  }] };
  const restored = await (context as any).restoreConversationContext(conversation);
  assert.equal(restored.turns[0].pendingInput.requestId, 'real-ask', 'legacy pending cards recover the real tool call id');
  const interruptedBeforeCard = { ...conversation, turns: [{ outcome: '可恢复', modelUsage: { contextTokens: 20 }, trajectory: [] }] };
  const recoveredCard = await (context as any).restoreConversationContext(interruptedBeforeCard);
  assert.equal(recoveredCard.turns[0].pendingInput?.requestId, 'real-ask', 'a durable pending input must reappear even if the conversation store crashed before saving its card');
  pending = null;
  const consumed = await (context as any).restoreConversationContext(conversation);
  assert.equal(consumed.turns[0].pendingInput, undefined, 'a durable answer accepted before desktop crash cannot reappear');
  assert.equal(persisted.pendingInput, null);
  assert.equal(JSON.parse(consumed.turns[0].trajectory[0].result).answered, true);
  console.log('Conversation pending state restoration passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
