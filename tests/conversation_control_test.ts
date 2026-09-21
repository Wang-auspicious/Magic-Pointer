const assert = require('assert');
// 阶段常量与协议值钉死：桥端、主进程、渲染层三方共用同一套名字。
const {
  ANSWER_CHUNK_PHASE,
  callConversationAction,
  PLAN_PHASE,
  SESSION_READY_PHASE,
  decodeChunkBlob,
  failedDraftValue,
  isConversationSender,
  planConversationSteer,
  planConversationStop,
  planStepsFromRecord,
  permissionGrantRule,
  sanitizePermissionRule,
  sessionIdFromRecord,
} = require('../electron/conversation_control');

assert.strictEqual(SESSION_READY_PHASE, 'session_ready');
assert.strictEqual(ANSWER_CHUNK_PHASE, 'answer_chunk');
assert.strictEqual(PLAN_PHASE, 'plan');

const NEW_SESSION_ID = 'agent-studio-new-' + 'a'.repeat(32);
const CONVERSATION_SESSION_ID = 'agent-studio-conv-' + 'b'.repeat(32);
const RETIRED_SHARED_SESSION_ID = 'agent-studio-' + 'c'.repeat(32);
const SELECTION_SESSION_ID = 'agent-a3618dc7-e244-4894-b2a6-2157f77a05d9';
const transcriptApi = require('../electron/conversation_control');
const transcript = transcriptApi.createTranscript();
const append = (phase: string, fields: Record<string, unknown>) => transcriptApi.appendTranscript(transcript, { phase, fields });
append('model_request', { turn: '1' });
append('reasoning_chunk', { b64: Buffer.from('first thought').toString('base64') });
append('answer_chunk', { b64: Buffer.from('Checking A.').toString('base64') });
append('tool_call', { id: 'a', name: 'Read' });
append('tool_result', { id: 'a', name: 'Read', args: '{"path":"a.pdf"}', result: 'missing', state: 'error' });
append('model_request', { turn: '2' });
append('answer_chunk', { b64: Buffer.from('Trying B.').toString('base64') });
assert.equal(transcript.answer, 'Trying B.');
assert.equal(transcript.trajectory.length, 3);
assert.equal(transcript.trajectory[0].text, 'Checking A.');
assert.equal(transcript.trajectory[0].reasoning, 'first thought');
assert.equal(transcript.trajectory[1].result, 'missing');
assert.equal(transcript.trajectory[1].isError, true);
assert.equal(transcript.trajectory[2].turn, 2);
append('tool_call', { id: 'parent-a', name: 'Agent' });
append('tool_call', { id: 'parent-b', name: 'Agent' });
append('subagent', { b64: Buffer.from(JSON.stringify({ id: 'child-a', parentCallId: 'parent-a', reasoning: 'Inspecting A', status: 'running' })).toString('base64') });
assert.equal(transcript.trajectory.find((r: any) => r.callId === 'parent-a').subagent.reasoning, 'Inspecting A');
assert.equal(transcript.trajectory.find((r: any) => r.callId === 'parent-b').subagent, undefined);
assert.deepStrictEqual(planConversationStop({ requestId: 'selection-request', agentSessionId: SELECTION_SESSION_ID }),
  { action: 'cancel', sessionId: SELECTION_SESSION_ID });
assert.deepStrictEqual(planConversationSteer({ text: '继续看右侧', agentSessionId: SELECTION_SESSION_ID }),
  { action: 'steer', sessionId: SELECTION_SESSION_ID, text: '继续看右侧' });

