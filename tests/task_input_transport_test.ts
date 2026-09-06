'use strict';

const assert = require('node:assert/strict');
const { createTaskInputTransport } = require('../electron/task_input_transport');

async function run() {
  let resolveBridge: (value: unknown) => void = () => {};
  const sent: any[] = [];
  const states: any[] = [];
  const accepted: string[] = [];
  const transport = createTaskInputTransport({
    send: (taskInput: unknown) => {
      sent.push(taskInput);
      return new Promise((resolve) => { resolveBridge = resolve; });
    },
    onState: (state: unknown) => states.push(state),
  });
  const taskInput = {
    inputId: 'input-stage-1',
    taskId: 'untrusted-renderer-task',
    target: 'next-step',
    instruction: '',
    referenceUpdates: [{
      operation: 'remove',
      binding: {
        referenceId: 'ref-a', label: 'A', sourceId: 'source-a',
        locator: { kind: 'visual-region', value: { snapshotId: 'snap-a' } },
        role: 'target', frameLeaseId: 'lease-a', capturedAtMs: 10,
        ordinal: 1, active: false,
      },
    }],
    sourceIds: ['source-a'],
    timeline: [{
      eventId: 'point-remove-a', kind: 'point', startMs: 10, endMs: 10,
      referenceId: 'ref-a',
    }],
    capturedAtMs: 10,
  };

  const pending = transport.submit(taskInput, {
    onAccepted: () => accepted.push('cleared'),
  });
  assert.deepStrictEqual(sent, [taskInput], 'the real bridge receives the full TaskInput');
  assert.deepStrictEqual(states, [{ inputId: 'input-stage-1', status: 'queueing' }]);
  assert.deepStrictEqual(accepted, [], 'local input is retained until the durable ACK');

  resolveBridge({ ok: true, inputId: 'input-stage-1', status: 'queued', referenceRevision: 7 });
  const result = await pending;
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(accepted, ['cleared']);
  assert.deepStrictEqual(states.at(-1), {
    inputId: 'input-stage-1', status: 'accepted', referenceRevision: 7,
  });

  let failedAccepted = false;
  const failed = createTaskInputTransport({
    send: async () => ({ ok: false, error: 'session_not_found' }),
    onState: (state: unknown) => states.push(state),
  });
  const rejected = await failed.submit(
    { ...taskInput, inputId: 'input-stage-2' },
    { onAccepted: () => { failedAccepted = true; } },
  );
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(failedAccepted, false, 'a rejected update stays editable in the UI');
  assert.deepStrictEqual(states.at(-1), {
    inputId: 'input-stage-2', status: 'failed', error: 'session_not_found',
  });
}

run().then(
  () => console.log('task input transport test ok'),
  (error) => { console.error(error); process.exitCode = 1; },
);
