'use strict';


const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.ts', 'utf8');
const bridge = fs.readFileSync('electron/runtime/index.ts', 'utf8');

// The IPC handler is a thin authorised wrapper; the payload is assembled in
// sendConversation. Find it where it actually lives, and tolerate the
// formatter wrapping the handle( … ) call over several lines — matching the
// literal one-line form is what made this fail after a reformat rather than
// after a behaviour change.
const channelAt = main.indexOf("'conversations:send'");
assert(channelAt > 0, 'main must handle conversations:send');
const sendFnAt = main.indexOf('function sendConversation');
assert(sendFnAt > 0, 'the conversations:send payload must be built in sendConversation');
const payloadAt = main.indexOf('const payload = {', sendFnAt);
assert(payloadAt > 0, 'sendConversation must build an explicit payload');
const payloadBlock = main.slice(payloadAt, main.indexOf('\n  };', payloadAt));
assert(payloadBlock.length > 0, 'the payload block must be readable');
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
