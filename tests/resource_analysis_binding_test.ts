import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {createConversationStore} from '../electron/conversation_store';

async function main(): Promise<void> {
  const baseDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mp-analysis-binding-'),
  );
  try {
    const store = createConversationStore({baseDir});
    const source = fs.readFileSync('electron/main.ts', 'utf8');
    const ast = ts.createSourceFile(
      'main.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const node = ast.statements.find(
      node =>
        ts.isFunctionDeclaration(node) &&
        node.name?.text === 'sendConversation',
    );
    assert.ok(node);
    const code = ts.transpileModule(node.getText(ast), {
      compilerOptions: {target: ts.ScriptTarget.ES2022},
    }).outputText;
    let calls = 0;
    let callbacks: any;
    const context = {
      path,
      Buffer,
      console,
      Date,
      Set,
      Map,
      ROOT: path.resolve('.'),
      FABRIC_DATA_DIR: baseDir,
      crypto: {randomUUID: () => 'analysis'},
      ...require('../electron/conversation_control'),
      ...require('../electron/permission_mode'),
      ...require('../electron/conversation_model'),
      ...require('../electron/project_context'),
      ...require('../electron/workspace_folders'),
      normalizeConversationEffort: () => 'medium',
      resolveConversationWorkspace: () => '',
      canonicalProjectRoot: async () => '',
      knownProjectRoot: (root: string) => root,
      studioConversationSessionId: () => 'agent-resource-analysis',
      TaskSources: require('../electron/task_sources'),
      activeModelRuntimeConfig: () => ({model: 'fixture'}),
      resolveModelConfig: (value: unknown) => value,
      stashBaseDir: () => baseDir,
      figmaRuntime: {clientConfigurations: () => []},
      conversations: () => store,
      restoreConversationContext: async (conversation: any) => conversation,
      notifyConversationChanged() {},
      activeConversations: new Map(),
      contextTrackerRuntime: null,
      conversationFailureMessage: (result: any) => result?.error || 'failed',
      setTimeout,
      clearTimeout,
      runRuntimeBridge: (
        _payload: unknown,
        _kind: string,
        _target: string,
        value: any,
      ) => {
        calls++;
        callbacks = value;
        return {};
      },
    };
    const send = vm.runInNewContext(`${code}\nsendConversation`, context);
    let boundId = '';
    const binding = send(
      {question: 'Organize retained resource', requestId: 'bound-analysis'},
      undefined,
      (id: string) => {
        boundId = id;
        assert.equal(calls, 0, 'resource binding precedes worker dispatch');
        const persisted = createConversationStore({baseDir}).get(id)!;
        assert.equal(
          (persisted.turns[0].request?.taskInput as any).inputId,
          'input:studio:bound-analysis',
        );
      },
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(boundId);
    assert.equal(calls, 1);
    callbacks.onComplete({
      ok: true,
      answer: 'Organized',
      hasPendingWork: false,
    });
    assert.equal((await binding).conversationId, boundId);
    const conflict = await send(
      {question: 'Do not run after edit', requestId: 'conflicting-analysis'},
      undefined,
      () => {
        throw new Error('Resource revision changed');
      },
    );
    assert.equal(conflict.ok, false);
    assert.equal(
      calls,
      1,
      'a failed resource binding must not dispatch an orphan task',
    );
    const failed = createConversationStore({baseDir}).get(
      conflict.conversationId,
    )!;
    assert.equal(failed.turns[0].outcome, '失败');
    assert.equal(failed.hasPendingWork, false);
    assert.equal(Boolean(failed.resumePending), false);
    console.log(
      'Resource task binding before dispatch and failed-binding settlement passed',
    );
  } finally {
    fs.rmSync(baseDir, {recursive: true, force: true});
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
