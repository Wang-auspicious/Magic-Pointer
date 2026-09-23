import { isDeepStrictEqual } from 'node:util';

export type Effect = 'read' | 'reversible_write' | 'local_irreversible' | 'external_send' | 'destructive' | 'purchase';
export type FailureType = 'stale_anchor' | 'focus_lost' | 'content_changed' | 'blocked_by_modal' | 'permission_denied' |
  'timeout' | 'tool_error' | 'stale_snapshot' | 'computer_use_busy' | 'steer_pending';
export type JsonSchema = Record<string, unknown>;
export interface ToolCall { id: string; name: string; arguments: unknown; argument_error?: string | null }
export interface ToolResult {
  tool_call_id: string;
  value: unknown;
  is_error: boolean;
  failure_type: FailureType | null;
  error_message?: string;
  used_backend: string | null;
  latency_ms: number | null;
  outcome_known: boolean;
  tool_name?: string;
  arguments?: Record<string, unknown>;
}
export interface ToolContext { signal: AbortSignal; tool_call_id: string; scope?: unknown }
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: JsonSchema;
  execute(args: Record<string, unknown>, context: ToolContext): unknown | Promise<unknown>;
  effect?: Effect;
  effect_for?: (args: Record<string, unknown>) => Effect;
  is_concurrency_safe?: boolean;
  is_concurrency_safe_for?: (args: Record<string, unknown>) => boolean;
  resource_keys?: readonly string[] | ((args: Record<string, unknown>) => Iterable<string>);
  used_backend?: string;
  timeout_ms?: number;
  access_for?: (args: Record<string, unknown>) => unknown;
  verify_result?: (value: unknown) => void | Promise<void>;
  preconditions?: readonly ((args: Record<string, unknown>, context: ToolContext) => void | Promise<void>)[];
  discovers_tools?: boolean;
  suspends_for_user_input?: boolean;
  deferred?: boolean;
  examples?: readonly Record<string, unknown>[];
}
export type ToolEvent = { type: 'started'; call: ToolCall; dispatched: boolean } |
  { type: 'committed'; call: ToolCall; dispatched: boolean; result: ToolResult };
type Committed = Extract<ToolEvent, { type: 'committed' }>;
export interface ScheduleOptions {
  signal?: AbortSignal;
  scope?: unknown;
  max_parallel_tool_calls?: number;
  before_dispatch?: (call: ToolCall) => ToolResult | undefined | Promise<ToolResult | undefined>;
  onSettled?: (event: Committed) => void;
}

export class ActionFailure extends Error {
  constructor(public failure_type: FailureType, message: string, public recovery_hint?: string, public partial_result: unknown = null) {
    super(message);
    this.name = 'ActionFailure';
  }
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const namePattern = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const effects = new Set<Effect>(['read', 'reversible_write', 'local_irreversible', 'external_send', 'destructive', 'purchase']);
const cancelled = (error: unknown) => error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);

