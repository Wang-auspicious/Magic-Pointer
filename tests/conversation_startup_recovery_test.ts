import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

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
    taskContext: { taskId: `agent-${origin}-audit`, referenceRevision: 0, sources: [], references: [] },
    trajectory: [{ kind: 'tool', name: 'read_file', state: 'running' }],
    receipts: [{ toolCallId: 'read-1', toolName: 'read_file', valuePreview: 'First page' }],
  }));
  const untouched = ['已完成', '失败', '等待输入'].map(outcome => previous.appendTurn({
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
  recovered.flush();
  assert.equal(createConversationStore({ baseDir }).get(interrupted[0].id).turns[0].outcome, '可恢复');

  const current = recovered.appendTurn({ newConversation: true, question: 'New owner is running', outcome: '进行中', hasPendingWork: true });
  assert.equal(conversations(), recovered);
  assert.equal(conversations().get(current.id).turns[0].outcome, '进行中', 'ordinary reads must never reconcile a task started in this process');
  recovered.flush();
  console.log('Conversation startup recovery tests ok');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
