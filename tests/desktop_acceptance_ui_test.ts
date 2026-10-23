import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {createConversationStore} = require('../electron/conversation_store');
const control = require('../electron/conversation_control');
const chat = require('../electron/renderer/chat_view');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-desktop-regression-'));
try {
  const store = createConversationStore({baseDir: dir});
  const before = store.appendTurn({
    question: 'CU-A1 订单复核',
    newConversation: true,
  });
  const originalTitle = before.title;
  const after = store.appendTurn({
    conversationId: before.id,
    question: 'Deny Bash. Use another approach.',
    permissionDeny: 'Bash',
  });
  assert.equal(
    after.title,
    originalTitle,
    'permission control turns must retain the task title',
  );
  const turns = [
    {
      question: '原问题',
      answer: '原回答',
      evidence: {contentDigest: '冻结事实'},
      thinking: 'x'.repeat(100000),
      trajectory: [{text: 'y'.repeat(100000)}],
    },
  ];
  assert.deepEqual(control.bridgeHistoryTurns(turns), [
    {
      question: '原问题',
      answer: '原回答',
      evidence: {contentDigest: '冻结事实'},
    },
  ]);
  const runningShell = chat
    .assistantTurnNode({
      trajectory: [
        {
          kind: 'tool',
          name: 'Bash',
          callId: 'b2',
          text: '{"command":"ping -n 4 127.0.0.1"}',
          state: 'running',
          progressText: 'reply-1\nreply-2',
        },
      ],
    })
    .map((node: {outerHTML: string}) => node.outerHTML)
    .join('');
  assert.match(runningShell, /reply-2/, 'a running shell row shows its streamed tail');
  const settledShell = chat
    .assistantTurnNode({
      trajectory: [
        {
          kind: 'tool',
          name: 'Bash',
          callId: 'b3',
          text: '{"command":"ping -n 4 127.0.0.1"}',
          state: 'ok',
          result: '{"exit":0,"cwd":"C:/tmp","stdout":"done","stderr":""}',
          isError: false,
          progressText: 'reply-1\nreply-2',
        },
      ],
    })
    .map((node: {outerHTML: string}) => node.outerHTML)
    .join('');
  assert.doesNotMatch(
    settledShell,
    /reply-2/,
    'a settled shell row shows the structured result, not the streamed tail',
  );
  assert.match(settledShell, /exit/, 'a settled shell row shows the structured result');
  assert.equal(
    chat.toolRowModel('Todo', '{}', {text: '{}', isError: false}).title,
    'Updated plan',
  );
  assert.equal(
    chat.toolRowModel('AskUser', '{}', {text: '{}', isError: false}).title,
    'Asked a question',
  );
  assert.equal(
    chat.toolRowModel('Observe', '{}', {text: '{}', isError: false}).title,
    'Observed',
  );
  assert.equal(
    chat.toolRowModel('Bash', '{}', {
      text: 'permission_denied: Bash not allowed',
      isError: true,
    }).title,
    'Blocked',
  );
  const group = chat
    .assistantTurnNode({
      trajectory: [
        {
          kind: 'tool',
          name: 'Todo',
          callId: 'p1',
          text: '{}',
          result: '{}',
          isError: false,
        },
        {
          kind: 'tool',
          name: 'AskUser',
          callId: 'p2',
          text: '{}',
          result: '{}',
          isError: false,
        },
        {
          kind: 'tool',
          name: 'Bash',
          callId: 'b1',
          text: '{}',
          result: 'permission_denied',
          isError: true,
        },
      ],
    })
    .map((node: {outerHTML: string}) => node.outerHTML)
    .join('');
  assert.match(group, /a command \(1 blocked\)/);
  assert.doesNotMatch(group, /Blocked 1 tool/);
  assert.doesNotMatch(group, /Read \d+ files|Ran \d+ commands/);
} finally {
  fs.rmSync(dir, {recursive: true, force: true});
}
