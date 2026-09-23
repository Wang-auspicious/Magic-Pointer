import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { handleSelection } from '../electron/runtime/desktop_perception';
import { runRuntime } from '../electron/runtime/index';

const { stageEventFromBridge } = require('../electron/stage_contract') as { stageEventFromBridge: (value: unknown) => { result: Record<string, any> } };
const { createConversationStore } = require('../electron/conversation_store');
const selected = '  Error 42: wrong value.\nKeep this line exactly.  ';
const snapshot = {
  snapshot_id: 'frozen-selection-1', status: 'ok', structured_covers_mark: true, conflicts: [],
  context: { adapter: 'uia', app: 'editor', content: selected, method: 'uia:selection',
    artifacts: { document: 'D:\\project\\source.ts' } },
  source_window: { hwnd: 51, pid: 77, process_name: 'editor.exe', title: 'source.ts - Editor' },
  perception_trace: { selectedAdapter: 'uia', liveIdentityMatched: true, conflicts: [] },
};

test('selection handoff creates an editable Stage prompt with a reusable Context Packet', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'mp-selection-prompt-'));
  const result = await handleSelection({ command: '让 Codex 修这个', requestMode: 'agent_prompt',
    selectionSnapshot: snapshot, selectionSessionId: 'selection-1', workspaceRoot: userDataDir,
    userDataDir }, { root: process.cwd(), userDataDir, runRuntime: async () => { throw new Error('external prompt request must not execute the Agent loop'); } });
  assert.equal(result.ok, true, JSON.stringify({ error: result.error, result }));
  assert.equal(result.kind, 'agent-prompt-draft');
  assert.equal(result.actionProposals.length, 0);
  assert.equal(result.contextPacket.schemaVersion, 2);
  assert.equal(result.contextPacket.intent.recipeId, 'agent.handoff');
  assert.equal(result.contextPacket.workspace.cwd, userDataDir);
  assert.equal(result.contextPacket.objects[0].content, selected);
  assert.equal(JSON.parse(await readFile(result.contextPacketArtifact, 'utf8')).packetId, result.contextPacket.packetId);
  assert.match(result.contextPrompt, /让 Codex 修这个/);
  assert.match(result.contextPrompt, /Error 42: wrong value/);
  const stage = stageEventFromBridge(result);
  assert.equal(stage.result.kind, 'agent-prompt-draft');
  assert.equal(stage.result.prompt, result.contextPrompt);
  const noEvidence = await handleSelection({ command: '让 Codex 修这个', requestMode: 'agent_prompt',
    selectionSnapshot: { ...snapshot, status: 'unsupported', context: { ...snapshot.context, content: '' } },
    selectionSessionId: 'selection-1', workspaceRoot: userDataDir },
  { runRuntime: async () => { throw new Error('no grounded evidence must not execute the Agent loop'); } });
  assert.equal(noEvidence.ok, false);
  assert.equal(noEvidence.error, 'agent_prompt_context_missing');
});

test('exact selection readback returns frozen text verbatim without a model call', async () => {
  const runRuntime = async () => { throw new Error('exact readback must not call model'); };
  const result = await handleSelection({ command: '我划了什么', selectionSnapshot: snapshot,
    selectionSessionId: 'selection-1' }, { runRuntime });
  assert.equal(result.ok, true);
  assert.equal(result.answer, selected);
  assert.equal(result.route.reason, 'exact_grounded_readback');
  assert.deepEqual(result.actionProposals, []);
  const visualOnly = await handleSelection({ command: '我划了什么', selectionSnapshot: {
    ...snapshot, status: 'unsupported', context: { ...snapshot.context, content: '' },
  } }, { runRuntime });
  assert.equal(visualOnly.ok, false);
  assert.equal(visualOnly.error, 'structured_context_unavailable');
  for (const command of ['我划了什么，顺便解释一下', '读出我选的这段并翻译', 'What text did I select and explain it?']) {
    let called = false;
    const composite = await handleSelection({ command, selectionSnapshot: snapshot }, { runRuntime: async () => {
      called = true;
      return { ok: true, answer: 'Agent handled the full request', hasPendingWork: false };
    } });
    assert.equal(called, true, command);
    assert.equal(composite.answer, 'Agent handled the full request', command);
  }
});

