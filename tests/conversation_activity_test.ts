import test from 'node:test';
import assert from 'node:assert/strict';
const activity = require('../electron/renderer/conversation_state');

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
