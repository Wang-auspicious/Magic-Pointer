import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const ast = ts.createSourceFile('studio.ts', source, ts.ScriptTarget.Latest, true);
let submit: ts.Node | undefined;
const visit = (node: ts.Node) => {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'form.addEventListener'
    && node.arguments[0].getText(ast) === "'submit'") submit = node.arguments[1];
  ts.forEachChild(node, visit);
};
visit(ast); assert.ok(submit);
const submitCode = ts.transpileModule(`globalThis.submit = ${submit.getText(ast)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const steer = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'steerActiveConversation');
assert.ok(steer);
const steerCode = ts.transpileModule(steer.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const detach = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'detachPendingConversation');
assert.ok(detach);
const detachCode = ts.transpileModule(detach.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const continuationCode = ['respondToPendingInput', 'syncConversationPendingInput'].map(name => {
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration);
  return ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}).join('\n');

function node() { return { className: '', dataset: {}, appendChild() {}, replaceChildren() {}, setAttribute() {}, removeAttribute() {}, querySelector: () => null }; }
function setup() {
  let finish!: (response: any) => void;
  let queued!: () => void;
  const textarea = { value: 'original request', focus() {} };
  const flow = node(); const stream = { ...node(), querySelector: () => flow };
  const opened: string[] = [];
  const settled: string[] = [];
  let suggestions = 0;
  let responses = 0;
  let questionVisible = false;
  let durable: any = { id: 'old', turns: [] };
  const context: any = {
    form: { ...node(), querySelector: () => textarea }, document: { getElementById: () => stream, createElement: node, querySelector: () => flow },
    window: { clearTimeout() {} },
    Data: { sendConversation: () => new Promise(resolve => { finish = resolve; }),
      conversation: async () => durable,
      respondConversation: async () => { responses++; return { ok: false, accepted: false, error: 'input_response_in_progress' }; } },
    DecisionCard: { pending() {}, clear() { questionVisible = false; } },
    DshChat: { userNode: node, liveActivityNode: node, createLiveTurn: () => ({}), turnErrorNode: node },
    ConversationControl: { createTranscript: () => ({}), failedDraftValue: (_: unknown, value: string) => value },
    TaskInputTransport: { createTaskInputTransport: () => ({ submit: async (_: unknown, options: any) => { queued = options.onAccepted; } }) },
    buildStudioTaskInput: () => ({}), attachmentSourcesForTask: () => [],
    studioTaskInputSequence: 0, composerAttachments: [], composerSelectedSourceIds: new Set(),
    pendingConversation: null, externalConversationRun: null, studioComposerBusy: false,
    activeConversationId: 'old', activeTaskContext: null, composerPreset: 'workspace-write', composerEffort: 'medium',
    pendingPermissionChoice: null, pendingPermissionAsk: null, pendingAskInput: null, pendingRenderTimer: null,
    setStudioHomeVisible() {}, scheduleStreamRail() {}, fitComposer() {}, clearComposerSuggestion() {},
    setComposerRunningState() {}, startPendingClock() {}, stopPendingClock() {}, renderConversationProgress() {},
    prepareComposerWorktree: async () => '',
    renderPermissionAsk() { questionVisible = Boolean(context.pendingAskInput || context.pendingPermissionAsk); },
    renderComposerAttachments() {}, renderComposerMaterials() {},
    openConversation: async (id: string) => { opened.push(id); }, renderSidebar: async () => {},
    setComposerSettledState: (state: string) => settled.push(state), refreshComposerSuggestion: () => { suggestions++; },
    activeConversationTurns: [], activeConversationTurnCount: 1, activeConversationRecord: {}, activeConversationObject: {},
  };
  vm.runInNewContext(submitCode + steerCode + detachCode + continuationCode, context);
  return { context, textarea, opened, settled, suggestions: () => suggestions, responses: () => responses,
    questionVisible: () => questionVisible, setDurable: (value: any) => { durable = value; },
    finish: (response: any) => finish(response), accepted: () => queued() };
}

async function main() {
  for (const source of ['local', 'external']) {
    const guarded = setup();
    const active = { requestId: 'new-message', body: node() };
    guarded.context.studioComposerBusy = true;
    guarded.context[source === 'local' ? 'pendingConversation' : 'externalConversationRun'] = active;
    await guarded.context.respondToPendingInput('old', 'old-ask', { answers: { Format: 'Brief' } });
    assert.equal(guarded.responses(), 0, 'a stale question click must not submit while a message is running');
    assert.equal(guarded.context[source === 'local' ? 'pendingConversation' : 'externalConversationRun'], active);
    assert.equal(guarded.context.studioComposerBusy, true, 'stale decision cleanup must not detach the live message');
  }
  const oldQuestion = { requestId: 'old-ask', question: 'Format?', options: ['Brief', 'Detailed'] };
  for (const failure of ['preparation', 'validation', 'provider']) {
    const pending = setup();
    pending.context.syncConversationPendingInput([{ pendingInput: oldQuestion }]);
    pending.setDurable({ id: 'old', turns: failure === 'provider'
      ? [{ pendingInput: oldQuestion }, { answer: '', failed: true }]
      : [{ pendingInput: oldQuestion }] });
    if (failure === 'preparation') pending.context.prepareComposerWorktree = async () => { throw new Error('worktree rejected'); };
    const sending = pending.context.submit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    if (failure !== 'preparation') {
      assert.equal(pending.questionVisible(), false, 'starting a new message must hide the superseded question');
      const active = pending.context.pendingConversation;
      await pending.context.respondToPendingInput('old', 'old-ask', { answers: { 'Format?': 'Brief' } });
      assert.equal(pending.context.pendingConversation, active, 'a retained old callback cannot detach the new message');
      pending.finish({ ok: false, error: failure, ...(failure === 'provider' ? { conversationId: 'old' } : {}) });
    }
    await sending;
    assert.equal(pending.questionVisible(), failure !== 'provider', 'only a still-pending durable question may be restored after failure');
    assert.equal(pending.context.studioComposerBusy, false);
  }
  const navigatedRecovery = setup();
  navigatedRecovery.context.syncConversationPendingInput([{ pendingInput: oldQuestion }]);
  let restore!: (value: any) => void;
  navigatedRecovery.context.Data.conversation = () => new Promise(resolve => { restore = resolve; });
  const recovery = navigatedRecovery.context.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  navigatedRecovery.finish({ ok: false, error: 'validation' });
  await new Promise(resolve => setImmediate(resolve));
  const nextDuringRestore = { requestId: 'new-task', body: node() };
  navigatedRecovery.context.pendingConversation = nextDuringRestore;
  navigatedRecovery.context.activeConversationId = 'new-task';
  navigatedRecovery.context.pendingAskInput = null;
  restore({ id: 'old', turns: [{ pendingInput: oldQuestion }] });
  await recovery;
  assert.equal(navigatedRecovery.context.pendingAskInput, null, 'late durable recovery cannot show an old question in a new task');
  assert.equal(navigatedRecovery.context.pendingConversation, nextDuringRestore);
  const normal = setup();
  normal.context.activeConversationId = null;
  const normalRun = normal.context.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  normal.finish({ ok: true, conversationId: 'created' }); await normalRun;
  assert.deepEqual(normal.opened, ['created']);
  assert.deepEqual(normal.settled, ['success']);
  assert.equal(normal.suggestions(), 1);
  assert.equal(normal.context.pendingConversation, null);
  assert.equal(normal.context.studioComposerBusy, false);
  for (const response of [{ ok: true, conversationId: 'old' }, { ok: false, conversationId: 'old', error: 'provider failed' }]) {
    const fixture = setup();
    const running = fixture.context.submit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    const next = { requestId: 'new-task', body: node() };
    fixture.context.pendingConversation = next;
    fixture.context.activeConversationId = 'new-task';
    fixture.context.composerAttachments = ['new attachment'];
    fixture.textarea.value = 'new draft';
    fixture.finish(response); await running;
    assert.equal(fixture.context.activeConversationId, 'new-task', 'an old send result must not reopen its conversation after navigation');
    assert.equal(fixture.context.pendingConversation, next, 'old cleanup must not clear the new running task');
    assert.equal(fixture.context.studioComposerBusy, true);
    assert.equal(fixture.textarea.value, 'new draft', 'old failure must not overwrite the new draft');
    assert.deepEqual(fixture.context.composerAttachments, ['new attachment']);
    assert.equal(fixture.opened.length, 0);
  }
  const model = setup();
  let finishCatalog!: () => void;
  model.context.refreshComposerModel = () => new Promise<void>(resolve => { finishCatalog = resolve; });
  const modelRun = model.context.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  model.finish({ ok: true, conversationId: 'old', command: { type: 'model' } });
  await new Promise(resolve => setImmediate(resolve));
  const nextModelTask = { requestId: 'new-task', body: node() };
  model.context.pendingConversation = nextModelTask;
  model.context.activeConversationId = 'new-task';
  model.context.composerAttachments = ['new attachment'];
  model.textarea.value = 'new draft';
  finishCatalog();
  await modelRun;
  assert.equal(model.opened.length, 0, 'a model command finishing its catalog refresh must not reopen a task after navigation');
  assert.equal(model.context.pendingConversation, nextModelTask);
  assert.equal(model.context.activeConversationId, 'new-task');
  assert.equal(model.context.studioComposerBusy, true);
  assert.equal(model.textarea.value, 'new draft');
  assert.deepEqual(model.context.composerAttachments, ['new attachment']);
  const fixture = setup();
  fixture.context.pendingConversation = { agentSessionId: 'agent-old', body: node() };
  await fixture.context.steerActiveConversation('original request', fixture.textarea);
  fixture.context.pendingConversation = { agentSessionId: 'agent-new', body: node() };
  fixture.context.composerAttachments = ['new attachment'];
  fixture.accepted();
  assert.equal(fixture.textarea.value, 'original request', 'late steer ACK must not clear text in another task, even when it happens to match');
  assert.deepEqual(fixture.context.composerAttachments, ['new attachment']);
  console.log('Studio pending navigation isolation passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
