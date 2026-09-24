import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

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
  defaultMaxTokens?: number;
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

export interface ModelMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string | null;
  name?: string | null;
  is_error?: boolean;
  origin?: string;
  injected?: boolean;
  tool_calls?: { id: string; name: string; arguments: unknown; argument_error?: string | null }[];
  provider_items?: Json[];
  images?: ToolImage[];
}
export interface ToolImage { path: string; mimeType?: string; label?: string }
/** Screenshots are the heaviest context; only the newest ones stay in the request, older ones become a pointer. */
export const LIVE_TOOL_IMAGES = 2;
function imageDataUrl(image: ToolImage): string | null {
  try { return `data:${image.mimeType || 'image/png'};base64,${readFileSync(image.path).toString('base64')}`; } catch { return null; }
}

export interface StreamRequest {
  root: string;
  userDataDir?: string;
  config?: ModelConfig;
  system: string;
  messages: ModelMessage[];
  tools: Json[];
  userContent?: Json[];
  signal?: AbortSignal;
  sessionId?: string;
  maxTokens?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  healthFile?: string;
  onEvent?: (event: { type: 'text_delta' | 'thinking_delta' | 'tool_delta' | 'usage'; text?: string; [key: string]: any }) => void;
}

export interface StreamReply {
  text: string;
  tool_calls: { id: string; name: string; arguments: unknown; argument_error?: string | null }[];
  provider_items: Json[];
  usage: Json;
  stop_reason: string;
  usedBackend: string;
  latencyMs: number;
}
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

function modelMode(config: ModelConfig): string {
  return config.apiMode || (config.baseUrl?.includes('/anthropic') ? 'messages' : 'chat-completions');
}

function endpoint(config: ModelConfig): string {
  const base = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const mode = modelMode(config);
  return mode === 'messages' || mode === 'responses' ? `${base}${base.endsWith('/v1') ? '' : '/v1'}/${mode}` : `${base}/chat/completions`;
}

function effortFields(config: ModelConfig): Json {
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(config.effort || '') ? config.effort : 'high';
  if (modelMode(config) === 'responses') return { reasoning: { effort } };
  if (modelMode(config) !== 'messages') return { reasoning_effort: effort };
  const name = config.model.toLowerCase().replace(/\./g, '-');
  const opus = name.includes('opus-4-6');
  return opus || name.includes('sonnet-4-6')
    ? { thinking: { type: 'adaptive' }, output_config: { effort: effort === 'xhigh' || (effort === 'max' && !opus) ? 'high' : effort } }
    : { thinking: { type: 'disabled' } };
}

function stripOptional(body: Json): Json {
  const { thinking: _thinking, reasoning: _reasoning, reasoning_effort: _effort, output_config: output, ...required } = body;
  if (output) {
    const { effort: _outputEffort, ...rest } = output;
    if (Object.keys(rest).length) required.output_config = rest;
  }
  return required;
}

function modelToolNames(request: Pick<StreamRequest, 'messages' | 'tools'>): Map<string, string> {
  const names = [...new Set<string>([...request.tools.map(tool => String((tool.function || tool).name || '')), ...request.messages.flatMap(message => (message.tool_calls || []).map(call => call.name))].filter(Boolean))].sort();
  const mapped = new Map<string, string>(), occupied = new Set(names.filter(name => /^[A-Za-z0-9_-]{1,64}$/.test(name)));
  for (const name of names) {
    if (/^[A-Za-z0-9_-]{1,64}$/.test(name)) { mapped.set(name, name); continue; }
    const base = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 58); let wire = base, suffix = 1;
    while (occupied.has(wire)) wire = `${base}_${suffix++}`;
    occupied.add(wire); mapped.set(name, wire);
  }
  return mapped;
}

