import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, open, stat, truncate, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentMessage } from './agent';
import { validateContextUpdate, taskSources, taskReferences, referenceRevision, registerSource, sourceRef } from './context';

type Data = Record<string, unknown>;
type Message = {
  role: string; content: string | null; tool_call_id: string | null; name: string | null;
  injected?: boolean; is_error?: boolean; tool_calls?: { id: string; arguments?: Data }[];
};
export type SessionEvent = { seq: number; type: string; data: Data; surfaceOp?: string; hash?: string; time?: number; sessionId?: string };
type Event = SessionEvent;

export function exactApprovedToolCall(events: readonly Pick<SessionEvent, 'type' | 'data'>[], toolName: string, args: Data, callId: string): boolean {
  if (!callId.startsWith('approval-')) return false;
  const requestId = callId.slice('approval-'.length);
  const answer = events.find(event => event.type === 'user_input/answered' && event.data.requestId === requestId);
  if (!answer) return false;
  const pending = object(answer.data.pendingInput), response = object(answer.data.response), action = object(pending.action);
  const approvedArguments = toolName === 'DailyWrap.read' && response.actionArguments !== undefined
    ? response.actionArguments : action.arguments;
  if (pending.kind !== 'permission' || pending.harnessPermission !== true || pending.tool !== toolName ||
    action.tool !== toolName || !['once', 'grant'].includes(text(response.decision)) ||
    !isDeepStrictEqual(approvedArguments, args)) return false;
  if (events.some(event => event.type === 'permission/cancelled' && array(event.data.requestIds).includes(requestId))) return false;
  const prepared = events.filter(event => event.type === 'operation/prepared' && event.data.callId === callId);
  if (prepared.length !== 1 || prepared[0]!.data.name !== toolName || !isDeepStrictEqual(prepared[0]!.data.arguments, args)) return false;
  return !events.some(event => event.type === 'operation/settled' && event.data.operationId === prepared[0]!.data.operationId);
}
type Operation = { id: string; callId: string; tool: string; arguments: Data; effect: string;
  prepared: number; settled?: number; outcome: string; recovery: string; recoveryScope: Data };

const unfinished = new Set(['budget_exhausted', 'stalled', 'provider_unavailable', 'user_interrupt',
  'max_output_tokens_recovered', 'invariant_failed', 'interrupted']);
const object = (value: unknown): Data => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => String(value ?? '');

function canonicalRow(row: string): string {
  const tokens = row.match(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]/g) ?? [];
  let cursor = 0;
  const parse = (root = false): string => {
    const token = tokens[cursor++];
    if (token === '{') {
      const entries: [string, string][] = [];
      while (tokens[cursor] !== '}') {
        const key = JSON.parse(tokens[cursor++]) as string;
        cursor++;
        const value = parse();
        if (!root || key !== 'hash') entries.push([key, value]);
        if (tokens[cursor] === ',') cursor++;
      }
      cursor++;
      return `{${entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(',')}}`;
    }
    if (token === '[') {
      const values: string[] = [];
      while (tokens[cursor] !== ']') {
        values.push(parse());
        if (tokens[cursor] === ',') cursor++;
      }
      cursor++;
      return `[${values.join(',')}]`;
    }
    return token.startsWith('"') ? JSON.stringify(JSON.parse(token)) : token;
  };
  return parse(true);
}

async function loadSession(file: string, sessionId: string): Promise<Event[]> {
  const raw = await readFile(file, 'utf8');
  if (!raw) throw new Error('empty session log');
  const rows = raw.split(/\r?\n/);
  if (rows.at(-1) === '') rows.pop();
  else {
    try { JSON.parse(rows.at(-1)!); } catch { rows.pop(); }
  }
  let previous = '0'.repeat(64);
  const events = rows.map((row, index) => {
    let value: Data;
    try { value = object(JSON.parse(row)); }
    catch { throw new Error(`invalid JSON at line ${index + 1}`); }
    if (value.formatVersion !== 1) throw new Error('unsupported session event format version');
    if (value.sessionId !== sessionId) throw new Error('session event identity mismatch');
    if (value.seq !== index) throw new Error(`non-contiguous seq; expected ${index}`);
    if (value.prevHash !== previous) throw new Error(`hash chain mismatch at event ${index}`);
    const expected = createHash('sha256').update(canonicalRow(row)).digest('hex');
    if (value.hash !== expected) throw new Error(`hash mismatch at event ${index}`);
    if (!value.data || Array.isArray(value.data) || typeof value.data !== 'object') throw new Error(`event ${index} data must be an object`);
    if (value.surfaceOp != null && !['append', 'append_many', 'replace'].includes(text(value.surfaceOp))) throw new Error(`event ${index} has invalid surface operation`);
    previous = expected;
    return value as unknown as Event;
  });
  const header = events[0];
  if (header?.type !== 'session/created') throw new Error('first event must be session/created');
  if (header.data.version !== 1 || header.data.sessionId !== sessionId) throw new Error('session header identity/version mismatch');
  return events;
}

function messages(events: Event[]): Message[] {
  let surface: Message[] = [];
  for (const event of events) {
    const data = event.data;
    if (event.type === 'permission/cancelled') {
      surface = surface.map(message => message.role === 'tool' && array(data.requestIds).includes(message.tool_call_id)
        ? { ...message, content: 'Not executed: a newer user instruction cancelled this approval.', is_error: true } : message);
    } else if (event.type === 'user_input/answered') {
      const response = data.message as Message;
      surface = surface.map(message => message.role === 'tool' && message.tool_call_id === response.tool_call_id ? response : message);
    } else if (event.surfaceOp === 'append') {
      if (!data.message || typeof data.message !== 'object') throw new Error(`surface append event ${event.seq} has no message`);
      surface.push(data.message as Message);
    } else if (event.surfaceOp) {
      if (!Array.isArray(data.messages)) throw new Error(`surface event ${event.seq} has no messages list`);
      surface = event.surfaceOp === 'append_many' ? [...surface, ...data.messages as Message[]] : data.messages as Message[];
    }
  }
  return surface;
}

