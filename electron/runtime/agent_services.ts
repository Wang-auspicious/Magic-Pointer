import { readFile, writeFile, mkdir, readdir, stat, access } from 'node:fs/promises';
import path from 'node:path';
import { extensionPaths } from './agent_plugins';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ActionFailure, ToolRegistry } from './tools';
import { asObject, type Data, type ModelRunner, type ModelRequest, type AgentMessage } from './agent';
import { ScreenMemory } from './context_memory';
import { EventSession, exactApprovedToolCall } from './session';

const str = (value: unknown) => String(value ?? '');
const exists = async (file: string) => { try { await access(file); return true; } catch { return false; } };
const list = async (directory: string) => readdir(directory, { withFileTypes: true }).catch(() => []);
const schema = (properties: Data, required: string[] = []): Data => ({ type: 'object', properties, required });
const string = { type: 'string' }, integer = { type: 'integer' };
export function contextWindowFor(model: unknown, fallback = 64000): number {
  const windows: [string, number][] = [['gemini-2', 1000000], ['gemini-3', 1000000], ['gpt-4.1', 1000000], ['gpt-5.6', 1050000], ['gpt-5.5', 1050000], ['gpt-5.4-mini', 400000], ['gpt-5.4-nano', 400000], ['gpt-5.4', 1050000], ['gpt-5', 400000], ['gpt-4o', 128000], ['o3', 200000], ['o4', 200000], ['claude-opus-5', 1000000], ['claude-sonnet-5', 1000000], ['claude-fable-5', 1000000], ['claude-mythos-5', 1000000], ['claude-opus-4-8', 1000000], ['claude-opus-4-7', 1000000], ['claude-opus-4-6', 1000000], ['claude-sonnet-4-6', 1000000], ['claude-opus-4', 200000], ['claude-sonnet-4', 200000], ['claude-haiku-4', 200000], ['claude-3', 200000], ['kimi-k', 256000], ['deepseek', 128000], ['qwen3-coder', 256000], ['qwen3', 128000], ['qwen4', 256000], ['glm-5', 200000], ['glm-4.6', 200000], ['glm-4', 128000], ['mimo', 128000], ['grok-4', 256000], ['llama4', 128000], ['minimax', 200000]];
  const name = str(model).toLowerCase().split('/').at(-1)!;
  return windows.filter(([prefix]) => name.startsWith(prefix)).sort((a, b) => b[0].length - a[0].length)[0]?.[1] ?? fallback;
}
/** Pull inline screenshots out of a tool value so the model receives pixels, not base64 text. */
export async function extractToolImages(value: unknown, directory: string, callId: string): Promise<{ value: unknown; images: { path: string; mimeType: string; label?: string }[] }> {
  const data = asObject(value);
  if (typeof data.image !== 'string' || !data.image) return { value, images: [] };
  const mimeType = typeof data.mimeType === 'string' ? data.mimeType : 'image/png';
  const file = path.join(directory, `${callId.replace(/[^A-Za-z0-9_.-]/g, '_')}-0.${mimeType === 'image/jpeg' ? 'jpg' : 'png'}`);
  await mkdir(directory, { recursive: true });
  await writeFile(file, Buffer.from(data.image, 'base64'));
  const { image: _image, imageLabel, ...rest } = data;
  return { value: { ...rest, imageAttached: file }, images: [{ path: file, mimeType, ...(typeof imageLabel === 'string' ? { label: imageLabel } : {}) }] };
}
export function projectContextMessages(messages: AgentMessage[]): AgentMessage[] {
  const seen = new Map<string, string>();
  return messages.map(message => {
    if (message.role !== 'tool' || !message.tool_call_id) return message;
    let content = message.content ?? '';
    if (!message.is_error && message.name?.startsWith('Context.')) try {
      const data = JSON.parse(content), rows = Array.isArray(data.results) ? data.results : [data];
      for (const row of rows) {
        if (!['ok', 'degraded', 'empty_confirmed'].includes(row.evidenceStatus) || !Array.isArray(row.fragments) || !row.fragments.length) continue;
        delete row.latencyMs;
        const shared: Data = {};
        for (const key of ['sourceTitle', 'sourceRevision']) { const value = row.fragments[0].metadata?.[key]; if (value != null && row.fragments.every((fragment: Data) => asObject(fragment.metadata)[key] === value)) shared[key] = value; }
        if (Object.keys(shared).length) row.sharedFragmentMetadata = shared;
        for (const fragment of row.fragments) {
          for (const key of Object.keys(shared)) delete fragment.metadata?.[key];
          if (JSON.stringify(fragment.citations) === JSON.stringify([{ sourceId: row.sourceId, locator: fragment.locator }])) { delete fragment.citations; row.citationTemplate = { sourceId: row.sourceId, locator: 'fragment.locator' }; }
        }
      }
      content = JSON.stringify(data);
    } catch {}
    const key = `${message.name}\n${content}`, previous = seen.get(key);
    if (content.length >= 512) {
      if (previous) content = `Same result as tool call ${previous}. Use ToolResult.read with tool_call_id=${previous} for a needed range.`;
      else seen.set(key, message.tool_call_id);
    }
    if (content.length > 6000 && message.name !== 'ToolResult.read') {
      const total = content.length;
      content = `${content.slice(0, 2200)}\n[${total} characters total; middle omitted. Use ToolResult.read with tool_call_id=${message.tool_call_id} and offset/limit for the full local result.]\n${content.slice(-500)}`;
    }
    return { ...message, content };
  });
}

