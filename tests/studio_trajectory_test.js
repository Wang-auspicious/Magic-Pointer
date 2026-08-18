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
    { seq: 2, kind: 'message', turn: 1, step: 1, state: 'done', text: '已完成。', startedAt: 1010,
      completedAt: 2210, firstTokenAt: 1330, usedBackend: 'gateway', outputTokens: 30 },
    { seq: 3, kind: 'tool', turn: 1, callId: 'call-1', name: 'read', state: 'done',
      text: '{"path":"a.md"}', result: 'text', startedAt: 1350, completedAt: 1750,
      usedBackend: 'filesystem' },
  ],
}]);

assert.strictEqual(rows.length, 3, 'one turn projects user, model and tool trajectory rows');
assert.deepStrictEqual(rows.map((row) => row.kind), ['user', 'message', 'tool']);
assert.strictEqual(rows[0].tokens, 120, 'input tokens stay on the input row');
assert.strictEqual(rows[1].tokens, 30, 'output tokens stay on the model row');
assert.strictEqual(rows[1].latencyMs, 1200, 'real model latency must survive projection');
assert.strictEqual(rows[1].firstTokenMs, 320, 'TTFT is derived from the persisted request timestamps');
assert.strictEqual(rows[2].label, 'Read');
assert.strictEqual(rows[2].backend, 'filesystem');
assert.strictEqual(rows[2].latencyMs, 400);
assert.strictEqual(rows[2].index, 3, 'trajectory record indexes retain event order');
assert.strictEqual(rows[2].recordId, 'tool\u0000call\u0000call-1', 'tool records retain stable call identity');

const node = DshTrajectory.render(rows);
const markup = node.outerHTML;
assert(markup.includes('dsh-trajectory-toolbar'), 'trajectory includes the DSH toolbar shell');
assert(markup.includes('dsh-trajectory-timeline'), 'trajectory includes the DSH timeline overview');
assert(markup.includes('dsh-trajectory-table'), 'trajectory uses the current DSH two-column ledger');
assert(markup.includes('data-role-kind="user"'), 'ledger exposes the DSH USER event tag');
assert(markup.includes('data-role-kind="message"'), 'ledger exposes the DSH ASSISTANT event tag');
assert(markup.includes('data-role-kind="tool"'), 'ledger exposes the DSH TOOL event tag');
assert(markup.includes('dsh-trajectory-result-request'),
  'tool request name and payload must stay in DSH resultRequest so the result remains on the same 30px row');
assert(markup.includes('Duration'), 'trajectory toolbar carries the DSH duration mode');
assert(markup.includes('data-actual-duration="true"'), 'trajectory opens in the reference Duration view');
assert(markup.includes('data-trajectory-action="duration" aria-pressed="true"'), 'Duration toggle paints its DSH selected capsule');
assert(markup.includes('Input'), 'trajectory timeline carries the input lane');
assert(markup.includes('Model'), 'trajectory timeline carries the model lane');
assert(markup.includes('Tools'), 'trajectory timeline carries the tools lane');

console.log('studio trajectory test ok');
