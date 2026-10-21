import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeActivitySink} from '../electron/runtime/agent_activity';
import {createConversationStore} from '../electron/conversation_store';
const control = require('../electron/conversation_control');
const start = {
  kind: 'context_compacting',
  compactionId: 'compact-one',
  status: 'request',
  pass: 0,
  chunk: 1,
  chunks: 3,
};
const notices = (rows: readonly Record<string, unknown>[]) =>
  rows.filter(row => row.noticeType === 'compaction');

test('compaction is present in both live and durable trajectories without creating a model answer', () => {
  const transcript = control.createTranscript();
  const sink = new RuntimeActivitySink((phase, fields) =>
    control.appendTranscript(transcript, {phase, fields}),
  );
  sink.onEvent(start);
  assert.equal(notices(sink.trajectory).length, 1);
  assert.equal(notices(transcript.trajectory).length, 1);
  assert.equal(notices(transcript.trajectory)[0].compactionId, 'compact-one');
  assert.equal(transcript.answer, '');
  assert.ok(!sink.trajectory.some(row => row.kind === 'message'));
});

test('stream and chunk updates mutate one compaction row and keep its original start time', () => {
  const sink = new RuntimeActivitySink(() => {});
  sink.onEvent(start);
  const first = notices(sink.trajectory)[0];
  const time = first?.startedAt;
  for (let i = 0; i < 20; i++) {
    sink.onEvent({...start, status: 'streaming', chunk: 2});
  }
  sink.onEvent({...start, pass: 1, chunk: 1, chunks: 2});
  assert.equal(notices(sink.trajectory).length, 1);
  assert.equal(notices(sink.trajectory)[0], first);
  assert.equal(first.startedAt, time);
  assert.equal(first.pass, 1);
  assert.equal(first.chunks, 2);
});

test('successful and repeated compactions retain independent outcomes and measured reduction', () => {
  const sink = new RuntimeActivitySink(() => {});
  sink.onEvent(start);
  sink.onEvent({
    ...start,
    status: 'done',
    beforeTokens: 12000,
    afterTokens: 1700,
  });
  const first = notices(sink.trajectory)[0];
  assert.equal(first?.state, 'done');
  assert.equal(first.afterTokens, 1700);
  assert.ok(Number(first.completedAt) >= Number(first.startedAt));
  sink.onEvent({...start, compactionId: 'compact-two'});
  assert.equal(notices(sink.trajectory).length, 2);
  assert.equal(first.state, 'done');
});

test('failure, cancellation, and unchanged history have distinct truthful states', () => {
  for (const [status, state] of [
    ['failed', 'error'],
    ['cancelled', 'cancelled'],
    ['history_changed', 'skipped'],
    ['not_reduced', 'skipped'],
  ]) {
    const sink = new RuntimeActivitySink(() => {});
    sink.onEvent(start);
    sink.onEvent({...start, status, error: 'Connection closed'});
    const row = notices(sink.trajectory)[0];
    assert.equal(row?.state, state, status);
    if (status === 'failed') {
      assert.equal(row.error, 'Connection closed');
    }
  }
});

test('a stopped worker settles an outstanding compaction instead of leaving it running forever', () => {
  const transcript = control.createTranscript();
  const sink = new RuntimeActivitySink((phase, fields) =>
    control.appendTranscript(transcript, {phase, fields}),
  );
  sink.onEvent(start);
  sink.onEvent({kind: 'loop_stopped', terminal: {reason: 'user_interrupt'}});
  assert.equal(notices(sink.trajectory)[0]?.state, 'cancelled');
  assert.equal(notices(transcript.trajectory)[0]?.state, 'cancelled');
});

test('pending answer text reaches the live stream before the compaction notice', () => {
  const transcript = control.createTranscript();
  const sink = new RuntimeActivitySink((phase, fields) =>
    control.appendTranscript(transcript, {phase, fields}),
  );
  sink.onEvent({kind: 'turn_started', turn: 1});
  sink.onEvent({kind: 'model_chunk', text: 'Read the source first.'});
  sink.onEvent(start);
  assert.equal(transcript.answer, 'Read the source first.');
  assert.equal(transcript.trajectory.at(-1)?.noticeType, 'compaction');
  assert.equal(transcript.trajectory[0].text, 'Read the source first.');
});

test('failed conversation settlement and restart recovery close persisted compaction notices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-compact-notice-'));
  const store = createConversationStore({baseDir: root});
  const row = {
    kind: 'notice',
    noticeType: 'compaction',
    compactionId: 'compact-one',
    status: 'request',
    state: 'running',
    startedAt: 20,
    timeOriginMs: Date.now(),
  };
  const nextRow = {...row};
  const conversation = store.appendTurn({
    newConversation: true,
    question: 'Continue',
    outcome: '进行中',
    trajectory: [row],
  });
  store.updateTurn({
    conversationId: conversation.id,
    turnIndex: 0,
    outcome: '失败',
    failed: true,
  });
  assert.equal(
    (
      store.get(conversation.id)!.turns[0].trajectory[0] as Record<
        string,
        unknown
      >
    ).state,
    'error',
  );
  const other = store.appendTurn({
    newConversation: true,
    question: 'Continue after restart',
    outcome: '进行中',
    trajectory: [nextRow],
  });
  store.flush();
  const reopened = createConversationStore({baseDir: root});
  reopened.recoverInterruptedTurns();
  assert.equal(
    (reopened.get(other.id)!.turns[0].trajectory[0] as Record<string, unknown>)
      .state,
    'cancelled',
  );
});

test('completed imported turns do not retain a running compaction marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-imported-compact-'));
  const store = createConversationStore({baseDir: root});
  const conversation = store.appendTurn({
    newConversation: true,
    question: 'Imported task',
    outcome: '已完成',
    trajectory: [
      {
        kind: 'notice',
        noticeType: 'compaction',
        compactionId: 'imported',
        state: 'running',
        status: 'request',
        startedAt: 10,
        timeOriginMs: Date.now(),
      },
    ],
  });
  assert.equal(
    (
      store.get(conversation.id)!.turns[0].trajectory[0] as Record<
        string,
        unknown
      >
    ).state,
    'cancelled',
    'completion alone is not evidence that compaction succeeded',
  );
});

test('starting compaction closes the prior model interval before summarizer time begins', () => {
  const transcript = control.createTranscript();
  const sink = new RuntimeActivitySink((phase, fields) =>
    control.appendTranscript(transcript, {phase, fields}),
  );
  sink.onEvent({kind: 'turn_started', turn: 1});
  sink.onEvent(start);
  const message = sink.trajectory.find(row => row.kind === 'message')!;
  assert.equal(message.state, 'done');
  assert.equal(
    transcript.trajectory.find(
      (row: Record<string, unknown>) => row.kind === 'message',
    ).state,
    'done',
  );
  assert.equal(sink.activities[0].state, 'done');
});
