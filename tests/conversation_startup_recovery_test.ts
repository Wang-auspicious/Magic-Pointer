import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import test from 'node:test';

const { createConversationStore } = require('../electron/conversation_store');
const source = fs.readFileSync('electron/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const init = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'conversations');
assert.ok(init);
const code = ts.transpileModule(init.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-startup-recovery-'));
const baseDir = path.join(directory, 'history');
let now = 100;
const previous = createConversationStore({ baseDir, now: () => ++now });
const snapshot = (value: unknown) => JSON.parse(JSON.stringify(value));

try {
  const interrupted = ['studio', 'selection'].map(origin => previous.appendTurn({
    newConversation: true, question: `${origin}: read the notes`, outcome: '进行中',
    answer: 'Read one page.', thinking: 'Checking the second page.', agentSessionId: `agent-${origin}-audit`,
    hasPendingWork: true,
    request: {taskInput: {inputId: `input-${origin}`}, attachments: ['original-attachment.txt']},
    taskContext: { taskId: `agent-${origin}-audit`, referenceRevision: 0, sources: [], references: [] },
    trajectory: [{ kind: 'tool', name: 'read_file', state: 'running' }],
    receipts: [{ toolCallId: 'read-1', toolName: 'read_file', valuePreview: 'First page' }],
  }));
  const untouched = ['已完成', '失败', '等待输入', '已停止'].map(outcome => previous.appendTurn({
    newConversation: true, question: outcome, answer: 'Existing result', outcome,
    hasPendingWork: outcome !== '已完成',
    pendingInput: outcome === '等待输入' ? { kind: 'permission', question: 'Save?', tool: 'write_file' } : undefined,
  }));
  const historic = previous.appendTurn({ newConversation: true, question: 'Earlier task', outcome: '进行中' });
  previous.appendTurn({ conversationId: historic.id, question: 'Already resumed', answer: 'Done', outcome: '已完成', hasPendingWork: false });
  const before = interrupted.map(snapshot);
  const unchanged = untouched.map(snapshot);
  const context = { conversationStore: null, createConversationStore, path,
    app: { getPath: () => directory }, log() {} };
  const conversations = vm.runInNewContext(`${code}\nconversations`, context);
  const recovered = conversations();
  interrupted.forEach((old, index) => {
    const actual = recovered.get(old.id);
    assert.equal(actual.turns[0].outcome, '可恢复', 'startup must settle disk-only running turns without claiming success or a confirmed physical stop');
    assert.equal(actual.turns[0].failed, true);
    assert.match(actual.turns[0].error, /客户端.*中断/);
    assert.match(actual.turns[0].error, /继续/);
    assert.match(actual.turns[0].error, /结果.*核实/);
    assert.equal(actual.hasPendingWork, true);
    assert.equal(actual.resumePending, true, 'interrupted work must retain a durable startup redispatch marker');
    assert.deepEqual(actual.turns[0].request, {taskInput: {inputId: `input-${index === 0 ? 'studio' : 'selection'}`}, attachments: ['original-attachment.txt']}, 'the original dispatch inputs must survive a crash before the worker accepts them');
    assert.equal(actual.agentSessionId, before[index].agentSessionId);
    assert.deepEqual(actual.taskContext, before[index].taskContext);
    for (const key of ['answer', 'thinking', 'trajectory', 'receipts', 'at', 'startedAt']) {
      assert.deepEqual(actual.turns[0][key], before[index].turns[0][key], `recovery must retain ${key}`);
    }
    assert.equal(actual.turns[0].completedAt, undefined, 'restart time is not evidence of when execution ended');
    assert.equal(actual.updatedAt, before[index].updatedAt, 'opening the app must not reorder all interrupted tasks');
  });
  untouched.forEach((old, index) => assert.deepEqual(snapshot(recovered.get(old.id)), unchanged[index]));
  assert.equal(recovered.get(historic.id).turns[0].outcome, '可恢复');
  assert.equal(recovered.get(historic.id).hasPendingWork, false, 'a later completed turn supersedes the old unfinished turn');
  assert.deepEqual(recovered.pendingResumeIds().sort(), interrupted.map(item => item.id).sort());
  recovered.flush();
  assert.equal(createConversationStore({ baseDir }).get(interrupted[0].id).turns[0].outcome, '可恢复');
  assert.equal(createConversationStore({ baseDir }).get(interrupted[0].id).resumePending, true);

  const current = recovered.appendTurn({ newConversation: true, question: 'New owner is running', outcome: '进行中', hasPendingWork: true });
  assert.equal(conversations(), recovered);
  assert.equal(conversations().get(current.id).turns[0].outcome, '进行中', 'ordinary reads must never reconcile a task started in this process');
  recovered.flush();
  console.log('Conversation startup recovery tests ok');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

test('startup redispatches only unfinished work and restores terminal, waiting, and stopped turns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-startup-dispatch-'));
  try {
    let clock = 1000;
    const store = createConversationStore({baseDir: dir, now: () => ++clock});
    const entries = ['unfinished', 'completed', 'question', 'stopped', 'unavailable', 'queued', 'unstarted', 'answered'].map(kind => store.appendTurn({
      newConversation: true, question: kind, outcome: '进行中', answer: 'Saved partial answer',
      agentSessionId: `agent-${kind}`, hasPendingWork: true,
      ...(['queued', 'unstarted'].includes(kind) ? {request: {taskInput: {inputId: `${kind}-input`}, attachments: ['original.csv']}} : {}),
    }));
    store.updateTurn({conversationId: entries[7].id, outcome: '继续执行', resumePending: true});
    store.flush();
    assert.equal(createConversationStore({baseDir: dir}).get(entries[7].id).resumePending, true);
    store.recoverInterruptedTurns();
    const resumed: unknown[] = [];
    const notified: string[] = [];
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === 'resumeInterruptedConversations');
    assert.ok(node);
    const script = ts.transpileModule(node.getText(ast), {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
    const context = {
      conversations: () => store, FABRIC_DATA_DIR: dir, log() {}, contextTrackerRuntime: null,
      notifyConversationChanged: (id: string) => notified.push(id),
      handleSessionRead: async ({sessionId}: {sessionId: string}) => {
        if (sessionId === 'agent-completed') return {ok: true, openTurn: null, lastTurnReason: 'completed', hasPendingWork: false,
          terminal: {answer: 'Full durable result', usedBackend: 'fixture.completed', receipts: [{status: 'succeeded'}], artifacts: [{artifactId: 'saved'}], completedAt: 700}};
        if (sessionId === 'agent-question') return {ok: true, openTurn: 1, pendingInput: {requestId: 'q1', kind: 'question', question: 'Which source?'}};
        if (sessionId === 'agent-stopped') return {ok: true, openTurn: 1, cancelRequested: true};
        if (sessionId === 'agent-unavailable') return {ok: false, error: 'session_not_found'};
        if (sessionId === 'agent-unstarted') return {ok: false, error: 'session_not_found'};
        if (sessionId === 'agent-queued') return {ok: true, openTurn: null, lastTurnReason: 'completed', inputRecorded: false, terminal: {answer: 'The previous task result'}};
        if (sessionId === 'agent-answered') return {ok: true, openTurn: null, lastTurnReason: 'awaiting_user', pendingInput: null, hasPendingWork: true};
        return {ok: true, openTurn: 1, hasPendingWork: true};
      },
      sendConversation: async (raw: {conversationId: string; resume: boolean}) => {
        resumed.push(raw);
        store.updateTurn({conversationId: raw.conversationId, resumePending: false, outcome: '进行中'});
        return {ok: true};
      },
    };
    const recover = vm.runInNewContext(`${script}\nresumeInterruptedConversations`, context);
    await recover();
    assert.deepEqual(snapshot(resumed).sort((left: {conversationId: string}, right: {conversationId: string}) => left.conversationId.localeCompare(right.conversationId)), [
      {conversationId: entries[0].id, resume: true},
      {conversationId: entries[7].id, resume: true},
      ...['queued', 'unstarted'].map((kind, index) => ({taskInput: {inputId: `${kind}-input`}, attachments: ['original.csv'], conversationId: entries[index + 5].id, resume: true, question: kind})),
    ].sort((left, right) => left.conversationId.localeCompare(right.conversationId)));
    const completed = store.get(entries[1].id).turns[0];
    assert.equal(completed.answer, 'Full durable result');
    assert.equal(completed.completedAt, 700, 'the restart time must not replace the actual completion time');
    assert.equal(completed.artifacts[0].artifactId, 'saved');
    assert.equal(store.get(entries[2].id).turns[0].pendingInput.requestId, 'q1');
    assert.equal(store.get(entries[2].id).turns[0].completedAt, undefined);
    assert.equal(store.get(entries[3].id).turns[0].outcome, '已停止');
    assert.match(store.get(entries[4].id).turns[0].error, /session_not_found/);
    assert.deepEqual(store.pendingResumeIds(), []);
    await recover();
    assert.equal(resumed.length, 4, 'a second startup drain must not repeat dispatch');
    assert.equal(notified.length, 4);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
