import test from 'node:test';
import assert from 'node:assert/strict';
const activity = require('../electron/renderer/conversation_state');

test('activity reads real list summaries whose turns field is a count', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const {createConversationStore} = require('../electron/conversation_store');
  const store = createConversationStore({
    baseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mp-summary-state-')),
  });
  const conversation = store.appendTurn({
    newConversation: true,
    question: 'A completed task',
    outcome: '已完成',
  });
  assert.equal(typeof store.list()[0].turns, 'number');
  assert.equal(activity.derive(store.list()[0]), 'completed');
  store.updateTurn({
    conversationId: conversation.id,
    turnIndex: 0,
    outcome: '等待输入',
    pendingInput: {requestId: 'question', kind: 'ask'},
  });
  assert.equal(activity.derive(store.list()[0]), 'awaiting');
});

test('a user-stopped task remains interrupted instead of being labelled as a failure', () => {
  assert.equal(
    activity.derive({
      hasPendingWork: true,
      lastOutcome: '已停止',
      lastFailed: true,
    }),
    'interrupted',
  );
  assert.equal(
    activity.derive({
      hasPendingWork: true,
      turns: [{outcome: '已停止', failed: true}],
    }),
    'interrupted',
  );
  assert.equal(
    activity.derive({
      hasPendingWork: true,
      lastOutcome: '失败',
      lastFailed: true,
    }),
    'failed',
  );
  assert.equal(
    activity.derive({
      hasPendingWork: true,
      turns: [{pendingInput: {requestId: 'ask'}}],
    }),
    'awaiting',
  );
});