export function modelPayload(config: ModelConfig, request: Pick<StreamRequest, 'system' | 'messages' | 'tools' | 'maxTokens'>): Json {
  const mode = modelMode(config);
  const names = modelToolNames(request), wireName = (name: string) => names.get(name) || name;
  const maxTokens = Math.max(1, request.maxTokens || config.defaultMaxTokens || 4096);
  const functions = request.tools.map(raw => raw.function || raw).filter(raw => raw.name);
  const tools = functions.map(raw => {
    const spec = { name: wireName(raw.name), description: raw.description || '', parameters: raw.parameters || raw.input_schema || { type: 'object', properties: {} } };
    return mode === 'messages' ? { name: spec.name, description: spec.description, input_schema: spec.parameters }
      : mode === 'responses' ? { type: 'function', ...spec, strict: false } : { type: 'function', function: spec };
  });
  const messages: Json[] = [];
  const imageBearing = request.messages.filter(message => message.role === 'tool' && message.images?.length);
  const liveImages = new Set(imageBearing.slice(-LIVE_TOOL_IMAGES));
  let pendingImages: Json[] = [];
  const imageParts = (message: ModelMessage): Json[] => (message.images || []).flatMap((image): Json[] => {
    const url = imageDataUrl(image); if (!url) return [];
    const label = image.label || `screenshot from ${message.name || 'tool'} ${message.tool_call_id || ''}`.trim();
    if (mode === 'responses') return [{ type: 'input_text', text: label }, { type: 'input_image', image_url: url }];
    if (mode === 'messages') { const match = /^data:([^;,]+);base64,(.+)$/s.exec(url)!; return [{ type: 'text', text: label }, { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }]; }
    return [{ type: 'text', text: label }, { type: 'image_url', image_url: { url } }];
  });
  const flushImages = () => { if (pendingImages.length) messages.push({ role: 'user', content: pendingImages }); pendingImages = []; };
  for (const message of request.messages) {
    let content = message.content || '';
    const attach = message.role === 'tool' && liveImages.has(message) ? imageParts(message) : [];
    if (message.role === 'tool' && message.images?.length && !attach.length) content += `
[earlier screenshot omitted from context; observe again for the current screen]`;
    if (message.role !== 'tool' && mode !== 'messages') flushImages();
    const calls = message.tool_calls || [];
    const items = message.provider_items || [];
    if (mode === 'responses') {
      if (message.role === 'tool') { messages.push({ type: 'function_call_output', call_id: message.tool_call_id, output: content }); pendingImages.push(...attach); }
      else {
        if (message.role === 'assistant') messages.push(...items.filter(item => item.type === 'reasoning'));
        if (content) messages.push({ role: message.role, content });
        for (const call of calls) messages.push({ type: 'function_call', call_id: call.id, name: wireName(call.name), arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments) });
      }
    } else if (mode === 'messages') {
      const blocks: Json[] = [];
      if (message.role === 'tool') blocks.push({ type: 'tool_result', tool_use_id: message.tool_call_id, content: attach.length ? [{ type: 'text', text: content }, ...attach] : content, is_error: Boolean(message.is_error) });
      else {
        if (message.role === 'assistant') blocks.push(...items.filter(item => ['thinking', 'redacted_thinking'].includes(item.type)));
        if (content) blocks.push({ type: 'text', text: content });
        for (const call of calls) blocks.push({ type: 'tool_use', id: call.id, name: wireName(call.name), input: call.arguments || {} });
      }
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      if (messages.at(-1)?.role === role) messages.at(-1)!.content.push(...blocks);
      else messages.push({ role, content: blocks });
    } else {
      const entry: Json = { role: message.role, content };
      if (message.role === 'tool') { entry.tool_call_id = message.tool_call_id; pendingImages.push(...attach); }
      if (message.role === 'assistant') {
        const reasoning = items.find(item => item.type === 'chat_reasoning');
        if (reasoning) entry.reasoning_content = reasoning.reasoning_content;
        if (calls.length) entry.tool_calls = calls.map(call => ({ id: call.id, type: 'function', function: { name: wireName(call.name), arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments) } }));
      }
      messages.push(entry);
    }
  }
  flushImages();
  const body: Json = { model: config.model, ...effortFields(config) };
  if (tools.length) body.tools = tools;
  if (mode === 'responses') Object.assign(body, { instructions: request.system, input: messages, max_output_tokens: maxTokens });
  else if (mode === 'messages') {
    Object.assign(body, { system: request.system, messages, max_tokens: maxTokens });
    if (!['0', 'false', 'no', 'off'].includes((process.env.MAGIC_POINTER_PROMPT_CACHE || '').toLowerCase())) {
      const cache = { type: 'ephemeral' };
      if (request.system) body.system = [{ type: 'text', text: request.system, cache_control: cache }];
      if (tools.length) (tools.at(-1)! as Json).cache_control = cache;
      let lastUser = messages.length - 1;
      while (lastUser >= 0 && messages[lastUser].role !== 'user') lastUser--;
      const prior = messages[lastUser - 1]?.content?.at(-1);
      if (prior) prior.cache_control = cache;
    }
  } else Object.assign(body, { messages: request.system ? [{ role: 'system', content: request.system }, ...messages] : messages, max_tokens: maxTokens, ...(tools.length ? { tool_choice: 'auto' } : {}) });
  return body;
}