// session_ready：渲染层只接受 Python 当前签发的 new/conv 两种 durable id。
assert.strictEqual(
  sessionIdFromRecord({ phase: SESSION_READY_PHASE, fields: { sid: NEW_SESSION_ID } }),
  NEW_SESSION_ID,
);
assert.strictEqual(
  sessionIdFromRecord({ phase: SESSION_READY_PHASE, fields: { sid: CONVERSATION_SESSION_ID } }),
  CONVERSATION_SESSION_ID,
);
assert.strictEqual(sessionIdFromRecord({ phase: 'other', fields: { sid: NEW_SESSION_ID } }), null);
assert.strictEqual(sessionIdFromRecord({ phase: SESSION_READY_PHASE, fields: { sid: RETIRED_SHARED_SESSION_ID } }), null);
assert.strictEqual(sessionIdFromRecord({ phase: SESSION_READY_PHASE, fields: {} }), null);
assert.strictEqual(sessionIdFromRecord({ phase: SESSION_READY_PHASE, fields: { sid: 'rm -rf /' } }), null);
assert.strictEqual(sessionIdFromRecord(null), null);

// Conversation actions are intentionally shared by Studio and Companion,
// while every other renderer remains unauthorized.
const dashboardContents = { id: 'dashboard' };
const companionContents = { id: 'companion' };
const liveWindow = (webContents: object) => ({
  isDestroyed: () => false,
  webContents,
});
assert.strictEqual(isConversationSender(
  { sender: dashboardContents },
  liveWindow(dashboardContents),
  liveWindow(companionContents),
), true);
assert.strictEqual(isConversationSender(
  { sender: companionContents },
  liveWindow(dashboardContents),
  liveWindow(companionContents),
), true);
assert.strictEqual(isConversationSender(
  { sender: { id: 'other' } },
  liveWindow(dashboardContents),
  liveWindow(companionContents),
), false);
assert.strictEqual(isConversationSender(
  { sender: companionContents },
  liveWindow(dashboardContents),
  { isDestroyed: () => true, webContents: companionContents },
), false);

// answer_chunk：base64 增量解码，坏数据一律空串（展示通道不能炸 UI）。
assert.strictEqual(
  decodeChunkBlob({ b64: Buffer.from('你好', 'utf8').toString('base64') }),
  '你好',
);
assert.strictEqual(decodeChunkBlob({}), '');
assert.strictEqual(decodeChunkBlob({ b64: '%%%not-base64%%%' }), '');

// plan：与 answer_chunk 同一条 blob 通道。
const steps = [{ content: '第一步', status: 'pending' }];
const planBlob = Buffer.from(JSON.stringify({ steps }), 'utf8').toString('base64');
assert.deepStrictEqual(planStepsFromRecord({ phase: PLAN_PHASE, fields: { b64: planBlob } }), { steps });
assert.deepStrictEqual(planStepsFromRecord({ phase: PLAN_PHASE, fields: {
  b64: Buffer.from(JSON.stringify({ steps: [] })).toString('base64'),
} }), { steps: [] }, 'an explicit empty plan must clear the visible task plan');
assert.strictEqual(planStepsFromRecord({ phase: PLAN_PHASE, fields: {
  b64: Buffer.from(JSON.stringify({ unrelated: [] })).toString('base64'),
} }), null, 'missing plan data must not be mistaken for an explicit clear');
assert.strictEqual(planStepsFromRecord({ phase: PLAN_PHASE, fields: {} }), null);
assert.deepStrictEqual(planStepsFromRecord({ phase: PLAN_PHASE, fields: { b64: '!!!' } }), null);

// stop：没有在跑的请求或还没拿到 session id 时诚实拒绝，不假装点了停。
assert.deepStrictEqual(planConversationStop({ requestId: '', agentSessionId: 's' }), { action: 'none', reason: 'no_request' });
assert.deepStrictEqual(planConversationStop({ requestId: 'r', agentSessionId: null }), { action: 'none', reason: 'no_session' });
assert.deepStrictEqual(
  planConversationStop({ requestId: 'r', agentSessionId: NEW_SESSION_ID }),
  { action: 'cancel', sessionId: NEW_SESSION_ID },
);
assert.deepStrictEqual(
  planConversationStop({ requestId: 'r', agentSessionId: RETIRED_SHARED_SESSION_ID }),
  { action: 'none', reason: 'no_session' },
);

