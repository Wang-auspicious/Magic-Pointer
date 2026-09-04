'use strict';

/* 运行中活动区契约(CC/DSH 金标准):
   1. 内部进度阶段绝不渲染成 Think 行——运行中只有一行状态(StateDot+标签),原地更新;
   2. "模型请求 · 第 N 轮"这类管道信息不进聊天流(细节在轨迹视图);
   3. 工具调用仍是工具行;
   4. session_ready / agent_turn 等阶段必须有友好标签,不许裸奔 phase 原文。 */

const assert = require('node:assert');
const fs = require('node:fs');

const chat = fs.readFileSync('electron/renderer/dsh_chat.ts', 'utf8');
const studio = fs.readFileSync('electron/renderer/studio.ts', 'utf8');

/* liveActivityNode:非工具阶段走单行状态,不走 thinkNode */
assert(!/thinkNode\(labels\[phase\]/.test(chat), 'live progress must not render as Think rows');
assert(chat.includes('turnStatusNode(liveStatusLabel'), 'live progress renders the single status row');
assert(/function liveStatusLabel\(/.test(chat), 'phase labels live in one friendly-label function');

/* 友好标签覆盖真实阶段,含 session_ready / agent_turn(带轮次) */
for (const needle of ["session_ready", 'agent_turn', "runtime_boot", 'model_request', 'model_first_chunk']) {
  assert(chat.includes(needle), `label table must cover ${needle}`);
}

/* 助手回合:模型请求管道行删除 */
assert(!chat.includes('visibleModelActivities'), 'model-request plumbing rows must be gone');
assert(!chat.includes('模型请求 · 第'), 'no plumbing text in the transcript');

/* studio:非工具进度全部并入单一 status 桶(原地更新,不堆叠) */
assert(/return 'status'/.test(studio), 'non-tool progress collapses into one status bucket');
assert(!studio.includes("return 'runtime'"), 'old runtime bucket must be gone');
assert(studio.includes("String(record.phase || '') === 'subagent'"));
assert(studio.includes('ConversationControl.decodeChunkBlob(fields)'));
assert(studio.includes('liveSubagentTasks.set('));
assert(studio.includes('renderProjectTasks()'));
assert(studio.includes('studioSubagentGlobals.activeSubagentParentCallId('),
  'a live child snapshot must inherit the active parent Agent call id');
assert(studio.includes("payload.parentCallId = parentCallId"));

console.log('studio_live_status_contract ok');