function stopReason(reason: string, text: string, calls: Json[]): string {
  if (['length', 'max_tokens', 'max_output_tokens'].includes(reason)) return 'max_output_tokens';
  if (['stop', 'end_turn', 'stop_sequence', 'tool_use', 'tool_calls', 'completed'].includes(reason)) return text || calls.length ? 'completed' : 'backend_error:empty_response';
  return reason ? `backend_error:${reason}` : text || calls.length ? 'max_output_tokens' : 'backend_error:empty_response';
}

function parsedCall(raw: Json, index: number): StreamReply['tool_calls'][number] {
  const call = { id: String(raw.id || raw.call_id || `call_${index}`), name: String(raw.name || ''), arguments: raw.arguments ?? raw.input ?? {} };
  if (call.arguments === '') call.arguments = {};
  if (typeof call.arguments === 'string') {
    try { call.arguments = JSON.parse(call.arguments); }
    catch { return { ...call, argument_error: `Malformed arguments JSON: ${String(call.arguments).slice(0, 2000)}` }; }
  }
  if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) return { ...call, argument_error: 'Tool arguments must be an object' };
  return call;
}

function parseResponse(data: Json, mode: string): Omit<StreamReply, 'usedBackend' | 'latencyMs'> {
  let calls: Json[] = [];
  let items: Json[] = [];
  let reason = '';
  if (mode === 'messages') {
    calls = (data.content || []).filter((item: Json) => item.type === 'tool_use');
    items = (data.content || []).filter((item: Json) => ['thinking', 'redacted_thinking'].includes(item.type));
    reason = data.stop_reason || '';
  } else if (mode === 'responses') {
    calls = (data.output || []).filter((item: Json) => item.type === 'function_call').map((item: Json) => ({ ...item, id: item.call_id || item.id }));
    items = (data.output || []).filter((item: Json) => item.type === 'reasoning');
    reason = data.status === 'incomplete' ? data.incomplete_details?.reason || 'response_incomplete' : data.status === 'failed' ? data.error?.code || 'response_failed' : data.status || '';
  } else {
    const message = data.choices?.[0]?.message || {};
    calls = (message.tool_calls || []).map((item: Json) => ({ id: item.id, ...item.function }));
    if (typeof message.reasoning_content === 'string') items = [{ type: 'chat_reasoning', reasoning_content: message.reasoning_content }];
    reason = data.choices?.[0]?.finish_reason || '';
  }
  const text = visibleText(data, mode);
  return { text, tool_calls: calls.filter(call => call.name).map(parsedCall), provider_items: items, usage: data.usage || {}, stop_reason: stopReason(reason, text, calls) };
}