test('Stage submission keeps a pointed office task outside installation and historical coding workspaces', async () => {
  const installRoot = await mkdtemp(join(tmpdir(), 'mp-stage-install-'));
  const userDataDir = await mkdtemp(join(tmpdir(), 'mp-stage-profile-'));
  const savedWorkspace = await mkdtemp(join(tmpdir(), 'mp-stage-old-project-'));
  await writeFile(join(userDataDir, 'workspace.txt'), savedWorkspace);
  const source = readFileSync('electron/main.ts', 'utf8');
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  const names = ['submitSelectionCommandWhenGrounded', 'beginStageLiveTurn', 'recordConversationTurn'];
  const declarations = ast.statements.filter((node) => ts.isFunctionDeclaration(node)
    && names.includes(node.name?.text || '')).map((node) => node.getText(ast));
  assert.equal(declarations.length, names.length);
  const code = ts.transpileModule(declarations.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const token = 'stage-office-selection';
  const session = { token, taskId: 'agent-stage-office', snapshot: { ...snapshot,
    context: { ...snapshot.context, app: 'word', artifacts: { document: 'D:\\Reports\\memo.docx' } } },
  captureEligibility: { commandReady: true }, activeRequestId: 'request-stage' };
  const store = createConversationStore({ baseDir: userDataDir });
  const stageLiveTurns = new Map<string, any>();
  const pendingQuestions = new Map<string, string>();
  const bridge: { payload: Record<string, any> | null } = { payload: null };
  const stage = vm.runInNewContext(`${code}\n({submitSelectionCommandWhenGrounded,beginStageLiveTurn,recordConversationTurn})`, {
    ROOT: installRoot, FABRIC_DATA_DIR: userDataDir, SUBMIT_WAIT: 'wait', SUBMIT_FAIL: 'fail',
    selectionSessions: { get: () => session, startRequest: () => 'request-stage' },
    activeSessionChildren: new Map(), activeSessionAgentIds: new Map(),
    stageLiveTurns, stageLiveFlushTimers: new Map(), pendingQuestions,
    decideSubmitGate: () => ({ decision: 'ready' }),
    screen: { getCursorScreenPoint: () => ({ x: 1, y: 1 }),
      getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1 }) },
    bindEpisodeForCommand: () => null, runningTaskContinuation: () => null,
    updateStage() {}, cancelSessionChild() {},
    withKeptStrokes: (value: unknown) => value, withPickedElement: (value: unknown) => value,
    safeClone: (value: unknown) => JSON.parse(JSON.stringify(value)),
    conversations: () => store, episodeObjectForSession: () => ({ app: 'word', source: { path: 'D:\\Reports\\memo.docx' } }),
    profileWorkspaceRoot: () => savedWorkspace,
    notifyConversationChanged() {}, answerTextFrom: (event: any) => String(event.result?.answer || ''),
    figmaRuntime: { clientConfigurations: () => [] }, activeModelRuntimeConfig: () => null,
    runRuntimeBridge: (payload: Record<string, any>) => { bridge.payload = payload; return null; },
    log() {},
  }) as Record<string, (...args: any[]) => void>;
  stage.submitSelectionCommandWhenGrounded({ selectionSessionToken: token, command: '/cwd' }, Date.now());
  const bridged = bridge.payload;
  assert.ok(bridged, 'Stage must submit to the Runtime bridge');
  assert.equal(bridged.workspaceRoot, '', 'a pointed Office task must explicitly suppress /cwd fallback');
  const result = await handleSelection(bridged, { root: installRoot, userDataDir,
    runRuntime: (payload) => runRuntime(payload, { root: installRoot, userDataDir }) });
  assert.equal(result.answer, '未绑定工作区。');
  assert.equal(result.selectionContext.content, selected, 'pointed Office context must remain available');
  const conversationId = stageLiveTurns.get(token)?.conversationId;
  assert.ok(conversationId, 'Stage must preserve its GUI task turn');
  assert.equal(store.get(conversationId).workspaceRoot || '', '', 'Stage history must not bind saved /cwd');
  stage.recordConversationTurn({ selectionSessionToken: 'fallback', event: { type: 'RESULT', result: { answer: 'Done' } } }, 'RESULT');
  const fallback = store.list().find((item: any) => item.id !== conversationId);
  assert.equal(fallback?.workspaceRoot || '', '', 'fallback Stage completion must also stay projectless');
});
