import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const { createConversationStore } = require('../electron/conversation_store');

const source = fs.readFileSync('electron/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const names = ['beginStageLiveTurn', 'appendStageLiveProgress', 'recordConversationTurn', 'answerTextFrom', 'notifyConversationChanged'];
const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node)
  && names.includes(node.name?.text || '')).map((node) => node.getText(ast));
assert.equal(functions.length, names.length, 'main must project real progress into one shared turn');
const code = ts.transpileModule(functions.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-selection-live-'));
const store = createConversationStore({ baseDir });
const sends: Array<{ channel: string; payload: any }> = [];
const timers = new Map<number, () => void>();
let timerId = 0;
const liveTurns = new Map();
const session = { taskId: 'agent-123', activeRequestId: 'request-123' };
const handlers = vm.runInNewContext(`${code}\n({${names.join(',')}})`, {
  Buffer, Map, console,
  appendTranscript: require('../electron/conversation_control').appendTranscript,
  stageLiveTurns: liveTurns, stageLiveFlushTimers: new Map(),
  pendingQuestions: new Map([['selection-1', 'What is this sidebar?']]),
  selectionSessions: { get: () => session }, conversations: () => store,
  episodeObjectForSession: () => ({ app: 'Codex', source: { path: 'frozen.png' } }),
  ROOT: baseDir, FABRIC_DATA_DIR: baseDir,
  profileWorkspaceRoot: (userDataDir: string) => {
    assert.equal(userDataDir, baseDir);
    return baseDir;
  },
  log() {},
  dashboardWindow: { isDestroyed: () => false, webContents: { send: (channel: string, payload: any) => sends.push({ channel, payload }) } },
  companionWindow: null,
  safeSurfaceSend: (_surface: string, channel: string, payload: any) => sends.push({ channel, payload }),
  setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; },
  clearTimeout: (id: number) => timers.delete(id),
});
handlers.beginStageLiveTurn('selection-1', { command: 'What is this sidebar?' });
const live = liveTurns.get('selection-1');
const progress = (phase: string, fields: Record<string, string>) => handlers.appendStageLiveProgress('selection-1', { phase, fields });
progress('reasoning_chunk', { b64: Buffer.from('Inspect selection').toString('base64') });
progress('tool_call', { id: 'look-1', name: 'Look', args: 'target=region' });
progress('tool_result', { id: 'look-1', name: 'Look', state: 'done', result: 'Environment sidebar' });
progress('answer_chunk', { b64: Buffer.from('Environment').toString('base64') });
progress('answer_chunk', { b64: Buffer.from(' sidebar').toString('base64') });
for (const fn of [...timers.values()]) fn();
timers.clear();
const turn = store.get(live.conversationId).turns[live.turnIndex];
assert.equal(turn.answer, 'Environment sidebar');
assert.equal(turn.thinking, 'Inspect selection');
assert.equal(store.get(live.conversationId).hasPendingWork, true);
const gui = sends.filter((item) => item.channel === 'conversations:turn').at(-1)?.payload;
const stage = sends.filter((item) => item.channel === 'stage:card-patch').at(-1)?.payload;
assert.deepEqual(gui.liveProgress, stage.patch.liveProgress, 'both surfaces receive exactly the same progress snapshot');
assert.equal(gui.liveProgress.records.filter((r: any) => r.fields?.id === 'look-1').length, 1);
assert.equal(gui.liveProgress.records.find((r: any) => r.fields?.id === 'look-1').phase, 'tool_result');
assert.equal(gui.liveProgress.requestId, 'request-123');
assert.equal(gui.liveProgress.agentSessionId, 'agent-123');
const taskContext = { taskId: 'agent-123', referenceRevision: 1,
  sources: [{ sourceId: 'selected-sidebar', kind: 'screen_region' }], references: [] };
const trajectory = Array.from({ length: 300 }, (_, index) => ({ kind: 'tool', name: 'Look',
  callId: `look-${index}`, state: 'done', result: `Verified step ${index}` }));
handlers.recordConversationTurn({ selectionSessionToken: 'selection-1', event: {
  type: 'RESULT', result: { answer: 'The Environment sidebar controls the workspace.',
    agentSessionId: 'agent-123', thinking: 'Inspected selection',
    trajectory,
    taskContext,
  },
} }, 'RESULT');
const settled = createConversationStore({ baseDir }).get(live.conversationId);
assert.equal(settled.hasPendingWork, false);
assert.equal(settled.agentSessionId, 'agent-123');
assert.deepEqual(settled.taskContext, taskContext, 'GUI follow-ups retain the exact selected task sources');
assert.equal(settled.turns[0].outcome, '已完成');
assert.equal(settled.turns[0].trajectory[0].name, 'Look');
assert.deepEqual(settled.turns[0].trajectory, trajectory, 'GUI completion must retain the same full process that Stage received');
assert.deepEqual(store.appendTurn({ newConversation: true, question: 'Direct GUI turn', trajectory }).turns[0].trajectory,
  trajectory, 'ordinary GUI tasks use the same durable trajectory projection');
assert.equal(liveTurns.size, 0);
assert.equal(sends.filter((item) => item.channel === 'conversations:turn').at(-1)?.payload.liveProgress, undefined);
assert.equal(handlers.answerTextFrom({ type: 'ERROR', error: { message: 'Provider unavailable' },
  result: { answer: '已识别侧栏，但读取详细状态失败。' } }), '已识别侧栏，但读取详细状态失败。');
console.log('selection shared progress and durable completion test ok');

handlers.beginStageLiveTurn('selection-1', { command: 'Change the selected document' });
const unverified = liveTurns.get('selection-1');
handlers.recordConversationTurn({ selectionSessionToken: 'selection-1', event: {
  type: 'RESULT', result: { answer: 'Write attempted; verification unavailable.',
    receipts: [{ status: 'unverified', wrote: true, verified: false }], hasPendingWork: true },
} }, 'RESULT');
assert.equal(store.get(unverified.conversationId).turns[unverified.turnIndex].outcome, '待核对');
assert.equal(store.get(unverified.conversationId).hasPendingWork, true);

handlers.beginStageLiveTurn('selection-1', { command: 'Summarize selected files' });
const stalled = liveTurns.get('selection-1');
handlers.recordConversationTurn({ selectionSessionToken: 'selection-1', event: {
  type: 'RESULT', result: { answer: 'No new evidence after retries.', loopTerminated: true, loopTerminatedReason: 'stalled' },
} }, 'RESULT');
assert.equal(store.get(stalled.conversationId).turns[stalled.turnIndex].outcome, '失败',
  'stalled evidence collection must not appear as a successfully completed task');
