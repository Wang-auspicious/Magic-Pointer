import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

async function main() {
  let observed: unknown;
  const context: any = { window: { magicPointerDashboard: { conversations: {
    respond: async (payload: unknown) => { observed = payload; return { ok: true, accepted: true }; },
  } } } };
  const code = ts.transpileModule(fs.readFileSync('electron/renderer/data.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code + '\nglobalThis.api = Data;', context);
  const payload = { conversationId: 'c', requestId: 'ask-1', requestToken: 'response-1', response: { decision: 'once' } };
  assert.equal(typeof context.api.respondConversation, 'function', 'interactive answers need their own bound runtime response channel');
  const response = await context.api.respondConversation(payload);
  assert.equal(observed, payload);
  assert.equal(response.accepted, true);
  console.log('Conversation structured response transport passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
