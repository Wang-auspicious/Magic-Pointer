'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

let receive;
const dataContext = { window: { magicPointerDashboard: { conversations: { onTurn: callback => { receive = callback; } } } } };
vm.runInNewContext(compile(fs.readFileSync('electron/renderer/data.ts', 'utf8')) + '\nglobalThis.api = Data;', dataContext);
let observed;
dataContext.api.onChange(event => { observed = event; });
const event = { id: 'selection-c1', turnIndex: 0, liveProgress: { answer: 'partial', records: [] } };
receive(event);
assert.equal(observed, event, 'Data must preserve the conversation id and live snapshot');

/* Windows 检出（core.autocrlf=true）下 studio.ts 是 CRLF，下面用 '\n}\n' 定位函数
   结尾会一条都匹配不到、切出空片段，测试就以「不是函数」这种和真实缺陷无关的方式失败。 */
const studio = fs.readFileSync('electron/renderer/studio.ts', 'utf8').replace(/\r\n/g, '\n');
const start = studio.indexOf('async function refreshOpenConversation(');
assert.ok(start >= 0, 'conversation changes must update the current open conversation');
const end = studio.indexOf('\n}\n', start) + 2;
const calls = [];
const recoveryCalls = [];
let taskPaints = 0;
let diskTurn = { question: 'What is here?', answer: 'Final disk answer' };
const context = {
  activeConversationId: 'selection-c1',
  activeConversationTurns: [{ question: 'What is here?', outcome: '进行中' }],
  activeConversationView: { update: value => { calls.push(value); } },
  activeConversationRecord: { id: 'selection-c1', turns: [] },
  conversationRefreshSequence: 0,
  composerPlan: null,
  pendingConversation: null,
  activeConversationTurnCount: 1,
  inspectorState: { open: true }, activeInspectorTab: 'tasks',
  Data: { conversation: async id => ({ id, turns: [diskTurn] }) },
  followIfNearBottom: (_body, mutate) => mutate(),
  document: { getElementById: id => id === 'stream' ? {} : null },
  syncExternalConversationRun() {}, renderUsageMeter() {}, renderProjectTasks() { taskPaints++; },
  renderConversationRecovery: async id => { recoveryCalls.push(id); },
  setActiveTaskContext() {},
  pendingPermissionAsk: null, pendingAskInput: null, renderPermissionAsk() {},
  renderPlanCard() {},
};
vm.runInNewContext(compile(fs.readFileSync('electron/renderer/plan_list.ts', 'utf8')), context);
vm.runInNewContext(compile(studio.slice(start, end)), context);
const requestIdStart = studio.indexOf('function pendingToolRequestId(');
assert.ok(requestIdStart >= 0);
const requestIdEnd = studio.indexOf('\n}\n', requestIdStart) + 2;
vm.runInNewContext(compile(studio.slice(requestIdStart, requestIdEnd)), context);
const pendingStart = studio.indexOf('function syncConversationPendingInput(');
if (pendingStart >= 0) {
  const pendingEnd = studio.indexOf('\n}\n', pendingStart) + 2;
  vm.runInNewContext(compile(studio.slice(pendingStart, pendingEnd)), context);
}
(async () => {
  await context.refreshOpenConversation(event);
  assert.equal(calls.at(-1).turns[0].liveProgress.answer, 'partial');
  assert.equal(recoveryCalls.length, 0, 'streaming chunks must not query recovery state');
  assert.equal(taskPaints, 1, 'external child progress must refresh the visible Tasks panel');
  context.inspectorState.open = false;
  await context.refreshOpenConversation(event);
  assert.equal(taskPaints, 1, 'hidden Tasks panel must not paint each external snapshot');
  await context.refreshOpenConversation({ id: 'selection-c1' });
  assert.equal(calls.at(-1).turns[0].answer, 'Final disk answer');
  assert.deepEqual(recoveryCalls, ['selection-c1'], 'a settled task refreshes its recovery panel');
  diskTurn = { answer: 'Updated plan', trajectory: [{ kind: 'tool', callId: 'plan-1', name: 'Todo', state: 'done', text: '{"todos":[{"content":"Verify notes","status":"blocked"}]}' }] };
  await context.refreshOpenConversation({ id: 'selection-c1' });
  assert.equal(context.composerPlan.steps[0].content, 'Verify notes', 'settled external updates project the durable plan into the task rail');
  assert.equal(context.composerPlan.steps[0].anchorToolUseId, 'plan-1');
  diskTurn = { answer: 'Waiting for approval', pendingInput: { kind: 'permission', requestId: 'permission-1', tool: 'write_file', prefix: 'notes', question: 'Save these notes?', options: ['Once', 'Always', 'Deny'] } };
  await context.refreshOpenConversation({ id: 'selection-c1' });
  assert.equal(context.pendingPermissionAsk?.tool, 'write_file', 'external task settling to approval must project its pending permission without reopening');
  assert.equal(context.pendingPermissionAsk.question, 'Save these notes?');
  assert.equal(context.pendingPermissionAsk.requestId, 'permission-1', 'the durable approval request id survives external refresh');
  assert.equal(context.pendingPermissionAsk.options.join(','), 'Once,Always,Deny');
  diskTurn = { answer: 'Choose a format', trajectory: [{ kind: 'tool', name: 'AskUser', callId: 'ask-1' }], pendingInput: { question: 'Which format?', options: ['Brief', 'Detailed'] } };
  await context.refreshOpenConversation({ id: 'selection-c1' });
  assert.equal(context.pendingPermissionAsk, null);
  assert.equal(context.pendingAskInput.question, 'Which format?');
  assert.equal(context.pendingAskInput.requestId, 'ask-1', 'older saved questions recover the id of their originating tool');
  diskTurn = { answer: 'Done' };
  await context.refreshOpenConversation({ id: 'selection-c1' });
  assert.equal(context.pendingAskInput, null, 'settled result must clear stale approval or question cards');
  const count = calls.length;
  const recoveryCount = recoveryCalls.length;
  await context.refreshOpenConversation({ id: 'another-task' });
  assert.equal(calls.length, count, 'other task notifications must not replace the current answer');
  assert.equal(recoveryCalls.length, recoveryCount, 'other task notifications must not replace recovery state');
  console.log('Studio external turn refresh tests ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
