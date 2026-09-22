'use strict';

const assert = require('node:assert/strict');
const ChatView = require('../electron/renderer/chat_view');

const html = (node) => (Array.isArray(node)
  ? node.map((n) => n.outerHTML).join('')
  : (node ? node.outerHTML : ''));
const chat = ChatView;

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

chat.expansion.clear();
const lone = html(chat.assistantTurnNode(turn({
  trajectory: [{ kind: 'tool', callId: 'solo', name: 'Read', text: '{"path":"a.md"}', result: 'ok', state: 'completed' }],
})));
assert(!/<details[^>]*class="mp-chat-tool-group"[^>]*\sopen/.test(lone),
  'a lone tool call must not come pre-expanded just because it is alone');
assert(!/data-row-id="tool:c1#0:solo"/.test(lone),
  'the structural row inside a single-call group must not claim a stored id');

chat.expansion.clear();
const pending = html(chat.toolRowNode(chat.toolRowModel('AskUser', '{"question":"选哪个?"}', undefined, 'q1')));
assert(pending.includes('data-open="true"'),
  'a question still waiting for an answer opens so the user can read it');

const answered = html(chat.toolRowNode(chat.toolRowModel('AskUser', '{"question":"选哪个?"}', { text: 'A', isError: false }, 'q2')));
assert(answered.includes('data-open="false"'),
  'once answered, the question row defaults closed like every other row');

chat.expansion.clear();
const first = html(chat.assistantTurnNode(turn()));
assert(first.includes('data-row-id="tool:c1#0:k1"'), 'tool rows carry a stable row id');

chat.expansion.setRow('tool:c1#0:k1', true);
const rebuilt = html(chat.assistantTurnNode(turn()));
assert(rebuilt.includes('data-row-id="tool:c1#0:k1"'));
const k1Open = /<div class="mp-chat-disclosure"[^>]*data-open="true"[^>]*data-row-id="tool:c1#0:k1"/.test(rebuilt)
  || /<div class="mp-chat-disclosure"[^>]*data-row-id="tool:c1#0:k1"[^>]*data-open="true"/.test(rebuilt);
assert(k1Open, 'a row the user opened stays open across a rebuild');

chat.expansion.setRow('tool:c1#0:k1', false);
const collapsedAgain = html(chat.assistantTurnNode(turn()));
assert(/<div class="mp-chat-disclosure"[^>]*data-row-id="tool:c1#0:k1"[^>]*data-open="false"/.test(collapsedAgain)
  || /<div class="mp-chat-disclosure"[^>]*data-open="false"[^>]*data-row-id="tool:c1#0:k1"/.test(collapsedAgain),
  'and a row the user closed stays closed');

chat.expansion.clear();
const thinkTurn = turn({
  answer: '',
  trajectory: [{ kind: 'message', turn: 0, reasoning: '先读文件。\n再看结构。', text: '' }],
});
const thinkCollapsed = html(chat.assistantTurnNode(thinkTurn));
assert(/class="mp-chat-disclosure mp-chat-think"[^>]*data-open="false"/.test(thinkCollapsed),
  'thinking starts collapsed, matching the CLI collapsed form');
chat.expansion.setRow('think:c1#0:r0', true);
const thinkOpen = html(chat.assistantTurnNode(thinkTurn));
assert(/class="mp-chat-disclosure mp-chat-think"[^>]*data-open="true"/.test(thinkOpen),
  'thinking keeps the state the user chose');
assert(/data-row-id="think:c1#0:r0"/.test(thinkOpen),
  'the thinking row id is scoped to conversation and turn so two turns cannot collide');

chat.expansion.clear();
const twoTools = turn({
  trajectory: [
    { kind: 'tool', callId: 'g1', name: 'Read', text: '{"path":"a.md"}', result: 'ok', state: 'completed' },
    { kind: 'tool', callId: 'g2', name: 'Read', text: '{"path":"b.md"}', result: 'ok', state: 'completed' },
  ],
});
assert(!/<details[^>]*data-group-id|open/.test(html(chat.assistantTurnNode(twoTools)).match(/<details[^>]*>/)[0]),
  'a tool group starts closed');
chat.expansion.setGroup('group:c1#0:g1', true);
assert(/<details[^>]*class="mp-chat-tool-group"[^>]*\sopen/.test(html(chat.assistantTurnNode(twoTools))),
  'a tool group the user opened reopens after a rebuild');


assert.strictEqual(typeof chat.expansion.clear, 'function');
chat.expansion.clear();
assert.strictEqual(chat.expansion.row('tool:c1#0:k1'), undefined);

console.log('chat expansion store test ok');
