import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {createConversationStore} from '../electron/conversation_store';

for (const operation of ['rename', 'project', 'workspace', 'model'] as const) {
  test(`${operation} reports a failed disk commit and preserves the previous conversation`, () => {
    const baseDir = fs.mkdtempSync(path.join(tmpdir(), 'mp-metadata-'));
    const errors: string[] = [];
    const store = createConversationStore({
      baseDir,
      onPersistError: (_error, context) => errors.push(context),
    });
    const conversation = store.appendTurn({
      newConversation: true,
      question: 'Keep this saved task',
      answer: 'Existing answer',
    });
    const projectRoot = path.join(baseDir, 'project');
    fs.mkdirSync(projectRoot);
    const project = store.registerProject(projectRoot);
    const original = JSON.stringify(store.get(conversation.id));
    const rename = fs.renameSync;
    fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
      if (String(destination) === path.join(baseDir, 'conversations.json')) {
        throw Object.assign(new Error('File cannot be replaced'), {
          code: 'EPERM',
        });
      }
      return rename(source, destination);
    }) as typeof fs.renameSync;
    let response: {ok: boolean; error?: string};
    const mutate = () =>
      operation === 'rename'
        ? store.rename(conversation.id, 'New title')
        : operation === 'project'
          ? store.setProject(conversation.id, project.id)
          : operation === 'workspace'
            ? store.setWorkspace(conversation.id, projectRoot)
            : store.setModel(conversation.id, {model: 'different-model'});
    try {
      response = mutate();
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(response!.ok, false, 'a failed commit must not claim success');
    assert.equal(response!.error, 'store_failed');
    assert.equal(
      JSON.stringify(store.get(conversation.id)),
      original,
      'live state remains the saved state',
    );
    assert.equal(
      JSON.stringify(createConversationStore({baseDir}).get(conversation.id)),
      original,
    );
    assert.equal(errors.length, 1);
    assert.equal(mutate().ok, true, 'the user can retry the same edit');
    assert.equal(
      JSON.stringify(createConversationStore({baseDir}).get(conversation.id)),
      JSON.stringify(store.get(conversation.id)),
    );
  });
}

test('explicit metadata edits commit immediately while token updates remain deferred', () => {
  const baseDir = fs.mkdtempSync(path.join(tmpdir(), 'mp-metadata-deferred-'));
  const store = createConversationStore({
    baseDir,
    deferPersist: true,
    persistDebounceMs: 10000,
  });
  const conversation = store.appendTurn({
    newConversation: true,
    question: 'A running task',
  });
  assert.equal(fs.existsSync(path.join(baseDir, 'conversations.json')), false);
  assert.equal(store.rename(conversation.id, 'Saved title').ok, true);
  assert.equal(
    createConversationStore({baseDir}).get(conversation.id)?.title,
    'Saved title',
  );
  store.flush();
});

test('a rejected metadata edit does not discard an unsaved transcript update', () => {
  const baseDir = fs.mkdtempSync(path.join(tmpdir(), 'mp-metadata-pending-'));
  const store = createConversationStore({
    baseDir,
    deferPersist: true,
    persistDebounceMs: 10000,
  });
  const conversation = store.appendTurn({
    newConversation: true,
    question: 'Original task',
  });
  store.flush();
  store.appendTurn({
    conversationId: conversation.id,
    question: 'Continue',
    answer: 'Actual new progress',
  });
  const rename = fs.renameSync;
  fs.renameSync = (() => {
    throw new Error('Cannot replace the file');
  }) as typeof fs.renameSync;
  try {
    assert.equal(store.rename(conversation.id, 'Rejected title').ok, false);
  } finally {
    fs.renameSync = rename;
  }
  store.flush();
  const saved = createConversationStore({baseDir}).get(conversation.id)!;
  assert.notEqual(saved.title, 'Rejected title');
  assert.equal(saved.turns.at(-1)?.answer, 'Actual new progress');
});

test('the rename IPC distinguishes a disk failure from an invalid title', () => {
  const baseDir = fs.mkdtempSync(path.join(tmpdir(), 'mp-metadata-ipc-'));
  const store = createConversationStore({baseDir});
  const conversation = store.appendTurn({
    newConversation: true,
    question: 'Saved title',
  });
  const source = fs.readFileSync('electron/main.ts', 'utf8');
  const ast = ts.createSourceFile(
    'main.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const statement = ast.statements.find(
    node =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(ast) === 'ipcMain.handle' &&
      node.expression.arguments[0].getText(ast) === "'conversations:rename'",
  );
  assert.ok(statement);
  let handler!: (
    event: unknown,
    input: unknown,
  ) => {ok: boolean; error?: string};
  let notifications = 0;
  vm.runInNewContext(
    ts.transpileModule(statement.getText(ast), {
      compilerOptions: {target: ts.ScriptTarget.ES2022},
    }).outputText,
    {
      ipcMain: {
        handle: (_name: string, callback: typeof handler) => {
          handler = callback;
        },
      },
      isDashboardSender: () => true,
      conversations: () => store,
      dashboardWindow: {
        isDestroyed: () => false,
        webContents: {
          send: () => {
            notifications++;
          },
        },
      },
    },
  );
  const rename = fs.renameSync;
  fs.renameSync = (() => {
    throw new Error('Cannot replace saved history');
  }) as typeof fs.renameSync;
  let failure: ReturnType<typeof handler>;
  try {
    failure = handler({}, {id: conversation.id, title: 'New title'});
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(failure!.ok, false);
  assert.equal(failure!.error, 'store_failed');
  assert.equal(notifications, 0);
  assert.equal(handler({}, {id: conversation.id, title: 'New title'}).ok, true);
  assert.equal(notifications, 1);
});
