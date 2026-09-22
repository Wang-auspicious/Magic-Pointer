import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ModelConfig {
  model: string;
  baseUrl?: string;
  credential?: string | null;
  apiMode?: 'chat-completions' | 'messages' | 'responses' | 'local';
  headers?: Record<string, string>;
  effort?: string;
  sessionId?: string;
  models?: Json[];
  defaultContextWindow?: number;
}

export interface TextRequest {
  prompt: string;
  context?: string;
  system?: string;
  maxTokens?: number;
  timeoutMs?: number;
  attempts?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  healthFile?: string;
}

type Json = Record<string, any>;
const sessionId = randomUUID();
const cooldown: Record<string, number> = { unauthorized: 240, payment_required: 240, model_missing: 240, rate_limited: 30, unreachable: 20, server_error: 20 };

const contextWindows: [number, string][] = [
  [1_050_000, 'gpt-5.6 gpt-5.5 gpt-5.4'],
  [1_000_000, 'gemini-2 gemini-3 gpt-4.1 claude-opus-5 claude-sonnet-5 claude-fable-5 claude-mythos-5 claude-opus-4-8 claude-opus-4-7 claude-opus-4-6 claude-sonnet-4-6'],
  [400_000, 'gpt-5.4-mini gpt-5.4-nano gpt-5.1 gpt-5'],
  [256_000, 'kimi-k2 kimi-k qwen3-coder qwen4 grok-4'],
  [200_000, 'o3 o4 claude-opus-4 claude-sonnet-4 claude-haiku-4-5 claude-haiku-4 claude-3-7 claude-3-5 glm-5 minimax'],
  [128_000, 'gpt-4o gpt-4o-mini deepseek-v4 deepseek-v3 deepseek-r deepseek-chat deepseek-reasoner qwen3.7 qwen3 glm-4.6 glm-4 mimo llama4'],
];

function modelHeaders(config: ModelConfig, mode: string, base: string): Headers {
  const headers = new Headers({ 'Content-Type': 'application/json', 'User-Agent': 'curl/8.0' });
  if (mode === 'messages') { headers.set('x-api-key', config.credential || ''); headers.set('anthropic-version', '2023-06-01'); }
  else if (mode !== 'local') headers.set('Authorization', `Bearer ${config.credential || ''}`);
  for (const [key, value] of Object.entries(config.headers || {})) {
    if (!['authorization', 'x-api-key', 'content-length', 'host'].includes(key.toLowerCase())) headers.set(key, value);
  }
  const target = new URL(base);
  if (target.hostname === 'opencode.ai' && target.pathname.startsWith('/zen/go/')) {
    headers.set('x-opencode-session', config.sessionId || sessionId);
    headers.set('User-Agent', 'MagicPointer');
  }
  return headers;
}

export async function listModels(config: ModelConfig, send: typeof fetch = fetch) {
  const base = (config.baseUrl || '').replace(/\/+$/, '');
  const mode = config.apiMode || (base.includes('/anthropic') ? 'messages' : 'chat-completions');
  let source = config.models?.length ? 'profile' : 'config';
  let entries = config.models || [];
  let error = '';
  let provider = '本地';
  if (base) {
    const target = new URL(base);
    const service = target.pathname.split('/').filter(Boolean)[0];
    provider = target.hostname === 'opencode.ai' && ['go', 'zen'].includes(service) ? `opencode-${service}` : target.hostname;
    if (!entries.length) {
      try {
        const url = `${base}${mode === 'messages' && !base.endsWith('/v1') ? '/v1' : ''}/models`;
        const response = await send(url, { headers: modelHeaders(config, mode, base), signal: AbortSignal.timeout(5000), redirect: 'manual' });
        if (!response.ok) throw new Error(`gateway /models HTTP ${response.status}`);
        const body = await response.json() as Json;
        if (!Array.isArray(body.data)) throw new Error('gateway /models missing data array');
        entries = body.data.filter((item: Json) => item && typeof item === 'object' && String(item.id || '').trim());
        source = 'gateway';
      } catch (failure) {
        error = `网关模型列表不可用：${failure instanceof Error ? failure.message : String(failure)}`.split(config.credential || '\0').join('[redacted]');
      }
    }
  }
  const rows = new Map(entries.map(item => [String(item.id || item.model || '').trim(), item]));
  rows.delete('');
  if (!rows.has(config.model)) entries = [{ id: config.model }, ...[...rows].map(([id, value]) => ({ ...value, id }))];
  else entries = [...rows].map(([id, value]) => ({ ...value, id }));
  const models = entries.map(item => {
    const id = String(item.id);
    let contextWindow = 0;
    for (const value of [item.contextWindow, item.context_length, item.context_window, item.top_provider?.context_length]) {
      if (Number.isFinite(Number(value)) && Number(value) > 0) { contextWindow = Math.trunc(Number(value)); break; }
    }
    if (!contextWindow) {
      const name = id.toLowerCase();
      const matches = contextWindows.flatMap(([window, prefixes]) => prefixes.split(' ').filter(prefix => name.startsWith(prefix) || name.split('/').at(-1)!.startsWith(prefix)).map(prefix => ({ prefix, window })));
      contextWindow = matches.sort((a, b) => b.prefix.length - a.prefix.length)[0]?.window || config.defaultContextWindow || 64000;
    }
    return { id, vision: Boolean(item.vision), contextWindow };
  });
  return { ok: true, current: config.model, provider, source, error, groups: [{ id: provider, name: provider, models }] };
}

