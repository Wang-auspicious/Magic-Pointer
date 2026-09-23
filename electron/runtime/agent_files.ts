import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, stat, unlink, access } from 'node:fs/promises';
import path from 'node:path';
import createIgnore, { type Ignore } from 'ignore';
import { ToolRegistry, type ToolSpec, type Effect } from './tools';
import { EventSession } from './session';
import { asObject, type Data } from './agent';

const str = (value: unknown) => String(value ?? '');
const exists = async (file: string) => { try { await access(file); return true; } catch { return false; } };
const normalize = (value: string) => value.replace(/\r\n/g, '\n').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
const ignore = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'release', 'build', 'dist', '.mp', 'external']);
const globRegex = (pattern: string) => new RegExp('^' + pattern.replaceAll('\\', '/').split('**').map(part => part.split('*').map(text => text.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('?', '.')).join('[^/]*')).join('.*') + '$', 'i');

export class WorkspaceFiles {
  readonly root: string;
  private readVersions = new Map<string, string>();
  private checkpointDir: string;
  constructor(root: string, readonly session: EventSession) { this.root = path.resolve(root); this.checkpointDir = path.join(this.root, '.mp', 'checkpoints', session.id); }
  resolve(raw: unknown): string {
    const target = path.resolve(this.root, str(raw || '.'));
    const relative = path.relative(this.root, target);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error(`Path escapes the workspace: ${target}`);
    return target;
  }
  display(file: string): string { return path.relative(this.root, file).replaceAll('\\', '/') || '.'; }
  async read(file: string): Promise<string> {
    const buffer = await readFile(file);
    if (buffer.subarray(0, 8192).includes(0)) throw new Error('Binary file requires its document or image reader');
    const body = buffer.toString('utf8'); this.readVersions.set(file, body); return body;
  }
  async requireFresh(file: string): Promise<void> {
    if (!await exists(file)) return;
    const previous = this.readVersions.get(file);
    if (previous === undefined) throw new Error(`Read ${this.display(file)} before editing or overwriting it`);
    if (await readFile(file, 'utf8') !== previous) throw new Error(`File changed since it was read: ${this.display(file)}. Read it again.`);
  }
  async checkpoint(file: string): Promise<void> {
    await mkdir(this.checkpointDir, { recursive: true });
    const old = await exists(file) ? await readFile(file) : null;
    const id = `${Date.now()}-${randomUUID()}`;
    if (old) await writeFile(path.join(this.checkpointDir, id + '.bin'), old);
    const handle = await import('node:fs/promises').then(fs => fs.open(path.join(this.checkpointDir, 'manifest.jsonl'), 'a'));
    try { await handle.writeFile(JSON.stringify({ id, path: file, existed: old !== null }) + '\n'); await handle.sync(); } finally { await handle.close(); }
  }
  async write(file: string, content: string, check = true): Promise<Data> {
    if (check) await this.requireFresh(file);
    const body = path.extname(file).toLowerCase() === '.csv' ? encodeCsv(content) : Buffer.from(content);
    await this.checkpoint(file); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, body);
    if (!body.equals(await readFile(file))) throw new Error(`File readback mismatch: ${file}`);
    this.readVersions.set(file, body.toString('utf8'));
    return { path: this.display(file), message: `Wrote ${body.length} bytes`, verification: { matched: true, method: 'file_bytes_readback', scope: 'persistence_only' } };
  }
  async rewind(steps: number): Promise<Data> {
    const manifest = path.join(this.checkpointDir, 'manifest.jsonl');
    if (!await exists(manifest)) return { restored: [] };
    const entries = (await readFile(manifest, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { id: string; path: string; existed: boolean });
    const count = steps > 0 ? Math.min(steps, entries.length) : entries.length, selected = entries.slice(-count);
    for (const entry of [...selected].reverse()) {
      const target = this.resolve(entry.path);
      if (entry.existed) { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, await readFile(path.join(this.checkpointDir, entry.id + '.bin'))); }
      else if (await exists(target)) await unlink(target);
      this.readVersions.delete(target);
    }
    await writeFile(manifest, entries.slice(0, entries.length - count).map(entry => JSON.stringify(entry)).join('\n') + '\n');
    return { restored: selected.map(entry => this.display(entry.path)), verification: { matched: true, method: 'checkpoint_restore' } };
  }
  async *walk(base: string, signal: AbortSignal): AsyncGenerator<string> {
    signal.throwIfAborted();
    if ((await stat(base)).isFile()) { yield base; return; }
    const rules: { directory: string; matcher: Ignore }[] = [];
    const addRules = async (directory: string) => {
      const matcher = createIgnore();
      for (const name of ['.gitignore', '.ignore', ...(directory === this.root ? ['.git/info/exclude'] : [])]) {
        try { matcher.add(await readFile(path.join(directory, name), 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      return { directory, matcher };
    };
    for (let directory = this.root; directory !== base;) {
      rules.push(await addRules(directory));
      const next = path.relative(directory, base).split(path.sep)[0];
      if (!next || next === '..') break;
      directory = path.join(directory, next);
    }
    const visit = async function* (directory: string, parents: typeof rules): AsyncGenerator<string> {
      const local = [...parents, await addRules(directory)];
      for (const item of await readdir(directory, { withFileTypes: true })) {
        signal.throwIfAborted(); if (ignore.has(item.name) || item.isSymbolicLink()) continue;
        const file = path.join(directory, item.name);
        let excluded = false;
        for (const rule of local) {
          const match = rule.matcher.test(path.relative(rule.directory, file).replaceAll('\\', '/') + (item.isDirectory() ? '/' : ''));
          if (match.ignored) excluded = true; else if (match.unignored) excluded = false;
        }
        if (excluded) continue;
        if (item.isDirectory()) yield* visit(file, local); else if (item.isFile()) yield file;
      }
    };
    yield* visit(base, rules);
  }
}

function encodeCsv(content: string): Buffer {
  const source = content.replace(/^\ufeff/, '').replace(/\r\n/g, '\n');
  const rows: string[][] = []; let row: string[] = [], value = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    if (character === '"') { if (quoted && source[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (character === ',' && !quoted) { row.push(value); value = ''; }
    else if (character === '\n' && !quoted) { row.push(value); rows.push(row); row = []; value = ''; }
    else value += character;
  }
  if (quoted) throw new Error('CSV has an unterminated quoted field');
  if (value || row.length) { row.push(value); rows.push(row); }
  const width = rows.find(item => item.length > 1 || item[0])?.length ?? 0;
  rows.forEach((item, index) => { if ((item.length > 1 || item[0]) && item.length !== width) throw new Error(`CSV row ${index + 1} has ${item.length} columns, expected ${width}`); });
  return Buffer.from('\ufeff' + rows.map(item => item.map(cell => /[,"\r\n]/.test(cell) ? '"' + cell.replaceAll('"', '""') + '"' : cell).join(',')).join('\r\n') + '\r\n');
}

type Replacement = { start: number; end: number; text: string };
function locate(raw: string, needle: string): [number, number][] {
  const exact: [number, number][] = [];
  for (let index = raw.indexOf(needle); index >= 0; index = raw.indexOf(needle, index + Math.max(1, needle.length))) exact.push([index, index + needle.length]);
  if (exact.length) return exact;
  const wanted = needle.split('\n');
  const lines = raw.split('\n'), starts: number[] = []; let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  for (const clean of [(s: string) => s.trimEnd(), (s: string) => s.trim(), (s: string) => normalize(s).replace(/\s+/g, ' ').trim()]) {
    const hits: [number, number][] = [];
    for (let index = 0; index <= lines.length - wanted.length; index++) if (wanted.every((line, part) => clean(lines[index + part]) === clean(line))) hits.push([starts[index], starts[index + wanted.length - 1] + lines[index + wanted.length - 1].length]);
    if (hits.length) return hits;
  }
  return [];
}

export async function applyWorkspacePatch(space: WorkspaceFiles, patch: string): Promise<Data> {
  const lines = patch.trim().replace(/^<<['"]?EOF['"]?\r?\n/, '').replace(/\r?\nEOF$/, '').split(/\r?\n/);
  if (lines.shift() !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') throw new Error('Patch must use Begin Patch and End Patch markers');
  const planned = new Map<string, string | null>();
  const current = async (file: string): Promise<string> => planned.has(file) ? planned.get(file) ?? '' : readFile(file, 'utf8');
  let index = 0;
  while (index < lines.length - 1) {
    const header = lines[index++], match = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(header);
    if (!match) throw new Error(`Invalid patch header: ${header}`);
    const target = space.resolve(match[2]);
    if (match[1] === 'Delete') { await current(target); planned.set(target, null); continue; }
    if (match[1] === 'Add') {
      if (await exists(target) || planned.has(target)) throw new Error(`Add target exists: ${match[2]}`);
      const added: string[] = [];
      while (index < lines.length && lines[index].startsWith('+')) added.push(lines[index++].slice(1));
      planned.set(target, added.join('\n') + '\n'); continue;
    }
    const original = await current(target);
    let raw = original.replace(/\r\n/g, '\n'), move: string | undefined, cursor = 0;
    if (lines[index]?.startsWith('*** Move to: ')) move = space.resolve(lines[index++].slice(13));
    while (index < lines.length && (!lines[index].startsWith('*** ') || lines[index] === '*** End of File')) {
      let hint = '';
      if (lines[index].startsWith('@@')) hint = lines[index++].slice(2).trim();
      if (hint) { const position = raw.indexOf(hint, cursor); if (position < 0) throw new Error(`Patch context not found: ${hint}`); cursor = position + hint.length; }
      const old: string[] = [], replacement: string[] = []; let eof = false;
      while (index < lines.length && !lines[index].startsWith('@@') && !lines[index].startsWith('*** ')) {
        const line = lines[index++];
        if (line.startsWith(' ')) { old.push(line.slice(1)); replacement.push(line.slice(1)); }
        else if (line.startsWith('-')) old.push(line.slice(1));
        else if (line.startsWith('+')) replacement.push(line.slice(1));
        else throw new Error(`Invalid patch line: ${line}`);
      }
      if (lines[index] === '*** End of File') { index++; eof = true; }
      if (!old.length && !replacement.length) throw new Error('Empty patch update');
      const needle = old.join('\n');
      let hits = old.length ? locate(raw, needle).filter(([start]) => start >= cursor) : [[raw.length, raw.length] as [number, number]];
      if (eof) hits = hits.filter(([, end]) => !raw.slice(end).trim());
      if (!hits.length) throw new Error(`Patch context does not match ${match[2]}: ${needle.slice(0, 120)}`);
      const [start, end] = hits[0], replacementText = replacement.join('\n');
      raw = raw.slice(0, start) + replacementText + raw.slice(end); cursor = start + replacementText.length;
    }
    if (original.includes('\r\n')) raw = raw.replaceAll('\n', '\r\n');
    if (move) { if (await exists(move)) throw new Error(`Move target exists: ${move}`); planned.set(target, null); planned.set(move, raw); }
    else planned.set(target, raw);
  }
  for (const [file, content] of planned) { if (content === null) { await space.checkpoint(file); await unlink(file); } else await space.write(file, content, false); }
  return { changed: [...planned.keys()].map(file => space.display(file)), verification: { matched: true, method: 'file_bytes_readback', scope: 'persistence_only' } };
}

export function commandEffect(args: Data): Effect {
  const command = str(args.command).trim();
  if (args.background || /[|&;<>`]|\$\(|[\r\n]/.test(command)) return 'local_irreversible';
  const tokens = command.split(/\s+/), first = tokens[0].toLowerCase();
  if (first === 'git') return ['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse', 'blame'].includes(tokens[1]) || tokens[1] === 'branch' && (!tokens[2] || ['--list', '--show-current', '-a', '-r'].includes(tokens[2])) ? 'read' : 'local_irreversible';
  if (first === 'rg' && tokens.some(token => token === '--pre' || token.startsWith('--pre='))) return 'local_irreversible';
  return ['rg', 'grep', 'cat', 'type', 'head', 'tail', 'ls', 'dir', 'pwd', 'whoami', 'get-content', 'get-childitem', 'get-location'].includes(first) ? 'read' : 'local_irreversible';
}

export async function runShell(command: string, cwd: string, signal: AbortSignal, timeoutMs: number): Promise<Data> {
  const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout?.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-64000); });
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
  const kill = () => { if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else child.kill('SIGKILL'); };
  signal.addEventListener('abort', kill, { once: true }); const timer = setTimeout(kill, timeoutMs);
  try {
    const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    signal.throwIfAborted();
    const result = { exit, cwd, stdout, stderr };
    if (exit !== 0 && !(exit === 1 && /^\s*(rg|grep|git\s+diff)\b/.test(command))) throw new Error(JSON.stringify(result));
    return result;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', kill); }
}

export function registerCodingTools(registry: ToolRegistry, workspace: string, session: EventSession): WorkspaceFiles {
  const space = new WorkspaceFiles(workspace, session); let shellCwd = space.root;
  const schema = (properties: Data, required: string[] = []): Data => ({ type: 'object', properties, required });
  const string = { type: 'string' }, integer = { type: 'integer' }, boolean = { type: 'boolean' };
  const add = (name: string, description: string, input_schema: Data, execute: ToolSpec['execute'], effect: Effect = 'read', extra: Partial<ToolSpec> = {}) => registry.register({ name, description, input_schema, execute, effect, is_concurrency_safe: effect === 'read', used_backend: 'workspace_fs', ...extra });
  add('Read', 'Read a workspace text file with line numbers and pagination. Use character offsets for long lines.', schema({ path: string, offset: integer, limit: integer, force: boolean, char_offset: integer, char_limit: integer }, ['path']), async args => {
    const file = space.resolve(args.path), raw = await space.read(file);
    if (args.char_offset !== undefined) { const offset = Math.max(0, Number(args.char_offset)), end = Math.min(raw.length, offset + Math.max(1, Math.min(Number(args.char_limit ?? 12000), 50000))); return { path: space.display(file), content: raw.slice(offset, end), charOffset: offset, nextCharOffset: end < raw.length ? end : null, totalChars: raw.length }; }
    const lines = raw.split(/\r?\n/), offset = Math.max(1, Number(args.offset ?? 1)), limit = Math.max(1, Math.min(2000, Number(args.limit ?? 200)));
    let body = '', end = offset - 1; const max = limit === 200 ? 12000 : 50000;
    for (let index = offset - 1; index < Math.min(lines.length, offset - 1 + limit); index++) { const line = `${index + 1}\t${lines[index]}\n`; if (body.length + line.length > max) { if (!body) body = line.slice(0, max); break; } body += line; end = index + 1; }
    return `${space.display(file)}\n${body}[showing lines ${offset}-${end} of ${lines.length}${end < lines.length ? '; continue with offset or char_offset' : ''}]`;
  });
  add('Write', 'Write a workspace text file. Read existing files first. Returns actual byte readback.', schema({ path: string, content: string }, ['path', 'content']), args => space.write(space.resolve(args.path), str(args.content)), 'reversible_write');
  const editSchema = schema({ old_string: string, new_string: string, replace_all: boolean }, ['old_string', 'new_string']);
  add('Edit', 'Replace unique text in a recently read workspace file. Preserves untouched text and the file\'s LF or CRLF line endings; use for precise local edits instead of a shell rewrite. Batch edits are applied together.', schema({ path: string, old_string: string, new_string: string, replace_all: boolean, edits: { type: 'array', items: editSchema } }, ['path']), async args => {
    const file = space.resolve(args.path); await space.requireFresh(file); const original = await readFile(file, 'utf8'), raw = original.replace(/\r\n/g, '\n');
    const edits = Array.isArray(args.edits) ? args.edits.map(asObject) : [args]; const replacements: Replacement[] = [];
    for (const edit of edits) {
      const old = str(edit.old_string).replace(/\r\n/g, '\n'), next = str(edit.new_string).replace(/\r\n/g, '\n');
      if (!old || old === next) throw new Error('old_string must be nonempty and differ from new_string');
      const hits = locate(raw, old);
      if (!hits.length || hits.length > 1 && !edit.replace_all) throw new Error(`Expected unique old_string; found ${hits.length} matches`);
      for (const [start, end] of hits) { if (replacements.some(item => start < item.end && end > item.start)) throw new Error('Batch edits overlap'); replacements.push({ start, end, text: next }); }
    }
    let output = raw;
    for (const item of replacements.sort((a, b) => b.start - a.start)) output = output.slice(0, item.start) + item.text + output.slice(item.end);
    if (original.includes('\r\n')) output = output.replaceAll('\n', '\r\n');
    return space.write(file, output);
  }, 'reversible_write');
  add('Patch', 'Apply an Add/Delete/Update/Move patch with @@ contexts across workspace files.', schema({ patch: { oneOf: [string, { type: 'array', items: string }] } }, ['patch']), async args => {
    const results: Data[] = []; for (const patch of Array.isArray(args.patch) ? args.patch : [args.patch]) results.push(await applyWorkspacePatch(space, str(patch))); return results.length === 1 ? results[0] : { patches: results };
  }, 'reversible_write');
  add('Rewind', 'Restore files changed in this session from persistent checkpoints. steps=0 restores all.', schema({ steps: integer }), args => space.rewind(Number(args.steps ?? 0)), 'reversible_write');
  add('Glob', 'Find workspace files matching a glob, ordered by most recent modification.', schema({ pattern: string }, ['pattern']), async (args, context) => {
    const pattern = str(args.pattern), match = globRegex(pattern), alternative = globRegex(pattern.replace(/^\*\*\//, '')), files: { path: string; time: number }[] = [];
    for await (const file of space.walk(space.root, context.signal)) { const relative = space.display(file); if (match.test(relative) || alternative.test(relative) || match.test(path.basename(file))) files.push({ path: relative, time: (await stat(file)).mtimeMs }); }
    return { files: files.sort((a, b) => b.time - a.time).slice(0, 500).map(item => item.path), truncated: files.length > 500 };
  });
  add('Grep', 'Search file content by regex. Prefer files_with_matches to locate files before reading details.', schema({ pattern: string, path: string, glob: string, glob_filter: string, max_results: integer, context: integer, offset: integer, case_sensitive: boolean, output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] } }, ['pattern']), async (args, context) => {
    const pattern = new RegExp(str(args.pattern), args.case_sensitive ? '' : 'i'), filter = str(args.glob_filter || args.glob), matcher = filter ? globRegex(filter) : null;
    const mode = str(args.output_mode || 'content'), hits: unknown[] = [], skip = Math.max(0, Number(args.offset ?? 0)), limit = Math.min(200, Math.max(1, Number(args.max_results ?? 200)));
    for await (const file of space.walk(space.resolve(args.path || '.'), context.signal)) {
      if (matcher && !matcher.test(space.display(file)) && !matcher.test(path.basename(file))) continue;
      const buffer = await readFile(file); if (buffer.subarray(0, 8192).includes(0)) continue;
      const lines = buffer.toString('utf8').split(/\r?\n/), matches: number[] = [];
      lines.forEach((line, index) => { if (pattern.test(line)) matches.push(index); });
      if (!matches.length) continue;
      if (mode === 'files_with_matches') hits.push(space.display(file));
      else if (mode === 'count') hits.push({ path: space.display(file), count: matches.length });
      else for (const index of matches) {
        const span = Math.min(5, Math.max(0, Number(args.context ?? 0)));
        const sensitive = /\.env|secret|\.(pem|key)$/i.test(space.display(file));
        hits.push({ path: space.display(file), line: index + 1, text: sensitive ? '[redacted]' : lines.slice(Math.max(0, index - span), index + span + 1).join('\n') });
      }
      if (hits.length >= skip + limit) break;
    }
    return { matches: hits.slice(skip, skip + limit), nextOffset: hits.length >= skip + limit ? skip + limit : null };
  }, 'read', { timeout_ms: 30000 });
  add('Bash', 'Run a workspace shell command. On Windows this is cmd.exe syntax, not Unix Bash. Use Read/Edit/Patch for file reads and local edits; use background=true for independent long processes, then BashRead for output.', schema({ command: string, cwd: string, timeout_s: { type: 'number' }, background: boolean }, ['command']), async (args, context) => {
    const command = str(args.command).trim(), cwd = args.cwd && args.cwd !== '.' ? space.resolve(args.cwd) : shellCwd;
    if (!command) throw new Error('command is required');
    if (args.background) return launchBackgroundCommand(command, cwd, session, space.root);
    const result = await runShell(command, cwd, context.signal, Math.min(600, Math.max(1, Number(args.timeout_s ?? 300))) * 1000);
    const cd = /^cd\s+(?:\/d\s+)?["']?([^"';&|]+)["']?$/i.exec(command);
    if (cd && result.exit === 0) shellCwd = space.resolve(path.resolve(cwd, cd[1].trim()));
    return result;
  }, 'local_irreversible', { effect_for: commandEffect, used_backend: 'shell', timeout_ms: 620000 });
  add('BashRead', 'Read the persisted status and recent output of an independent background command.', schema({ id: { oneOf: [integer, string] } }, ['id']), async args => {
    const directory = path.join(space.root, '.mp', 'background'), meta = asObject(JSON.parse(await readFile(path.join(directory, `${str(args.id)}.json`), 'utf8')));
    const output = await readFile(path.join(directory, `${str(args.id)}.log`), 'utf8').catch(() => '');
    return { ...meta, output: output.slice(-8000) };
  });
  for (const [alias, name] of Object.entries({ read_file: 'Read', write_file: 'Write', edit_file: 'Edit', apply_patch: 'Patch', restore_files: 'Rewind', glob: 'Glob', grep: 'Grep', run_command: 'Bash', read_background: 'BashRead' })) registry.alias(alias, name);
  return space;
}

async function launchBackgroundCommand(command: string, cwd: string, session: EventSession, workspace: string): Promise<Data> {
  const id = Math.floor(Math.random() * 2 ** 48), directory = path.join(workspace, '.mp', 'background');
  await mkdir(directory, { recursive: true });
  const meta = { id, command, cwd, status: 'starting', started: Date.now(), sessionFile: session.file, sessionId: session.id, log: path.join(directory, `${id}.log`) };
  const file = path.join(directory, `${id}.json`); await writeFile(file, JSON.stringify(meta));
  const child = spawn(process.execPath, [path.join(__dirname, 'agent_worker.js'), 'shell', file], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  child.unref(); return { id, status: 'running', pid: child.pid, message: 'Running independently. Use BashRead for output.' };
}
