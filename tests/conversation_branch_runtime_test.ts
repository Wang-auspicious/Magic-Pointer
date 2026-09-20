const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConversationStore } = require('../electron/conversation_store');
const { planConversationStop } = require('../electron/conversation_control');
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-runtime-branch-'));
try {
  let now = 1000;
  const store = createConversationStore({ baseDir, now: () => ++now });
  const parent = store.appendTurn({ question: 'question', agentSessionId: 'parent', runtimeTurn: 7 });
  assert.equal(parent.turns[0].runtimeTurn, 7, 'persist durable turn identity independently of UI position');
  const taskContext = { taskId: 'child', sources: [{ sourceId: 'source-a', title: 'A' }], references: [], referenceRevision: 1 };
  const branch = store.branch(parent.id, 0, { agentSessionId: 'child', taskContext });
  assert.equal(branch.agentSessionId, 'child');
  assert.equal(branch.taskContext.taskId, 'child');
  assert.equal(branch.taskContext.sources[0].sourceId, 'source-a');
  const mainSource = fs.readFileSync(path.resolve(__dirname, '../electron/main.ts'), 'utf8');
  const childIdExpression = mainSource.match(/const childSessionId = (`[^;]+`);/)[1];
  const childSessionId = require('node:vm').runInNewContext(childIdExpression, { crypto: { randomUUID: () => '11111111-2222-3333-4444-555555555555' } });
  assert.equal(planConversationStop({ requestId: 'running', agentSessionId: childSessionId }).action, 'cancel', 'a fork remains controllable by the normal stop/steer contract');
  console.log('conversation_branch_runtime_test: passed');
} finally { fs.rmSync(baseDir, { recursive: true, force: true }); }
