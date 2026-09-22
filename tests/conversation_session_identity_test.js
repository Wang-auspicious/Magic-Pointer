'use strict';


const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.ts', 'utf8');
const bridge = fs.readFileSync('electron/runtime/index.ts', 'utf8');

const sendHandler = main.slice(main.indexOf("ipcMain.handle('conversations:send'"));
assert(sendHandler.length > 0, 'main must handle conversations:send');
const payloadBlock = sendHandler.slice(
  sendHandler.indexOf('const payload = {'),
  sendHandler.indexOf('return new Promise'),
);
assert(
  /\bconversationId\b/.test(payloadBlock),
  'conversations:send payload must carry conversationId — 否则桥端无法按对话分 session',
);
assert(
  /\bagentSessionId\b/.test(payloadBlock),
  'conversations:send payload must carry the thread agentSessionId — 新建对话第一轮还没有 conversationId，靠它把首轮和后续轮接上',
);

assert(
  bridge.includes('export function resolveSessionId'),
  'bridge must resolve the agent session id through one explicit seam',
);
assert(
  !/sha256\(\s*session_key/.test(bridge) && !bridge.includes('windowTitle") or "chat"'),
  'bridge must not derive the agent session from windowTitle/"chat" — 普通对话没有 selection object，会全部塌缩成同一个 id',
);
assert(
  bridge.includes('conversationId') && bridge.includes('agentSessionId'),
  'bridge main() must read both identity fields off the payload',
);
assert(
  bridge.includes('agentSessionId: session.id'),
  'bridge must return the resolved session id so conversation_store can persist it',
);

console.log('conversation session identity test ok');
