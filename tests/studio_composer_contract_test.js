'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const preload = fs.readFileSync('electron/preload.ts', 'utf8');
const main = fs.readFileSync('electron/main.ts', 'utf8');
const studio = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const data = fs.readFileSync('electron/renderer/data.ts', 'utf8');

assert.match(preload, /send:\s*\(payload:[^)]*\)\s*=>\s*ipcRenderer\.invoke\('conversations:send'/,
  'the visible Studio composer must have an acknowledged IPC channel');
assert.match(main, /ipcMain\.handle\('conversations:send'/,
  'main must own the conversation send boundary');
assert(main.includes("runPythonBridge(payload, 'scripts/conversation_bridge.py', 'dashboard'"),
  'Studio follow-ups must use the configured model runtime through a bounded bridge');
assert(data.includes('sendConversation('), 'Studio data must expose the live send operation');
assert.match(studio, /Data\.sendConversation\(\s*activeConversationId,\s*requestQuestion,\s*composerPreset,\s*requestId,\s*activeProjectRoot/,
  'submitting the visible composer must carry attachments, permission preset, and the selected project');
assert(studio.includes("composerPreset = 'workspace-write'"),
  'the permission chip must default to the workspace-write preset');
assert(studio.includes('confirmFullAccess'),
  'Full access must pass an explicit risk confirmation gate before it can be selected');
assert(main.includes('raw?.permissionPreset'), 'main must forward the permission preset to the agent runtime');
assert(preload.includes('permissionPreset'), 'preload must forward the permission preset');
assert(!studio.includes('主窗输入条还没有发送通道'),
  'the knowingly inert composer must not return');
const conversationSendHandler = main.slice(
  main.indexOf("ipcMain.handle('conversations:send'"),
  main.indexOf("ipcMain.handle('conversations:stop'"),
);
assert(
  conversationSendHandler.indexOf('recordPermissionDecision') >= 0
    && conversationSendHandler.indexOf('recordPermissionDecision') < conversationSendHandler.indexOf('runPythonBridge('),
  'always-allow/deny decisions must persist before the resumed model request can fail',
);
assert(!/recordPermissionDecision\([\s\S]{0,200}onceNow/.test(conversationSendHandler),
  'one-shot permission must never enter the durable thread memo');

// Stop 必须只有一个行为入口：按钮与 Escape 共用，才能保持 Receipt/状态提示一致。
assert.match(studio, /async function stopActiveConversation\(\)/,
  'Studio must centralize active-turn cancellation');
assert((studio.match(/stopActiveConversation\(\)/g) || []).length >= 3,
  'the stop button and Escape must both call the shared stop path');
assert.strictEqual((studio.match(/Data\.stopConversation\(/g) || []).length, 1,
  'only the shared stop path may cross the conversation stop boundary');
assert(studio.includes('ConversationControl.callConversationAction'),
  'the shared stop path must normalize rejected IPC and ok:false results');
assert.match(studio, /const menuWasOpen[\s\S]*if \(!menuWasOpen && studioComposerBusy && pendingConversation\)/,
  'Escape must snapshot open menus before deciding whether to stop the turn');
assert(studio.includes("note.textContent = '正在停止…'"),
  'the shared stop path must show honest stopping feedback');
assert.match(studio, /if \(!result\.ok && pendingConversation === pending\)[\s\S]*delete pending\.body\.dataset\.stopRequested[\s\S]*note\.textContent = result\.error/,
  'a normalized stop failure must clear the guard and leave an honest retryable error');
assert.match(studio, /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); closeSlashMenu\(\); return; \}/,
  'Escape used to close the slash menu must not bubble and stop the active turn');
assert.match(studio, /input\.addEventListener\('keydown', \(event\) => \{[\s\S]*?event\.key !== 'Escape'[\s\S]*?event\.preventDefault\(\);\s*event\.stopPropagation\(\);[\s\S]*?setExpanded\(false\);\s*\}\);/,
  'Escape consumed by sidebar search must not bubble into the active-turn stop handler');

// idle 转换集中恢复焦点，并在用户正编辑另一个 input/textarea 时让路。
assert.match(studio, /function focusComposerWhenIdle\(\)/,
  'Studio must centralize guarded idle focus restoration');
assert.match(studio, /document\.activeElement[\s\S]*tagName[\s\S]*textarea\.focus\(\)/,
  'Studio focus restoration must inspect the current typing target');
assert.match(studio, /if \(!running\) focusComposerWhenIdle\(\)/,
  'the idle state transition must own focus restoration');
assert(!/setComposerRunningState\(false\);\s*textarea\.focus\(\);/.test(studio),
  'request cleanup must not unconditionally steal focus from another field');
assert(studio.includes('ConversationControl.failedDraftValue(textarea.value, question)'),
  'failed requests must merge the old question without overwriting a new draft');

// Bash prefix grant must survive bridge/store/UI and persist the narrow rule,
// never widen "always allow pytest" into the whole Bash tool.
assert(data.includes('prefix?: string'), 'pending permission input must type the Bash prefix');
assert.match(studio, /pendingPermissionAsk:\s*\{ tool: string; prefix\?: string \}/,
  'Studio pending permission state must retain the command prefix');
assert(studio.includes('ConversationControl.permissionGrantRule'),
  'Studio must build a deterministic Bash(prefix) grant rule');
assert.match(studio, /Always allow \$\{prefix \|\| tool\}/,
  'the always-allow button must show the granted command prefix');
assert(studio.includes("make('Allow once'"));
assert(studio.includes("make('Deny'"));
assert.match(preload, /permissionGrant[^\n]*slice\(0, 200\)/,
  'preload must not truncate a bounded Bash(prefix) rule at the old 64-char tool-name cap');

console.log('studio composer contract test ok');