export function validate(value: unknown, schema: JsonSchema, root = schema, path = 'input', depth = 0): string[] {
  const errors: string[] = [];
  const fail = (message: string) => { errors.push(`${path}: ${message}`); };
  if (depth > 32) return [`${path}: maximum nesting depth exceeded`];
  if (typeof value === 'number' && !Number.isFinite(value)) return [`${path}: expected a finite number`];
  if (schema.$ref !== undefined) {
    const ref = String(schema.$ref);
    let target: unknown = root;
    if (ref !== '#' && !ref.startsWith('#/')) return [`${path}: non-local schema reference`];
    for (const key of ref === '#' ? [] : ref.slice(2).split('/')) {
      target = object(target) ? target[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
    }
    if (!object(target)) return [`${path}: unresolved schema reference ${ref}`];
    errors.push(...validate(value, target, root, path, depth + 1));
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    const matches = branches.map(branch => object(branch) ? validate(value, branch, root, path, depth + 1) : ['invalid schema']);
    if (keyword === 'allOf') errors.push(...matches.flat());
    else {
      const count = matches.filter(branch => !branch.length).length;
      if (!count || keyword === 'oneOf' && count !== 1) fail(`does not match ${keyword}`);
    }
  }
  if ('const' in schema && !isDeepStrictEqual(value, schema.const)) fail('does not match const');
  if (Array.isArray(schema.enum) && !schema.enum.some(item => isDeepStrictEqual(value, item))) fail('not an allowed enum value');
  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  if (types.length && !types.some(type => type === 'object' ? object(value) : type === 'array' ? Array.isArray(value) :
    type === 'integer' ? Number.isInteger(value) : type === 'null' ? value === null : typeof value === type)) {
    return [...errors, `${path}: expected ${types.join(' or ')}`];
  }
  const bounds = (size: number, lower: string, upper: string) => {
    if (typeof schema[lower] === 'number' && size < schema[lower]) fail(`violates ${lower}=${schema[lower]}`);
    if (typeof schema[upper] === 'number' && size > schema[upper]) fail(`violates ${upper}=${schema[upper]}`);
  };
  if (typeof value === 'string') {
    bounds([...value].length, 'minLength', 'maxLength');
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) fail('does not match pattern');
  } else if (typeof value === 'number') {
    bounds(value, 'minimum', 'maximum');
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) fail('violates exclusiveMinimum');
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) fail('violates exclusiveMaximum');
  } else if (Array.isArray(value)) {
    bounds(value.length, 'minItems', 'maxItems');
    if (schema.uniqueItems && value.some((item, index) => value.slice(0, index).some(previous => isDeepStrictEqual(item, previous)))) fail('violates uniqueItems');
    value.forEach((item, index) => errors.push(...validate(item, object(schema.items) ? schema.items : {}, root, `${path}[${index}]`, depth + 1)));
  } else if (object(value)) {
    const properties = object(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) if (!(String(key) in value)) fail(`missing ${key}`);
    const extra = schema.additionalProperties ?? (depth !== 0);
    for (const [key, item] of Object.entries(value)) {
      const child = properties[key] ?? extra;
      if (child === false) fail(`unexpected field ${key}`);
      else errors.push(...validate(item, object(child) ? child : {}, root, `${path}.${key}`, depth + 1));
    }
  }
  return errors;
}

