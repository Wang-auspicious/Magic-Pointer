import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../electron/runtime/agent';
import { EventSession } from '../electron/runtime/session';
import { ToolRegistry } from '../electron/runtime/tools';

test('a real Agent loop reports cumulative provider tokens, latest context, and DeepSeek cost', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'mp-model-usage-'));
  const session = await EventSession.open(userDataDir, 'model-usage');
  const registry = new ToolRegistry();
  registry.register({ name: 'ReadFact', description: 'Read one fact', effect: 'read',
    input_schema: { type: 'object', properties: {}, required: [] }, execute: () => 'fact' });
  const emitted: Record<string, number>[] = [];
  let call = 0;
  const result = await runAgent({ root: userDataDir, userDataDir, session, registry,
    instruction: 'Read the fact and answer', system: 'Test',
    config: { model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1' },
    onEvent: event => { if (event.kind === 'model_usage') emitted.push(event.usage as Record<string, number>); },
    model: async () => ++call === 1
      ? { text: '', tool_calls: [{ id: 'fact', name: 'ReadFact', arguments: {} }], usedBackend: 'magic_pointer.chat-completions_streaming',
          usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_cache_hit_tokens: 400 } }
      : { text: 'Done', tool_calls: [], usedBackend: 'magic_pointer.chat-completions_streaming',
          usage: { prompt_tokens: 2000, completion_tokens: 300, total_tokens: 2300, prompt_cache_hit_tokens: 500 } } });
  assert.equal(result.reason, 'completed');
  assert.equal(result.model_usage.inputTokens, 3000);
  assert.equal(result.model_usage.outputTokens, 500);
  assert.equal(result.model_usage.totalTokens, 3500);
  assert.equal(result.model_usage.cacheReadTokens, 900);
  assert.equal(result.model_usage.contextTokens, 2000);
  assert.equal(result.model_usage.lastOutputTokens, 300);
  assert.equal(result.model_usage.lastCacheReadTokens, 500);
  assert.equal(result.model_usage.turnsReported, 2);
  assert.equal(result.model_usage.pricedRequests, 2);
  assert.ok(result.model_usage.estimatedCostUsd > 0);
  assert.deepEqual(emitted.at(-1), result.model_usage);
});

test('Anthropic input tokens include separately reported cache reads and writes', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'mp-model-usage-'));
  const session = await EventSession.open(userDataDir, 'cache-usage');
  const result = await runAgent({ root: userDataDir, userDataDir, session, registry: new ToolRegistry(),
    instruction: 'Answer', system: 'Test', model: async () => ({ text: 'Done', tool_calls: [],
      usage: { input_tokens: 100, cache_read_input_tokens: 60, cache_creation_input_tokens: 40, output_tokens: 20 } }) });
  assert.equal(result.model_usage.inputTokens, 200);
  assert.equal(result.model_usage.cacheReadTokens, 60);
  assert.equal(result.model_usage.cacheWriteTokens, 40);
  assert.equal(result.model_usage.contextTokens, 200);
  assert.equal(result.model_usage.totalTokens, 220);
  assert.equal(result.model_usage.pricedRequests, undefined);
});