export function initialToolNames(context: { workspace?: string; taskContext?: { sources?: unknown[] }; selectionSnapshot?: unknown; object?: Data; permissionMode?: string }): string[] {
  const names = ['Tools', 'AskUser', 'ToolResult.read'];
  if (context.workspace) {
    names.push('Read');
    if (context.permissionMode !== 'safe' && context.permissionMode !== 'plan') names.push('Write', 'Edit', 'Patch');
  }
  if (context.taskContext?.sources?.length) names.push('Context.read', 'Context.search');
  if (context.selectionSnapshot || context.object?.hwnd || context.object?.windowHwnd) names.push('look', 'read_around', 'get_app_state');
  if (context.permissionMode === 'plan') names.push('ExitPlanMode');
  return names;
}

export function registerToolResultReader(registry: ToolRegistry, session: EventSession): void {
  registry.register({ name: 'ToolResult.read', description: 'Read a precise character range from a previous tool result in this task by tool_call_id. Full result remains in the local session log.',
    input_schema: schema({ tool_call_id: string, offset: integer, limit: integer }, ['tool_call_id']),
    is_concurrency_safe: true, used_backend: 'session_log', execute: args => {
      const callId = str(args.tool_call_id);
      const event = [...session.events].reverse().find(item => item.type === 'operation/settled' && asObject(item.data.message).tool_call_id === callId);
      if (!event) throw new Error(`Unknown tool result: ${callId}`);
      const message = asObject(event.data.message), content = str(message.content);
      const offset = Math.max(0, Math.min(content.length, Number(args.offset ?? 0)));
      const limit = Math.max(1, Math.min(3000, Number(args.limit ?? 3000)));
      const end = Math.min(content.length, offset + limit);
      return { toolCallId: callId, name: message.name, content: content.slice(offset, end), charOffset: offset, nextCharOffset: end < content.length ? end : null, totalChars: content.length };
    } });
}
export type Skill = { name: string; description: string; source: string; path: string; modifiedAt: number; userInvocable: boolean; whenToUse?: string };

