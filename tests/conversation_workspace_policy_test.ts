const assert = require('node:assert');
const {
  resolveConversationWorkspace,
  workspaceCapabilityState,
} = require('../electron/conversation_workspace_policy');

assert.strictEqual(resolveConversationWorkspace('', ''), null);
assert.strictEqual(resolveConversationWorkspace(' D:/picked ', 'C:/old'), 'D:/picked');
assert.strictEqual(resolveConversationWorkspace('', ' C:/thread '), 'C:/thread');
assert.deepStrictEqual(workspaceCapabilityState(null), {
  bound: false,
  codingTools: false,
  label: 'Select folder…',
});
assert.deepStrictEqual(workspaceCapabilityState('C:/repo'), {
  bound: true,
  codingTools: true,
  label: 'repo',
});

console.log('conversation workspace policy test ok');
