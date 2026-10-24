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
  assert.match(
    settledShell,
    /done/,
    'a settled shell row shows the structured stdout from the result',
  );
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
  const workflowSettled = chat
    .assistantTurnNode({
      trajectory: [
        {
          kind: 'tool',
          name: 'Workflow.run',
          callId: 'wf1',
          text: '{"title":"Cmd run","steps":[]}',
          state: 'ok',
          result: '{"ok":true,"runId":"run-1"}',
          isError: false,
          presentation: JSON.stringify({
            kind: 'workflow_run',
            runId: 'run-1',
            title: 'Cmd run',
            status: 'succeeded',
            tokens: 1234,
            steps: [
              {id: 'a', title: '盘点目录', status: 'succeeded', attempts: 1, depends_on: [], readonly: true},
              {id: 'c', title: '对照清单', status: 'succeeded', attempts: 1, depends_on: [], readonly: true},
              {id: 'b', title: '起草命令', status: 'succeeded', attempts: 1, depends_on: ['a'], readonly: false},
              {id: 'd', title: '执行复核', status: 'failed', attempts: 2, depends_on: ['b', 'c'], readonly: false},
            ],
          }),
        },
      ],
    })
    .map((node: {outerHTML: string}) => node.outerHTML)
    .join('');
  assert.match(
    workflowSettled,
    /class="wf-card" data-wf-status="succeeded"/,
    'a settled workflow run renders a DAG card',
  );
  assert.match(workflowSettled, /data-run-id="run-1"/);
  assert.match(workflowSettled, /已完成/, 'the badge spells the run status');
  assert.match(workflowSettled, /4 个步骤 · 4\/4 · 1\.2k tokens/);
  assert.equal(
    [...workflowSettled.matchAll(/class="wf-station"/g)].length,
    4,
    'every step becomes a track station',
  );
  const ordered = ['盘点目录', '对照清单', '起草命令', '执行复核'].map(
    title => workflowSettled.indexOf(title),
  );
  assert.ok(
    ordered.every((at, i) => at >= 0 && (i === 0 || at > ordered[i - 1]!)),
    `stations follow topological layers, got positions ${ordered.join(',')}`,
  );
  assert.match(workflowSettled, /class="wf-arc"/, 'skipped dependencies arc over the track');
  const workflowRunning = chat
    .assistantTurnNode({
      trajectory: [
        {
          kind: 'tool',
          name: 'Workflow.run',
          callId: 'wf2',
          text: '{}',
          state: 'running',
          progressText: JSON.stringify({
            runId: 'run-2',
            title: 'Cmd run',
            status: 'running',
            tokens: 40,
            steps: [
              {id: 'a', title: '盘点目录', status: 'succeeded', attempts: 1},
              {id: 'b', title: '执行复核', status: 'running', attempts: 1},
            ],
          }),
        },
      ],
    })
    .map((node: {outerHTML: string}) => node.outerHTML)
    .join('');
  assert.match(
    workflowRunning,
    /data-wf-status="running"/,
    'an in-flight workflow lights its card from the progress snapshot',
  );
  assert.match(workflowRunning, /运行中/);
  assert.match(workflowRunning, /data-status="running"/, 'the running step pulses');
} finally {
  fs.rmSync(dir, {recursive: true, force: true});
}
