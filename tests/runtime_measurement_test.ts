import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { phases, reducePhases, percentile, verifyBenchmarkOutcome, aggregateCacheUsage,
  type Measurement } from '../scripts/measure-runtime';

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

test('a benchmark checks the delivered file instead of accepting a successful-sounding answer', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'mp-measure-verdict-'));
  const file = join(workspace, 'result.txt');
  const response = { ...outcome, answer: 'Done', hasPendingWork: false };
  await writeFile(file, 'wrong result');
  const expected = { files: [{ path: 'result.txt', exactText: 'verified result' }] };
  assert.equal((await verifyBenchmarkOutcome(response, expected, workspace)).passed, false);
  await writeFile(file, 'verified result');
  assert.equal((await verifyBenchmarkOutcome(response, expected, workspace)).passed, true);
  assert.equal((await verifyBenchmarkOutcome(response, {}, workspace)).passed, false,
    'an empty rubric cannot certify a task');
});

test('cache hit rate reports the measured denominator and excludes requests without cache telemetry', () => {
  const measured = aggregateCacheUsage([
    { prompt_tokens: 100, prompt_cache_hit_tokens: 70 },
    { input_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 },
    { prompt_tokens: 50 },
  ]);
  assert.equal(measured.requests, 3);
  assert.equal(measured.reportedRequests, 2);
  assert.equal(measured.inputTokens, 200);
  assert.equal(measured.cacheReadTokens, 150);
  assert.equal(measured.hitRate, 0.75);
  assert.deepEqual(measured.samples.map(sample => sample.hitRate), [0.7, 0.8, null]);
  assert.equal(aggregateCacheUsage([{ prompt_tokens: 50 }]).hitRate, null);
});
