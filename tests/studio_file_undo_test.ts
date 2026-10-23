import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {EventSession} from '../electron/runtime/session';
import {ToolRegistry} from '../electron/runtime/tools';
import {registerCodingTools} from '../electron/runtime/agent_files';
import {RuntimeActivitySink} from '../electron/runtime/agent_activity';
import {createConversationStore} from '../electron/conversation_store';

const chat = require('../electron/renderer/chat_view');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const ast = ts.createSourceFile(
  'studio.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
);
function code() {
  return ts.transpileModule(
    ['submitFileUndo', 'submitConversationFollowup', 'submitOpenUiAction']
      .map(name => {
        const node = ast.statements.find(
          n => ts.isFunctionDeclaration(n) && n.name?.text === name,
        );
        assert.ok(node, name);
        return node.getText(ast);
      })
      .join('\n'),
    {compilerOptions: {target: ts.ScriptTarget.ES2022}},
  ).outputText;
}
function fixture(record: any, send: (request: any) => Promise<any>) {
  const events = new Map<string, (event: any) => void>();
  const flow: any = {
    children: [],
    append(...items: any[]) {
      this.children.push(...items);
    },
    appendChild(item: any) {
      this.children.push(item);
    },
  };
  const draft = {
    value: 'keep my unsent draft',
    attachments: ['D:/my-draft.png'],
  };
  const sent: any[] = [];
  const context: any = {
    activeConversationId: record.id,
    activeConversationRecord: record,
    studioComposerBusy: false,
    pendingConversation: null,
    externalConversationRun: null,
    pendingPermissionAsk: null,
    pendingAskInput: null,
    composerPreset: 'workspace-write',
    composerEffort: 'medium',
    currentComposerModelSelection: () => ({
      profileId: 'local',
      model: 'controlled',
    }),
    crypto: {randomUUID: () => 'undo-request'},
    Date,
    document: {
      querySelector: () => flow,
      createElement: () => ({className: '', replaceChildren() {}}),
      addEventListener: (name: string, listener: any) =>
        events.set(name, listener),
    },
    captureComposerDraft() {
      assert.equal(draft.value, 'keep my unsent draft');
    },
    buildStudioTaskInput: (
      instruction: string,
      sourceId: string,
      taskId: string,
      files: any[],
      sources: any[],
    ) => ({instruction, sourceId, taskId, files, sources}),
    ChatView: {
      ...chat,
      userNode: (question: string) => ({question, dataset: {}}),
      createLiveTurn: () => ({}),
      turnErrorNode: (message: string) => ({error: message}),
    },
    ConversationControl: {createTranscript: () => ({})},
    setComposerRunningState() {},
    startPendingClock() {},
    renderConversationProgress() {},
    scrollChatToBottom() {},
    prepareComposerWorktree: async () => {
      throw new Error('Undo must use its saved execution root');
    },
    Data: {
      conversation: async () => record,
      sendConversation: async (request: any) => {
        sent.push(request);
        return send(request);
      },
    },
    openConversation: async () => {},
    renderSidebar: async () => {},
    detachPendingConversation: () => {
      context.pendingConversation = null;
      context.studioComposerBusy = false;
    },
  };
  vm.createContext(context);
  vm.runInContext(code(), context);
  const listener = ast.statements.find(
    node =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(ast) === 'document.addEventListener' &&
      node.expression.arguments[0].getText(ast) === "'mp:undo-file-changes'",
  );
  assert.ok(listener);
  vm.runInContext(
    ts.transpileModule(listener.getText(ast), {
      compilerOptions: {target: ts.ScriptTarget.ES2022},
    }).outputText,
    context,
  );
  context.dispatchUndo = (detail: any) =>
    new Promise((resolve, reject) =>
      events.get('mp:undo-file-changes')!({
        detail: {
          ...detail,
          respond: (result: any) =>
            result.ok ? resolve(result) : reject(new Error(result.error)),
        },
      }),
    );
  return {context, draft, sent, flow};
}

