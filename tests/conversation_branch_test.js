'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConversationStore } = require('../electron/conversation_store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-branch-'));
let clock = 1_780_000_000_000;
const store = createConversationStore({ baseDir: dir, now: () => (clock += 1) });

const original = store.appendTurn({
  newConversation: true,
  question: '先分析项目',
  answer: '第一轮',
  workspaceRoot: 'D:/projects/alpha',
  agentSessionId: 'runtime-session-original',
  hasPendingWork: true,
});
store.appendTurn({ conversationId: original.id, question: '继续实现', answer: '第二轮' });
store.appendTurn({ conversationId: original.id, question: '运行测试', answer: '第三轮' });

const forked = store.branch(original.id, 1);
assert(forked, 'a valid turn must create a branch');
assert.notStrictEqual(forked.id, original.id, 'a branch is a new conversation');
assert.strictEqual(forked.title, `${store.get(original.id).title} · 分支`, 'the branch must be legible in the project tree');
assert.strictEqual(forked.workspaceRoot, 'D:/projects/alpha', 'a branch remains in the same project');
assert.strictEqual(forked.turns.length, 2, 'turn index is inclusive and later work must be excluded');
assert.strictEqual(forked.turns[1].question, '继续实现');
assert.strictEqual(forked.agentSessionId, undefined, 'a branch must start a new runtime session');
assert.strictEqual(forked.hasPendingWork, false, 'a branch must not inherit a stale running badge');
assert.strictEqual(store.get(original.id).turns.length, 3, 'branching must not mutate the source conversation');
assert.strictEqual(store.branch(original.id, -1), null, 'negative branch index is invalid');
assert.strictEqual(store.branch(original.id, 99), null, 'out-of-range branch index is invalid');
assert.strictEqual(store.branch('missing', 0), null, 'unknown conversations cannot branch');

fs.rmSync(dir, { recursive: true, force: true });
console.log('conversation branch test ok');
