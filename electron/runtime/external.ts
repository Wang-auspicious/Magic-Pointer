import { spawn, spawnSync } from 'node:child_process';
import { access, open, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readJson, writeAtomic, redactSecrets } from './learning';
import { withFileLock } from './session';
import { runPowerShellJson, runProcess } from './desktop';

type Data = Record<string, any>;
const now = () => new Date().toISOString();
const alive = (pid: number) => { try { if (!pid) return false; process.kill(pid, 0); return true; } catch { return false; } };
export function terminateProcess(pid?: number): void {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
  else { try { process.kill(pid); } catch {} }
}
const exists = async (file: string) => { try { await access(file); return true; } catch { return false; } };
const providerNames: Record<string, string> = { codex: 'Codex', pi: 'Pi', claude: 'Claude Code', gemini: 'Gemini CLI', cursor: 'Cursor Agent', opencode: 'OpenCode', aider: 'Aider' };
const protocols: Record<string, string[]> = { codex: ['app-server', 'exec-json'], pi: ['extension-hooks', 'rpc-steer', 'json'], claude: ['user-prompt-hook', 'stream-json'], gemini: ['before-agent-hook', 'extension', 'json'], cursor: ['headless-stream-json', 'hooks-observe'], opencode: ['plugin-hooks', 'http-openapi'], aider: ['message-file', 'print'] };

export async function locateExecutable(command: string): Promise<string | null> {
  if (path.isAbsolute(command)) return await exists(command) ? command : null;
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) for (const suffix of suffixes) {
    const file = path.join(directory.replace(/^"|"$/g, ''), command + suffix); if (await exists(file)) return file;
  }
  return null;
}

export async function executableCommand(file: string, args: string[]): Promise<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> {
  if (!/\.cmd$/i.test(file)) return { file, args };
  const source = await readFile(file, 'utf8');
  const script = /["']?%dp0%[\\/]([^"'\r\n]+\.(?:js|mjs|cjs))["']?/i.exec(source)?.[1];
  if (!script) throw new Error(`Unsupported command shim: ${file}`);
  return { file: process.execPath, args: [path.resolve(path.dirname(file), script), ...args], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
}

export async function discoverProviders(): Promise<Data[]> {
  return Promise.all(Object.entries(providerNames).map(async ([id, name]) => {
    const executable = await locateExecutable(id === 'cursor' ? 'cursor-agent' : id);
    let version: string | null = null, reason: string | null = executable ? null : 'executable_not_found';
    if (executable) { try { const cmd = await executableCommand(executable, ['--version']); version = redactSecrets(await runProcess(cmd.file, cmd.args, { timeoutMs: 2000, env: cmd.env })).split(/\r?\n/)[0].slice(0, 160); } catch (error) { reason = String(error).slice(0, 160); } }
    return { id, name, available: !!executable, executable, version, protocols: protocols[id], reason, installHint: executable ? null : `Install ${name}.`, sessionSupport: id === 'aider' ? 'new_only' : 'resume', backgroundSteerable: id === 'pi' && !!executable };
  }));
}

async function walk(directory: string, accept: (file: string) => boolean): Promise<string[]> {
  let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  return (await Promise.all(entries.filter(item => item.name !== 'subagents').map(item => item.isDirectory() ? walk(path.join(directory, item.name), accept) : accept(item.name) ? [path.join(directory, item.name)] : []))).flat();
}

async function sessionRecords(file: string): Promise<Data[]> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024), read = await handle.read(buffer, 0, buffer.length, 0), text = buffer.subarray(0, read.bytesRead).toString('utf8');
    if (file.endsWith('.json')) { try { return [JSON.parse(text)]; } catch { return []; } }
    return text.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  } finally { await handle.close(); }
}