export function resolveModelConfig(config: Partial<ModelConfig> | null, root: string, userDataDir: string): ModelConfig {
  const read = (name: string): string => {
    if (process.env.MAGIC_POINTER_DISABLE_LOCAL_SECRETS === '1') return '';
    for (const directory of [join(root, 'secrets'), join(userDataDir, 'secrets')]) {
      try { return readFileSync(join(directory, name), 'utf8').replace(/^\uFEFF/, '').trim(); } catch {}
    }
    return '';
  };
  if (config && [config.model, config.credential, config.baseUrl, config.apiMode].some(Boolean)) {
    return { ...config, model: config.model || 'gpt-4o-mini' };
  }
  const baseUrl = process.env.OPENAI_BASE_URL || read('openai_base_url.txt');
  const mode = (process.env.MAGIC_POINTER_API_MODE || read('model_api_mode.txt')).toLowerCase();
  const apiMode = mode === 'anthropic' || mode === 'messages' ? 'messages'
    : mode === 'responses' || mode === 'local' ? mode
    : !mode && baseUrl.toLowerCase().includes('/anthropic') ? 'messages' : 'chat-completions';
  return { model: process.env.MAGIC_POINTER_MODEL || read('model.txt') || 'gpt-4o-mini', baseUrl,
    credential: process.env.OPENAI_API_KEY || read('openai_key.txt'), apiMode, effort: config?.effort };
}

function healthEntries(file?: string): Json {
  if (!file) return {};
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return raw.entries || { [String(raw.base_url || '').replace(/\/+$/, '')]: raw };
  } catch { return {}; }
}

function recordHealth(file: string | undefined, config: ModelConfig, status: number | null, detail = '') {
  if (!file) return;
  const base = (config.baseUrl || '').replace(/\/+$/, '');
  const entries = healthEntries(file);
  const state = status === 200 ? 'ok' : status === 401 || status === 403 ? 'unauthorized'
    : status === 402 ? 'payment_required' : status === 404 ? 'model_missing'
    : status === 429 ? 'rate_limited' : status === null ? 'unreachable' : 'server_error';
  const transient = ['unreachable', 'server_error', 'rate_limited'].includes(state);
  const streak = transient ? Number(entries[base]?.transient_streak || 0) + 1 : 0;
  const now = Date.now() / 1000;
  entries[base] = { state, http_status: status, detail: detail.slice(0, 300), checked_at: now,
    open_until: state === 'ok' || (transient && streak < 2) ? 0 : now + cooldown[state],
    model: config.model, base_url: base, transient_streak: streak };
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ schema: 2, entries }), 'utf8');
    renameSync(temp, file);
  } catch {}
}

function visibleText(data: Json, mode: string): string {
  if (mode === 'messages') return (data.content || []).filter((block: Json) => block.type === 'text').map((block: Json) => block.text || '').join('\n').trim();
  if (mode === 'responses') return (data.output || []).flatMap((item: Json) => item.content || []).filter((block: Json) => block.type === 'output_text').map((block: Json) => block.text || '').join('\n').trim();
  return String(data.choices?.[0]?.message?.content || '').trim();
}

