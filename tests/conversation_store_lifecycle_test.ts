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

const renamed = store.rename(conversation.id, '季度汇报整理');
assert.strictEqual(renamed?.conversation?.title, '季度汇报整理', 'rename must set the custom title');
const reloaded = createConversationStore({ baseDir });
assert.strictEqual(reloaded.get(conversation.id)?.title, '季度汇报整理', 'rename must persist to disk');

assert.strictEqual(store.rename(conversation.id, '   ')?.ok, false, 'blank title must be rejected');

const moved = store.setProject(conversation.id, path.join(baseDir, 'project-b'));
assert.strictEqual(moved.ok, true);
assert.strictEqual(createConversationStore({ baseDir }).get(conversation.id).workspaceRoot, path.join(baseDir, 'project-b'));
assert.strictEqual(store.listProjects().some((project: { root: string }) => project.root === path.join(baseDir, 'project-b')), true);
assert.strictEqual(store.setProject('missing', 'unused').ok, false);
assert.strictEqual(store.setProject(conversation.id, '').conversation.workspaceRoot, undefined, 'No folder actually removes the binding');

assert.strictEqual(store.remove(conversation.id)?.ok, true);
assert.strictEqual(store.get(conversation.id), null);
const afterDelete = createConversationStore({ baseDir });
assert.strictEqual(afterDelete.get(conversation.id), null, 'delete must persist to disk');

assert.strictEqual(store.rename('nope', 'x')?.ok, false);
assert.strictEqual(store.remove('nope')?.ok, false);

let tick = 1000;
const library = createConversationStore({ baseDir: path.join(baseDir, 'library'), now: () => ++tick });
const taskContext = { taskId: 'material-task', referenceRevision: 0,
  sources: [{ sourceId: 'notes', identity: { absolutePath: 'D:/notes.md' } }], references: [] };
for (let index = 0; index < 65; index++) library.appendTurn({ newConversation: true,
  question: `Task ${index}`, answer: 'Complete transcript', taskContext });
const first = library.list()[0];
assert.strictEqual(library.list().length, 65, 'View all must not silently stop at the old sidebar limit of 60');
assert.strictEqual(library.list(2).length, 2, 'bounded consumers can still request a limited view');
assert.strictEqual(first.createdAt, library.get(first.id).createdAt);
assert.deepStrictEqual(first.taskContext, taskContext);
assert.strictEqual(first.turns, 1, 'the list remains a summary projection');

console.log('conversation store lifecycle test ok');
