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

const clarification = stageEventFromBridge({
  ok: true,
  answer: 'Which one?\n\n1. A\n2. B',
  answerShape: 'clarification',
  awaitingUserInput: true,
  pendingInput: { question: 'Which one?', options: ['A', 'B'] },
  modelUsage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
});
assert.strictEqual(clarification.type, 'RESULT');
assert.strictEqual(clarification.result.awaitingUserInput, true);
assert.deepStrictEqual(clarification.result.pendingInput, { question: 'Which one?', options: ['A', 'B'] });
assert.deepStrictEqual(clarification.result.modelUsage, { inputTokens: 12, outputTokens: 4, totalTokens: 16 });

const promptDraft = stageEventFromBridge({
  ok: true,
  kind: 'agent-prompt-draft',
  contextPrompt: '请检查这个文件并修复。',
  generatedBy: 'model',
  contextPacket: { schemaVersion: 2, packetId: 'must-not-cross' },
  actionProposals: [],
});
assert.strictEqual(promptDraft.type, 'RESULT');
assert.strictEqual(promptDraft.result.kind, 'agent-prompt-draft');
assert.strictEqual(promptDraft.result.prompt, '请检查这个文件并修复。');
assert.strictEqual(promptDraft.result.generatedBy, 'model');
assert.strictEqual(promptDraft.result.contextPacket, undefined);

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

// --- Human error messages -------------------------------------------------
// The acceptance run put `bridge_timeout` on screen. A bridge code is for the
// log; the bubble gets a sentence, and an unmapped code gets the honest
// fallback rather than the identifier. Timeout/cancel happen AFTER tools may
// have run, so they must not claim nothing changed (O4).
{
  const { humanErrorMessage } = require('../electron/stage_contract');
  assert.strictEqual(
    stageEventFromBridge({ ok: false, error: 'bridge_timeout' }).error.message,
    '这次处理超时停下了。已完成步骤的记录都保留在会话里；可以重试或换一个更小的范围。',
  );
  assert.strictEqual(
    stageEventFromBridge({ ok: false, error: 'some_unmapped_future_code' }).error.message,
    '这次没能完成。已完成的部分记录在会话里。',
  );
  assert.strictEqual(humanErrorMessage('已经写好的一句话。'), '已经写好的一句话。');
  assert.strictEqual(humanErrorMessage(''), '这次没能完成。已完成的部分记录在会话里。');
  assert.strictEqual(humanErrorMessage('structured_context_unavailable').includes('没能从这个窗口读到可靠的文字'), true);
  for (const event of [
    stageEventFromBridge({ ok: false, error: 'bridge_timeout' }),
    stageEventFromBridge({ ok: false, error: 'payload_too_large' }),
    stageEventFromBridge({ ok: true, answer: '好了', error: 'capture_missing' }),
  ]) {
    const text = JSON.stringify(event);
    assert(!/[a-z]+_[a-z]+_?[a-z]*"/.test(text.replace(/"[a-zA-Z]+":/g, '')), `leaked a code: ${text}`);
  }
}
console.log('stage contract human error test ok');

// ---- 账单随结果到达渲染层（O6）：真实轮数/token，不是假数字 ----
const billed = stageEventFromBridge({
  ok: true,
  answer: '做完了。',
  interactionLedger: {
    interactionId: 'sess:3',
    turns: 12,
    tokensText: 3400,
    tokensVision: 900,
    succeeded: true,
    failureType: null,
    egressEventIds: [],
  },
});
assert.strictEqual(billed.type, 'RESULT');
assert.deepStrictEqual(billed.result.ledger, {
  turns: 12,
  tokensText: 3400,
  tokensVision: 900,
  succeeded: true,
  failureType: null,
}, '账单只带可渲染的事实，原始 session 事件不过界');

const unbilled = stageEventFromBridge({ ok: true, answer: '好。' });
assert.strictEqual(unbilled.result.ledger, undefined, '没有账单就不编一个');
