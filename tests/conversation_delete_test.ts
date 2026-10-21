import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {createConversationStore} from '../electron/conversation_store';

test('deletion retains live Studio, pointer and background tasks until they stop', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-delete-active-'));
  try {
    const persistenceErrors: string[] = [];
    const store = createConversationStore({
      baseDir,
      onPersistError: error => persistenceErrors.push(String(error)),
    });
    const entry = store.appendTurn({
      newConversation: true,
      question: 'Read sources',
      outcome: '进行中',
      agentSessionId: 'agent-delete',
    });
    const source = fs.readFileSync('electron/main.ts', 'utf8');
    const ast = ts.createSourceFile(
      'main.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const node = ast.statements.find(
      node =>
        ts.isExpressionStatement(node) &&
        ts.isCallExpression(node.expression) &&
        node.expression.expression.getText(ast) === 'ipcMain.handle' &&
        ts.isStringLiteral(node.expression.arguments[0]) &&
        node.expression.arguments[0].text === 'conversations:delete',
    );
    assert.ok(node);
    let remove!: (event: unknown, input: {id: string}) => Promise<any>;
    let children: Array<{status: string}> = [];
    const active = new Map([['request', {conversationId: entry.id}]]);
    const pointer = new Map();
    const context = {
      path,
      FABRIC_DATA_DIR: baseDir,
      activeConversations: active,
      stageLiveTurns: pointer,
      isDashboardSender: () => true,
      conversations: () => store,
      dashboardWindow: null,
      readBackgroundAgents: async () => children,
      ipcMain: {
        handle: (_name: string, callback: typeof remove) => {
          remove = callback;
        },
      },
    };
    vm.runInNewContext(
      ts.transpileModule(node.getText(ast), {
        compilerOptions: {target: ts.ScriptTarget.ES2022},
      }).outputText,
      context,
    );
    assert.equal((await remove({}, {id: entry.id})).ok, false);
    assert.ok(store.get(entry.id));
    active.clear();
    pointer.set('selection', {conversationId: entry.id});
    assert.equal((await remove({}, {id: entry.id})).ok, false);
    pointer.clear();
    for (const status of ['starting', 'running', 'awaiting_user']) {
      children = [{status}];
      assert.equal((await remove({}, {id: entry.id})).ok, false);
      assert.ok(store.get(entry.id));
    }
    children = [{status: 'stopped'}];
    const deleted = await remove({}, {id: entry.id});
    assert.equal(
      deleted.ok,
      true,
      JSON.stringify({deleted, persistenceErrors}),
    );
    assert.equal(store.get(entry.id), null);
  } finally {
    fs.rmSync(baseDir, {recursive: true, force: true});
  }
});

test('deletion acknowledges disk persistence and preserves the conversation after a failed write', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-delete-durable-'));
  const store = createConversationStore({
    baseDir,
    deferPersist: true,
    persistDebounceMs: 10000,
  });
  const entry = store.appendTurn({
    newConversation: true,
    question: 'Keep until deletion succeeds',
  });
  store.flush();
  const rename = fs.renameSync;
  try {
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).startsWith(baseDir)) {
        throw new Error('Disk unavailable');
      }
      return rename(from, to);
    }) as typeof fs.renameSync;
    assert.equal(store.remove(entry.id).ok, false);
    assert.ok(store.get(entry.id));
    assert.ok(createConversationStore({baseDir}).get(entry.id));
    fs.renameSync = rename;
    assert.equal(store.remove(entry.id).ok, true);
    assert.equal(
      createConversationStore({baseDir}).get(entry.id),
      null,
      'the success response must already be durable',
    );
  } finally {
    fs.renameSync = rename;
    store.flush();
    fs.rmSync(baseDir, {recursive: true, force: true});
  }
});

test('an older async rename cannot resurrect an acknowledged deletion', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-delete-async-'));
  const store = createConversationStore({
    baseDir,
    deferPersist: true,
    persistDebounceMs: 1,
  });
  const rename = fs.rename;
  let held!: () => Promise<void>;
  let started!: () => void;
  const ready = new Promise<void>(resolve => {
    started = resolve;
  });
  try {
    fs.rename = ((
      from: fs.PathLike,
      to: fs.PathLike,
      callback: fs.NoParamCallback,
    ) => {
      if (String(to).startsWith(baseDir)) {
        held = () =>
          new Promise(resolve =>
            rename(from, to, error => {
              callback(error);
              resolve();
            }),
          );
        started();
      } else {
        rename(from, to, callback);
      }
    }) as typeof fs.rename;
    const entry = store.appendTurn({
      newConversation: true,
      question: 'Slow disk snapshot',
    });
    await ready;
    assert.equal(store.remove(entry.id).ok, true);
    await held();
    assert.equal(createConversationStore({baseDir}).get(entry.id), null);
  } finally {
    fs.rename = rename;
    store.flush();
    fs.rmSync(baseDir, {recursive: true, force: true});
  }
});
