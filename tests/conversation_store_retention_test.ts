const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConversationStore } = require('../electron/conversation_store');
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-conversation-retention-'));
const store = createConversationStore({ baseDir, deferPersist: true });
try {
  const first = store.appendTurn({ newConversation: true, question: 'turn 1', answer: 'one' });
  for (let i = 2; i <= 201; i++) store.appendTurn({ conversationId: first.id, question: `turn ${i}`, answer: 'ok' });
  for (let i = 1; i <= 500; i++) store.appendTurn({ newConversation: true, question: `conversation ${i}`, answer: 'ok' });
  store.flush();
  const reopened = createConversationStore({ baseDir });
  assert.equal(reopened.list().length, 501, 'all saved conversations remain discoverable');
  assert.equal(reopened.get(first.id)?.turns?.length, 201, 'long tasks retain every turn');
  assert.equal(reopened.get(first.id)?.turns?.[0].question, 'turn 1');
  console.log('conversation_store_retention_test: passed');
} finally {
  store.flush();
  fs.rmSync(baseDir, { recursive: true, force: true });
}
