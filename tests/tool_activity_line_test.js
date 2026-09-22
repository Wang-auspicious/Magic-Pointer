'use strict';


const assert = require('node:assert');
const CardModel = require('../electron/cards');

function activityRecord(line) {
  return {
    phase: 'tool_activity',
    fields: { b64: Buffer.from(JSON.stringify(line), 'utf8').toString('base64') },
  };
}

const started = CardModel.phaseStep({
  phase: 'tool_call',
  fields: { name: 'Read', id: 'call-1' },
});
assert.strictEqual(started.phase, 'tool:call-1');
assert.strictEqual(started.label, 'Read');
assert.strictEqual(started.state, 'pending');

const finished = CardModel.phaseStep(activityRecord({
  id: 'call-1',
  tool: 'Read',
  target: '…/renderer/stage.ts',
  ok: true,
  detail: '2371 行',
}));
assert.strictEqual(finished.phase, 'tool:call-1', '两个时刻共用一行，不叠成两行');
assert.strictEqual(finished.label, 'Read(…/renderer/stage.ts)');
assert.strictEqual(finished.note, '2371 行');
assert.strictEqual(finished.state, 'done');

const merged = CardModel.applyPatch(
  CardModel.normalizeCard({ kind: 'prose', state: 'running', steps: [started] }),
  { steps: [finished] },
);
assert.strictEqual(merged.steps.length, 1, '等待行升级成完成行，不是再加一行');
assert.strictEqual(merged.steps[0].label, 'Read(…/renderer/stage.ts)');

const failed = CardModel.phaseStep(activityRecord({
  id: 'call-2',
  tool: 'Bash',
  target: 'npm test',
  ok: false,
  detail: 'TOOL_ERROR',
}));
assert.strictEqual(failed.state, 'failed');
assert.strictEqual(failed.label, 'Bash(npm test)');

assert.strictEqual(CardModel.phaseStep({ phase: 'tool_activity', fields: { b64: '!!!' } }), null);
assert.strictEqual(CardModel.phaseStep({ phase: 'tool_activity', fields: {} }), null);

for (const phase of ['model_request', 'model_response', 'loop_progress', 'loop_started']) {
  assert.ok(CardModel.isPlumbingPhase(phase), `${phase} 是管道，不该占一行动作`);
}
assert.ok(!CardModel.isPlumbingPhase('tool:call-1'), '工具调用是动作');
assert.ok(!CardModel.isPlumbingPhase('action_executed'), '真实动作仍然可见');

assert.strictEqual(
  CardModel.runningLabel(CardModel.normalizeCard({ kind: 'prose', state: 'running', steps: [started] })),
  'Read',
);

console.log('tool activity line test ok');
