const assert = require('assert');
// 阶段常量与协议值钉死：桥端、主进程、渲染层三方共用同一套名字。
const {
  ANSWER_CHUNK_PHASE,
  PLAN_PHASE,
  SESSION_READY_PHASE,
  decodeChunkBlob,
  planConversationSteer,
  planConversationStop,
  planStepsFromRecord,
  sessionIdFromRecord,
} = require('../electron/conversation_control');

assert.strictEqual(SESSION_READY_PHASE, 'session_ready');
assert.strictEqual(ANSWER_CHUNK_PHASE, 'answer_chunk');
assert.strictEqual(PLAN_PHASE, 'plan');

// session_ready：渲染层从这里拿到停止/插话要指向的 durable session id。
assert.strictEqual(
  sessionIdFromRecord({ phase: SESSION_READY_PHASE, fields: { sid: 'agent-studio-' + 'a'.repeat(32) } }),
  'agent-studio-' + 'a'.repeat(32),
);
assert.strictEqual(sessionIdFromRecord({ phase: 'other', fields: { sid: 'agent-studio-' + 'a'.repeat(32) } }), null);
assert.strictEqual(sessionIdFromRecord({ phase: SESSION_READY_PHASE, fields: {} }), null);
assert.strictEqual(sessionIdFromRecord({ phase: SESSION_READY_PHASE, fields: { sid: 'rm -rf /' } }), null);
assert.strictEqual(sessionIdFromRecord(null), null);

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
  planConversationStop({ requestId: 'r', agentSessionId: 'agent-studio-' + 'b'.repeat(32) }),
  { action: 'cancel', sessionId: 'agent-studio-' + 'b'.repeat(32) },
);

// steer：文本有界（桥端 MAX_TEXT_CHARS=4000），没起来时明确不可插话。
assert.deepStrictEqual(planConversationSteer({ text: '  ', agentSessionId: 's' }), { action: 'none', reason: 'empty_text' });
assert.deepStrictEqual(planConversationSteer({ text: 'x'.repeat(4001), agentSessionId: 's' }), { action: 'none', reason: 'text_too_long' });
assert.deepStrictEqual(planConversationSteer({ text: '先别删文件', agentSessionId: null }), { action: 'none', reason: 'no_session' });
assert.deepStrictEqual(
  planConversationSteer({ text: '先别删文件', agentSessionId: 'agent-studio-' + 'c'.repeat(32) }),
  { action: 'steer', sessionId: 'agent-studio-' + 'c'.repeat(32), text: '先别删文件' },
);

console.log('conversation control test ok');
