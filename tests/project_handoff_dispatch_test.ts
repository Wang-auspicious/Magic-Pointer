import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {createConversationStore} from '../electron/conversation_store';
import {ResourceCollectionService} from '../electron/resource_collection_service';
import {handoffsForTurn} from '../electron/resource_handoff';
const {createStashRuntime} = require('../electron/stash_runtime');

test('project task dispatch journals exact versions and accepts bounded handoffs once per conversation', async () => {
  const baseDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mp-handoff-dispatch-'),
  );
  const store = createConversationStore({
    baseDir: path.join(baseDir, 'history'),
  });
  const project = store.registerProject(baseDir)!;
  const stash = createStashRuntime({
    baseDir: path.join(baseDir, 'stash'),
    clipboard: {
      availableFormats: () => [],
      readText: () => '',
      readImage: () => ({isEmpty: () => true}),
    },
  });
  const service = new ResourceCollectionService({
    stash: () => stash,
    projects: () => store.listProjects(),
    attach: (id, files) => {
      const project = store.getProject(id)!;
      store.updateProject(id, {
        sharedFiles: [...(project.sharedFiles || []), ...files],
      });
    },
    analyze: async () => {
      throw new Error('Unexpected model');
    },
  });
  for (let i = 0; i < 10; i++) {
    const item = await service.add({
      text: `Original ${i}`,
      projectId: project.id,
      title: `Reference ${i}`,
    });
    service.update(item.id, {summary: `Handoff ${i}`}, 1);
    await service.deliver(item.id);
  }
  const source = fs.readFileSync('electron/main.ts', 'utf8');
  const ast = ts.createSourceFile(
    'main.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const node = ast.statements.find(
    node =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'sendConversation',
  )!;
  let payload: any;
  let callbacks: any;
  let sequence = 0;
  const context = {
    path,
    Buffer,
    console,
    Date,
    Set,
    Map,
    ROOT: path.resolve('.'),
    FABRIC_DATA_DIR: baseDir,
    crypto: {randomUUID: () => `request-${++sequence}`},
    ...require('../electron/conversation_control'),
    ...require('../electron/permission_mode'),
    ...require('../electron/conversation_model'),
    ...require('../electron/project_context'),
    ...require('../electron/workspace_folders'),
    normalizeConversationEffort: () => 'medium',
    resolveConversationWorkspace: () => '',
    canonicalProjectRoot: async () => '',
    knownProjectRoot: (root: string) => root,
    studioConversationSessionId: ({existing}: any) =>
      existing || `agent-project-${sequence}`,
    TaskSources: require('../electron/task_sources'),
    activeModelRuntimeConfig: () => ({model: 'fixture'}),
    resolveModelConfig: (value: unknown) => value,
    stashBaseDir: () => stash.baseDir,
    figmaRuntime: {clientConfigurations: () => []},
    conversations: () => store,
    resources: () => service,
    handoffsForTurn,
    notifyConversationChanged() {},
    activeConversations: new Map(),
    stageLiveTurns: new Map(),
    contextTrackerRuntime: null,
    conversationFailureMessage: (result: any) => result?.error || 'failed',
    handleAgentCursorProgress() {},
    combineModelUsage: require('../electron/runtime/model').combineModelUsage,
    setTimeout,
    clearTimeout,
    runRuntimeBridge: (
      request: any,
      _kind: string,
      _target: string,
      value: any,
    ) => {
      payload = request;
      callbacks = value;
      return {};
    },
  };
  const code = ts.transpileModule(node.getText(ast), {
    compilerOptions: {target: ts.ScriptTarget.ES2022},
  }).outputText;
  const send = vm.runInNewContext(`${code}\nsendConversation`, context);
  try {
    const first = send({
      question: 'Read new project references',
      projectId: project.id,
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(payload.projectContext.resourceInbox.length, 8);
    const conversation = store.list()[0];
    assert.equal(
      (
        store.get(conversation.id)!.turns[0].request
          ?.projectHandoffs as unknown[]
      )?.length,
      8,
    );
    assert.equal(
      store.handoffReceipts(project.id).length,
      0,
      'queued request is not a delivery receipt',
    );
    callbacks.onProgress({phase: 'model_request', fields: {turn: '1'}});
    assert.equal(store.handoffReceipts(project.id).length, 8);
    callbacks.onComplete({
      ok: true,
      answer: 'Read the references',
      hasPendingWork: false,
    });
    await first;
    const second = send({
      question: 'Continue',
      conversationId: conversation.id,
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
      payload.projectContext.resourceInbox.length,
      2,
      'older unseen handoffs are not starved by a fixed recent window',
    );
    callbacks.onProgress({phase: 'model_request', fields: {turn: '2'}});
    callbacks.onComplete({
      ok: true,
      answer: 'Continued',
      hasPendingWork: false,
    });
    await second;
    const third = send({
      question: 'Continue again',
      conversationId: conversation.id,
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(payload.projectContext.resourceInbox.length, 0);
    callbacks.onComplete({ok: true, answer: 'Done', hasPendingWork: false});
    await third;
    assert.equal(store.handoffReceipts(project.id).length, 10);
    store.flush();
    assert.equal(
      createConversationStore({
        baseDir: path.join(baseDir, 'history'),
      }).handoffReceipts(project.id).length,
      10,
      'receipts survive reopening',
    );
  } finally {
    store.flush();
    fs.rmSync(baseDir, {recursive: true, force: true});
  }
});
