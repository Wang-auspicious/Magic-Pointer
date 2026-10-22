import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
import {createConversationStore} from '../electron/conversation_store';
import {ResourceCollectionService} from '../electron/resource_collection_service';
import {handoffsForTurn} from '../electron/resource_handoff';
const {createStashRuntime} = require('../electron/stash_runtime');

test('project task dispatch journals exact versions and accepts bounded handoffs once per conversation', async () => {
  const baseDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mp-handoff-dispatch-'),
  );
  let store = createConversationStore({
    baseDir: path.join(baseDir, 'history'),
  });
  const repository = path.join(baseDir, 'repository');
  fs.mkdirSync(repository);
  const git = (args: string[], cwd = repository) => execFileSync('git', args, {cwd, encoding: 'utf8', windowsHide: true}).trim();
  git(['init', '--quiet', '--initial-branch=main']);
  git(['config', 'user.name', 'MP Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  fs.writeFileSync(path.join(repository, 'marker.txt'), 'main content');
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'main fixture']);
  git(['checkout', '--quiet', '-b', 'feature/environment']);
  fs.writeFileSync(path.join(repository, 'marker.txt'), 'feature content');
  git(['commit', '--quiet', '-am', 'feature fixture']);
  git(['checkout', '--quiet', 'main']);
  const project = store.registerProject(repository)!;
  const additionalFolder = path.join(baseDir, 'references');
  fs.mkdirSync(additionalFolder);
  assert.ok(store.updateProject(project.id, {
    environments: [{id: 'review', name: 'Review', modelSelection: {model: 'environment-model'}, permissionPreset: 'read-only', effort: 'low', additionalFolders: [additionalFolder], branch: 'feature/environment', worktree: true}],
    defaultEnvironmentId: 'review',
  }).ok);
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
  let dispatched: () => void = () => {};
  const nextDispatch = () => new Promise<void>(resolve => { dispatched = resolve; });
  const context = {
    path,
    fs,
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
    ...require('../electron/project_workspace'),
    ...require('../electron/session_worktree'),
    runGitCapture: async (root: string, args: string[]) => git(args, root),
    normalizeConversationEffort: (value: string) => value || 'medium',
    resolveConversationWorkspace: (requested: string, saved: string) => requested || saved || '',
    canonicalProjectRoot: async (root: string) => root || '',
    knownProjectRoot: (root: string) => root,
    samePath: (left: string, right: string) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(),
    studioConversationSessionId: ({existing}: any) =>
      existing || `agent-project-${sequence}`,
    TaskSources: require('../electron/task_sources'),
    activeModelRuntimeConfig: (selection?: {model: string}) => ({model: selection?.model || 'fixture'}),
    resolveModelConfig: (value: unknown) => value,
    stashBaseDir: () => stash.baseDir,
    figmaRuntime: {clientConfigurations: () => []},
    conversations: () => store,
    restoreConversationContext: async (conversation: any) => conversation,
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
      dispatched();
      return {};
    },
  };
  const code = ts.transpileModule(node.getText(ast), {
    compilerOptions: {target: ts.ScriptTarget.ES2022},
  }).outputText;
  const send = vm.runInNewContext(`${code}\nsendConversation`, context);
  try {
    const firstDispatch = nextDispatch();
    const first = send({
      question: 'Read new project references',
      projectId: project.id,
    });
    await Promise.race([firstDispatch, first.then((result: unknown) => assert.fail(`Request settled before dispatch: ${JSON.stringify(result)}`))]);
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
    const executionRoot = payload.workspaceRoot;
    assert.notEqual(executionRoot, repository, 'main applies the saved isolation setting when no renderer prepared a workspace');
    assert.equal(fs.readFileSync(path.join(executionRoot, 'marker.txt'), 'utf8'), 'feature content');
    assert.equal(git(['branch', '--show-current']), 'main');
    store.flush();
    store = createConversationStore({baseDir: path.join(baseDir, 'history')});
    assert.equal(store.get(conversation.id)!.turns!.at(-1)!.request!.executionWorkspaceRoot, executionRoot);
    assert.equal(payload.permissionPreset, 'read-only', 'new project tasks inherit the accepted environment at the main dispatch boundary');
    assert.equal(payload.modelRuntime.model, 'environment-model');
    assert.equal(payload.effort, 'low');
    assert.deepEqual(payload.additionalFolders, [additionalFolder]);
    const secondDispatch = nextDispatch();
    const second = send({
      question: 'Continue',
      conversationId: conversation.id,
      permissionPreset: 'workspace-write',
      modelSelection: {model: 'explicit-model'},
      effort: 'max',
      additionalFolders: [],
    });
    await Promise.race([secondDispatch, second.then((result: unknown) => assert.fail(`Request settled before dispatch: ${JSON.stringify(result)}`))]);
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
    assert.equal(payload.workspaceRoot, executionRoot, 'a follow-up without a renderer keeps the accepted execution worktree');
    assert.equal(payload.permissionPreset, 'workspace-write');
    assert.equal(payload.modelRuntime.model, 'explicit-model');
    assert.equal(payload.effort, 'max');
    assert.deepEqual(payload.additionalFolders, []);
    const thirdDispatch = nextDispatch();
    const third = send({
      question: 'Continue again',
      conversationId: conversation.id,
    });
    await Promise.race([thirdDispatch, third.then((result: unknown) => assert.fail(`Request settled before dispatch: ${JSON.stringify(result)}`))]);
    assert.equal(payload.projectContext.resourceInbox.length, 0);
    callbacks.onComplete({ok: true, answer: 'Done', hasPendingWork: false});
    await third;
    assert.equal(payload.workspaceRoot, executionRoot);
    assert.equal(payload.permissionPreset, 'workspace-write', 'existing task settings are not replaced by project defaults');
    assert.equal(payload.modelRuntime.model, 'explicit-model');
    context.activeConversations.set('live-task', {conversationId: conversation.id});
    const busy = await send({question: 'Rejected workspace change', conversationId: conversation.id, branch: 'feature/environment', worktree: false});
    assert.equal(busy.ok, false);
    assert.equal(busy.active, true);
    assert.equal(git(['branch', '--show-current']), 'main', 'a rejected busy request cannot switch the project branch');
    context.activeConversations.delete('live-task');
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
