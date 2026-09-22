import assert from 'node:assert/strict';
import { phases, reducePhases, percentile, type Measurement } from '../scripts/measure-runtime';

const tool = Buffer.from(JSON.stringify({ name: 'Read', latency_ms: 4.7, result: '内容' })).toString('base64');
const outcome: Measurement = { ok: true, error: '', wallMs: 1250, totalMs: null, bootMs: null, turns: 0, ttftMs: [], toolMs: [], toolNames: [], usedBackend: 'fixture' };
reducePhases(phases(`ordinary diagnostic\n@@mp phase=runtime_ready ms=40\n@@mp phase=model_request ms=50\n@@mp phase=reasoning_chunk ms=900 b64=YQ==\n@@mp phase=tool_call ms=1000\n@@mp phase=tool_result ms=1010 b64=${tool}\n@@mp phase=model_request ms=1011\n@@mp phase=answer_chunk ms=1200 b64=YQ==\n@@mp phase=total ms=1240\n`), outcome);
assert.equal(outcome.bootMs, 40);
assert.equal(outcome.totalMs, 1240);
assert.equal(outcome.turns, 2);
assert.deepEqual(outcome.ttftMs, [850, 189]);
assert.deepEqual(outcome.toolMs, [4.7]);
assert.deepEqual(outcome.toolNames, ['Read']);
assert.equal(percentile([40, 10, 20], .5), 20);
console.log('runtime measurement protocol passed');
