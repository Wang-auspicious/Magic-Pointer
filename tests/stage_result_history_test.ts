import assert from 'node:assert/strict';
const { stageEventFromBridge } = require('../electron/stage_contract');

const metadata = {
  agentSessionId: 'agent-selection-1', runtimeTurn: 7, usedBackend: 'configured-model', timingMs: 913,
  thinking: 'Inspect the selected sidebar.',
  trajectory: [{ kind: 'tool', name: 'Look', result: 'Environment' }],
  activities: [{ kind: 'tool', name: 'Look', state: 'done' }],
  receipts: [{ status: 'succeeded' }],
  events: [{ type: 'tool_result', name: 'Look' }],
  modelUsage: { inputTokens: 300, outputTokens: 40, totalTokens: 340, contextTokens: 300,
    cacheReadTokens: 100, cacheWriteTokens: 25, lastCacheReadTokens: 100, lastOutputTokens: 40,
    reasoningTokens: 10, estimatedCostUsd: 0.00013, pricedRequests: 1 },
};
for (const terminal of [
  { ok: true, answer: 'This is the Environment sidebar.' },
  { ok: true, answer: 'Updated the selected field.', executionResult: { status: 'succeeded', output: { verified: true } } },
  { ok: false, answer: 'The tool failed after inspecting the sidebar.', error: 'Vision unavailable' },
]) {
  const event = stageEventFromBridge({ ...metadata, ...terminal });
  for (const [key, value] of Object.entries(metadata)) {
    assert.deepEqual(event.result?.[key], value, `${event.type} must retain ${key} in the shared turn`);
  }
  assert.equal(event.result.answer, terminal.answer, `${event.type} must retain the real response`);
}
const permission = stageEventFromBridge({ ok: true, answer: '需要允许操作', awaitingUserInput: true,
  pendingInput: { kind: 'permission', question: '允许执行?', tool: 'Bash', prefix: 'npm test' } });
assert.equal(permission.result.pendingInput?.tool, 'Bash');
assert.equal(permission.result.awaitingUserInput, true);
console.log('stage result history test ok');