function failure(call: ToolCall, error: unknown, backend: string | null = null, elapsed: number | null = 0): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof ActionFailure && error.recovery_hint ? `; recovery: ${error.recovery_hint}` : '';
  return { tool_call_id: call.id, tool_name: call.name, value: error instanceof ActionFailure ? error.partial_result : message,
    is_error: true, failure_type: error instanceof ActionFailure ? error.failure_type :
      error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'tool_error',
    error_message: `Error calling tool (${call.name}): ${message}${hint}`, used_backend: backend,
    latency_ms: elapsed, outcome_known: !cancelled(error) };
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();
  private readonly aliases = new Map<string, string>();
  private readonly loaded = new Set<string>();
  private initialTools: Set<string> | null = null;
  private readonly endListeners = new Set<() => void | Promise<void>>();

  onSessionEnd(listener: () => void | Promise<void>): () => void { this.endListeners.add(listener); return () => { this.endListeners.delete(listener); }; }
  async close(): Promise<void> {
    const results = await Promise.allSettled([...this.endListeners].map(listener => Promise.resolve().then(listener)));
    this.endListeners.clear();
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  register(spec: ToolSpec): ToolSpec {
    if (!namePattern.test(spec.name) || this.tools.has(spec.name) || this.aliases.has(spec.name)) throw new Error(`Invalid or duplicate tool: ${spec.name}`);
    if (spec.input_schema.type !== 'object' || !object(spec.input_schema.properties) || !Array.isArray(spec.input_schema.required)) {
      throw new Error(`${spec.name}: object input_schema with properties and required is required`);
    }
    if ('scope' in spec.input_schema.properties) throw new Error(`${spec.name}: scope is a reserved argument`);
    if (spec.effect && !effects.has(spec.effect)) throw new Error(`${spec.name}: invalid effect`);
    if (spec.timeout_ms !== undefined && (!Number.isInteger(spec.timeout_ms) || spec.timeout_ms <= 0)) throw new Error(`${spec.name}: invalid timeout_ms`);
    this.tools.set(spec.name, spec);
    return spec;
  }
  unregister(name: string, expected?: ToolSpec): boolean {
    if (!this.tools.has(name) || expected && this.tools.get(name) !== expected) return false;
    this.loaded.delete(name);
    for (const [alias, canonical] of this.aliases) if (canonical === name) this.aliases.delete(alias);
    return this.tools.delete(name);
  }
  alias(alias: string, canonical: string): void {
    if (!namePattern.test(alias) || this.tools.has(alias)) throw new Error(`Invalid tool alias: ${alias}`);
    this.get(canonical);
    this.aliases.set(alias, canonical);
  }
  get(name: string): ToolSpec {
    const spec = this.tools.get(this.aliases.get(name) ?? name);
    if (!spec) throw new Error(`Unknown tool: ${name}`);
    return spec;
  }
  list(): ToolSpec[] { return [...this.tools.values()]; }
  setInitialTools(names: Iterable<string>): void {
    this.initialTools = new Set([...names].map(name => this.aliases.get(name) ?? name).filter(name => this.tools.has(name)));
  }
  schemas() {
    return this.list().filter(spec => this.loaded.has(spec.name) || (this.initialTools ? this.initialTools.has(spec.name) : !spec.deferred)).map(spec => ({
      name: spec.name, description: spec.description, parameters: spec.input_schema, ...(spec.examples?.length ? { examples: spec.examples } : {}),
    }));
  }
  directory(): string {
    return this.list().filter(spec => !this.loaded.has(spec.name) && (this.initialTools ? !this.initialTools.has(spec.name) : spec.deferred))
      .map(spec => spec.name).join(', ');
  }
  search(keyword: string, limit = 8): ToolSpec[] {
    const query = keyword.trim().toLowerCase();
    if (!query || limit <= 0) return [];
    const exact = this.list().find(spec => spec.name.toLowerCase() === query);
    if (exact) return [exact];
    const tokens = query.match(/[a-z0-9_]+|[\u4e00-\u9fff]+/g) ?? [];
    return this.list().map(spec => {
      const text = `${spec.name} ${spec.description} ${JSON.stringify(spec.examples ?? [])}`.toLowerCase();
      const words = text.match(/[a-z0-9_]+/g) ?? [];
      const score = tokens.reduce((sum, token) => sum + (/^[a-z0-9_]+$/.test(token)
        ? [...new Set(words)].filter(word => word === token || word.split('_').includes(token)).length : Number(text.includes(token))), 0);
      return { spec, score };
    }).filter(item => item.score).sort((a, b) => b.score - a.score || a.spec.name.localeCompare(b.spec.name)).slice(0, limit).map(item => item.spec);
  }
  discover({ names, keyword = '' }: { names?: string[]; keyword?: string }, limit = 8): ToolSpec[] {
    if (!names?.length && !keyword.trim()) throw new Error('Provide names or a search keyword');
    const specs = names?.length ? [...new Set(names)].map(name => this.get(name)) : this.search(keyword, limit);
    specs.forEach(spec => this.loaded.add(spec.name));
    return specs;
  }
  registerDiscovery(limit = 8): ToolSpec {
    return this.register({ name: 'Tools', description: 'Load tools by exact names, or search by keyword. Full parameters appear in the next tool list.',
      input_schema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16 },
        keyword: { type: 'string' } }, required: [] },
      execute: args => ({ tools: this.discover(args as { names?: string[]; keyword?: string }, limit).map(spec => ({ name: spec.name })) }),
      discovers_tools: true, is_concurrency_safe: true, used_backend: 'tool_registry_search', timeout_ms: 5000 });
  }
  effect(name: string, args: Record<string, unknown>): Effect {
    const spec = this.get(name);
    try { const effect = spec.effect_for?.(args); if (effect && effects.has(effect)) return effect; } catch {}
    return spec.effect ?? 'read';
  }
  claim(call: ToolCall): { parallel: boolean; keys: Set<string> } {
    try {
      const spec = this.get(call.name), args = object(call.arguments) ? call.arguments : {};
      const parallel = spec.is_concurrency_safe_for?.(args) ?? spec.is_concurrency_safe ?? false;
      const raw = typeof spec.resource_keys === 'function' ? spec.resource_keys(args) : spec.resource_keys ?? [];
      if (typeof raw === 'string') throw new Error('Invalid resource keys');
      const keys = [...raw];
      if (keys.some(key => typeof key !== 'string' || !key.trim())) throw new Error('Invalid resource keys');
      return { parallel, keys: new Set(keys.map(key => key.trim())) };
    } catch { return { parallel: false, keys: new Set() }; }
  }
  validateInput(spec: ToolSpec, args: unknown): string[] { return validate(args, spec.input_schema); }
  async execute(call: ToolCall, options: { signal?: AbortSignal; scope?: unknown } = {}): Promise<ToolResult> {
    const started = performance.now();
    let spec: ToolSpec | undefined, dispatched = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      spec = this.get(call.name);
      if (call.argument_error) throw new Error(call.argument_error);
      const errors = this.validateInput(spec, call.arguments);
      if (errors.length) throw new Error(errors.join('; '));
      const args = call.arguments as Record<string, unknown>;
      const deadline = new AbortController();
      timer = setTimeout(() => deadline.abort(new DOMException('Tool execution timed out', 'TimeoutError')), spec.timeout_ms ?? 30_000);
      const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
      signal.throwIfAborted();
      const context: ToolContext = { signal, tool_call_id: call.id, scope: options.scope };
      for (const precondition of spec.preconditions ?? []) await precondition(args, context);
      signal.throwIfAborted();
      dispatched = true;
      const value = await spec.execute(args, context);
      await spec.verify_result?.(value);
      return { tool_call_id: call.id, tool_name: call.name, arguments: args, value, is_error: false, failure_type: null,
        used_backend: spec.used_backend ?? 'local', latency_ms: performance.now() - started, outcome_known: true };
    } catch (error) {
      const result = failure(call, error, spec?.used_backend ?? (spec ? 'local' : null), performance.now() - started);
      if (!dispatched) result.outcome_known = true;
      return result;
    } finally { if (timer) clearTimeout(timer); }
  }
}

