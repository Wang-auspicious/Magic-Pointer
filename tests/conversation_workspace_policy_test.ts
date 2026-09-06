const assert = require('node:assert');
const {
  resolveConversationWorkspace,
  workspaceCapabilityState,
  attachmentDialogOptions,
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
assert.deepStrictEqual(attachmentDialogOptions(''), {
  title: '添加任务材料',
  properties: ['openFile', 'multiSelections'],
}, 'ordinary office tasks must be able to attach files without opening a code project');
assert.deepStrictEqual(attachmentDialogOptions(' C:/repo '), {
  title: '添加任务材料',
  defaultPath: 'C:/repo',
  properties: ['openFile', 'multiSelections'],
});

console.log('conversation workspace policy test ok');
