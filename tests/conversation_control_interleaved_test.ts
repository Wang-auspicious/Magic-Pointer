import test from 'node:test';
import assert from 'node:assert/strict';

const ConversationControl = require('../electron/conversation_control');

function encodeText(value: string): {b64: string} {
  return {b64: Buffer.from(value, 'utf8').toString('base64')};
}

function encodeJson(value: unknown): {b64: string} {
  return encodeText(JSON.stringify(value));
}

test('appendTranscript preserves chronological interleaved order across same-turn post-tool narration and multi-turn finish', () => {
  const transcript = ConversationControl.createTranscript();
  const append = (phase: string, fields: Record<string, unknown>) =>
    ConversationControl.appendTranscript(transcript, {phase, fields});

  append('model_request', {turn: 1, atMs: 10});
  append('reasoning_chunk', {...encodeText('Think 1'), atMs: 20});
  append('answer_chunk', {...encodeText('Step 1 narration'), atMs: 30});
  append('tool_call', {id: 't1', name: 'Read', atMs: 40});
  append('tool_result', {id: 't1', name: 'Read', state: 'done', result: 'ok', atMs: 50});

  append('answer_chunk', {
    ...encodeText('Post-tool narration in same turn'),
    atMs: 60,
  });

  assert.equal(transcript.answer, 'Post-tool narration in same turn');
  assert.equal(
    transcript.trajectory.length,
    3,
    'post-tool narration in the same turn must append a new message record instead of mutating pre-tool message',
  );
  assert.equal(transcript.trajectory[0].kind, 'message');
  assert.equal(transcript.trajectory[0].text, 'Step 1 narration');
  assert.equal(transcript.trajectory[0].reasoning, 'Think 1');
  assert.equal(transcript.trajectory[0].state, 'done');
  assert.equal(transcript.trajectory[1].kind, 'tool');
  assert.equal(transcript.trajectory[1].callId, 't1');
  assert.equal(transcript.trajectory[2].kind, 'message');
  assert.equal(transcript.trajectory[2].turn, 1);
  assert.equal(transcript.trajectory[2].text, 'Post-tool narration in same turn');
  assert.equal(transcript.trajectory[2].state, 'running');

  append('tool_call', {id: 't2', name: 'Bash', atMs: 70});
  append('tool_result', {id: 't2', name: 'Bash', state: 'done', result: 'ok', atMs: 80});
  append('model_request', {turn: 2, atMs: 90});
  append('answer_chunk', {...encodeText('Final answer'), atMs: 100});

  assert.equal(transcript.answer, 'Final answer');
  assert.deepEqual(
    transcript.trajectory.map((item: Record<string, unknown>) => ({
      kind: item.kind,
      turn: item.turn,
      callId: item.callId,
      text: item.text,
      reasoning: item.reasoning,
      state: item.state,
    })),
    [
      {
        kind: 'message',
        turn: 1,
        callId: undefined,
        text: 'Step 1 narration',
        reasoning: 'Think 1',
        state: 'done',
      },
      {
        kind: 'tool',
        turn: 1,
        callId: 't1',
        text: '',
        reasoning: undefined,
        state: 'done',
      },
      {
        kind: 'message',
        turn: 1,
        callId: undefined,
        text: 'Post-tool narration in same turn',
        reasoning: '',
        state: 'done',
      },
      {
        kind: 'tool',
        turn: 1,
        callId: 't2',
        text: '',
        reasoning: undefined,
        state: 'done',
      },
      {
        kind: 'message',
        turn: 2,
        callId: undefined,
        text: 'Final answer',
        reasoning: '',
        state: 'running',
      },
    ],
  );
});

test('post-tool reasoning_chunk splits chronologically and model_usage attaches to the latest message', () => {
  const transcript = ConversationControl.createTranscript();
  const append = (phase: string, fields: Record<string, unknown>) =>
    ConversationControl.appendTranscript(transcript, {phase, fields});

  append('model_request', {turn: 1, atMs: 5});
  append('answer_chunk', {...encodeText('Initial'), atMs: 10});
  append('tool_call', {id: 't1', name: 'Read', atMs: 15});
  append('tool_result', {id: 't1', name: 'Read', state: 'done', result: 'ok', atMs: 20});
  append('reasoning_chunk', {...encodeText('Post-tool thought'), atMs: 25});
  append('answer_chunk', {...encodeText('Follow-up text'), atMs: 30});
  append('model_usage', {...encodeJson({totalTokens: 77}), atMs: 35});

  assert.equal(transcript.trajectory.length, 3);
  assert.equal(transcript.trajectory[0].text, 'Initial');
  assert.equal(transcript.trajectory[0].state, 'done');
  assert.equal(transcript.trajectory[0].modelUsage, undefined);
  assert.equal(transcript.trajectory[2].kind, 'message');
  assert.equal(transcript.trajectory[2].reasoning, 'Post-tool thought');
  assert.equal(transcript.trajectory[2].text, 'Follow-up text');
  assert.deepEqual(transcript.trajectory[2].modelUsage, {totalTokens: 77});
  assert.equal(transcript.trajectory[2].completedAt, 35);
  assert.equal(transcript.answer, 'Follow-up text');
  assert.equal(transcript.thinking, 'Post-tool thought');
});

test('non-message records like notice, compaction, or permission-review after a message also start a fresh message record', () => {
  const transcript = ConversationControl.createTranscript();
  const append = (phase: string, fields: Record<string, unknown>) =>
    ConversationControl.appendTranscript(transcript, {phase, fields});

  append('model_request', {turn: 1, atMs: 1});
  append('answer_chunk', {...encodeText('Before steer'), atMs: 2});
  append('steer_absorbed', {...encodeJson({turn: 1, texts: ['focus here']}), atMs: 3});
  append('answer_chunk', {...encodeText('After steer'), atMs: 4});

  assert.deepEqual(
    transcript.trajectory.map((item: Record<string, unknown>) => item.kind),
    ['message', 'notice', 'message'],
  );
  assert.equal(transcript.trajectory[0].text, 'Before steer');
  assert.equal(transcript.trajectory[0].state, 'done');
  assert.equal(transcript.trajectory[2].text, 'After steer');
});
