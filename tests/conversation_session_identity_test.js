'use strict';

// 一条对话 = 一条 agent session。
//
// Python 侧的 agent session 是磁盘上一条哈希链 JSONL，断点续跑摘要
// (interrupted_turn_summary)、待办、取消请求、has_pending_work 都挂在它上面。
// 身份一旦塌缩成常量，症状不是"某个功能坏了"而是"对话本身不正常"：
//   - 新开的对话被上一条对话的未完成任务续跑块劫持；
//   - 停止按钮打断的是另一条正在跑的对话；
//   - 并发两条对话往同一条哈希链里追加。
//
// 旧实现从 object.windowTitle 派生，而普通文本对话根本没有 selection
// object —— 于是全 app 的普通对话共用 sha256("chat")。这里把身份过桥这件事
// 钉死在两端。

const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.ts', 'utf8');
const bridge = fs.readFileSync('scripts/conversation_bridge.py', 'utf8');

// —— Electron 侧：会话身份必须进 payload ——
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

// —— Python 侧：绝不回退到常量 ——
assert(
  bridge.includes('def resolve_agent_session_id'),
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
// 回传链路：结果里的 agentSessionId 必须是解析后的那个，不是入参回声，
// 否则 conversation_store 落库的是空串，下一轮又退回重新派生。
assert(
  bridge.includes('agent_session_id=resolved_session_id'),
  'bridge must return the resolved session id so conversation_store can persist it',
);

console.log('conversation session identity test ok');