export async function discoverExternalSessions(options: Data = {}): Promise<Data[]> {
  const home = options.home || os.homedir(), roots: Record<string, string> = { codex: path.join(home, '.codex', 'sessions'), claude: path.join(home, '.claude', 'projects'), pi: path.join(home, '.pi', 'agent', 'sessions'), gemini: path.join(home, '.gemini', 'tmp') };
  const sessions: Data[] = [];
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  for (const [provider, root] of Object.entries(roots)) {
    if (options.provider && options.provider !== provider) continue;
    const files = await walk(root, file => /\.jsonl$/.test(file) || provider === 'gemini' && /^session-.*\.json$/.test(file));
    for (const file of files) {
      let records: Data[], info; try { records = await sessionRecords(file); info = await stat(file); } catch { continue; }
      let meta: Data | undefined, cwd = '', token: string | undefined;
      if (provider === 'codex') { meta = records[0]?.type === 'session_meta' ? records[0].payload : undefined; if (meta?.source?.subagent) continue; }
      else if (provider === 'gemini') { meta = Object.assign({}, ...records.map(item => item.$set || (item.sessionId ? item : {}))); try { cwd = (await readFile(path.join(path.dirname(file), '..', '.project_root'), 'utf8')).trim(); } catch {} }
      else meta = records.find(item => (item.sessionId || item.session_id || item.id) && item.cwd);
      const id = meta?.sessionId || meta?.session_id || meta?.id; cwd ||= meta?.cwd || ''; if (!id || !cwd || provider === 'gemini' && meta?.kind && meta.kind !== 'main') continue;
      const relative = options.cwd ? path.relative(normalize(options.cwd), normalize(cwd)) : '';
      const match = !options.cwd ? 'unscoped' : normalize(options.cwd) === normalize(cwd) ? 'strict' : options.cwdMatch === 'subtree' && relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? 'subtree' : options.cwdMatch === 'confirm' ? 'confirmation_required' : 'none';
      if (match === 'none' && !options.includeMismatch) continue;
      const message = records.find(item => item.type === 'user' || item.message?.role === 'user' || item.payload?.role === 'user');
      const raw = meta?.title || meta?.name || message?.message?.content || message?.payload?.content || message?.text || '';
      const title = (typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(item => item.text || '').join(' ') : '').replace(/\s+/g, ' ').slice(0, 100);
      if (provider === 'pi') token = file;
      sessions.push({ provider, sessionId: id, title: title || `${providerNames[provider]} · ${path.basename(cwd)} · ${id.slice(0, 8)}`, cwd: path.resolve(cwd), lastActiveAt: info.mtime.toISOString(), state: Date.now() - info.mtimeMs <= 900000 ? 'recent' : 'resumable', transport: protocols[provider][0], source: `${provider}_session_meta`, resumeToken: token || id, cwdMatch: match, _file: file });
    }
  }
  if (options.activeOnly && process.platform === 'win32' && sessions.length) {
    const data = await runPowerShellJson(`$paths=ConvertFrom-Json '${JSON.stringify(sessions.map(item => item._file)).replace(/'/g, "''")}'\n$result=@{}\nforeach($p in $paths){try{$f=[System.IO.File]::Open($p,'Open','Read','None');$f.Dispose();$result[$p]=$false}catch [System.IO.IOException]{$result[$p]=($_.Exception.HResult -band 65535) -eq 32}}\n$result|ConvertTo-Json -Compress`);
    for (let index = sessions.length - 1; index >= 0; index--) if (!data[sessions[index]._file]) sessions.splice(index, 1); else Object.assign(sessions[index], { live: true, liveEvidence: 'windows_sharing_violation' });
  } else if (options.activeOnly) return [];
  return sessions.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)).filter((item, index, all) => all.findIndex(other => other.provider === item.provider && other.sessionId === item.sessionId) === index).slice(0, Math.min(Number(options.limit ?? 200), 1000)).map(({ _file, ...item }) => item);
}