test('Undo reaches the normal conversation request with saved origin and restores real files through coding tools', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-footer-undo-'));
  try {
    const session = await EventSession.open(root, 'agent-footer-undo');
    const registry = new ToolRegistry();
    registerCodingTools(registry, root, session);
    fs.writeFileSync(path.join(root, 'file.txt'), 'before\n');
    const read = await registry.execute({
      id: 'read',
      name: 'Read',
      arguments: {path: 'file.txt'},
    });
    assert.equal(read.is_error, false);
    const edit = await registry.execute({
      id: 'edit',
      name: 'Edit',
      arguments: {path: 'file.txt', old_string: 'before', new_string: 'after'},
    });
    assert.equal(edit.is_error, false);
    const sink = new RuntimeActivitySink(() => {});
    sink.onEvent({kind: 'tool_call_finished', result: read});
    sink.onEvent({kind: 'tool_call_finished', result: edit});
    const store = createConversationStore({baseDir: root});
    const saved = store.appendTurn({
      newConversation: true,
      question: 'Edit',
      answer: 'Saved',
      agentSessionId: session.id,
      workspaceRoot: root,
      request: {executionWorkspaceRoot: root},
      trajectory: sink.trajectory,
    });
    store.flush();
    const record = createConversationStore({baseDir: root}).get(saved.id);
    const {context, draft, sent} = fixture(record, async request => {
      assert.equal(request.conversationId, record.id);
      assert.equal(request.executionWorkspaceRoot, root);
      assert.equal(
        request.question,
        'Undo the changes you made to `file.txt` in your last turn and restore it to its previous state.',
      );
      const result = await registry.execute({
        id: 'restore',
        name: 'Rewind',
        arguments: {steps: 0},
      });
      assert.equal(result.is_error, false, result.error_message);
      return {ok: true, conversationId: record.id};
    });
    await context.dispatchUndo({conversationId: record.id, turnIndex: 0});
    assert.equal(sent.length, 1);
    assert.equal(sent[0].taskInput.taskId, session.id);
    assert.equal(sent[0].taskInput.instruction, sent[0].question);
    assert.deepEqual([...sent[0].attachments], []);
    assert.equal(
      fs.readFileSync(path.join(root, 'file.txt'), 'utf8'),
      'before\n',
    );
    assert.equal(draft.value, 'keep my unsent draft');
    assert.deepEqual(draft.attachments, ['D:/my-draft.png']);
    assert.equal(context.pendingConversation, null);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('Undo rejects wrong tasks, busy or awaiting tasks and missing changes without sending', async () => {
  const record = {
    id: 'original',
    agentSessionId: 'agent-original',
    workspaceRoot: 'D:/origin',
    turns: [{trajectory: []}],
  };
  const {context, sent} = fixture(record, async () => ({
    ok: false,
    error: 'Actual send failure',
  }));
  await assert.rejects(
    context.submitFileUndo({conversationId: 'other', turnIndex: 0}),
  );
  context.studioComposerBusy = true;
  await assert.rejects(
    context.submitFileUndo({conversationId: 'original', turnIndex: 0}),
  );
  context.studioComposerBusy = false;
  context.pendingAskInput = {kind: 'ask'};
  await assert.rejects(
    context.submitFileUndo({conversationId: 'original', turnIndex: 0}),
  );
  context.pendingAskInput = null;
  await assert.rejects(
    context.submitFileUndo({conversationId: 'original', turnIndex: 0}),
  );
  assert.equal(sent.length, 0);
});

function changedRecord() {
  return {
    id: 'original',
    agentSessionId: 'agent-original',
    workspaceRoot: 'D:/origin',
    turns: [
      {
        request: {executionWorkspaceRoot: 'D:/original-worktree'},
        trajectory: [
          {
            kind: 'tool',
            name: 'Write',
            text: JSON.stringify({path: 'file.txt', content: 'saved'}),
            result: JSON.stringify({
              absolutePath: 'D:/original-worktree/file.txt',
              created: true,
            }),
          },
        ],
      },
    ],
  };
}
test('a failed Undo send is reported and releases the running state while preserving the composer', async () => {
  const record = changedRecord();
  const {context, sent, draft} = fixture(record, async () => ({
    ok: false,
    error: 'Actual send failure',
  }));
  await assert.rejects(
    context.submitFileUndo({conversationId: 'original', turnIndex: 0}),
    /Actual send failure/,
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].executionWorkspaceRoot, 'D:/original-worktree');
  assert.equal(context.pendingConversation, null);
  assert.equal(context.studioComposerBusy, false);
  assert.equal(draft.value, 'keep my unsent draft');
});
test('switching chats while Undo reads history prevents a request in the new chat', async () => {
  const record = changedRecord();
  const {context, sent} = fixture(record, async () => ({ok: true}));
  context.Data.conversation = async () => {
    context.activeConversationId = 'other';
    return record;
  };
  await assert.rejects(
    context.submitFileUndo({conversationId: 'original', turnIndex: 0}),
    /active task changed/,
  );
  assert.equal(sent.length, 0);
});

test('fresh stored pending work prevents Undo even before this window receives its running state', async () => {
  const record = {...changedRecord(), hasPendingWork: true};
  const {context, sent} = fixture(record, async () => ({ok: true}));
  await assert.rejects(
    context.submitFileUndo({conversationId: 'original', turnIndex: 0}),
    /current task/,
  );
  assert.equal(sent.length, 0);
});
test('the shared sender preserves OpenUI follow-up fields and its existing busy steering behavior', async () => {
  const record = changedRecord();
  const {context, sent, draft} = fixture(record, async () => ({ok: true}));
  context.prepareComposerWorktree = async () => ({
    projectRoot: 'D:/origin',
    executionWorkspaceRoot: 'D:/current-worktree',
  });
  await context.submitOpenUiAction({
    scope: 'original#0',
    blockId: 'form',
    event: {
      type: 'continue_conversation',
      humanFriendlyMessage: 'Use these values',
      formState: {query: 'exact'},
    },
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].question, /Use these values/);
  assert.match(sent[0].question, /Interactive response: original#0, form/);
  assert.match(sent[0].question, /"query":"exact"/);
  assert.equal(sent[0].executionWorkspaceRoot, 'D:/current-worktree');
  assert.match(sent[0].taskInput.sourceId, /^input:openui:/);
  assert.equal(draft.value, 'keep my unsent draft');
  let steered = 0;
  context.studioComposerBusy = true;
  context.Data.steerConversation = async (session: string, taskInput: any) => {
    steered++;
    assert.equal(session, record.agentSessionId);
    assert.match(taskInput.instruction, /Use these values/);
    return {ok: true};
  };
  await context.submitOpenUiAction({
    scope: 'original#0',
    blockId: 'form',
    event: {
      type: 'continue_conversation',
      humanFriendlyMessage: 'Use these values',
    },
  });
  assert.equal(steered, 1);
  assert.equal(sent.length, 1);
});
