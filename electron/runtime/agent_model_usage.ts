import type {ModelConfig} from './model';
import {estimateCostUsd} from './agent_services';
type Data = Record<string, unknown>;
const asObject = (value: unknown): Data =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Data)
    : {};

function usageCount(data: Data, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.trunc(value));
    }
  }
  return undefined;
}

export function mergeModelUsage(
  total: Record<string, number>,
  raw: unknown,
  includeContext = true,
): boolean {
  const data = asObject(raw);
  const prompt = usageCount(data, 'prompt_tokens', 'promptTokens');
  const uncached = usageCount(data, 'input_tokens', 'inputTokens');
  const cacheRead =
    usageCount(
      data,
      'cache_read_input_tokens',
      'prompt_cache_hit_tokens',
      'cacheReadTokens',
    ) ??
    usageCount(asObject(data.prompt_tokens_details), 'cached_tokens') ??
    usageCount(asObject(data.input_tokens_details), 'cached_tokens');
  const cacheWrite =
    usageCount(data, 'cache_creation_input_tokens', 'cacheWriteTokens') ??
    usageCount(asObject(data.prompt_tokens_details), 'cache_write_tokens');
  const input =
    prompt ??
    (uncached === undefined
      ? undefined
      : uncached +
        (usageCount(data, 'cache_read_input_tokens') ?? 0) +
        (usageCount(data, 'cache_creation_input_tokens') ?? 0));
  const output = usageCount(
    data,
    'output_tokens',
    'completion_tokens',
    'outputTokens',
  );
  const reportedTotal = usageCount(data, 'total_tokens', 'totalTokens');
  const requestTotal =
    reportedTotal ??
    (input === undefined && output === undefined
      ? undefined
      : (input ?? 0) + (output ?? 0));
  for (const [key, value] of [
    ['inputTokens', input],
    ['outputTokens', output],
    ['totalTokens', requestTotal],
    ['cacheReadTokens', cacheRead],
    ['cacheWriteTokens', cacheWrite],
  ] as const) {
    if (value !== undefined) {
      total[key] = (total[key] ?? 0) + value;
    }
  }
  if (includeContext) {
    for (const [key, value] of [
      ['contextTokens', input],
      ['lastOutputTokens', output],
      ['lastCacheReadTokens', cacheRead],
      ['lastCacheWriteTokens', cacheWrite],
    ] as const) {
      delete total[key];
      if (value !== undefined) {
        total[key] = value;
      }
    }
    if (input !== undefined) {
      total.contextEstimated = 0;
    }
  }
  if (
    input === undefined &&
    output === undefined &&
    requestTotal === undefined
  ) {
    return false;
  }
  total.turnsReported = (total.turnsReported ?? 0) + 1;
  return true;
}

export function recordModelCost(
  total: Record<string, number>,
  requestUsage: Record<string, number>,
  config: ModelConfig | undefined,
  backend: string | undefined,
  at: number,
): void {
  if (!backend?.startsWith('magic_pointer.') || !config?.baseUrl) {
    return;
  }
  let host = '';
  try {
    host = new URL(config.baseUrl).hostname;
  } catch {}
  const cost = estimateCostUsd(requestUsage, config.model, host, at);
  if (cost !== null) {
    total.estimatedCostUsd = (total.estimatedCostUsd ?? 0) + cost;
    total.pricedRequests = (total.pricedRequests ?? 0) + 1;
  }
}
