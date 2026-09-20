import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const { createConversationStore } = require('../electron/conversation_store');
const control = require('../electron/conversation_control');
const source = fs.readFileSync('electron/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const fn = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'sendConversation');
assert.ok(fn);
const code = ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const selectFn = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'selectRuntimeModel');
const selectCode = selectFn ? ts.transpileModule(selectFn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText : '';
const stopFn = ast.statements.find((node) => node.getText(ast).startsWith("ipcMain.handle('conversations:stop'"));
assert.ok(stopFn);
const stopCode = ts.transpileModule(stopFn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

async function main() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-conversation-persistence-'));
  let now = 10;
  const store = createConversationStore({ baseDir, now: () => ++now });
  let callbacks: any;
  let payload: any;
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const sessionId = 'agent-studio-new-' + 'a'.repeat(32);
  const runs = new Map();
  let stopped: any;
  let bridgeCalls = 0;
  const { defaultSettings } = require('../electron/settings_store');
  const { selectActiveProfileModel, resolveActiveModelRuntimeConfig } = require('../electron/model_runtime_config');
  const settings = defaultSettings();
  settings.models = { schemaVersion: 1, defaultProfileId: 'audit', profiles: [{
    id: 'audit', schemaVersion: 1, displayName: 'Audit', provider: 'local', baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'audit-model', apiMode: 'local', enabled: true, credentialRef: '',
  }] };
  const context = {
    path, Buffer, console, Map, Date, Set,
    crypto: { randomUUID: () => 'request-audit' },
    normalizeConversationEffort: () => 'medium',
    sanitizePermissionRule: control.sanitizePermissionRule,
    resolveConversationWorkspace: () => '',
    studioConversationSessionId: () => sessionId,
    TaskSources: require('../electron/task_sources'),
    activeModelRuntimeConfig: () => resolveActiveModelRuntimeConfig(settings, null),
    fabricSettings: settings,
    selectActiveProfileModel,
    saveFabricSettingsPatch: async (patch: any) => { settings.models = patch.models; return { ok: true }; },
    invalidateRuntimeState() {},
    runPythonBridgePromise: () => { throw new Error('active profile must not write the legacy model file'); },
    figmaRuntime: { clientConfigurations: () => [] },
    conversations: () => store,
    notifyConversationChanged() {},
    activeConversations: runs,
    stageLiveTurns: new Map(),
    ipcMain: { handle: (_channel: string, callback: any) => { stopped = callback; } },
    isConversationSender: () => true, dashboardWindow: null, companionWindow: null,
    planConversationStop: control.planConversationStop,
    requestGracefulAgentCancel() {}, log() {}, GRACEFUL_CANCEL_GRACE_MS: 5000,
    handleAgentCursorProgress() {},
    sessionIdFromRecord: control.sessionIdFromRecord,
    appendTranscript: control.appendTranscript,
    conversationFailureMessage: (result: any) => result?.error || 'failed',
    runPythonBridge: (request: any, _script: string, _target: string, options: any) => {
      bridgeCalls++;
      payload = request; callbacks = options;
      return { killed: false, kill: () => options.onComplete({ ok: false, error: 'bridge_no_output' }) };
    },
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
  };
  const send = vm.runInNewContext(`${selectCode}\n${stopCode}\n${code}\nsendConversation`, context);
  try {
    for (const reason of ['provider_unavailable', 'user_interrupt', 'stalled', null]) {
      const pending = send({ question: 'Read the notes', requestId: `request-${now}` });
      const conversation = store.list()[0];
      assert.ok(conversation, 'the task must exist before provider completion so failure and restart retain its identity');
      assert.equal(conversation.agentSessionId, sessionId);
      assert.equal(store.get(conversation.id).turns[0].outcome, '进行中');
      assert.equal(payload.turns.length, 0, 'the new in-flight turn must not be sent back as its own history');
      callbacks.onProgress({ phase: 'model_request', fields: { turn: '1' } });
      callbacks.onProgress({ phase: 'answer_chunk', fields: { b64: Buffer.from('Read the first page.').toString('base64') } });
      for (const callback of timers.values()) callback();
      timers.clear();
      assert.equal(store.get(conversation.id).turns[0].answer, 'Read the first page.');
      callbacks.onComplete({
        ok: reason === null || reason === 'stalled',
        answer: reason === null ? 'Finished reading.' : reason === 'stalled' ? 'Read one page; no further progress.' : '',
        error: reason,
        loopTerminated: reason !== null,
        loopTerminatedReason: reason,
        hasPendingWork: reason !== null,
        trajectory: [{ kind: 'message', text: 'Read the first page.' }],
      });
      const response = await pending;
      assert.equal(response.conversationId, conversation.id, 'failed requests must keep a visible resumable conversation');
      const persisted = createConversationStore({ baseDir }).get(conversation.id);
      assert.equal(persisted.turns.length, 1, 'completion patches the original task instead of adding a duplicate');
      assert.equal(persisted.turns[0].outcome, reason === null ? '已完成' : reason === 'user_interrupt' ? '已停止' : '失败');
      assert.equal(persisted.turns[0].failed, reason !== null);
      assert.equal(persisted.agentSessionId, sessionId);
      assert.equal(persisted.hasPendingWork, reason !== null);
      assert.equal(persisted.turns[0].trajectory.length, 1);
      assert.ok(persisted.turns[0].answer, 'provider failure retains actual streamed text');
    }
    const stoppedRequest = send({ question: 'Slow provider', requestId: 'forced-stop' });
    const stopResult = await stopped({}, { requestId: 'forced-stop' });
    assert.equal(stopResult.ok, true);
    for (const callback of [...timers.values()]) callback();
    timers.clear();
    const cancelled = await stoppedRequest;
    assert.equal(store.get(cancelled.conversationId).turns[0].outcome, '已停止', 'the stop fallback must retain the user cancellation intent');
    assert.equal(cancelled.loopTerminatedReason, 'user_interrupt');
    const beforeModel = bridgeCalls;
    const modelRequest = send({ question: '/model next-audit', requestId: 'select-profile-model', conversationId: cancelled.conversationId });
    assert.equal(bridgeCalls, beforeModel, '/model must use the same active-profile save path as the model menu');
    const selected = await modelRequest;
    assert.equal(selected.ok, true);
    assert.equal(selected.command.model, 'next-audit');
    assert.equal(store.get(selected.conversationId).hasPendingWork, true, 'changing the model must not clear the task that was interrupted');
    assert.equal(resolveActiveModelRuntimeConfig(settings, null).model, 'next-audit');
    const next = send({ question: 'Continue', conversationId: selected.conversationId });
    assert.equal(payload.modelRuntime.model, 'next-audit', 'the very next provider request must use the selected model');
    callbacks.onComplete({ ok: true, answer: 'Done', hasPendingWork: false });
    await next;
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
