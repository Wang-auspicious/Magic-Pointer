const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConversationStore } = require('../electron/conversation_store');

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-conv-store-'));
const store = createConversationStore({ baseDir });

const conversation = store.appendTurn({
  newConversation: true,
  question: '帮我总结这份报告的三个要点',
  answer: '要点如下',
  object: { app: 'Word', windowTitle: '季度报告.docx' },
});
assert(conversation?.id, 'appendTurn must produce a conversation');

// 重命名：用户起的名字优先于自动标题，且必须落盘（重启后仍在）。
const renamed = store.rename(conversation.id, '季度汇报整理');
assert.strictEqual(renamed?.conversation?.title, '季度汇报整理', 'rename must set the custom title');
const reloaded = createConversationStore({ baseDir });
assert.strictEqual(reloaded.get(conversation.id)?.title, '季度汇报整理', 'rename must persist to disk');

// 空白名字拒绝——不把对话改成空标题。
assert.strictEqual(store.rename(conversation.id, '   ')?.ok, false, 'blank title must be rejected');

// 删除：列表与 get 都不能再看到它。
assert.strictEqual(store.remove(conversation.id)?.ok, true);
assert.strictEqual(store.get(conversation.id), null);
const afterDelete = createConversationStore({ baseDir });
assert.strictEqual(afterDelete.get(conversation.id), null, 'delete must persist to disk');

// 未知 id：诚实失败，不假装成功。
assert.strictEqual(store.rename('nope', 'x')?.ok, false);
assert.strictEqual(store.remove('nope')?.ok, false);

console.log('conversation store lifecycle test ok');
