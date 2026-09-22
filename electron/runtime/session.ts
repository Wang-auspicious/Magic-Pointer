import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

type Data = Record<string, unknown>;
type Message = {
  role: string; content: string | null; tool_call_id: string | null; name: string | null;
  injected?: boolean; is_error?: boolean; tool_calls?: { id: string; arguments?: Data }[];
};
type Event = { seq: number; type: string; data: Data; surfaceOp?: string };
type Operation = { id: string; callId: string; tool: string; arguments: Data; effect: string;
  prepared: number; settled?: number; outcome: string; recovery: string };

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

function normalizedInput(value: Data): Data {
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
    if (message.role !== 'tool' || !['AskUser', 'AskUserQuestion', 'ask_user_question', 'ExitPlanMode'].includes(message.name ?? '')) continue;
    try {
      const value = object(JSON.parse(message.content ?? ''));
      if (value.awaitingUserInput !== true) continue;
      const pending = { ...normalizedInput(value), requestId: message.tool_call_id } as Data;
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
        recovery: !data.dispatched || effect === 'read' ? 'safe_replay' : effect === 'reversible_write' ? 'verify_before_retry' : 'never_replay' });
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

function estimate(value: string): number {
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
  const tokens = (tools: boolean) => estimate(surface.filter(message => (message.role === 'tool') === tools)
    .map(message => (message.content ?? '') + (message.tool_calls?.length ? pythonRepr(message.tool_calls) : '')).join(''));
  const used = object(response.data.usage);
  return { contextTokens: prompt(used), contextEstimated: 0, lastOutputTokens: Number(used.completion_tokens || used.output_tokens || 0),
    systemTokensEstimate: estimate(text(object(request.data.header).systemPrompt)),
    toolSchemaTokensEstimate: array(request.data.tools).length ? estimate(pythonRepr(request.data.tools)) : 0,
    messageTokensEstimate: tokens(false), toolResultTokensEstimate: tokens(true) };
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
  return { ...result, hasPendingWork: unfinished.has(lastTurnReason ?? ''), lastTurnReason, openTurn,
    pendingInput: pendingInput(events, messages(events)), answeredInputIds: answers.map(event => event.data.requestId),
    lastInputAnswer: last ? { requestId: last.requestId, message: last.message } : null,
    pendingRecovery: recovery(events) };
}
