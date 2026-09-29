type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
};

type ExaSearchReport = {
  query: string;
  resultLimit: number;
  pagination: 'unavailable';
  results: SearchResult[];
  requestId: string | null;
  costUsd: number | null;
  usedBackend: 'exa_search';
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sourceKey(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString();
  } catch {
    return raw;
  }
}

export async function searchExa(
  query: string,
  requestedLimit: number,
  apiKey: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ExaSearchReport> {
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    throw new Error('Search query is empty');
  }
  if (!apiKey.trim()) {
    throw new Error('Exa API key is not configured');
  }
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(5, Math.floor(requestedLimit)))
    : 5;
  const response = await fetchImpl('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: cleanQuery,
      type: 'auto',
      numResults: limit,
      contents: {highlights: true},
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Exa Search returned HTTP ${response.status}`);
  }
  const body = record(await response.json());
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const value of Array.isArray(body.results) ? body.results : []) {
    const item = record(value);
    const url = String(item.url || '');
    if (!/^https?:\/\//.test(url) || seen.has(sourceKey(url))) {
      continue;
    }
    seen.add(sourceKey(url));
    const highlights = Array.isArray(item.highlights)
      ? item.highlights.filter(part => typeof part === 'string')
      : [];
    const result: SearchResult = {
      title: String(item.title || '').slice(0, 300),
      url,
      snippet: highlights.join(' … ').slice(0, 700),
    };
    if (typeof item.publishedDate === 'string') {
      result.publishedDate = item.publishedDate;
    }
    results.push(result);
    if (results.length >= limit) {
      break;
    }
  }
  const cost = record(body.costDollars).total;
  return {
    query: cleanQuery,
    resultLimit: limit,
    pagination: 'unavailable',
    results,
    requestId: typeof body.requestId === 'string' ? body.requestId : null,
    costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
    usedBackend: 'exa_search',
  };
}
