const assert = require('assert');
const {
  commandForChip,
  inferObjectKind,
  selectionSourceForReason,
  stageEventFromBridge,
} = require('../electron/stage_contract');

assert.strictEqual(commandForChip('rewrite'), '改写这段文字');
assert.strictEqual(commandForChip('translate'), '把这段文字翻译成中文');
assert.strictEqual(commandForChip('summarize'), '总结这段文字');
assert.strictEqual(commandForChip('compare'), '对比这个和上一个对象');
assert.strictEqual(commandForChip('tidy'), '整理这个对象');
assert.strictEqual(commandForChip('add-to-calendar'), '添加到日历');
assert.strictEqual(commandForChip('unknown'), null);

assert.strictEqual(inferObjectKind({
  source_kind: 'visual_region',
  context: { content: 'OCR text' },
}), 'image');
assert.strictEqual(inferObjectKind({
  source_kind: 'native_selection',
  context: { content: '设计评审 2026年7月30日 10:00' },
}), 'date');
assert.strictEqual(inferObjectKind({
  source_kind: 'native_selection',
  context: { content: 'ordinary selected text' },
}), 'text');
assert.strictEqual(inferObjectKind({ source_kind: 'window', context: {} }), null);

assert.strictEqual(selectionSourceForReason('click'), 'click');
assert.strictEqual(selectionSourceForReason('mouse-click'), 'click');
assert.strictEqual(selectionSourceForReason('wiggle'), 'wiggle');

const calendar = stageEventFromBridge({
  ok: true,
  answer: '日历草稿已生成。',
  intentKind: 'calendar_event_draft',
  calendarDraft: {
    title: '设计评审',
    location: 'A 会议室',
    event: {
      title: '设计评审',
      start_at: '2026-07-30T10:00:00+08:00',
      end_at: '2026-07-30T11:00:00+08:00',
      location: 'A 会议室',
    },
    warnings: [],
  },
});
assert.strictEqual(calendar.type, 'RESULT');
assert.strictEqual(calendar.result.kind, 'calendar-draft');
assert.strictEqual(calendar.result.status, 'draft');
assert.strictEqual(calendar.result.title, '设计评审');
assert.strictEqual(calendar.result.actions[0].kind, 'context');
assert.strictEqual(calendar.result.actions[0].id, 'open-calendar-draft');

const word = stageEventFromBridge({
  ok: true,
  answer: '已生成替换预览。',
  actionProposals: [{
    id: 'replace-1',
    action_token: 'token-1',
    action_type: 'office_replace_selection',
    confirmation_required: true,
    parameters: {
      expected_text_excerpt: '原始文字',
      replacement_text_excerpt: '改写后的文字',
    },
  }],
});
assert.strictEqual(word.type, 'RESULT');
assert.strictEqual(word.result.kind, 'text-draft');
assert.strictEqual(word.result.original, '原始文字');
assert.strictEqual(word.result.proposed, '改写后的文字');
assert.deepStrictEqual(word.result.actions[0], {
  kind: 'proposal',
  id: 'replace-1',
  actionToken: 'token-1',
  label: '确认替换',
  confirmationRequired: true,
});

const accepted = stageEventFromBridge({
  ok: true,
  answer: '已交给 Pi，任务 task-9 正在运行，尚未完成。',
  executionResult: {
    status: 'pending',
    output: {
      fabric_receipt: {
        status: 'accepted',
        verified: false,
        output: { taskId: 'task-9', provider: 'pi', status: 'queued' },
      },
    },
  },
  actionProposals: [],
});
assert.strictEqual(accepted.type, 'RESULT');
assert.strictEqual(accepted.result.status, 'accepted');
assert.strictEqual(accepted.result.verified, false);
assert.strictEqual(accepted.result.taskId, 'task-9');
assert.ok(!accepted.result.statusLabel.includes('完成'));

const executed = stageEventFromBridge({
  ok: true,
  answer: '已加入购物清单。',
  executionResult: {
    status: 'succeeded',
    output: { verified: true },
  },
  actionProposals: [{
    id: 'undo-1',
    action_token: 'undo-token',
    action_type: 'shopping_list_undo_add',
    confirmation_required: true,
  }],
});
assert.deepStrictEqual(executed, {
  type: 'COMPLETE',
  outcome: { status: 'succeeded', verified: true },
}, 'verified execution finishes without opening a reply card');

const question = stageEventFromBridge({
  ok: true,
  answer: '这是一个需要展示给用户的回答。',
  actionProposals: [],
});
assert.strictEqual(question.type, 'RESULT');
assert.strictEqual(question.result.presentation, 'answer-card');
assert.strictEqual(question.result.answer, '这是一个需要展示给用户的回答。');

const failure = stageEventFromBridge({
  ok: false,
  error: '当前选区已过期。',
  actionProposals: [],
});
assert.deepStrictEqual(failure, {
  type: 'ERROR',
  error: { message: '当前选区已过期。' },
});

console.log('stage_contract_test: all assertions passed');