export async function requestText(config: ModelConfig, request: TextRequest) {
  request.signal?.throwIfAborted();
  if (!config.credential && config.apiMode !== 'local') throw new Error('当前模型没有可用密钥。');
  const started = performance.now();
  const base = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const blocked = healthEntries(request.healthFile)[(config.baseUrl || '').replace(/\/+$/, '')];
  if (process.env.MAGIC_POINTER_IGNORE_MODEL_HEALTH !== '1' && blocked?.open_until > Date.now() / 1000) {
    throw new Error(`模型端点暂不可用（${blocked.state}${blocked.http_status ? `，HTTP ${blocked.http_status}` : ''}）。${blocked.detail || ''}`);
  }
  const mode = config.apiMode || (base.includes('/anthropic') ? 'messages' : 'chat-completions');
  const url = mode === 'messages' || mode === 'responses' ? `${base}${base.endsWith('/v1') ? '' : '/v1'}/${mode}` : `${base}/chat/completions`;
  const headers = modelHeaders(config, mode, base);
  const content = `${request.prompt.trim() || '解释当前选中的内容'}${request.context ? `\n\n${request.context}` : ''}`;
  const system = request.system || '你是 Magic Pointer 的本地选区助手。只基于提供的真实应用上下文回答，不要编造。';
  const maxTokens = Math.max(1, request.maxTokens || 1200);
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(config.effort || '') ? config.effort : 'high';
  let body: Json = mode === 'responses'
    ? { model: config.model, instructions: system, input: [{ role: 'user', content: [{ type: 'input_text', text: content }] }], max_output_tokens: maxTokens }
    : mode === 'messages'
      ? { model: config.model, system, messages: [{ role: 'user', content }], max_tokens: maxTokens, thinking: { type: 'disabled' } }
      : { model: config.model, messages: [{ role: 'system', content: system }, { role: 'user', content }], max_tokens: maxTokens, thinking: { type: 'disabled' }, reasoning_effort: effort };
  const timeout = AbortSignal.timeout(Math.max(1, request.timeoutMs || 120_000));
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const send = request.fetch || fetch;
  const attempts = Math.max(1, Math.min(2, request.attempts ?? 2));
  let retries = 0;
  let optionalRetry = true;
  while (true) {
    let response: Response;
    try {
      response = await send(url, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'manual' });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const message = String(error instanceof Error ? error.message : error).split(config.credential || '\0').join('[redacted]');
      recordHealth(request.healthFile, config, null, message);
      if (++retries < attempts) continue;
      throw new Error(`模型连接失败：${message}`);
    }
    const raw = await response.text();
    const detail = raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]*>/gi, ' ').replace(/\s+/g, ' ').split(config.credential || '\0').join('[redacted]').slice(0, 220);
    let data: Json = {};
    if (response.ok) {
      try { data = JSON.parse(raw); } catch { throw new Error('模型端点没有返回有效 JSON。'); }
    }
    const text = visibleText(data, mode);
    if (optionalRetry && 'thinking' in body && ((response.status >= 400 && response.status < 500) || (response.ok && !text))) {
      const { thinking: _thinking, reasoning_effort: _effort, ...required } = body;
      body = required;
      optionalRetry = false;
      continue;
    }
    if (!response.ok) {
      recordHealth(request.healthFile, config, response.status, detail);
      if (response.status >= 500 && ++retries < attempts) continue;
      throw new Error(`HTTP ${response.status}。${detail}`);
    }
    const reason = mode === 'responses' ? data.status : mode === 'messages' ? data.stop_reason : data.choices?.[0]?.finish_reason;
    const complete = mode === 'responses' ? ['completed'] : mode === 'messages' ? ['end_turn', 'stop_sequence'] : ['stop'];
    recordHealth(request.healthFile, config, 200);
    if (reason && !complete.includes(reason)) throw new Error(`模型输出未完成（${reason}）`);
    if (!text) throw new Error('模型没有返回正文。');
    return { text, usedBackend: config.model, latencyMs: performance.now() - started, usage: data.usage || null };
  }
}
