'use strict';

const assert = require('assert');
const { scheduleBackgroundLearning } = require('../electron/background_learning');

{
  const calls: any[] = [];
  const logs: string[] = [];
  const scheduled = scheduleBackgroundLearning({
    enabled: true,
    request: { requested: true, sessionId: 'agent-s1', terminalReason: 'completed' },
    runBridge: (...args: any[]) => {
      calls.push(args);
      return { pid: 42 };
    },
    log: (message: string) => logs.push(message),
  });
  assert.strictEqual(scheduled, true);
  assert.strictEqual(calls[0][1], 'scripts/learning_review_bridge.py');
  assert.strictEqual(calls[0][2], null);
  assert.strictEqual(calls[0][3].allowWithoutSurface, true);
  calls[0][3].onComplete({ ok: true, candidateIds: ['c1'] });
  assert.ok(logs[0].includes('candidates=1'));
}

{
  let called = false;
  const scheduled = scheduleBackgroundLearning({
    enabled: true,
    request: { requested: false, sessionId: 'agent-s1', terminalReason: 'completed' },
    runBridge: () => { called = true; },
  });
  assert.strictEqual(scheduled, false);
  assert.strictEqual(called, false);
}

{
  let called = false;
  const scheduled = scheduleBackgroundLearning({
    enabled: false,
    request: { requested: true, sessionId: 'agent-s1', terminalReason: 'completed' },
    runBridge: () => { called = true; },
  });
  assert.strictEqual(scheduled, false);
  assert.strictEqual(called, false);
}

console.log('background_learning_wiring_test: all assertions passed');