export async function* scheduleToolCalls(calls: readonly ToolCall[], registry: ToolRegistry, options: ScheduleOptions = {}): AsyncGenerator<ToolEvent> {
  const limit = options.max_parallel_tool_calls ?? 8;
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('max_parallel_tool_calls must be a positive integer');
  const running = new Map<number, Promise<void>>(), settled = new Map<number, Committed>(), active = new Set<string>();
  let cursor = 0, commit = 0, exclusive = false, cancellation: unknown;
  const settle = (index: number, result: ToolResult, dispatched: boolean) => {
    const event: Committed = { type: 'committed', call: calls[index]!, result, dispatched };
    settled.set(index, event);
    try { options.onSettled?.(event); } catch {}
  };
  try {
    while (commit < calls.length) {
      if (options.signal?.aborted) cancellation = options.signal.reason;
      while (!cancellation && !exclusive && cursor < calls.length && running.size < limit) {
        const index = cursor, call = calls[index]!;
        const blocked = await options.before_dispatch?.(call);
        if (options.signal?.aborted) { cancellation = options.signal.reason; break; }
        if (blocked) { cursor++; yield { type: 'started', call, dispatched: false }; settle(index, blocked, false); continue; }
        const claim = registry.claim(call);
        if (running.size && (!claim.parallel || [...claim.keys].some(key => active.has(key)))) break;
        cursor++;
        exclusive = !claim.parallel;
        claim.keys.forEach(key => active.add(key));
        yield { type: 'started', call, dispatched: true };
        const task = registry.execute(call, options).then(result => {
          claim.keys.forEach(key => active.delete(key));
          running.delete(index);
          if (!claim.parallel) exclusive = false;
          settle(index, result, true);
          if (!result.outcome_known && result.failure_type === 'tool_error') cancellation ??= new DOMException(result.error_message, 'AbortError');
        });
        running.set(index, task);
      }
      while (settled.has(commit)) { const event = settled.get(commit)!; settled.delete(commit++); yield event; }
      if (running.size) { await Promise.race(running.values()); continue; }
      if (cancellation) {
        while (cursor < calls.length) {
          const index = cursor++, call = calls[index]!;
          yield { type: 'started', call, dispatched: false };
          settle(index, failure(call, new Error('tool call aborted before dispatch')), false);
          yield settled.get(index)!;
          settled.delete(index);
          commit++;
        }
        throw cancellation;
      }
    }
    if (options.signal?.aborted) throw options.signal.reason;
  } finally { await Promise.allSettled(running.values()); }
}
