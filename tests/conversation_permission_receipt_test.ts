import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {createConversationStore} from '../electron/conversation_store';
import {
  EventSession,
  handleSession,
  handleSessionRead,
} from '../electron/runtime/session';
import {studioConversationSessionId} from '../electron/agent_session_id';
import * as permissions from '../electron/permission_mode';

const source = fs.readFileSync('electron/main.ts', 'utf8');
const ast = ts.createSourceFile(
  'main.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
);
function functions(...names: string[]) {
  return ts.transpileModule(
    ast.statements
      .filter(
        node =>
          ts.isFunctionDeclaration(node) &&
          names.includes(node.name?.text || ''),
      )
      .map(node => node.getText(ast))
      .join('\n'),
    {compilerOptions: {target: ts.ScriptTarget.ES2022}},
  ).outputText;
}
function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'mp-permission-receipt-'));
  const store = createConversationStore({baseDir: root});
  const conversation = store.appendTurn({
    newConversation: true,
    question: 'Keep a durable permission choice',
    outcome: '已完成',
  });
  const context: Record<string, any> = {
    ...permissions,
    path,
    fs,
    FABRIC_DATA_DIR: root,
    studioConversationSessionId,
    handleSession,
    handleSessionRead,
    restoredContextUsage: new Map(),
    conversations: () => store,
    notifyConversationChanged() {},
  };
  vm.runInNewContext(
    functions('setConversationPermission', 'restoreConversationContext'),
    context,
  );
  return {root, store, conversation, context};
}
function blockConversationWrites(root: string) {
  const rename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === path.join(root, 'conversations.json'))
      throw Object.assign(new Error('Conversation file is locked'), {
        code: 'EPERM',
      });
    return rename(from, to);
  }) as typeof fs.renameSync;
  return () => {
    fs.renameSync = rename;
  };
}

test('a committed Session mode remains applied and reports an unsaved conversation projection', async () => {
  const {root, conversation, context} = fixture();
  const release = blockConversationWrites(root);
  let receipt: any;
  try {
    receipt = await context.setConversationPermission(conversation.id, 'plan');
  } finally {
    release();
  }
  assert.equal(
    receipt.ok,
    true,
    'the authoritative Session really accepted the mode',
  );
  const status = await handleSessionRead(
    {action: 'status', sessionId: receipt.sessionId},
    root,
  );
  assert.equal(status.permissionMode, 'plan');
  assert.equal(receipt.warning, 'conversation_not_saved');
  assert.equal(
    createConversationStore({baseDir: root}).get(conversation.id)
      ?.agentSessionId,
    undefined,
  );
});

test('reopening recovers a committed mode even if its first conversation projection did not save', async () => {
  const {root, conversation, context} = fixture();
  const release = blockConversationWrites(root);
  try {
    await context.setConversationPermission(conversation.id, 'read-only');
  } finally {
    release();
  }
  const reopened = createConversationStore({baseDir: root});
  context.conversations = () => reopened;
  const restored = await context.restoreConversationContext(
    reopened.get(conversation.id),
  );
  assert.equal(restored.taskContext?.permissionMode, 'safe');
  assert.equal(
    restored.agentSessionId,
    studioConversationSessionId({conversationId: conversation.id}),
  );
});

test('a failed permission decision preserves the pending question and is not accepted', () => {
  const {root, store, conversation} = fixture();
  store.updateTurn({
    conversationId: conversation.id,
    pendingInput: {
      kind: 'permission',
      requestId: 'grant-save',
      question: 'Save the file?',
    },
  });
  const before = JSON.stringify(store.get(conversation.id));
  const release = blockConversationWrites(root);
  let result: any;
  try {
    result = store.recordPermissionDecision({
      conversationId: conversation.id,
      grant: 'WriteFile',
    });
  } finally {
    release();
  }
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(store.get(conversation.id)), before);
  assert.equal(
    JSON.stringify(
      createConversationStore({baseDir: root}).get(conversation.id),
    ),
    before,
  );
  assert.equal(
    store.recordPermissionDecision({
      conversationId: conversation.id,
      grant: 'WriteFile',
    }).ok,
    true,
  );
  assert.deepEqual(
    createConversationStore({baseDir: root}).get(conversation.id)
      ?.permissionGrants,
    ['WriteFile'],
  );
});

test('a journal sync error after a complete append reports the mode that actually changed', async () => {
  const {root, conversation, context} = fixture();
  const sessionId = studioConversationSessionId({
    conversationId: conversation.id,
  });
  await EventSession.open(root, sessionId);
  const open = fs.promises.open;
  fs.promises.open = (async (
    file: fs.PathLike,
    flags: string | number,
    ...args: any[]
  ) => {
    const handle = await (open as any)(file, flags, ...args);
    if (
      String(file) ===
        path.join(root, 'agent-sessions', `${sessionId}.jsonl`) &&
      flags === 'a'
    ) {
      handle.sync = async () => {
        throw new Error('Journal sync failed');
      };
    }
    return handle;
  }) as typeof fs.promises.open;
  let receipt: any;
  try {
    receipt = await context.setConversationPermission(conversation.id, 'plan');
  } finally {
    fs.promises.open = open;
  }
  assert.equal(
    (await handleSessionRead({action: 'status', sessionId}, root))
      .permissionMode,
    'plan',
    'the completed journal line exists despite the failed sync',
  );
  assert.equal(receipt.ok, true);
  assert.equal(receipt.permissionMode, 'plan');
  assert.equal(receipt.warning, 'permission_save_unconfirmed');
});
