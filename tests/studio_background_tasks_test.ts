import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const ast = ts.createSourceFile('studio.ts', source, ts.ScriptTarget.Latest, true);
const code = ['backgroundTaskView', 'childActive', 'stopSubagentTask'].map(name => {
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration);
  return ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}).join('\n');

async function main() {
  let resolve!: (value: any) => void;
  const calls: Array<Record<string, string>> = [];
  const context: any = {
    activeConversationId: 'first', pendingConversation: null, backgroundTaskViews: new Map(),
    Data: { stopSubagent(payload: Record<string, string>) { calls.push(payload); return new Promise(done => { resolve = done; }); } },
  };
  vm.runInNewContext(code, context);
  const first = context.backgroundTaskView();
  first.finishedOpen = true;
  first.cleared.add('finished-child');
  context.activeConversationId = 'second';
  assert.equal(context.backgroundTaskView().finishedOpen, false, 'another task starts with its own folded history');
  assert.equal(context.backgroundTaskView().cleared.size, 0, 'Clear must not dismiss another task history');
  context.activeConversationId = 'first';
  assert.equal(context.backgroundTaskView(), first, 'returning to a task retains its Finished selection');

  const button = { disabled: false, title: '', setAttribute() {} };
  const error = { hidden: true, textContent: '' };
  const state = { textContent: '' };
  const row = { dataset: { conversationId: 'first', taskId: 'child-a', status: 'running' } as Record<string, string>,
    querySelector: (selector: string) => selector === '.mp-subagent-stop' ? button : selector === '.mp-subagent-state' ? state : error };
  const failed = context.stopSubagentTask(row);
  assert.equal(button.disabled, true);
  assert.equal(state.textContent, 'Stopping');
  await context.stopSubagentTask(row);
  assert.equal(calls.length, 1, 'a pending cancel request cannot be submitted twice');
  resolve({ ok: false, error: 'not saved' });
  await failed;
  assert.equal(button.disabled, false, 'a rejected cancel remains retryable');
  assert.equal(state.textContent, '');
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, 'not saved');
  const accepted = context.stopSubagentTask(row);
  context.activeConversationId = 'second';
  resolve({ ok: true });
  await accepted;
  assert.equal(row.dataset.status, 'running', 'acceptance must not invent a terminal child status');
  assert.equal(row.dataset.stopState, 'requested');
  assert.equal(button.disabled, true);
  assert.equal(error.hidden, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { conversationId: 'first', subagentId: 'child-a' },
    { conversationId: 'first', subagentId: 'child-a' },
  ], 'a task switch must not retarget a pending child cancellation');

  delete row.dataset.stopState;
  button.disabled = false;
  const late = context.stopSubagentTask(row);
  row.dataset.status = 'stopped';
  resolve({ ok: false, error: 'no_open_turn' });
  await late;
  assert.equal(error.hidden, true, 'late cancellation rejection cannot turn a stopped child into a retry error');
  console.log('Studio background task state, independent Stop and retry passed');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
