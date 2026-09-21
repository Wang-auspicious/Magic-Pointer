'use strict';

// 展开态活在渲染层之外，按稳定 id 存。
//
// 这一版修的是两件事：
//   1. 重建不该丢掉用户的开合选择。助手轮结束时的 finish() 会 replaceChildren
//      整块换成终态节点，流式更新时也会换掉子节点——以前靠把旧 DOM 上的
//      data-open 按下标抄回去，行数或顺序一变就贴到别的行上，于是同一段流里
//      「有的自己折叠、有的自己展开」。
//   2. 默认值不该由「这一串里是不是只有一个调用」决定。参考实现里默认展开的
//      条件与数量无关，只有待回答的问题类工具会自己开。
const assert = require('node:assert/strict');
const DshChat = require('../electron/renderer/dsh_chat');

/* assistantTurnNode 返回节点数组，toolRowNode 返回单个节点。 */
const html = (node) => (Array.isArray(node)
  ? node.map((n) => n.outerHTML).join('')
  : (node ? node.outerHTML : ''));
const chat = DshChat;

/* 两个调用：单独一个会被折成「单芯片组」，那一行的行头由 CSS 藏起来，展开态
   是结构性的、不接受用户输入。要验用户选择，就得用真正对用户可见的行。 */
function turn(overrides = {}) {
  return {
    answer: '完成',
    conversationId: 'c1',
    turnIndex: 0,
    trajectory: [
      { kind: 'tool', callId: 'k1', name: 'Read', text: '{"path":"a.md"}', result: 'ok', state: 'completed' },
      { kind: 'tool', callId: 'k2', name: 'Read', text: '{"path":"b.md"}', result: 'ok', state: 'completed' },
    ],
    ...overrides,
  };
}

/* ---- 默认条：与「这一串里只有一个调用」无关 ---- */
chat.expansion.clear();
const lone = html(chat.assistantTurnNode(turn({
  trajectory: [{ kind: 'tool', callId: 'solo', name: 'Read', text: '{"path":"a.md"}', result: 'ok', state: 'completed' }],
})));
// 单调用组里的内层行是结构性打开（组头一行就是这一行，CSS 把内层行头藏了），
// 但外层那个 details 不带 open —— 用户看到的是收起的。
assert(!/<details[^>]*class="dsh-tool-group"[^>]*\sopen/.test(lone),
  'a lone tool call must not come pre-expanded just because it is alone');
assert(!/data-row-id="tool:solo"/.test(lone),
  'the structural row inside a single-call group must not claim a stored id');

/* ---- 默认条：待回答的问题类工具自己开 ---- */
chat.expansion.clear();
const pending = html(chat.toolRowNode(chat.toolRowModel('AskUser', '{"question":"选哪个?"}', undefined, 'q1')));
assert(pending.includes('data-open="true"'),
  'a question still waiting for an answer opens so the user can read it');

const answered = html(chat.toolRowNode(chat.toolRowModel('AskUser', '{"question":"选哪个?"}', { text: 'A', isError: false }, 'q2')));
assert(answered.includes('data-open="false"'),
  'once answered, the question row defaults closed like every other row');

/* ---- 核心：重建之后用户的选择还在 ---- */
chat.expansion.clear();
const first = html(chat.assistantTurnNode(turn()));
assert(first.includes('data-row-id="tool:k1"'), 'tool rows carry a stable row id');

chat.expansion.setRow('tool:k1', true);
const rebuilt = html(chat.assistantTurnNode(turn()));
assert(rebuilt.includes('data-row-id="tool:k1"'));
assert(/data-row-id="tool:k1"[^>]*/.test(rebuilt));
const k1Open = /<div class="dsh-disclosure"[^>]*data-open="true"[^>]*data-row-id="tool:k1"/.test(rebuilt)
  || /<div class="dsh-disclosure"[^>]*data-row-id="tool:k1"[^>]*data-open="true"/.test(rebuilt);
assert(k1Open, 'a row the user opened stays open across a rebuild');

chat.expansion.setRow('tool:k1', false);
const collapsedAgain = html(chat.assistantTurnNode(turn()));
assert(/<div class="dsh-disclosure"[^>]*data-row-id="tool:k1"[^>]*data-open="false"/.test(collapsedAgain)
  || /<div class="dsh-disclosure"[^>]*data-open="false"[^>]*data-row-id="tool:k1"/.test(collapsedAgain),
  'and a row the user closed stays closed');

/* ---- 思考行也按同一个 store 存 ---- */
chat.expansion.clear();
const thinkTurn = turn({
  answer: '',
  trajectory: [{ kind: 'message', turn: 0, reasoning: '先读文件。\n再看结构。', text: '' }],
});
const thinkCollapsed = html(chat.assistantTurnNode(thinkTurn));
assert(/class="dsh-disclosure dsh-think"[^>]*data-open="false"/.test(thinkCollapsed),
  'thinking starts collapsed, matching the CLI collapsed form');
chat.expansion.setRow('think:c1#0:r0', true);
const thinkOpen = html(chat.assistantTurnNode(thinkTurn));
assert(/class="dsh-disclosure dsh-think"[^>]*data-open="true"/.test(thinkOpen),
  'thinking keeps the state the user chose');
assert(/data-row-id="think:c1#0:r0"/.test(thinkOpen),
  'the thinking row id is scoped to conversation and turn so two turns cannot collide');

/* ---- 组展开态同样独立保存 ---- */
chat.expansion.clear();
const twoTools = turn({
  trajectory: [
    { kind: 'tool', callId: 'g1', name: 'Read', text: '{"path":"a.md"}', result: 'ok', state: 'completed' },
    { kind: 'tool', callId: 'g2', name: 'Read', text: '{"path":"b.md"}', result: 'ok', state: 'completed' },
  ],
});
assert(!/<details[^>]*data-group-id|open/.test(html(chat.assistantTurnNode(twoTools)).match(/<details[^>]*>/)[0]),
  'a tool group starts closed');
chat.expansion.setGroup('group:g1', true);
assert(/<details[^>]*class="dsh-tool-group"[^>]*\sopen/.test(html(chat.assistantTurnNode(twoTools))),
  'a tool group the user opened reopens after a rebuild');

/* 流式期间与终态用的是同一套 id（「开着的行在轮末不自己收回去」）由
   tests/dsh_live_turn_test.js 用它的 DOM 桩验证——这里要真造 document 才跑得起来。 */

/* ---- 展开态存储是显式的，测试之间可清空 ---- */
assert.strictEqual(typeof chat.expansion.clear, 'function');
chat.expansion.clear();
assert.strictEqual(chat.expansion.row('tool:k1'), undefined);

console.log('dsh expansion store test ok');
