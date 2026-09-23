import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const { createConversationStore } = require('../electron/conversation_store');
const control = require('../electron/conversation_control');
const source = fs.readFileSync('electron/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const functions = ['respondConversation', 'sendConversation'];
const nodes = functions.map(name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name));
assert.ok(nodes.every(Boolean), 'the response IPC must resume an existing pending call');
const code = ts.transpileModule(nodes.map(node => node!.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

async function main() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-input-response-'));
  try {
    const store = createConversationStore({ baseDir });
    const initial = store.appendTurn({ newConversation: true, question: 'Prepare report', answer: 'Choose format',
      agentSessionId: 'agent-studio-new-fixture', outcome: '等待输入',
      trajectory: [{ kind: 'message', turn: 1, text: 'Choose format' },
        { kind: 'tool', callId: 'earlier', name: 'Read', result: 'source preserved' },
        { kind: 'tool', callId: 'ask-1', name: 'AskUser', result: JSON.stringify({ awaitingUserInput: true, question: 'Format?' }) }],
      pendingInput: { requestId: 'ask-1', question: 'Format?', options: ['Brief', 'Detailed'] } });
    let callbacks: any; let bridgePayload: any; let calls = 0; let accepted = false;
    const delivered: any[] = [];
    const context: any = { path, Buffer, console, Date, Set, Map, FABRIC_DATA_DIR: baseDir,
      crypto: { randomUUID: () => 'response-stream' }, inputResponseRuns: new Set(),
      normalizeConversationEffort: () => 'medium', ...control,
      resolveConversationWorkspace: () => '', studioConversationSessionId: ({ existing }: any) => existing,
      activeModelRuntimeConfig: () => ({ model: 'fake' }),
      TaskSources: { bindConversationTaskInput: () => { throw new Error('Response is not a user instruction'); } },
      conversations: () => store, activeConversations: new Map(),
      figmaRuntime: { clientConfigurations: () => [] }, notifyConversationChanged() {},
      handleAgentCursorProgress() {}, conversationFailureMessage: (value: any) => value.error || 'failed',
      setTimeout: () => 1, clearTimeout() {},
      handleSessionRead: async () => ({ ok: true, openTurn: accepted ? null : 1,
        pendingInput: accepted ? null : { requestId: 'ask-1' }, answeredInputIds: accepted ? ['ask-1'] : [] }),
      runRuntimeBridge: (payload: any, _file: any, _target: any, cb: any) => { calls++; bridgePayload = payload; callbacks = cb; return {}; },
    };
    vm.runInNewContext(code, context);
    const sender = { isDestroyed: () => false, send: (_: string, value: any) => delivered.push(value) };
    const request = { conversationId: initial.id, requestId: 'ask-1', requestToken: 'stream-1', response: { answers: { 'Format?': 'Detailed' } } };
    const response = context.respondConversation(request, sender);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(store.get(initial.id).turns.length, 1, 'answer continues the original visible turn');
    assert.equal(bridgePayload.question, '');
    assert.equal(bridgePayload.inputResponse.requestId, 'ask-1');
    assert.equal(bridgePayload.agentSessionId, 'agent-studio-new-fixture');
    const overlapping = await context.respondConversation(request, sender);
    assert.equal(overlapping.accepted, false);
    callbacks.onComplete({ ok: false, error: 'invalid_input_response', accepted: false });
    assert.equal((await response).accepted, false);
    assert.equal(store.get(initial.id).turns[0].pendingInput.requestId, 'ask-1', 'rejection leaves the original card retryable');
    assert.equal(JSON.parse(store.get(initial.id).turns[0].trajectory[2].result).awaitingUserInput, true);
    const retry = context.respondConversation(request, sender);
    await new Promise(resolve => setImmediate(resolve));
    accepted = true;
    const toolAnswer = JSON.stringify({ requestId: 'ask-1', awaitingUserInput: false, answered: true, answers: { 'Format?': 'Detailed' } });
    callbacks.onProgress({ phase: 'user_input_accepted', fields: { b64: Buffer.from(JSON.stringify({ requestId: 'ask-1', message: { content: toolAnswer } })).toString('base64') } });
    assert.equal(store.get(initial.id).turns[0].pendingInput, undefined, 'durable acknowledgement consumes the card immediately');
    assert.equal(store.get(initial.id).turns[0].trajectory[2].result, toolAnswer, 'the original AskUser result becomes the accepted answer');
    assert.equal(store.get(initial.id).turns[0].trajectory[1].result, 'source preserved');
    assert.equal(delivered.at(-1).requestId, 'stream-1');
    assert.equal(delivered.at(-1).turnIndex, 0);
    callbacks.onComplete({ ok: false, error: 'provider failed', accepted: true });
    assert.equal((await retry).accepted, true, 'model failure cannot resurrect a consumed input');
    assert.equal(store.get(initial.id).turns[0].question, 'Prepare report');
    assert.equal(store.get(initial.id).turns[0].trajectory[0].text, 'Choose format');
    assert.equal(store.get(initial.id).turns[0].trajectory[2].result, toolAnswer, 'settlement cannot restore an unanswered tool result');
    const duplicate = await context.respondConversation(request, sender);
    assert.equal(duplicate.accepted, true);
    assert.equal(duplicate.alreadyAccepted, true);
    assert.equal(calls, 2, 'duplicate acknowledgement never starts another model loop');
    console.log('Conversation structured responses passed');
  } finally { fs.rmSync(baseDir, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
