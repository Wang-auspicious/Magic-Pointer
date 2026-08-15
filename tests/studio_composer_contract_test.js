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
assert(studio.includes('await Data.sendConversation(activeConversationId, question)'),
  'submitting the visible composer must run the real operation');
assert(!studio.includes('主窗输入条还没有发送通道'),
  'the knowingly inert composer must not return');

console.log('studio composer contract test ok');
