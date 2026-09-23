import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventSession, estimateTokens, handleSessionRead } from '../electron/runtime/session';

test('request audit describes the actual projected model messages while retaining journal surface identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-request-projection-'));
  const session = await EventSession.open(root, 'projection');
  await session.startTurn();
  try {
    await session.appendMessage({ role: 'user', content: 'Summarize source A', origin: 'instruction' });
    await session.appendMessage({ role: 'tool', content: 'Long source result', name: 'Context.read', tool_call_id: 'read-1', origin: 'data' });
    const projected = [{ role: 'user' as const, content: 'Summarize source A', origin: 'instruction' as const },
      { role: 'tool' as const, content: 'Source result reference', name: 'Context.read', tool_call_id: 'read-1', origin: 'data' as const }];
    await session.recordRequest(1, 'System instruction', [{ name: 'Context.read' }], projected);
    const request = session.events.at(-1)!;
    assert.equal(request.type, 'model/request');
    assert.equal(request.data.messageCount, 2);
    assert.equal(request.data.projectedMessageCount, 2);
    assert.notEqual(request.data.messagesHash, request.data.projectedMessagesHash);
    const costs = request.data.estimatedTokenBreakdown as Record<string, number>;
    assert.ok(costs.system > 0 && costs.tools > 0 && costs.history > 0 && costs.evidence > 0);
    assert.equal(costs.taskState, 0);
    await session.append('model/response', { turn: session.openTurn, step: 1, usage: { prompt_tokens: 1000, completion_tokens: 3 } });
    const usage = (await handleSessionRead({ action: 'usage', sessionId: session.id }, root)).contextUsage as Record<string, any>;
    assert.equal(usage.toolResultTokensEstimate, estimateTokens(JSON.stringify(projected[1])));
    assert.deepEqual(usage.estimatedTokenBreakdown, costs);
  } finally { await session.endTurn('completed'); }
});
