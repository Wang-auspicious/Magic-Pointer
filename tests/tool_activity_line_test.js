'use strict';

// 过程流里的一行 = 一次真实的工具调用。
//
// 真机 9·3：一次问答在小窗里展开了十一行「思考过程」，十一行全是管道自己的
// 流水账（读了设置 / 过了一遍窗口 / 冻住了这块画面 / 凑上下文 / 交给模型 …），
// 没有一行说出它去动了什么。Claude Code 的过程流有用，是因为每一行都是
// `Read(file)` / `Bash(cmd)` 这样的「动词 + 对象」。这份测试钉那条线：
// 桥的 tool_call / tool_activity → cards.js → 界面上的一行。

const assert = require('node:assert');
const CardModel = require('../electron/cards');

function activityRecord(line) {
  return {
    phase: 'tool_activity',
    fields: { b64: Buffer.from(JSON.stringify(line), 'utf8').toString('base64') },
  };
}

// ---- 开始动了：一行等待，标签就是工具名 ----
const started = CardModel.phaseStep({
  phase: 'tool_call',
  fields: { name: 'Read', id: 'call-1' },
});
assert.strictEqual(started.phase, 'tool:call-1');
assert.strictEqual(started.label, 'Read');
assert.strictEqual(started.state, 'pending');

// ---- 动完了：同一个 phase，就地升级成「动词 + 对象」 ----
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

// ---- 失败的工具调用是失败的一行，不是一个安静的勾 ----
const failed = CardModel.phaseStep(activityRecord({
  id: 'call-2',
  tool: 'Bash',
  target: 'npm test',
  ok: false,
  detail: 'TOOL_ERROR',
}));
assert.strictEqual(failed.state, 'failed');
assert.strictEqual(failed.label, 'Bash(npm test)');

// ---- 坏掉的诊断行不许弄崩一次回答 ----
assert.strictEqual(CardModel.phaseStep({ phase: 'tool_activity', fields: { b64: '!!!' } }), null);
assert.strictEqual(CardModel.phaseStep({ phase: 'tool_activity', fields: {} }), null);

// ---- 模型往返不是动作 ----
for (const phase of ['model_request', 'model_response', 'loop_progress', 'loop_started']) {
  assert.ok(CardModel.isPlumbingPhase(phase), `${phase} 是管道，不该占一行动作`);
}
assert.ok(!CardModel.isPlumbingPhase('tool:call-1'), '工具调用是动作');
assert.ok(!CardModel.isPlumbingPhase('action_executed'), '真实动作仍然可见');

// ---- 正在跑的时候，标题说的是当前那个工具 ----
assert.strictEqual(
  CardModel.runningLabel(CardModel.normalizeCard({ kind: 'prose', state: 'running', steps: [started] })),
  'Read',
);

console.log('tool activity line test ok');