export async function listSkills(workspace?: string, userDataDir?: string, home = os.homedir()): Promise<{ skills: Skill[]; errors: string[] }> {
  const roots = [...(workspace ? [path.join(workspace, '.agents', 'skills'), path.join(workspace, '.dsh', 'skills')] : []),
    path.join(home, '.agents', 'skills'), path.join(home, '.dsh', 'skills'), ...(userDataDir ? [path.join(userDataDir, 'skills')] : [])];
  const skills = new Map<string, Skill>(), errors: string[] = [];
  for (const directory of roots) for (const item of await list(directory)) {
    if (!item.isDirectory()) continue; const file = path.join(directory, item.name, 'SKILL.md');
    try {
      const raw = await readFile(file, 'utf8'), match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
      if (!match) throw new Error('Missing frontmatter');
      const fields: Data = {}; let last = '';
      for (const line of match[1].split(/\r?\n/)) {
        const field = /^([\w-]+):\s*(.*)$/.exec(line);
        if (field) { last = field[1]; fields[last] = field[2].replace(/^["']|["']$/g, '').replace(/^[>|]-?$/, ''); }
        else if (last && /^\s/.test(line)) fields[last] = (str(fields[last]) + ' ' + line.trim()).trim();
      }
      const name = str(fields.name), description = str(fields.description);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !description) throw new Error('Skill requires a kebab-case name and description');
      if (!skills.has(name)) skills.set(name, { name, description, source: workspace && directory.startsWith(workspace) ? 'project-agents' : 'user-agents', path: file, modifiedAt: (await stat(file)).mtimeMs,
        userInvocable: !['false', 'no', 'off', '0'].includes(str(fields['user-invocable'])), ...(fields.whenToUse ? { whenToUse: str(fields.whenToUse) } : {}) });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${file}: ${(error as Error).message}`); }
  }
  return { skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

export async function skillBody(skill: Skill): Promise<string> { return (await readFile(skill.path, 'utf8')).replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, '').trim(); }
export async function relevantSkills(command: string, userDataDir: string): Promise<string> {
  const { skills } = await listSkills(undefined, userDataDir); const terms = command.toLowerCase().match(/[a-z0-9_+-]{2,}|[\u3400-\u9fff]{1,2}/g) ?? [];
  const ranked = skills.filter(skill => skill.path.startsWith(path.join(userDataDir, 'skills'))).map(skill => ({ skill, score: terms.filter(term => `${skill.name} ${skill.description}`.toLowerCase().includes(term)).length })).filter(item => item.score).sort((a, b) => b.score - a.score).slice(0, 6);
  const blocks: string[] = []; for (const { skill } of ranked) blocks.push(`## skill: ${skill.name}\n${(await skillBody(skill)).slice(0, 3500)}`);
  return blocks.join('\n\n').slice(0, 12000);
}

export async function directoryPayload(workspace?: string, userDataDir?: string): Promise<Data> {
  const { skills, errors } = await listSkills(workspace, userDataDir);
  return { ok: true, commands: [
    { name: 'help', description: '显示命令帮助' }, { name: 'compact', description: '压缩当前任务上下文' },
    { name: 'model', description: '选择模型' }, { name: 'permission', description: '选择权限模式' },
    { name: 'cwd', description: '查看或设置编码工作区' }, { name: 'rewind', description: '恢复本任务文件检查点' },
  ], skills: skills.filter(skill => skill.userInvocable), errors };
}

export async function extensionsInventory(userDataDir: string): Promise<Data> {
  const paths = extensionPaths(userDataDir), directory = paths.plugins, items: Data[] = [];
  for (const entry of await list(directory)) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(directory, entry.name), manifest = path.join(folder, 'plugin.json');
    const row: Data = { id: entry.name, name: entry.name, description: '', path: folder, status: 'configured' };
    try { const metadata = asObject(JSON.parse(await readFile(manifest, 'utf8'))); row.description = str(metadata.description); const main = str(metadata.main || 'plugin.js'); if (!await exists(path.resolve(folder, main))) throw new Error(`Plugin code is missing: ${main}`); }
    catch (error) { row.status = 'invalid'; row.error = (error as Error).message; } items.push(row);
  }
  const file = paths.mcp, mcp: Data = { path: file, exists: await exists(file), servers: [] };
  if (mcp.exists) {
    try { const raw = asObject(JSON.parse(await readFile(file, 'utf8'))); if (!raw.mcpServers) throw new Error('MCP configuration must contain mcpServers');
      mcp.servers = Object.entries(asObject(raw.mcpServers)).map(([name, value]) => { const fields = asObject(value), enabled = fields.disabled !== true && fields.enabled !== false, valid = typeof fields.command === 'string'; return { name, transport: fields.command ? 'stdio' : fields.url ? 'http' : 'unknown', enabled, status: !valid ? 'invalid' : enabled ? 'configured' : 'disabled', ...(!valid ? { error: 'Only stdio MCP servers are supported.' } : {}) }; });
    } catch (error) { mcp.error = (error as Error).message; }
  }
  return { ok: true, plugins: { directory, exists: await exists(directory), items }, mcp };
}

export function registerWaitTool(registry: ToolRegistry, probes: { workspace?: string; windows: () => Promise<Data[]>; elements: (hwnd: number) => Promise<Data[]> }): void {
  registry.register({ name: 'wait', description: 'Wait locally for an authorized file, window or UI text, without model polling. Use a timeout appropriate to the requested wait (up to 24 hours). Returns satisfied=false on timeout; user stop cancels the wait.', deferred: true, effect: 'read', used_backend: 'wait_probe', timeout_ms: 86410000,
    input_schema: schema({ window_title: string, element_text: string, file_exists: string, timeout_s: { type: 'number', minimum: 0, maximum: 86400 }, poll_ms: integer }),
    access_for: args => ({ action: 'read', paths: args.file_exists ? [path.resolve(probes.workspace ?? process.cwd(), str(args.file_exists))] : [] }),
    execute: async (args, context) => {
      if (![args.window_title, args.element_text, args.file_exists].some(value => str(value).trim())) throw new Error('At least one condition is required');
      const started = Date.now(), timeout = Math.max(50, Math.min(86400000, Number(args.timeout_s ?? 20) * 1000)); let lastError = '', tick = 0;
      while (true) {
        context.signal.throwIfAborted(); let condition = '';
        try {
          if (args.element_text && ++tick % 2 === 0) {
            for (const window of await probes.windows()) {
              if (args.window_title && !str(window.title).toLowerCase().includes(str(args.window_title).toLowerCase())) continue;
              if ((await probes.elements(Number(window.hwnd))).some(element => [element.name, element.value, element.text].map(str).join(' ').toLowerCase().includes(str(args.element_text).toLowerCase()))) { condition = 'element_text'; break; }
            }
          } else if (!args.element_text && args.window_title && (await probes.windows()).some(window => str(window.title).toLowerCase().includes(str(args.window_title).toLowerCase()))) condition = 'window_title';
          if (args.file_exists && await exists(path.resolve(probes.workspace ?? process.cwd(), str(args.file_exists)))) condition = 'file_exists';
        } catch (error) { lastError = (error as Error).message; }
        if (condition || Date.now() - started >= timeout) return { satisfied: !!condition, condition: condition || (args.element_text ? 'element_text' : args.window_title ? 'window_title' : 'file_exists'), elapsed_s: (Date.now() - started) / 1000, ...(lastError ? { note: lastError } : {}) };
        await delay(Math.max(10, Math.min(2000, Number(args.poll_ms ?? 250))), undefined, { signal: context.signal });
      }
    } });
}

export async function expandSkillCommand(instruction: string, workspace: string | undefined, userDataDir: string): Promise<string> {
  const match = /^\/([a-z0-9-]+)(?:\s+|$)([\s\S]*)/.exec(instruction);
  if (!match) return instruction;
  const { skills } = await listSkills(workspace, userDataDir), skill = skills.find(item => item.name === match[1]);
  if (!skill) return instruction;
  const usagePath = path.join(userDataDir, 'skill-usage.json');
  const usage = await readFile(usagePath, 'utf8').then(raw => asObject(JSON.parse(raw))).catch(() => ({} as Data));
  const old = asObject(usage[skill.name]); usage[skill.name] = { count: Number(old.count ?? 0) + 1, lastUsed: Date.now() };
  await mkdir(userDataDir, { recursive: true }); await writeFile(usagePath, JSON.stringify(usage));
  return `User invoked skill ${skill.name} from ${skill.path}:\n${await skillBody(skill)}\n\nUser request:\n${match[2]}`;
}

function htmlText(html: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return html.replace(/<(script|style|noscript|svg|head|nav|footer|iframe|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (raw, value: string) => value.startsWith('#') ? String.fromCodePoint(parseInt(value.replace(/^#x?/i, ''), /^#x/i.test(value) ? 16 : 10)) : entities[value] ?? raw)
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
const fetchCache = new Map<string, { at: number; body: string }>();

export function registerWebTools(registry: ToolRegistry): void {
  registry.register({ name: 'Search', description: 'Search the internet for titles, URLs and snippets; use Fetch to read a selected result.', input_schema: schema({ query: string, limit: integer }, ['query']), is_concurrency_safe: true, timeout_ms: 30000, used_backend: 'duckduckgo_html',
    execute: async (args, context) => {
      const response = await fetch('https://html.duckduckgo.com/html/', { method: 'POST', body: new URLSearchParams({ q: str(args.query) }), signal: context.signal, redirect: 'manual', headers: { 'User-Agent': 'MagicPointer/1.0' } });
      if (!response.ok) throw new Error(`Search returned HTTP ${response.status}`);
      const html = await response.text(), results: Data[] = [];
      for (const block of html.split(/<div class="result\b/).slice(1)) {
        const anchor = /<a\b[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/.exec(block); if (!anchor) continue;
        const href = /href="([^"]+)"/.exec(anchor[0]); let url = href?.[1] ?? '';
        try { url = new URL(url.replaceAll('&amp;', '&'), 'https://duckduckgo.com').searchParams.get('uddg') || url; } catch {}
        const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? '';
        results.push({ title: htmlText(anchor[1]), url, snippet: htmlText(snippet).slice(0, 300) });
        if (results.length >= Math.max(1, Math.min(20, Number(args.limit ?? 5)))) break;
      }
      return { query: args.query, results, ...(results.length ? {} : { note: 'Search endpoint returned no usable results' }) };
    } });
  registry.register({ name: 'Fetch', description: 'Fetch page text without running JavaScript. Redirects and unavailable content are reported explicitly.', input_schema: schema({ url: string, char_limit: integer }, ['url']), is_concurrency_safe: true, timeout_ms: 40000, used_backend: 'native_fetch',
    execute: async (args, context) => {
      const url = str(args.url); if (!/^https?:\/\//.test(url)) throw new Error('URL must use HTTP or HTTPS');
      const cached = fetchCache.get(url); let body: string;
      if (cached && Date.now() - cached.at < 900000) body = cached.body;
      else {
        const response = await fetch(url, { signal: context.signal, redirect: 'manual' });
        if (response.status >= 300 && response.status < 400) return { url, redirect: response.headers.get('location'), status: response.status };
        if (!response.ok) throw new Error(`Fetch returned HTTP ${response.status}`);
        const type = response.headers.get('content-type') ?? ''; if (!/html|text|json|xml/.test(type)) return { url, contentType: type, note: 'Use the matching document or binary reader for this content' };
        const raw = await response.text(); body = type.includes('html') ? htmlText(raw) : raw;
        fetchCache.set(url, { at: Date.now(), body }); if (fetchCache.size > 20) fetchCache.delete(fetchCache.keys().next().value!);
      }
      const limit = Math.min(60000, Math.max(2000, Number(args.char_limit ?? 15000)));
      return { url, totalChars: body.length, content: body.length > limit ? body.slice(0, Math.floor(limit * 0.7)) + `\n[${body.length - limit} characters omitted]\n` + body.slice(-Math.floor(limit * 0.3)) : body,
        ...(body ? {} : { note: 'No readable text; this may require a browser' }) };
    } });
  registry.alias('web_search', 'Search'); registry.alias('web_fetch', 'Fetch');
}

export function registerMemoryTools(registry: ToolRegistry, userDataDir: string, session: EventSession, allowSkills = false): void {
  const screenMemory = new ScreenMemory(path.join(userDataDir, 'screen-memory.json'));
  registry.register({ name: 'Recall', description: 'Search durable session history and retained screen evidence. Read individual matching session events with pagination.', deferred: true, is_concurrency_safe: true, used_backend: 'local_memory',
    input_schema: schema({ query: string, max_results: integer, session_id: string, event_seq: integer, offset: integer, max_chars: integer, since: { type: 'number' }, until: { type: 'number' }, limit: integer }),
    execute: async (args, context) => {
      if (args.session_id !== session.id && !exactApprovedToolCall(session.events, 'Recall', args, context.tool_call_id)) {
        throw new ActionFailure('permission_denied', 'Reading history outside this task requires approval for this exact Recall request.');
      }
      const directory = path.join(userDataDir, 'agent-sessions');
      if (args.session_id) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(str(args.session_id))) throw new Error('invalid_session_id');
        const rows = (await readFile(path.join(directory, `${args.session_id}.jsonl`), 'utf8')).split('\n').filter(Boolean).map(line => asObject(JSON.parse(line)));
        const row = rows.find(item => item.seq === args.event_seq); if (!row) throw new Error('event_seq was not found');
        const body = JSON.stringify(row.data), offset = Math.max(0, Number(args.offset ?? 0)), end = Math.min(body.length, offset + Math.min(8000, Math.max(1, Number(args.max_chars ?? 4000))));
        return { sessionId: args.session_id, eventSeq: row.seq, type: row.type, content: body.slice(offset, end), offset, nextOffset: end < body.length ? end : null, totalChars: body.length };
      }
      const query = str(args.query).toLowerCase(); if (!query.trim()) throw new Error('query is required');
      const files = await Promise.all((await list(directory)).filter(item => item.isFile() && item.name.endsWith('.jsonl')).map(async item => ({ file: path.join(directory, item.name), time: (await stat(path.join(directory, item.name))).mtimeMs })));
      const hits: Data[] = [], limit = Math.min(30, Math.max(1, Number(args.max_results ?? 8)));
      for (const { file } of files.sort((a, b) => b.time - a.time)) {
        let count = 0;
        for (const line of (await readFile(file, 'utf8')).split('\n')) {
          if (!line) continue; let event: Data; try { event = asObject(JSON.parse(line)); } catch { continue; }
          if (event.type === 'model/request') continue; const body = JSON.stringify(event.data), position = body.toLowerCase().indexOf(query); if (position < 0) continue;
          hits.push({ sessionId: path.basename(file, '.jsonl'), eventSeq: event.seq, type: event.type, excerpt: body.slice(Math.max(0, position - 200), Math.max(0, position - 200) + 700) });
          if (++count >= 3 || hits.length >= limit) break;
        }
        if (hits.length >= limit) break;
      }
      return { matches: hits, screenEvidence: await screenMemory.recall(query, {
        since: args.since === undefined ? undefined : Number(args.since),
        until: args.until === undefined ? undefined : Number(args.until),
        limit: Math.min(30, Math.max(1, Number(args.limit ?? limit))),
      }) };
    } });
  registry.alias('search_history', 'Recall');
  if (allowSkills) registerSkillTools(registry, userDataDir);
}

export function registerSkillTools(registry: ToolRegistry, userDataDir: string): void {
    registry.register({ name: 'SaveSkill', description: 'Save a reusable procedure as a skill after user authorization. Do not archive one-off transcripts.', deferred: true, effect: 'reversible_write', used_backend: 'skill_store',
      input_schema: schema({ name: string, content: string, overwrite: { type: 'boolean' } }, ['name', 'content']), execute: async args => {
        const name = str(args.name), body = str(args.content).trim();
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !body || body.length > 12000 || !/^---\s*\n[\s\S]*?\bdescription:/m.test(body)) throw new Error('Skill requires a kebab-case name and valid frontmatter; maximum 12000 characters');
        const target = path.join(userDataDir, 'skills', name, 'SKILL.md'); if (!args.overwrite && await exists(target)) throw new Error('Skill exists; use overwrite=true to replace');
        await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, body + '\n', 'utf8'); return { name, path: target };
      } }); registry.alias('save_skill', 'SaveSkill');
}

export async function suggestNextPrompt(model: ModelRunner, request: Omit<ModelRequest, 'messages' | 'tools' | 'system'>, history: string): Promise<string> {
  if (!history.trim()) return '';
  try {
    const reply = await model({ ...request, system: '预测用户接下来最可能输入的一句话。只输出该句话，不要解释、引号、编号和换行；保持对话语言，使用具体上下文，不写通用的继续或下一步。120字以内。', messages: [{ role: 'user', content: history.slice(-12000), origin: 'data', injected: true }], tools: [], maxTokens: 80, timeoutMs: 20000 });
    const value = reply.text.trim().split('\n')[0].replace(/^(?:1[.、]\s*|[-*>]\s*)/, '').replace(/^["'「“《]|["'」”》]$/g, '').trim();
    return value.length <= 120 ? value : '';
  } catch { return ''; }
}

export function estimateCostUsd(usage: Data, model: string, host: string, at = Date.now()): number | null {
  if (host !== 'api.deepseek.com' || !['contextTokens', 'lastCacheReadTokens', 'lastOutputTokens'].every(key => typeof usage[key] === 'number')) return null;
  const rates = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model) ? [.003, .15, .6] : model === 'deepseek-v4-pro' ? [.022, .66, 1.98] : null;
  if (!rates) return null;
  const date = new Date(at), weekday = date.getUTCDay(), hour = date.getUTCHours();
  const multiplier = weekday >= 1 && weekday <= 5 && (hour >= 1 && hour < 4 || hour >= 6 && hour < 10) ? 2 : 1;
  const cached = Math.min(Number(usage.contextTokens), Number(usage.lastCacheReadTokens));
  return (cached * rates[0] + (Number(usage.contextTokens) - cached) * rates[1] + Number(usage.lastOutputTokens) * rates[2]) * multiplier / 1000000;
}