async function parseStream(response: Response, mode: string, request: StreamRequest): Promise<Omit<StreamReply, 'usedBackend' | 'latencyMs'>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty_response');
  const decoder = new TextDecoder();
  let buffer = '', text = '', reasoning = '', reason = '', failure = '';
  let usage: Json = {};
  const pending = new Map<number, Json>();
  const provider = new Map<number, Json>();
  const emit = (type: 'text_delta' | 'thinking_delta', value: string) => {
    if (!value) return;
    if (type === 'text_delta') text += value;
    request.onEvent?.({ type, text: value });
  };
  const slot = (index: number) => { if (!pending.has(index)) pending.set(index, { id: '', name: '', arguments: '' }); return pending.get(index)!; };
  const consume = (data: string) => {
    if (!data || data === '[DONE]') return;
    let frame: Json;
    try { frame = JSON.parse(data); } catch { return; }
    if (frame.usage) usage = { ...usage, ...frame.usage };
    if (frame.type === 'error' || frame.error) failure = frame.error?.type || frame.error?.code || frame.code || 'stream_error';
    if (mode === 'messages') {
      if (frame.message?.usage) usage = { ...usage, ...frame.message.usage };
      if (frame.type === 'message_delta' && frame.delta?.stop_reason) reason = frame.delta.stop_reason;
      const index = Number(frame.index || 0);
      const block = frame.content_block;
      const delta = frame.delta || {};
      if (frame.type === 'content_block_start' && block) {
        if (block.type === 'text') emit('text_delta', block.text || '');
        if (['thinking', 'redacted_thinking'].includes(block.type)) { provider.set(index, { ...block }); emit('thinking_delta', block.thinking || ''); }
        if (block.type === 'tool_use') Object.assign(slot(index), { id: block.id, name: block.name, arguments: Object.keys(block.input || {}).length ? JSON.stringify(block.input) : '' });
      }
      if (frame.type === 'content_block_delta') {
        if (delta.type === 'text_delta') emit('text_delta', delta.text || '');
        if (delta.type === 'input_json_delta') { slot(index).arguments += delta.partial_json || ''; request.onEvent?.({ type: 'tool_delta', index, text: delta.partial_json || '' }); }
        if (delta.type === 'thinking_delta') { const item = provider.get(index) || { type: 'thinking', thinking: '' }; item.thinking += delta.thinking || ''; provider.set(index, item); emit('thinking_delta', delta.thinking || ''); }
        if (delta.type === 'signature_delta' && provider.has(index)) provider.get(index)!.signature = (provider.get(index)!.signature || '') + (delta.signature || '');
      }
    } else if (mode === 'responses') {
      const index = Number(frame.output_index || 0);
      if (frame.type === 'response.output_text.delta') emit('text_delta', frame.delta || '');
      if (['response.reasoning_text.delta', 'response.reasoning_summary_text.delta'].includes(frame.type)) emit('thinking_delta', frame.delta || '');
      if (['response.output_item.added', 'response.output_item.done'].includes(frame.type)) {
        const item = frame.item || {};
        if (item.type === 'function_call') Object.assign(slot(index), { id: item.call_id || item.id, name: item.name, arguments: item.arguments || slot(index).arguments });
        if (item.type === 'reasoning') provider.set(index, item);
      }
      if (frame.type === 'response.function_call_arguments.delta') { slot(index).arguments += frame.delta || ''; request.onEvent?.({ type: 'tool_delta', index, text: frame.delta || '' }); }
      if (frame.type === 'response.function_call_arguments.done') slot(index).arguments = frame.arguments || slot(index).arguments;
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(frame.type)) {
        const final = frame.response || {};
        if (final.usage) usage = final.usage;
        reason = final.status === 'incomplete' ? final.incomplete_details?.reason || 'response_incomplete' : final.status === 'failed' ? final.error?.code || 'response_failed' : final.status || '';
        for (const [i, item] of (final.output || []).entries()) if (item.type === 'reasoning') provider.set(i, item);
      }
    } else {
      const choice = frame.choices?.[0];
      if (!choice) return;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string') emit('text_delta', delta.content);
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      emit('thinking_delta', delta.reasoning_content || delta.reasoning || '');
      for (const fragment of delta.tool_calls || []) {
        const index = Number(fragment.index || 0), current = slot(index);
        if (fragment.id) current.id = fragment.id;
        if (fragment.function?.name) current.name = fragment.function.name;
        if (fragment.function?.arguments) { current.arguments += fragment.function.arguments; request.onEvent?.({ type: 'tool_delta', index, text: fragment.function.arguments }); }
      }
      if (choice.finish_reason) reason = choice.finish_reason;
    }
  };
  let dataLines: string[] = [];
  const line = (value: string) => {
    if (!value) { consume(dataLines.join('\n')); dataLines = []; }
    else if (value.startsWith('data:')) dataLines.push(value.slice(5).trimStart());
  };
  try {
    while (true) {
      request.signal?.throwIfAborted();
      const next = await reader.read();
      buffer += decoder.decode(next.value, { stream: !next.done });
      let position: number;
      while ((position = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, position).replace(/\r$/, '')); buffer = buffer.slice(position + 1); }
      if (next.done) break;
    }
    if (buffer) line(buffer.replace(/\r$/, ''));
    if (dataLines.length) consume(dataLines.join('\n'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const calls = [...pending].sort(([a], [b]) => a - b).map(([, item]) => item).filter(item => item.name);
  const items = [...provider].sort(([a], [b]) => a - b).map(([, item]) => item);
  if (reasoning) items.push({ type: 'chat_reasoning', reasoning_content: reasoning });
  return { text, tool_calls: calls.map(parsedCall), provider_items: items, usage, stop_reason: failure ? `backend_error:${failure}` : stopReason(reason, text, calls) };
}

export async function streamModel(request: StreamRequest): Promise<StreamReply> {
  const started = performance.now();
  const config = { ...resolveModelConfig(request.config || null, request.root, request.userDataDir || process.env.MAGIC_POINTER_USER_DATA_DIR || request.root), ...(request.sessionId ? { sessionId: request.sessionId } : {}) };
  const mode = modelMode(config);
  const usedBackend = `magic_pointer.${mode}_streaming`;
  const canonicalNames = new Map([...modelToolNames(request)].map(([canonical, wire]) => [wire, canonical]));
  const finish = (value: Omit<StreamReply, 'usedBackend' | 'latencyMs'>): StreamReply => ({ ...value, tool_calls: value.tool_calls.map(call => ({ ...call, name: canonicalNames.get(call.name) || call.name })), usedBackend, latencyMs: performance.now() - started });
  const fail = (reason: string) => finish({ text: '', tool_calls: [], provider_items: [], usage: {}, stop_reason: `backend_error:${reason}` });
  if (!config.credential && mode !== 'local') return fail('credential_missing');
  const blocked = healthEntries(request.healthFile)[(config.baseUrl || '').replace(/\/+$/, '')];
  if (process.env.MAGIC_POINTER_IGNORE_MODEL_HEALTH !== '1' && blocked?.open_until > Date.now() / 1000) return fail(`circuit_open:${blocked.state}`);
  const timeout = AbortSignal.timeout(Math.max(1, request.timeoutMs || 180_000));
  const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;
  let body = { ...modelPayload(config, request), stream: process.env.MAGIC_POINTER_STREAMING !== '0' } as Json;
  if (request.userContent) {
    const message = { role: 'user', content: request.userContent };
    if (mode === 'responses') body.input.push(message);
    else body.messages.push(message);
  }
  if (body.stream && !['messages', 'responses'].includes(mode)) body.stream_options = { include_usage: true };
  let optionalRetry = true, attempts = 0, committed = false;
  const emit: StreamRequest['onEvent'] = event => { if (event.type !== 'usage') committed = true; request.onEvent?.(event); };
  while (true) {
    try {
      signal.throwIfAborted();
      const response = await (request.fetch || fetch)(endpoint(config), { method: 'POST', headers: modelHeaders(config, mode, config.baseUrl || 'https://api.openai.com/v1'), body: JSON.stringify(body), signal, redirect: 'manual' });
      if (!response.ok) {
        const detail = (await response.text()).split(config.credential || '\0').join('[redacted]').replace(/<[^>]*>/g, ' ').slice(0, 500);
        if (/context.{0,35}(length|limit|window|exceed)|too many tokens|maximum.{0,20}tokens/i.test(detail)) return finish({ text: '', tool_calls: [], provider_items: [], usage: {}, stop_reason: 'context_overflow' });
        if (optionalRetry && response.status >= 400 && response.status < 500) {
          optionalRetry = false;
          const stripped = stripOptional(body);
          if (JSON.stringify(stripped) !== JSON.stringify(body)) { body = stripped; continue; }
        }
        recordHealth(request.healthFile, config, response.status, detail);
        if ((response.status >= 500 || response.status === 429) && attempts++ < 2) { await delay(250 * 2 ** attempts, undefined, { signal }); continue; }
        return fail(`http_${response.status}:${detail}`);
      }
      const streaming = /text\/event-stream/i.test(response.headers.get('content-type') || '');
      const reply = streaming ? await parseStream(response, mode, { ...request, signal, onEvent: emit }) : parseResponse(await response.json() as Json, mode);
      if (!streaming) {
        for (const item of reply.provider_items) if (item.thinking || item.reasoning_content) emit({ type: 'thinking_delta', text: item.thinking || item.reasoning_content });
        if (reply.text) emit({ type: 'text_delta', text: reply.text });
      }
      if (!committed && reply.stop_reason === 'backend_error:empty_response' && body.stream) { body = { ...body, stream: false }; delete body.stream_options; continue; }
      if (reply.stop_reason.startsWith('backend_error:')) recordHealth(request.healthFile, config, null, reply.stop_reason);
      else recordHealth(request.healthFile, config, 200);
      request.onEvent?.({ type: 'usage', usage: reply.usage });
      return finish(reply);
    } catch (error) {
      request.signal?.throwIfAborted();
      if (timeout.aborted) return fail('model_request_timeout');
      const message = String(error instanceof Error ? error.message : error).split(config.credential || '\0').join('[redacted]');
      if (!committed && attempts++ < 2) { await delay(250 * 2 ** attempts, undefined, { signal }); continue; }
      recordHealth(request.healthFile, config, null, message);
      return fail(message);
    }
  }
}

export async function requestVision(config: ModelConfig, request: Omit<TextRequest, 'prompt'> & { prompt: string; images: { path?: string; dataUrl?: string; label?: string }[] }) {
  const mode = modelMode(config);
  const content: Json[] = [{ type: mode === 'responses' ? 'input_text' : 'text', text: `${request.prompt}${request.context ? `\n\n${request.context}` : ''}` }];
  for (const [index, image] of request.images.entries()) {
    const url = image.dataUrl || `data:image/${image.path?.toLowerCase().endsWith('.jpg') || image.path?.toLowerCase().endsWith('.jpeg') ? 'jpeg' : image.path?.toLowerCase().endsWith('.webp') ? 'webp' : 'png'};base64,${readFileSync(image.path!).toString('base64')}`;
    content.push({ type: mode === 'responses' ? 'input_text' : 'text', text: image.label || (index ? `REFERENCE_${index}` : 'IMAGE A / THIS / current object / frozen screenshot') });
    if (mode === 'responses') content.push({ type: 'input_image', image_url: url });
    else if (mode === 'messages') { const match = /^data:([^;,]+);base64,(.+)$/s.exec(url); if (!match) throw new Error('Expected image data URL'); content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }); }
    else content.push({ type: 'image_url', image_url: { url } });
  }
  const response = await streamModel({ root: '', config, messages: [], tools: [], ...request, userContent: content,
    system: request.system || '只描述提供图像中的真实内容，区分当前对象与参考图，不要编造。', maxTokens: request.maxTokens || 1200 });
  if (response.stop_reason !== 'completed') throw new Error(response.stop_reason);
  return { text: response.text, usage: response.usage, usedBackend: response.usedBackend, latencyMs: response.latencyMs };
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
