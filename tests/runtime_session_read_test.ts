import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleSessionRead } from '../electron/runtime/session';

type Data = Record<string, unknown>;
const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Data)[key])}`).join(',')}}`
    : JSON.stringify(value);
const message = (role: string, content: string, fields: Data = {}) => ({
  role, content, tool_call_id: null, name: null, is_error: false, origin: 'data',
  injected: false, tool_calls: [], provider_items: [], ...fields,
});

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'mp-session-read-'));
  await mkdir(path.join(root, 'agent-sessions'));
  const file = path.join(root, 'agent-sessions', 'session.jsonl');
  let rows: string[] = [];
  let previous = '0'.repeat(64);
  const event = (type: string, data: Data, surfaceOp?: string) => {
    const core = { formatVersion: 1, sessionId: 'session', seq: rows.length, time: 1,
      type, data, prevHash: previous, ...(surfaceOp ? { surfaceOp } : {}) };
    const serialized = (value: unknown) => canonical(value).replace('"latencyMs":1,', '"latencyMs":1.0,');
    previous = createHash('sha256').update(serialized(core)).digest('hex');
    rows.push(serialized({ ...core, hash: previous }));
  };
  const save = (tail = '') => writeFile(file, rows.join('\n') + '\n' + tail);
  const read = (action = 'status', fields: Data = {}) => handleSessionRead({ action, sessionId: 'session', ...fields }, root);
  try {
    event('session/created', { version: 1, sessionId: 'session', createdAt: 1, parentSessionId: 'parent', seedLength: 0 });
    event('turn/start', { turn: 1 });
    event('user/message', { message: message('user', '整理文件') }, 'append');
    const permission = { kind: 'permission', question: '继续吗？', options: ['允许', '拒绝'], requestId: 'approval', childSessionId: 'child', action: { tool: 'Write', arguments: { path: 'a.txt' } } };
    event('permission/requested', { requestId: 'approval', pendingInput: permission });
    event('turn/end', { turn: 1, reason: 'user_interrupt' });
    event('turn/start', { turn: 2 });
    await save('{"partial":');
    const before = await readFile(file);
    assert.deepEqual(await read(), { ok: true, sessionId: 'session', hasPendingWork: true,
      lastTurnReason: 'user_interrupt', lastReceiptStatus: null, openTurn: 2, pendingInput: permission,
      answeredInputIds: [], lastInputAnswer: null, pendingRecovery: [] });
    assert.deepEqual(await readFile(file), before);
    const answer = message('tool', 'allowed', { tool_call_id: 'approval', name: 'AskUser' });
    event('user_input/answered', { requestId: 'approval', message: answer });
    event('permission/requested', { requestId: 'cancelled', pendingInput: { requestId: 'cancelled' } });
    event('permission/cancelled', { requestIds: ['cancelled'] });
    event('operation/prepared', { operationId: 'write', callId: 'w', name: 'Write', effect: 'reversible_write', dispatched: true, arguments: { path: 'a.txt' } });
    event('operation/settled', { operationId: 'write', outcome: 'unknown', latencyMs: 1 });
    event('operation/prepared', { operationId: 'read', callId: 'r', name: 'Read', effect: 'read', dispatched: true, arguments: { path: 'a.txt' } });
    event('operation/settled', { operationId: 'read', outcome: 'succeeded', message: message('tool', 'saved') });
    await save();
    const status = await read();
    assert.equal(status.pendingInput, null);
    assert.deepEqual(status.answeredInputIds, ['approval']);
    assert.deepEqual(status.lastInputAnswer, { requestId: 'approval', message: answer });
    assert.deepEqual(status.pendingRecovery, [{ operationId: 'write', tool: 'Write', arguments: { path: 'a.txt' }, recoveryPolicy: 'verify_before_retry', verificationCandidates: [{ callId: 'r', tool: 'Read', arguments: { path: 'a.txt' }, result: 'saved' }] }]);
    event('operation/recovery_resolved', { operationId: 'write' });
    event('inbox/message', { messageId: 'old', target: 'next-step', text: 'consumed' });
    event('inbox/consumed', { messageIds: ['old'] });
    event('inbox/message', { messageId: 'new', target: 'next-step', text: 'next', payload: { sourceIds: ['document'], taskId: 'session' } });
    event('inbox/message', { messageId: 'later', target: 'next-turn', text: 'later' });
    await save();
    assert.deepEqual(await read('pending', { target: 'next-step' }), { ok: true, sessionId: 'session', messages: [{ messageId: 'new', target: 'next-step', text: 'next', taskInput: { sourceIds: ['document'], taskId: 'session' } }] });
    assert.deepEqual((await read()).pendingRecovery, []);
    event('context/compacted', { messages: [message('user', 'write'),
      message('assistant', '', { tool_calls: [{ id: 'blocked', name: 'Write', arguments: { path: 'b.txt' } }] }),
      message('tool', 'permission required', { name: 'Write', tool_call_id: 'blocked', is_error: true }),
      message('tool', JSON.stringify({ awaitingUserInput: true, question: '允许写入？', options: ['允许', '拒绝'], kind: 'permission', tool: 'Write' }), { name: 'AskUser', tool_call_id: 'ask' }),
    ] }, 'replace');
    await save();
    assert.deepEqual((await read()).pendingInput, { question: '允许写入？', options: ['允许', '拒绝'], kind: 'permission', tool: 'Write', requestId: 'ask', action: { tool: 'Write', arguments: { path: 'b.txt' } } });
    event('user_input/answered', { requestId: 'ask', message: message('tool', 'denied', { tool_call_id: 'ask', name: 'AskUser' }) });
    await save();
    assert.equal((await read()).pendingInput, null);
    event('tool/result', { message: message('tool', JSON.stringify({ awaitingUserInput: true, question: '执行计划？', options: ['执行', '取消'], kind: 'plan', plan: '修改文件' }), { name: 'ExitPlanMode', tool_call_id: 'plan' }) }, 'append');
    await save();
    assert.deepEqual((await read()).pendingInput, { question: '执行计划？', options: ['执行', '取消'], kind: 'plan', plan: '修改文件', tool: 'ExitPlanMode', requestId: 'plan' });
    event('user/message', { message: message('user', '新任务') }, 'append');
    await save();
    assert.equal((await read()).pendingInput, null);
    event('context/compacted', { messages: [message('user', '你好abc'), message('tool', 'done')] }, 'replace');
    event('model/request', { turn: 2, step: 1, header: { systemPrompt: '系统test' }, tools: [] });
    event('model/response', { turn: 2, step: 1, usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 3, output_tokens: 5 } });
    event('assistant/message', { message: message('assistant', 'must not count after request') }, 'append');
    await save();
    assert.deepEqual(await read('usage'), { ok: true, sessionId: 'session', contextUsage: {
      contextTokens: 123, contextEstimated: 0, lastOutputTokens: 5, systemTokensEstimate: 3,
      toolSchemaTokensEstimate: 0, messageTokensEstimate: 3, toolResultTokensEstimate: 1,
    } });
    assert.deepEqual(await read('pending'), { ok: false, error: 'invalid_target' });
    assert.deepEqual(await handleSessionRead({ action: 'status', sessionId: '../bad' }, root), { ok: false, error: 'invalid_session_id' });
    assert.deepEqual(await handleSessionRead({ action: 'status', sessionId: 'missing' }, root), { ok: false, error: 'session_not_found' });
    const valid = rows.join('\n') + '\n';
    await writeFile(file, valid.trimEnd());
    assert.equal((await read()).ok, true);
    await writeFile(file, valid.replace('整理文件', '篡改文件'));
    await assert.rejects(read(), /hash mismatch/);
    await writeFile(file, valid + '{"partial":\n');
    await assert.rejects(read(), /invalid JSON/);
    rows = [];
    console.log('runtime session reads passed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