export async function buildInvocation(request: Data, executable: string, profile: Data = {}): Promise<Data> {
  const cwd = path.resolve(request.cwd || '.'); if (!(await stat(cwd)).isDirectory()) throw new Error('agent_cwd_missing');
  const provider = String(request.provider), session = request.resumeToken || request.resume_token || request.sessionId || request.session_id, read = request.permission === 'read';
  let args: string[], protocol = 'jsonl', input: string | null = String(request.prompt || '');
  if (request.submit) throw new Error('external_submit_not_allowed');
  if (provider === 'codex') args = ['exec', ...(read ? ['--sandbox', 'read-only'] : []), ...(session ? ['resume'] : []), '--json', '--skip-git-repo-check', ...(request.attachments || []).flatMap((file: string) => ['--image', file]), ...(session ? [session] : []), '-'];
  else if (provider === 'pi') { protocol = request.background ? 'jsonl-rpc' : 'json'; args = ['--mode', request.background ? 'rpc' : 'json', ...(!request.background ? ['--print'] : []), ...(session ? ['--session', session] : ['--no-session']), ...(read ? ['--tools', 'read'] : [])]; }
  else if (provider === 'claude') args = ['-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'text', ...(session ? ['--resume', session] : []), ...(read ? ['--permission-mode', 'plan'] : [])];
  else if (provider === 'gemini') { protocol = 'json'; args = ['-p', '', '--output-format', 'json', ...(read ? ['--approval-mode', 'plan'] : []), ...(session ? ['--resume', session] : [])]; }
  else if (provider === 'cursor') args = ['-p', '--output-format', 'stream-json', ...(!read ? ['--force'] : []), ...(session ? [`--resume=${session}`] : [])];
  else if (provider === 'opencode') args = ['run', '--format', 'json', ...(session ? ['--session', session] : [])];
  else if (provider === 'aider') { args = ['--message-file', '{PROMPT_FILE}', '--no-auto-commits', '--no-dirty-commits', ...(read ? ['--dry-run'] : [])]; protocol = 'text'; input = null; }
  else if (provider === 'generic' && Array.isArray(profile.argv) && profile.argv.length && profile.argv.every((item: unknown) => typeof item === 'string' && !item.toLowerCase().includes('{prompt}'))) { executable = profile.argv[0]; args = profile.argv.slice(1); protocol = profile.protocol || 'text'; }
  else throw new Error(`unsupported_provider:${provider}`);
  return { argv: [executable, ...args], stdin: input, cwd, protocol, shell: false, submit: false, env: {} };
}

export class ExternalTasks {
  constructor(readonly userDataDir: string) {}
  file(id: string): string { if (!/^[a-f0-9-]{16,64}$/i.test(id)) throw new Error('invalid_task_id'); return path.join(this.userDataDir, 'agent-tasks', id, 'task.json'); }
  async get(id: string): Promise<Data> { const value = await readJson(this.file(id)); if (value.taskId !== id) throw new Error('invalid_task_state'); return value; }
  async mutate(id: string, action: (value: Data) => unknown | Promise<unknown>): Promise<Data> { return withFileLock(this.file(id) + '.mutation', async () => { const value = await this.get(id); await action(value); value.updatedAt = now(); await writeAtomic(this.file(id), value); return value; }); }
  public(value: Data): Data {
    const { request, invocation, ...rest } = value;
    const terminal = ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(value.status);
    return { ...rest, sessionId: request.sessionId || request.session_id || null, sessionStrategy: request.metadata?.sessionStrategy || null, sessionEvidence: request.metadata?.sessionEvidence || {}, contextPacket: request.metadata?.contextPacket || {}, transport: invocation.protocol, steerable: invocation.protocol === 'jsonl-rpc' && ['queued', 'running'].includes(value.status), completed: value.status === 'succeeded', terminalOutcomeVerified: terminal, resumable: ['failed', 'interrupted'].includes(value.status), state: value.status === 'succeeded' ? 'completed' : ['queued', 'running'].includes(value.status) ? 'accepted' : value.status };
  }
  async launch(id: string): Promise<void> {
    const child = spawn(process.execPath, [path.join(__dirname, 'external_worker.js'), this.file(id)], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    await this.mutate(id, value => { value.workerPid = child.pid; }); child.unref();
  }
  async start(request: Data, invocation: Data): Promise<Data> {
    if (!String(request.prompt || '').trim()) throw new Error('agent_prompt_missing');
    const id = randomUUID(), time = now(); await writeAtomic(this.file(id), { schemaVersion: 1, taskId: id, provider: request.provider, status: 'queued', createdAt: time, updatedAt: time, workerPid: null, agentPid: null, exitCode: null, error: null, summary: null, result: {}, cancelRequested: false, attempt: 1, steeringReceipts: [], request, invocation });
    try { await this.launch(id); } catch (error) { await this.mutate(id, value => { value.status = 'failed'; value.error = `worker_spawn_failed:${error}`; }); }
    return this.public(await this.get(id));
  }
  async status(id: string): Promise<Data> { let value = await this.get(id); if (['running', 'queued'].includes(value.status) && value.workerPid && !alive(value.workerPid)) value = await this.mutate(id, current => { if (['running', 'queued'].includes(current.status)) { current.status = 'interrupted'; current.error = 'worker_interrupted'; } }); return this.public(value); }
  async list(limit = 100): Promise<Data[]> { let names: string[]; try { names = await readdir(path.join(this.userDataDir, 'agent-tasks')); } catch { return []; } const values = await Promise.all(names.filter(id => /^[a-f0-9-]{16,64}$/i.test(id)).map(id => this.status(id).catch(() => null))); return values.filter((value): value is Data => !!value).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit); }
  async cancel(id: string): Promise<Data> { const value = await this.mutate(id, current => { if (['queued', 'running'].includes(current.status)) { current.cancelRequested = true; current.status = 'cancelled'; } }); if (value.cancelRequested) terminateProcess(value.agentPid); return this.public(value); }
  async steer(id: string, message: string): Promise<Data> { if (!message.trim()) throw new Error('empty_steering'); const receipt = { id: randomUUID(), message, state: 'queued', createdAt: now() }; const value = await this.mutate(id, current => { if (current.invocation.protocol !== 'jsonl-rpc' || !['queued', 'running'].includes(current.status)) throw new Error('task_not_steerable'); current.steeringReceipts.push(receipt); }); return this.public(value); }
  async resume(id: string): Promise<Data> { await this.mutate(id, value => { if (!['failed', 'interrupted'].includes(value.status)) throw new Error('task_not_resumable'); value.status = 'queued'; value.attempt++; value.cancelRequested = false; value.error = null; value.workerPid = null; value.agentPid = null; }); await this.launch(id); return this.status(id); }
}

export async function dispatchExternal(payload: Data, userDataDir: string): Promise<Data> {
  const provider = String(payload.provider || 'pi').toLowerCase(), executable = payload.executable || await locateExecutable(provider === 'cursor' ? 'cursor-agent' : provider);
  if (!executable) throw new Error(`agent_provider_unavailable:${provider}`);
  const request = { ...payload, provider }, mode = payload.deliveryMode || 'active_session';
  if (!['active_session', 'managed_session'].includes(mode)) throw new Error('agent_delivery_mode_invalid');
  const sessions = await discoverExternalSessions({ provider, cwd: payload.cwd, cwdMatch: payload.cwdMatch || 'strict', includeMismatch: !!payload.sessionConfirmed, limit: 1000 });
  const selected = payload.sessionId ? sessions.find(item => item.sessionId === payload.sessionId && (['strict', 'subtree'].includes(item.cwdMatch) || item.cwdMatch === 'confirmation_required' && payload.sessionConfirmed)) : payload.autoAttach !== false && sessions.length === 1 ? sessions[0] : null;
  if (payload.sessionId && !selected) throw new Error('agent_session_not_found');
  if (mode === 'active_session' && !selected) throw new Error('agent_existing_session_required');
  Object.assign(request, { sessionId: selected?.sessionId, resumeToken: selected?.resumeToken, metadata: { ...payload.metadata, sessionStrategy: selected ? 'resume_existing' : 'new_managed_session', sessionEvidence: selected || {}, contextPacket: payload.contextPacket || {} } });
  return new ExternalTasks(userDataDir).start(request, await buildInvocation(request, executable));
}