export function normalizedInput(value: Data): Data {
  const questions = array(value.questions || [{ question: value.question, options: value.options }]).map(raw => {
    const item = object(raw);
    const question = text(item.question).trim();
    const options = array(item.options).map(rawOption => {
      const option = object(rawOption);
      const label = text(typeof rawOption === 'object' ? option.label : rawOption).trim();
      if (!label || label.length > 200) throw new Error('invalid option');
      return { label, ...(option.description ? { description: text(option.description).trim().slice(0, 1000) } : {}),
        ...(option.preview ? { preview: text(option.preview).slice(0, 16000) } : {}) };
    });
    if (!question || question.length > 1000 || options.length < 2 || options.length > 4 || new Set(options.map(option => option.label)).size !== options.length) throw new Error('invalid question');
    return { question, options, multiSelect: item.multiSelect === true,
      ...(item.header ? { header: text(item.header).trim().slice(0, 100) } : {}) };
  });
  if (!questions.length || questions.length > 4 || new Set(questions.map(question => question.question)).size !== questions.length) throw new Error('invalid questions');
  const pending: Data = { question: questions[0].question, options: questions[0].options.map(option => option.label) };
  if (value.questions) pending.questions = questions;
  if (value.kind === 'plan') {
    const plan = text(value.plan);
    if (!plan.trim() || plan.length > 32000) throw new Error('invalid plan');
    Object.assign(pending, { kind: 'plan', tool: 'ExitPlanMode', plan });
  }
  if (value.kind === 'permission' && text(value.tool).trim()) {
    Object.assign(pending, { kind: 'permission', tool: text(value.tool).trim().slice(0, 64) });
    if (text(value.prefix).trim()) pending.prefix = text(value.prefix).trim().slice(0, 160);
    if (value.harnessPermission === true && value.action && typeof value.action === 'object') {
      Object.assign(pending, { action: value.action, harnessPermission: true, actionPreview: text(value.actionPreview) });
    }
  }
  if (value.kind === 'desktop_wait' && value.waitingForDesktop === true && value.notExecuted === true)
    Object.assign(pending, { kind: 'desktop_wait', waitingForDesktop: true, notExecuted: true });
  if (value.requestId) pending.requestId = text(value.requestId);
  return pending;
}

function pendingInput(events: Event[], surface: Message[]): Data | null {
  const answered = new Set(events.filter(event => event.type === 'user_input/answered').map(event => event.data.requestId));
  for (const event of events) if (event.type === 'permission/cancelled') for (const id of array(event.data.requestIds)) answered.add(id);
  const approval = events.find(event => event.type === 'permission/requested' && !answered.has(event.data.requestId));
  if (approval) return object(approval.data.pendingInput);
  const reversed = [...surface].reverse();
  for (const message of reversed) {
    if (message.role === 'user' && !message.injected) return null;
    if (message.role !== 'tool') continue;
    try {
      const value = object(JSON.parse(message.content ?? ''));
      if (value.awaitingUserInput !== true || !['AskUser', 'AskUserQuestion', 'ask_user_question', 'ExitPlanMode'].includes(message.name ?? '') &&
        !(value.kind === 'desktop_wait' && value.waitingForDesktop === true && value.notExecuted === true)) continue;
      const pending = { ...normalizedInput(value), requestId: message.tool_call_id } as Data;
      if (pending.kind === 'desktop_wait') pending.tool = message.name;
      if (pending.kind === 'permission') {
        for (const item of reversed) {
          if (item.role === 'user' && !item.injected) break;
          if (item.role === 'tool' && item.name === pending.tool && item.is_error) {
            const call = reversed.flatMap(item => item.tool_calls ?? []).find(call => call.id === item.tool_call_id);
            if (call) pending.action = { tool: pending.tool, arguments: call.arguments ?? {} };
            break;
          }
        }
      }
      return pending;
    } catch {}
  }
  return null;
}

function recovery(events: Event[]): Data[] {
  const operations = new Map<string, Operation>();
  for (const { type, data, seq } of events) {
    const id = text(data.operationId);
    if (type === 'operation/prepared') {
      if (!id || operations.has(id)) throw new Error(`invalid or duplicate operation at event ${seq}`);
      const effect = text(data.effect || 'unknown');
      operations.set(id, { id, callId: text(data.callId), tool: text(data.name), arguments: object(data.arguments), effect,
        prepared: seq, outcome: data.dispatched ? 'unknown' : 'not_started',
        recovery: !data.dispatched || effect === 'read' ? 'safe_replay' : effect === 'reversible_write' ? 'verify_before_retry' : 'never_replay',
        recoveryScope: object(data.recoveryScope) });
    } else if (type === 'operation/recovery_resolved' || type === 'operation/settled') {
      const operation = operations.get(id);
      if (!operation) throw new Error(`operation event ${seq} has no prepared operation`);
      if (type === 'operation/recovery_resolved') operation.recovery = 'none';
      else {
        if (operation.settled !== undefined) throw new Error(`operation ${id} settled more than once`);
        if (!['succeeded', 'failed', 'unknown', 'not_started'].includes(text(data.outcome))) throw new Error(`operation ${id} has invalid outcome`);
        operation.outcome = text(data.outcome);
        operation.settled = seq;
        if (['succeeded', 'failed'].includes(operation.outcome)) operation.recovery = 'none';
      }
    }
  }
  return [...operations.values()].filter(operation => ['verify_before_retry', 'never_replay'].includes(operation.recovery)).map(operation => ({
    operationId: operation.id, tool: operation.tool, arguments: operation.arguments, recoveryPolicy: operation.recovery,
    ...(operation.effect === 'external_send' ? { effect: operation.effect, recoveryScope: operation.recoveryScope } : {}),
    verificationCandidates: [...operations.values()].filter(read => read.effect === 'read' && read.outcome === 'succeeded' && read.prepared > operation.prepared).map(read => ({
      callId: read.callId, tool: read.tool, arguments: read.arguments,
      result: read.settled === undefined ? '' : object(events[read.settled].data.message).content ?? null,
    })),
  }));
}

