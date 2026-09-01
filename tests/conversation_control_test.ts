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

// steer：文本有界（桥端 MAX_TEXT_CHARS=4000），没起来时明确不可插话。
assert.deepStrictEqual(planConversationSteer({ text: '  ', agentSessionId: 's' }), { action: 'none', reason: 'empty_text' });
assert.deepStrictEqual(planConversationSteer({ text: 'x'.repeat(4001), agentSessionId: 's' }), { action: 'none', reason: 'text_too_long' });
assert.deepStrictEqual(planConversationSteer({ text: '先别删文件', agentSessionId: null }), { action: 'none', reason: 'no_session' });
assert.deepStrictEqual(
  planConversationSteer({ text: '先别删文件', agentSessionId: CONVERSATION_SESSION_ID }),
  { action: 'steer', sessionId: CONVERSATION_SESSION_ID, text: '先别删文件' },
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
