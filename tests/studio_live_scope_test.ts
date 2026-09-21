import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const ast = ts.createSourceFile('studio.ts', source, ts.ScriptTarget.Latest, true);
const statement = ast.statements.find(node => node.getText(ast).startsWith('Data.onConversationProgress('));
assert.ok(statement);
const scopes: string[] = [];
const received: unknown[] = [];
let callback!: (payload: any) => void;
const context: any = {
  pendingConversation: { requestId: 'new-request', body: { replaceChildren() {} }, renderer: {}, transcript: {} },
  Data: { onConversationProgress: (value: typeof callback) => { callback = value; } },
  DshChat: { createLiveTurn: (_: unknown, scope: string) => { scopes.push(scope); return { scope }; } },
  renderConversationProgress: (record: unknown) => received.push(record),
};
vm.runInNewContext(ts.transpileModule(statement.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
callback({ requestId: 'new-request', conversationId: 'persisted-new', turnIndex: 0, record: { phase: 'model_request' } });
assert.equal(scopes[0], 'persisted-new#0', 'new task live rows must use the same durable scope as the settled conversation view');
const renderer = context.pendingConversation.renderer;
callback({ requestId: 'new-request', conversationId: 'persisted-new', turnIndex: 0, record: { phase: 'tool_call' } });
assert.equal(context.pendingConversation.renderer, renderer, 'later progress must preserve the renderer and its open disclosures');
callback({ requestId: 'other-request', conversationId: 'other-task', turnIndex: 0, record: { phase: 'tool_call' } });
assert.equal(scopes.length, 1, 'another task must not rebind the live view');
assert.equal(received.length, 2);
context.pendingConversation = { requestId: 'next-request', body: { replaceChildren() {} }, renderer: {}, transcript: {} };
callback({ requestId: 'next-request', conversationId: 'persisted-new', turnIndex: 1, record: { phase: 'model_request' } });
assert.equal(scopes[1], 'persisted-new#1', 'the next turn owns a separate expansion scope');
console.log('Studio live task scope passed');