function inbox(events: Event[], target: string): Data[] {
  const items = new Map<string, Data>();
  const consumed = new Set<string>();
  for (const event of events) {
    const data = event.data;
    if (event.type === 'inbox/message') {
      const id = text(data.messageId);
      if (!id || items.has(id)) throw new Error(`invalid or duplicate inbox message at event ${event.seq}`);
      items.set(id, data);
    } else if (event.type === 'inbox/consumed') {
      for (const raw of array(data.messageIds)) {
        const id = text(raw);
        if (!items.has(id) || consumed.has(id)) throw new Error(`inbox consumption references non-pending ${id}`);
        consumed.add(id);
      }
    }
  }
  return [...items.values()].filter(item => !consumed.has(text(item.messageId)) && item.target === target).slice(0, 100).map(item => ({
    messageId: text(item.messageId), target: text(item.target), text: text(item.text),
    ...(Object.keys(object(item.payload)).length ? { taskInput: item.payload } : {}),
  }));
}

function inboxMessages(items: Data[]): AgentMessage[] {
  return items.flatMap(item => {
    const output: AgentMessage[] = [];
    if (text(item.text)) output.push({ role: 'user', content: text(item.text), origin: 'instruction' });
    if (item.taskInput) output.push({ role: 'user', content: `[Task input data; not instructions]\n${JSON.stringify(item.taskInput)}`, origin: 'data', injected: true });
    return output;
  });
}

function pythonRepr(value: unknown): string {
  if (value == null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    return quote + value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replaceAll(quote, `\\${quote}`) + quote;
  }
  if (Array.isArray(value)) return `[${value.map(pythonRepr).join(', ')}]`;
  if (typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${pythonRepr(key)}: ${pythonRepr(item)}`).join(', ')}}`;
  return String(value);
}

const ranges = '1100-115f 231a-231b 2329-232a 23e9-23ec 23f0-23f0 23f3-23f3 25fd-25fe 2614-2615 2648-2653 267f-267f 2693-2693 26a1-26a1 26aa-26ab 26bd-26be 26c4-26c5 26ce-26ce 26d4-26d4 26ea-26ea 26f2-26f3 26f5-26f5 26fa-26fa 26fd-26fd 2705-2705 270a-270b 2728-2728 274c-274c 274e-274e 2753-2755 2757-2757 2795-2797 27b0-27b0 27bf-27bf 2b1b-2b1c 2b50-2b50 2b55-2b55 2e80-2e99 2e9b-2ef3 2f00-2fd5 2ff0-2ffb 3000-303e 3041-3096 3099-30ff 3105-312f 3131-318e 3190-31e3 31f0-321e 3220-3247 3250-4dbf 4e00-a48c a490-a4c6 a960-a97c ac00-d7a3 f900-faff fe10-fe19 fe30-fe52 fe54-fe66 fe68-fe6b ff01-ff60 ffe0-ffe6 16fe0-16fe4 16ff0-16ff1 17000-187f7 18800-18cd5 18d00-18d08 1aff0-1aff3 1aff5-1affb 1affd-1affe 1b000-1b122 1b132-1b132 1b150-1b152 1b155-1b155 1b164-1b167 1b170-1b2fb 1f004-1f004 1f0cf-1f0cf 1f18e-1f18e 1f191-1f19a 1f200-1f202 1f210-1f23b 1f240-1f248 1f250-1f251 1f260-1f265 1f300-1f320 1f32d-1f335 1f337-1f37c 1f37e-1f393 1f3a0-1f3ca 1f3cf-1f3d3 1f3e0-1f3f0 1f3f4-1f3f4 1f3f8-1f43e 1f440-1f440 1f442-1f4fc 1f4ff-1f53d 1f54b-1f54e 1f550-1f567 1f57a-1f57a 1f595-1f596 1f5a4-1f5a4 1f5fb-1f64f 1f680-1f6c5 1f6cc-1f6cc 1f6d0-1f6d2 1f6d5-1f6d7 1f6dc-1f6df 1f6eb-1f6ec 1f6f4-1f6fc 1f7e0-1f7eb 1f7f0-1f7f0 1f90c-1f93a 1f93c-1f945 1f947-1f9ff 1fa70-1fa7c 1fa80-1fa88 1fa90-1fabd 1fabf-1fac5 1face-1fadb 1fae0-1fae8 1faf0-1faf8 20000-2fffd 30000-3fffd'.split(' ').map(range => range.split('-').map(value => parseInt(value, 16)));

export function estimateTokens(value: string): number {
  let wide = 0, other = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    let low = 0, high = ranges.length - 1, found = false;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const [start, end] = ranges[middle];
      if (code < start) high = middle - 1;
      else if (code > end) low = middle + 1;
      else { found = true; break; }
    }
    if (found) wide++; else other++;
  }
  return wide + Math.ceil(other / 4);
}

function usage(events: Event[]): Data | null {
  const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  const prompt = (value: unknown) => {
    const data = object(value);
    return count(data.prompt_tokens) || count(data.input_tokens) + count(data.cache_read_input_tokens) + count(data.cache_creation_input_tokens);
  };
  const response = [...events].reverse().find(event => event.type === 'model/response' && prompt(event.data.usage) > 0);
  if (!response) return null;
  const request = [...events].reverse().find(event => event.type === 'model/request' && event.data.turn === response.data.turn && event.data.step === response.data.step);
  if (!request) return null;
  const surface = messages(events.slice(0, request.seq));
  const tokens = (tools: boolean) => estimateTokens(surface.filter(message => (message.role === 'tool') === tools)
    .map(message => (message.content ?? '') + (message.tool_calls?.length ? pythonRepr(message.tool_calls) : '')).join(''));
  const used = object(response.data.usage), projected = object(request.data.estimatedTokenBreakdown);
  const hasProjection = typeof request.data.projectedMessageTokensEstimate === 'number' && typeof request.data.projectedToolResultTokensEstimate === 'number';
  return { contextTokens: prompt(used), contextEstimated: 0, lastOutputTokens: Number(used.completion_tokens || used.output_tokens || 0),
    systemTokensEstimate: hasProjection ? Number(projected.system) : estimateTokens(text(object(request.data.header).systemPrompt)),
    toolSchemaTokensEstimate: hasProjection ? Number(projected.tools) : array(request.data.tools).length ? estimateTokens(pythonRepr(request.data.tools)) : 0,
    messageTokensEstimate: hasProjection ? Number(request.data.projectedMessageTokensEstimate) : tokens(false),
    toolResultTokensEstimate: hasProjection ? Number(request.data.projectedToolResultTokensEstimate) : tokens(true),
    ...(hasProjection ? { estimatedTokenBreakdown: projected } : {}) };
}