// steer：与输入框及桥端一致，最多 12000 字；没起来时明确不可插话。
assert.deepStrictEqual(planConversationSteer({ text: '  ', agentSessionId: 's' }), { action: 'none', reason: 'empty_text' });
assert.deepStrictEqual(planConversationSteer({ text: 'x'.repeat(12001), agentSessionId: 's' }), { action: 'none', reason: 'text_too_long' });
assert.deepStrictEqual(planConversationSteer({ text: '先别删文件', agentSessionId: null }), { action: 'none', reason: 'no_session' });
assert.deepStrictEqual(
  planConversationSteer({ text: '先别删文件', agentSessionId: CONVERSATION_SESSION_ID }),
  { action: 'steer', sessionId: CONVERSATION_SESSION_ID, text: '先别删文件' },
);
const pointedCorrection = {
  inputId: 'input-studio-point-1',
  taskId: 'untrusted-renderer-task',
  target: 'next-turn',
  instruction: '',
  referenceUpdates: [{ operation: 'correct', binding: { referenceId: 'reference:B' } }],
  sourceIds: ['source:B'],
  timeline: [{ eventId: 'point-B', kind: 'point', startMs: 5, endMs: 5, referenceId: 'reference:B' }],
  capturedAtMs: 5,
};
assert.deepStrictEqual(
  planConversationSteer({ taskInput: pointedCorrection, agentSessionId: CONVERSATION_SESSION_ID }),
  {
    action: 'steer',
    sessionId: CONVERSATION_SESSION_ID,
    text: '',
    taskInput: pointedCorrection,
  },
  'Studio accepts reference-only TaskInput and leaves task identity enforcement to main',
);

// 权限规则：历史裸工具名兼容；Bash 前缀保持括号/空格，不能被 main.ts
// 旧 sanitizeTool 削成一个永远匹配不到的 Bashpytest。
assert.strictEqual(sanitizePermissionRule('run_command'), 'run_command');
assert.strictEqual(sanitizePermissionRule('Bash(pytest)'), 'Bash(pytest)');
assert.strictEqual(sanitizePermissionRule('Bash(npm run test:unit)'), 'Bash(npm run test:unit)');
assert.strictEqual(sanitizePermissionRule('Bash(pytest && rm -rf .)'), '');
assert.strictEqual(sanitizePermissionRule('Bash(pytest)\nBash(rm)'), '');
assert.strictEqual(sanitizePermissionRule('Bash()'), '');
assert.strictEqual(sanitizePermissionRule('not a rule'), '');
assert.strictEqual(permissionGrantRule('Bash', 'pytest'), 'Bash(pytest)');
assert.strictEqual(permissionGrantRule('Bash', 'npm run test'), 'Bash(npm run test)');
assert.strictEqual(permissionGrantRule('Bash', ''), 'Bash');
assert.strictEqual(permissionGrantRule('Read', 'ignored'), 'Read');
assert.strictEqual(permissionGrantRule('Bash', 'pytest && rm -rf .'), '');

// 长请求失败时只恢复仍为空/仍是旧问题的输入框；用户已经打的新草稿优先。
assert.strictEqual(failedDraftValue('', '旧问题'), '旧问题');
assert.strictEqual(failedDraftValue('旧问题', '旧问题'), '旧问题');
assert.strictEqual(failedDraftValue('我正在写的新问题', '旧问题'), '我正在写的新问题');

async function verifyConversationActionResult() {
  assert.deepStrictEqual(
    await callConversationAction(() => Promise.resolve({ ok: true })),
    { ok: true, error: '' },
  );
  assert.deepStrictEqual(
    await callConversationAction(() => Promise.resolve({ ok: false, error: 'bridge refused' })),
    { ok: false, error: 'bridge refused' },
  );
  assert.deepStrictEqual(
    await callConversationAction(() => Promise.reject(new Error('ipc gone'))),
    { ok: false, error: '请求未送达，请重试。' },
  );
}

verifyConversationActionResult().then(
  () => console.log('conversation control test ok'),
  (error) => { console.error(error); process.exitCode = 1; },
);
