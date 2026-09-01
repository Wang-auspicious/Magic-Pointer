'use strict';

const assert = require('node:assert');
const DshTrajectory = require('../electron/renderer/dsh_trajectory');

const rows = DshTrajectory.project([{
  at: 1000,
  question: '检查文件',
  answer: '已完成。',
  timingMs: 1800,
  modelUsage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
  trajectory: [
    { seq: 1, kind: 'user', turn: 1, text: '检查文件', startedAt: 1000 },
    { seq: 2, kind: 'request-header', turn: 1, promptCache: true,
      usedBackend: 'magic_pointer.messages_multiturn_streaming', maxTokens: 4096 },
    { seq: 3, kind: 'message', turn: 1, step: 1, state: 'done', text: '已完成。', startedAt: 1010,
      completedAt: 2210, firstTokenAt: 1330, usedBackend: 'gateway', outputTokens: 30 },
    { seq: 4, kind: 'tool', turn: 1, callId: 'call-1', name: 'read', state: 'done',
      text: '{"path":"a.md"}', result: 'text', startedAt: 1350, completedAt: 1750,
      usedBackend: 'filesystem' },
  ],
}]);

assert.strictEqual(rows.length, 4, 'one turn projects user, request, model and tool trajectory rows');
assert.deepStrictEqual(rows.map((row) => row.kind), ['user', 'request', 'message', 'tool']);
assert.strictEqual(rows[0].tokens, 120, 'input tokens stay on the input row');
assert.strictEqual(rows[1].label, 'REQUEST');
assert(rows[1].text.includes('Prompt cache: on'));
assert(rows[1].text.includes('Max tokens: 4096'));
assert.strictEqual(rows[2].tokens, 30, 'output tokens stay on the model row');
assert.strictEqual(rows[2].latencyMs, 1200, 'real model latency must survive projection');
assert.strictEqual(rows[2].firstTokenMs, 320, 'TTFT is derived from the persisted request timestamps');
assert.strictEqual(rows[3].label, 'Read');
assert.strictEqual(rows[3].backend, 'filesystem');
assert.strictEqual(rows[3].latencyMs, 400);
assert.strictEqual(rows[3].index, 4, 'trajectory record indexes retain event order');
assert.strictEqual(rows[3].recordId, 'tool\u0000call\u0000call-1', 'tool records retain stable call identity');

const node = DshTrajectory.render(rows);
const markup = node.outerHTML;
assert(markup.includes('dsh-trajectory-toolbar'), 'trajectory includes the DSH toolbar shell');
assert(markup.includes('dsh-trajectory-timeline'), 'trajectory includes the DSH timeline overview');
assert(markup.includes('dsh-trajectory-table'), 'trajectory uses the current DSH two-column ledger');
assert(markup.includes('data-role-kind="user"'), 'ledger exposes the DSH USER event tag');
assert(markup.includes('data-role-kind="message"'), 'ledger exposes the DSH ASSISTANT event tag');
assert(markup.includes('data-role-kind="tool"'), 'ledger exposes the DSH TOOL event tag');
assert(markup.includes('data-role-kind="request"'), 'ledger exposes prompt-cache request diagnostics');
assert(markup.includes('Prompt cache: on'), 'trajectory visibly reports prompt cache request state');

const legacyRequestRows = DshTrajectory.project([{
  trajectory: [{ seq: 1, kind: 'request-header', turn: 1, usedBackend: 'legacy-gateway' }],
}]);
assert.strictEqual(legacyRequestRows.length, 1);
assert(legacyRequestRows[0].text.includes('Prompt cache: not recorded'),
  'legacy request headers without the field must not be rewritten as cache off');
assert(markup.includes('dsh-trajectory-result-request'),
  'tool request name and payload must stay in DSH resultRequest so the result remains on the same 30px row');
assert(markup.includes('Duration'), 'trajectory toolbar carries the DSH duration mode');
assert(markup.includes('data-actual-duration="true"'), 'trajectory opens in the reference Duration view');
assert(markup.includes('data-trajectory-action="duration" aria-pressed="true"'), 'Duration toggle paints its DSH selected capsule');
assert(markup.includes('Input'), 'trajectory timeline carries the input lane');
assert(markup.includes('Model'), 'trajectory timeline carries the model lane');
assert(markup.includes('Tools'), 'trajectory timeline carries the tools lane');

console.log('studio trajectory test ok');