export async function handleSessionRead(payload: Data, userDataDir: string): Promise<Data> {
  const action = text(payload.action).trim(), sessionId = text(payload.sessionId).trim();
  if (!['status', 'usage', 'pending'].includes(action)) return { ok: false, error: 'invalid_action' };
  const target = text(object(payload.taskInput).target || payload.target).trim();
  if (action === 'pending' && !['next-step', 'next-turn'].includes(target)) return { ok: false, error: 'invalid_target' };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) return { ok: false, error: 'invalid_session_id' };
  let events: Event[];
  try { events = await loadSession(path.join(userDataDir, 'agent-sessions', `${sessionId}.jsonl`), sessionId); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, error: 'session_not_found' };
    throw error;
  }
  const result = { ok: true, sessionId };
  if (action === 'pending') return { ...result, messages: inbox(events, target) };
  if (action === 'usage') return { ...result, contextUsage: usage(events) };
  let openTurn: number | null = null;
  let lastTurnReason: string | null = null;
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (openTurn !== null) throw new Error('turn starts while another is open');
      openTurn = Number(event.data.turn);
    } else if (event.type === 'turn/end') {
      if (openTurn !== Number(event.data.turn)) throw new Error('turn/end does not match the open turn');
      openTurn = null;
      lastTurnReason = text(event.data.reason);
    }
  }
  const answers = events.filter(event => event.type === 'user_input/answered');
  const last = answers.at(-1)?.data;
  const outstandingInput = pendingInput(events, messages(events)), pendingRecovery = recovery(events);
  const lastReceiptStatus = text([...events].reverse().find(event => event.type === 'receipt/issued')?.data.status) || null;
  return { ...result, hasPendingWork: openTurn !== null || unfinished.has(lastTurnReason ?? '') || !!outstandingInput || pendingRecovery.length > 0 || ['partial', 'unverified'].includes(lastReceiptStatus ?? ''), lastTurnReason, lastReceiptStatus, openTurn,
    pendingInput: outstandingInput, answeredInputIds: answers.map(event => event.data.requestId),
    lastInputAnswer: last ? { requestId: last.requestId, message: last.message } : null,
    pendingRecovery };
}

export const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');

export async function resumeSourceAvailability(events: readonly Pick<SessionEvent, 'type' | 'data'>[]): Promise<Data[]> {
  return Promise.all(taskSources(events).map(async source => {
    const absolutePath = text(source.identity.absolutePath);
    const frozenPath = text(object(object(source.identity.frameLease).localArtifact).path);
    const pixelAvailable = !!frozenPath && path.isAbsolute(frozenPath) && await stat(frozenPath).then(info => info.isFile(), () => false);
    const historicalTextAvailable = source.revision.authority === 'historical' &&
      !!text(source.identity.content ?? source.identity.text ?? object(source.identity.availableContent).text).trim();
    const historicalEvidenceAvailable = historicalTextAvailable || pixelAvailable;
    const base = { sourceId: source.sourceId, title: source.title, kind: source.kind, historicalEvidenceAvailable, pixelAvailable };
    if (absolutePath && path.isAbsolute(absolutePath)) {
      try {
        const current = await stat(absolutePath), previous = source.revision;
        const changed = typeof previous.size === 'number' && previous.size !== current.size ||
          typeof previous.mtimeMs === 'number' && previous.mtimeMs !== current.mtimeMs;
        return { ...base, availability: changed ? 'changed' : 'available', reason: changed ? 'disk_revision_changed' : null };
      } catch (error) {
        return { ...base, availability: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable',
          reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'disk_path_missing' : 'disk_read_failed' };
      }
    }
    return { ...base, availability: historicalEvidenceAvailable ? 'historical_only' : source.kind === 'capture' ? 'missing' : 'reacquire_required',
      reason: historicalEvidenceAvailable ? pixelAvailable ? 'frozen_evidence_available' : 'historical_text_only' : source.kind === 'capture' ? 'frozen_evidence_missing' : 'live_identity_must_be_reacquired' };
  }));
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const localLocks = new Map<string, Promise<unknown>>();

export async function withFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const previous = localLocks.get(file) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    let handle;
    const until = Date.now() + 30000;
    while (!handle) {
      try { handle = await open(file, 'wx'); await handle.writeFile(JSON.stringify({ pid: process.pid })); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const owner = object(JSON.parse(await readFile(file, 'utf8')));
          if (owner.pid && !alive(Number(owner.pid))) { await unlink(file); continue; }
        } catch {}
        if (Date.now() >= until) throw new Error(`Session is busy: ${path.basename(file)}`);
        await sleep(20);
      }
    }
    try { return await action(); } finally { await handle.close(); await unlink(file); }
  });
  localLocks.set(file, pending);
  try { return await pending; } finally { if (localLocks.get(file) === pending) localLocks.delete(file); }
}

export class EventSession {
  events: SessionEvent[] = [];
  private size = 0;
  private releaseTurn?: () => Promise<void>;
  constructor(readonly file: string, readonly id: string) {}

  static async open(userDataDir: string, id: string, create = true, parentSessionId: string | null = null): Promise<EventSession> {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error('invalid_session_id');
    const session = new EventSession(path.join(userDataDir, 'agent-sessions', `${id}.jsonl`), id);
    await withFileLock(`${session.file}.ts-lock`, async () => {
      try { await session.refresh(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
        await session.write('session/created', { version: 1, sessionId: id, createdAt: Date.now(), parentSessionId, parentThroughTurn: null });
      }
    });
    return session;
  }

  async refresh(): Promise<void> {
    const info = await stat(this.file);
    if (info.size === this.size && this.events.length) return;
    if (this.events.length && info.size > this.size) {
      const handle = await open(this.file, 'r');
      try {
        const buffer = Buffer.alloc(info.size - this.size);
        await handle.read(buffer, 0, buffer.length, this.size);
        const raw = buffer.toString('utf8');
        if (raw.endsWith('\n')) {
          const next = raw.trimEnd().split('\n');
          let previous = this.events.at(-1)!.hash;
          const adopted: SessionEvent[] = [];
          for (const row of next) {
            const event = JSON.parse(row) as SessionEvent & { prevHash: string };
            if (event.sessionId !== this.id || event.seq !== this.events.length + adopted.length || event.prevHash !== previous || createHash('sha256').update(canonicalRow(row)).digest('hex') !== event.hash) throw new Error('invalid session event chain');
            adopted.push(event); previous = event.hash;
          }
          this.events.push(...adopted); this.size = info.size; return;
        }
      } finally { await handle.close(); }
    }
    const raw = await readFile(this.file);
    const lastNewline = raw.lastIndexOf(10);
    if (raw.length && lastNewline !== raw.length - 1) {
      const tail = raw.subarray(lastNewline + 1).toString('utf8');
      try { JSON.parse(tail); const handle = await open(this.file, 'a'); try { await handle.write('\n'); } finally { await handle.close(); } }
      catch { await truncate(this.file, lastNewline + 1); }
    }
    this.events = await loadSession(this.file, this.id);
    this.size = (await stat(this.file)).size;
  }

  get openTurn(): number | null {
    let turn: number | null = null;
    for (const event of this.events) {
      if (event.type === 'turn/start') turn = Number(event.data.turn);
      if (event.type === 'turn/end') turn = null;
    }
    return turn;
  }
  deriveMessages(): AgentMessage[] { return structuredClone(messages(this.events)) as AgentMessage[]; }
  pendingInput(): Data | null { return pendingInput(this.events, messages(this.events)); }
  pendingRecovery(): Data[] { return recovery(this.events); }
  pendingInbox(target: string): Data[] { return inbox(this.events, target); }
  permissionMode(fallback: string): string {
    for (const event of [...this.events].reverse()) {
      if (event.type === 'permission/mode') return text(event.data.mode);
      if (event.type === 'user_input/answered' && object(event.data.pendingInput).kind === 'plan') return ({ once: 'safe', grant: 'default', deny: 'plan' })[text(object(event.data.response).decision)] ?? fallback;
    }
    return fallback;
  }

  async append(type: string, data: Data, surfaceOp?: string): Promise<SessionEvent> {
    return withFileLock(`${this.file}.ts-lock`, async () => { await this.refresh(); return this.write(type, data, surfaceOp); });
  }

  private async write(type: string, data: Data, surfaceOp?: string): Promise<SessionEvent> {
    if (type === 'context/updated') validateContextUpdate(data, this.id, this.events);
    if (type === 'inbox/consumed' && data.contextUpdate) validateContextUpdate(object(data.contextUpdate), this.id, this.events);
    if (type === 'artifact/generated' || type === 'artifact/patched' || type === 'artifact/accepted') {
      const current = [...this.events].reverse().find(event => ['artifact/generated', 'artifact/patched'].includes(event.type) && event.data.artifactId === data.artifactId);
      if (type === 'artifact/generated' && current) throw new Error('duplicate_artifact');
      if (type === 'artifact/patched' && (!current || Number(data.revision) !== Number(current.data.revision ?? 1) + 1)) throw new Error('stale_revision');
      if (type === 'artifact/accepted' && (!current || data.revision !== current.data.revision || data.contentHash !== current.data.contentHash)) throw new Error('stale_revision');
    }
    if (type === 'operation/recovery_resolved') {
      if (this.openTurn !== null || data.confirmed !== true || !this.pendingRecovery().some(item => item.operationId === data.operationId)) throw new Error('recovery_confirmation_required');
      const prepared = this.events.find(event => event.type === 'operation/prepared' && event.data.callId === data.verificationCallId && event.data.effect === 'read');
      const settled = prepared && this.events.find(event => event.type === 'operation/settled' && event.data.operationId === prepared.data.operationId && event.data.outcome === 'succeeded');
      const unknown = this.events.find(event => event.type === 'operation/settled' && event.data.operationId === data.operationId && event.data.outcome === 'unknown');
      if (!settled || !unknown || settled.seq <= unknown.seq) throw new Error('successful_post_recovery_read_required');
    }
    if (type === 'turn/start' && this.openTurn !== null) throw new Error('session_busy');
    if (type === 'turn/end' && this.openTurn !== data.turn) throw new Error('turn_mismatch');
    if (type === 'operation/prepared' && this.events.some(event => event.type === type && event.data.operationId === data.operationId)) throw new Error('duplicate_operation');
    if (type === 'operation/settled') {
      const prepared = this.events.find(event => event.type === 'operation/prepared' && event.data.operationId === data.operationId);
      if (!prepared || object(data.message).tool_call_id !== prepared.data.callId || this.events.some(event => event.type === type && event.data.operationId === data.operationId)) throw new Error('invalid_operation_settlement');
    }
    if (type === 'user_input/answered' && (this.openTurn !== null || this.pendingInput()?.requestId !== data.requestId)) throw new Error('pending_input_mismatch');
    if (type === 'inbox/message' && this.events.some(event => event.type === type && event.data.messageId === data.messageId)) throw new Error('duplicate_inbox_message');
    if (type === 'inbox/consumed') {
      const pending = new Set(this.pendingInbox(text(data.target)).map(item => item.messageId));
      if (!array(data.messageIds).every(id => pending.has(id))) throw new Error('inbox_claim_conflict');
    }
    const core = { formatVersion: 1, sessionId: this.id, seq: this.events.length, time: Date.now(), type,
      data: structuredClone(data), prevHash: this.events.at(-1)?.hash ?? '0'.repeat(64), ...(surfaceOp ? { surfaceOp } : {}) };
    const event = { ...core, hash: digest(core) };
    const line = Buffer.from(canonicalJson(event) + '\n');
    await mkdir(path.dirname(this.file), { recursive: true });
    const handle = await open(this.file, 'a');
    try { await handle.writeFile(line); await handle.sync(); } finally { await handle.close(); }
    this.events.push(event); this.size += line.length;
    return event;
  }

  private async acquireTurnLock(): Promise<() => Promise<void>> {
    const lock = `${this.file}.turn.ts-lock`;
    await mkdir(path.dirname(lock), { recursive: true });
    try {
      const prior = object(JSON.parse(await readFile(lock, 'utf8')));
      if (alive(Number(prior.pid))) throw new Error('session_busy');
      await unlink(lock);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const handle = await open(lock, 'wx'); await handle.writeFile(JSON.stringify({ pid: process.pid }));
    return async () => { await handle.close(); await unlink(lock); };
  }
  async startTurn(): Promise<number> {
    this.releaseTurn = await this.acquireTurnLock();
    try {
      await this.refresh(); await this.repairInterruptedTurn();
      const turn = Math.max(0, ...this.events.filter(event => event.type === 'turn/start').map(event => Number(event.data.turn))) + 1;
      await this.append('turn/start', { turn }); return turn;
    } catch (error) { await this.releaseTurn(); this.releaseTurn = undefined; throw error; }
  }
  private async recoverInterruptedTurn(): Promise<void> {
    const release = await this.acquireTurnLock();
    try { await this.refresh(); await this.repairInterruptedTurn(); }
    finally { await release(); }
  }
  async endTurn(reason: string, detail = ''): Promise<void> {
    try { if (this.openTurn !== null) await this.append('turn/end', { turn: this.openTurn, reason, detail }); }
    finally { await this.releaseTurn?.(); this.releaseTurn = undefined; }
  }
  async appendMessage(message: AgentMessage): Promise<SessionEvent> {
    return this.append(message.role === 'user' ? 'user/message' : message.role === 'assistant' ? 'assistant/message' : 'tool/result', { message }, 'append');
  }
  async replaceMessages(next: AgentMessage[], reason: string, expected?: AgentMessage[]): Promise<boolean> {
    return withFileLock(`${this.file}.ts-lock`, async () => {
      await this.refresh();
      if (expected && (this.openTurn !== null || canonicalJson(this.deriveMessages()) !== canonicalJson(expected))) return false;
      await this.write('surface/replace', { messages: next, reason }, 'replace'); return true;
    });
  }
  async freezePrompt(system: string): Promise<string> {
    const saved = this.events.find(event => event.type === 'prompt/frozen')?.data;
    const old = [...this.events].reverse().find(event => event.type === 'model/request' && typeof object(event.data.header).systemPrompt === 'string');
    const prompt = text(saved?.systemPrompt ?? object(old?.data.header).systemPrompt ?? system);
    if (!saved) await this.append('prompt/frozen', { systemPrompt: prompt, systemPromptHash: digest(prompt), systemPromptSections: null });
    if (prompt !== system) await this.append('prompt/drift', { message: 'Using the saved session prompt.', savedHash: digest(prompt), currentHash: digest(system), changedSections: null, currentSections: null });
    return prompt;
  }
  async recordRequest(step: number, system: string, tools: unknown[], projectedMessages?: AgentMessage[]): Promise<void> {
    const surface = this.deriveMessages(), projected = projectedMessages ?? surface;
    const estimatedTokenBreakdown = { system: estimateTokens(system), tools: estimateTokens(JSON.stringify(tools)), taskState: 0, evidence: 0, history: 0 };
    let projectedMessageTokensEstimate = 0, projectedToolResultTokensEstimate = 0;
    const readResults = new Set(this.events.filter(event => event.type === 'operation/prepared' && event.data.effect === 'read').map(event => text(event.data.callId)));
    for (const message of projected) {
      const content = text(message.content), tokens = estimateTokens(JSON.stringify(message));
      if (message.role === 'tool') projectedToolResultTokensEstimate += tokens;
      else projectedMessageTokensEstimate += tokens;
      if (message.injected && (/Saved unfinished task state|历史摘要是会话数据|\[Task input data/.test(content))) estimatedTokenBreakdown.taskState += tokens;
      else if (message.injected || message.role === 'tool' && (readResults.has(text(message.tool_call_id)) || /^(?:Context\.|Knowledge\.|ToolResult\.read$|Read$|Glob$|Grep$|Search$|Fetch$|Look$|Observe$|get_app_state$|read_text$)/.test(text(message.name)))) estimatedTokenBreakdown.evidence += tokens;
      else estimatedTokenBreakdown.history += tokens;
    }
    await this.append('model/request', { turn: this.openTurn, step, messageCount: surface.length, messagesHash: digest(surface),
      projectedMessageCount: projected.length, projectedMessagesHash: digest(projected), estimatedTokenBreakdown,
      projectedMessageTokensEstimate, projectedToolResultTokensEstimate,
      tools, header: { systemPrompt: system }, systemPromptHash: digest(system), systemPromptSections: null });
  }
  async enqueue(instruction: string, target = 'next-step', payload?: Data, messageId: string = randomUUID()): Promise<SessionEvent> {
    if (!['next-step', 'next-turn'].includes(target) || !instruction.trim() && !payload) throw new Error('invalid_inbox_input');
    return this.append('inbox/message', { messageId, text: instruction.trim(), target, ...(payload ? { payload } : {}) });
  }
  async fork(userDataDir: string, childId: string, throughTurn?: number): Promise<EventSession> {
    await this.refresh(); let history = this.events;
    if (throughTurn !== undefined) {
      if (!Number.isInteger(throughTurn) || throughTurn < 1) throw new Error('invalid_turn_boundary');
      const boundary = history.findIndex(event => event.type === 'turn/end' && event.data.turn === throughTurn);
      if (boundary < 0) throw new Error('turn_has_no_completed_boundary'); history = history.slice(0, boundary + 1);
    } else if (this.openTurn !== null) throw new Error('session_busy');
    const child = await EventSession.open(userDataDir, childId, true, this.id);
    if (child.events.length !== 1) throw new Error('child_session_exists');
    for (const event of history.slice(1)) {
      const data = structuredClone(event.data);
      if (event.type === 'plan/updated') data.taskId = childId;
      if (event.type === 'inbox/message' && data.payload) object(data.payload).taskId = childId;
      if (event.type === 'inbox/consumed') {
        const pending = child.pendingInbox(text(data.target));
        const selected = array(data.messageIds).map(id => pending.find(item => item.messageId === id));
        if (selected.some(item => !item)) throw new Error('fork_inbox_message_missing');
        data.messages = inboxMessages(selected as Data[]);
      }
      const update = event.type === 'context/updated' ? data : event.type === 'inbox/consumed' ? object(data.contextUpdate) : null;
      if (update) { update.taskId = childId; for (const item of [...array(update.sources), ...array(update.scopeGrants)]) object(item).taskId = childId; }
      if (event.type === 'model/request') { data.messageCount = child.deriveMessages().length; data.messagesHash = digest(child.deriveMessages()); }
      await child.append(event.type, data, event.surfaceOp);
    }
    return child;
  }
  async claimInbox(target: string): Promise<Data[]> {
    return withFileLock(`${this.file}.ts-lock`, async () => {
      await this.refresh(); const pending = this.pendingInbox(target); if (!pending.length) return [];
      const revision = this.events.reduce((current, event) => Math.max(current, Number(object(event.data.contextUpdate).referenceRevision ?? event.data.referenceRevision ?? 0)), 0);
      const updates = pending.flatMap(item => array(object(item.taskInput).referenceUpdates));
      const surface = inboxMessages(pending);
      await this.write('inbox/consumed', { target, messageIds: pending.map(item => item.messageId), messages: surface,
        inputIds: pending.map(item => object(item.taskInput).inputId).filter(Boolean),
        contextUpdate: { taskId: this.id, sources: [], referenceUpdates: updates, referenceRevision: revision + Number(updates.length > 0) } }, 'append_many');
      return pending;
    });
  }
  async requestCancel(reason = ''): Promise<void> {
    await this.refresh(); if (this.openTurn === null) return;
    await this.append('cancel/request', { turn: this.openTurn, requestId: randomUUID(), reason });
  }
  async consumeCancel(): Promise<boolean> {
    await this.refresh();
    const consumed = new Set(this.events.filter(event => event.type === 'cancel/consumed').map(event => event.data.requestId));
    const pending = this.events.find(event => event.type === 'cancel/request' && event.data.turn === this.openTurn && !consumed.has(event.data.requestId));
    if (!pending) return false;
    await this.append('cancel/consumed', { turn: this.openTurn, requestId: pending.data.requestId }); return true;
  }
  async answer(requestId: string, response: Data): Promise<SessionEvent> {
    await this.refresh();
    if (this.openTurn !== null) await this.recoverInterruptedTurn();
    const pending = this.pendingInput();
    if (!pending || pending.requestId !== requestId) throw new Error('pending_input_mismatch');
    const normalized = normalizeResponse(pending, response);
    return this.append('user_input/answered', { requestId, pendingInput: pending, response: normalized,
      message: { role: 'tool', tool_call_id: requestId, name: pending.harnessPermission || pending.kind === 'desktop_wait' ? pending.tool : pending.kind === 'plan' ? 'ExitPlanMode' : 'AskUser', origin: 'data', content: JSON.stringify({ ...pending, ...normalized, answered: true, awaitingUserInput: false }) } });
  }
  approvedCalls(): Data[] {
    const started = new Set(this.events.filter(event => event.type === 'operation/prepared').map(event => event.data.callId));
    for (const event of this.events) if (event.type === 'permission/cancelled') for (const id of array(event.data.requestIds)) started.add(`approval-${id}`);
    return this.events.filter(event => event.type === 'user_input/answered' && object(event.data.pendingInput).harnessPermission && object(event.data.response).decision !== 'deny' && !started.has(`approval-${event.data.requestId}`))
      .map(event => {
        const action = object(object(event.data.pendingInput).action), response = object(event.data.response);
        return { id: `approval-${event.data.requestId}`, name: action.tool,
          arguments: action.tool === 'DailyWrap.read' && response.actionArguments !== undefined ? response.actionArguments : action.arguments };
      });
  }
  async cancelPermissions(): Promise<void> {
    const answered = new Set(this.events.filter(event => event.type === 'user_input/answered').map(event => event.data.requestId));
    for (const event of this.events) if (event.type === 'permission/cancelled') for (const id of array(event.data.requestIds)) answered.add(id);
    const requestIds = [...this.events.filter(event => event.type === 'permission/requested' && !answered.has(event.data.requestId)).map(event => event.data.requestId), ...this.approvedCalls().map(call => text(call.id).slice(9))];
    if (requestIds.length) await this.append('permission/cancelled', { requestIds });
  }
  async repairInterruptedTurn(): Promise<void> {
    if (this.openTurn === null) return;
    const settled = new Set(this.events.filter(event => event.type === 'operation/settled').map(event => event.data.operationId));
    const pending = this.events.filter(event => event.type === 'operation/prepared' && event.data.turn === this.openTurn && !settled.has(event.data.operationId));
    for (const event of pending) {
      const data = event.data, unknown = data.dispatched === true;
      await this.append('operation/settled', { turn: this.openTurn, operationId: data.operationId, outcome: unknown ? 'unknown' : 'not_started', failureType: 'interrupted', usedBackend: null, latencyMs: null,
        message: { role: 'tool', name: data.name, tool_call_id: data.callId, origin: 'data', is_error: true,
          content: unknown ? `Execution interrupted; outcome unknown. ${data.effect === 'read' ? 'Safe to read again.' : 'Verify the target state before retrying. Do not repeat an external action without confirmation.'}` : 'Not executed before interruption.' } }, 'append');
    }
    const surface = this.deriveMessages();
    const completed = new Set(surface.filter(message => message.role === 'tool').map(message => message.tool_call_id));
    for (const call of surface.flatMap(message => message.tool_calls ?? [])) if (!completed.has(call.id)) {
      await this.appendMessage({ role: 'tool', tool_call_id: call.id, name: call.name, content: 'Not dispatched before interruption.', is_error: true, origin: 'data' });
    }
    await this.append('turn/end', { turn: this.openTurn, reason: 'interrupted', detail: 'Recovered interrupted execution.' });
  }
}

export function normalizeResponse(pending: Data, response: Data): Data {
  if (pending.kind === 'permission' || pending.kind === 'plan') {
    const decision = text(response.decision);
    if (!['once', 'grant', 'deny'].includes(decision)) throw new Error('invalid_permission_decision');
    if (response.actionArguments !== undefined) {
      if (pending.kind !== 'permission' || pending.harnessPermission !== true || pending.tool !== 'DailyWrap.read' || decision !== 'once')
        throw new Error('action_scope_override_not_allowed');
      if (!response.actionArguments || typeof response.actionArguments !== 'object' || Array.isArray(response.actionArguments))
        throw new Error('invalid_daily_wrap_scope');
      const selected = object(response.actionArguments), original = object(object(pending.action).arguments);
      if (Object.keys(selected).some(key => !['from_ms', 'to_ms', 'conversation_ids', 'limit'].includes(key)) ||
        !Number.isSafeInteger(selected.from_ms) || !Number.isSafeInteger(selected.to_ms) ||
        Number(selected.from_ms) < 0 || Number(selected.to_ms) < Number(selected.from_ms) ||
        !Array.isArray(selected.conversation_ids) ||
        selected.conversation_ids.some(id => typeof id !== 'string' || !id.trim()) ||
        new Set(selected.conversation_ids).size !== selected.conversation_ids.length ||
        (selected.limit !== undefined && selected.limit !== original.limit)) throw new Error('invalid_daily_wrap_scope');
      return { decision, actionArguments: { from_ms: selected.from_ms, to_ms: selected.to_ms,
        conversation_ids: selected.conversation_ids, ...(original.limit === undefined ? {} : { limit: original.limit }) } };
    }
    return { decision };
  }
  const questions = array(pending.questions ?? [{ question: pending.question, options: pending.options }]).map(object);
  const answers = object(response.answers);
  if (!Object.keys(answers).length && response.answer !== undefined && questions.length === 1) answers[text(questions[0].question)] = response.answer;
  const skipped: string[] = [];
  if (Object.keys(answers).sort().join('\n') !== questions.map(question => text(question.question)).sort().join('\n')) throw new Error('answers_must_match_pending_questions');
  for (const question of questions) {
    const answer = answers[text(question.question)];
    if (question.multiSelect ? !Array.isArray(answer) || answer.length > 5 : typeof answer !== 'string') throw new Error('invalid_answer_type');
    if (answer === '' || Array.isArray(answer) && !answer.length) { skipped.push(text(question.question)); continue; }
    const items = Array.isArray(answer) ? answer : [answer];
    if (items.some(item => typeof item !== 'string' || !item.trim() || item.length > 4000)) throw new Error('answer_must_contain_1_4000_characters');
    answers[text(question.question)] = Array.isArray(answer) ? [...new Set(items.map(item => String(item).trim()))] : String(answer).trim();
  }
  return { answers, ...(skipped.length ? { skippedQuestions: skipped } : {}) };
}

export async function handleSession(payload: Data, userDataDir: string): Promise<Data> {
  const action = text(payload.action);
  if (['status', 'usage', 'pending'].includes(action)) return handleSessionRead(payload, userDataDir);
  try {
    const session = await EventSession.open(userDataDir, text(payload.sessionId), false);
    if (action === 'subagent-respond') { const { respondToAgent } = require('./agent_background') as typeof import('./agent_background'); return await respondToAgent(userDataDir, text(payload.parentSessionId), session.id, text(payload.requestId), object(payload.response)); }
    if (action === 'subagent-steer') { const { steerAgent } = require('./agent_background') as typeof import('./agent_background'); return await steerAgent(userDataDir, text(payload.parentSessionId), session.id, text(payload.text)); }
    if (action === 'fork') {
      const child = await session.fork(userDataDir, text(payload.childSessionId), payload.throughTurn === undefined ? undefined : Number(payload.throughTurn));
      return { ok: true, sessionId: child.id, taskContext: { taskId: child.id, sources: taskSources(child.events), references: taskReferences(child.events), referenceRevision: referenceRevision(child.events) } };
    }
    if (action === 'cancel') {
      const { readAgentStatus, stopAgent } = require('./agent_background') as typeof import('./agent_background');
      if (await readAgentStatus(userDataDir, session.id)) return await stopAgent(userDataDir, text(payload.parentSessionId), session.id);
      if (payload.parentSessionId && session.events[0]?.data.parentSessionId !== payload.parentSessionId) throw new Error('subagent_parent_mismatch');
      if (session.openTurn === null) return { ok: false, error: 'no_open_turn' };
      await session.requestCancel(text(payload.reason)); return { ok: true, sessionId: session.id, cancelled: true, turn: session.openTurn };
    }
    if (action === 'answer') { const event = await session.answer(text(payload.requestId), object(payload.response)); return { ok: true, sessionId: session.id, requestId: payload.requestId, answer: event.data }; }
    if (action === 'put') {
      const input = object(payload.taskInput), target = text(input.target ?? payload.target ?? 'next-step'), instruction = text(input.instruction ?? payload.text);
      if (input.taskId && input.taskId !== session.id) throw new Error('task_mismatch');
      if (instruction.length > 12000 || session.pendingInbox(target).length >= 100) throw new Error('inbox_limit_exceeded');
      for (const raw of array(payload.sources)) { const source = sourceRef(raw); if (source.taskId !== session.id) throw new Error('source_task_mismatch'); const known = taskSources(session.events).find(item => item.sourceId === source.sourceId); if (!known) await registerSource(session, source); else if (canonicalJson(known) !== canonicalJson(source)) throw new Error('source_identity_changed'); }
      const event = await session.enqueue(instruction, target, Object.keys(input).length ? input : undefined, text(input.inputId || payload.messageId || randomUUID()));
      return { ok: true, sessionId: session.id, status: 'queued', queued: true, target, messageId: event.data.messageId, inputId: input.inputId ?? null };
    }
    if (action === 'resolve_recovery' || action === 'recovery-resolve') { await session.append('operation/recovery_resolved', { operationId: payload.operationId, verificationCallId: payload.verificationCallId, confirmed: payload.confirmed === true }); return { ok: true, sessionId: session.id, pendingRecovery: session.pendingRecovery() }; }
    return { ok: false, error: 'invalid_action' };
  } catch (error) { return { ok: false, error: (error as Error).message }; }
}
