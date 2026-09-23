import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, statSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ActionFailure, type ToolRegistry, type ToolSpec, type Effect } from './tools';
import type { AccessRequest } from './context';
import { chooseUiTarget } from './desktop_selector';

export type DesktopRecord = Record<string, any>;
export type Rect = [number, number, number, number];
export interface DesktopWindow extends DesktopRecord { hwnd: number; pid: number; bbox: Rect; title: string; processStartTime?: string }
export interface DesktopElement extends DesktopRecord { index: number; hwnd: number; name: string; role: string; rect: Rect; runtime_id: number[]; patterns: string[] }
export interface DesktopSnapshot { snapshot_id: string; state_id: string; window: DesktopWindow; windows: DesktopWindow[]; elements: DesktopElement[]; root_ref: string; mode: string; surface?: Buffer }

let desktopRoot = resolve(__dirname, '..', '..');
if (basename(desktopRoot) === 'build') desktopRoot = resolve(desktopRoot, '..');
export function configureDesktop(root: string): void { desktopRoot = resolve(root); }
export function desktopRuntimeRoot(): string { return desktopRoot; }
export function desktopDataRoot(): string { return process.env.MAGIC_POINTER_USER_DATA_DIR ? join(process.env.MAGIC_POINTER_USER_DATA_DIR, 'runtime') : join(desktopRoot, 'data', 'runtime'); }

export function runProcess(file: string, args: string[], options: { signal?: AbortSignal; timeoutMs?: number; input?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((accept, reject) => {
    const child = execFile(file, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: options.timeoutMs ?? 15000, signal: options.signal, cwd: options.cwd ?? desktopRoot, env: options.env ?? process.env }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file}: ${stderr.trim() || stdout.trim() || error.message}`)); else accept(stdout.replace(/^\uFEFF/, ''));
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

export async function runPowerShellJson(script: string, signal?: AbortSignal, timeoutMs = 15000): Promise<DesktopRecord> {
  if (process.platform !== 'win32') throw new Error(`unsupported_platform:powershell:${process.platform}`);
  const prefix = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$ErrorActionPreference="Stop"\n';
  const output = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(prefix + script, 'utf16le').toString('base64')], { signal, timeoutMs });
  const lines = output.trim().split(/\r?\n/);
  return JSON.parse(lines.at(-1) || '{}') as DesktopRecord;
}

let compileTask: Promise<string> | undefined;
export async function ensureNativeTool(name = 'desktop_host', defines?: string): Promise<string> {
  if (process.platform !== 'win32') throw new Error(`unsupported_platform:${name}:${process.platform}`);
  const source = join(desktopRoot, 'scripts', `${name === 'uia_host' ? 'uia_selection_probe' : name}.cs`);
  const output = join(desktopDataRoot(), `${name}.exe`);
  if (existsSync(output) && (!existsSync(source) || statSync(output).mtimeMs >= statSync(source).mtimeMs)) return output;
  mkdirSync(dirname(output), { recursive: true });
  const framework = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const references = join(process.env.ProgramFiles || 'C:\\Program Files', 'Reference Assemblies', 'Microsoft', 'Framework', '.NETFramework');
  const versions = existsSync(references) ? readdirSync(references).filter(value => /^v4/.test(value)).sort().reverse() : [];
  const ref = (dll: string) => {
    for (const version of versions) for (const folder of ['', 'Profile\\Client']) { const candidate = join(references, version, folder, dll); if (existsSync(candidate)) return candidate; }
    const wpf = join(framework, 'WPF', dll); return existsSync(wpf) ? wpf : join(framework, dll);
  };
  await runProcess(join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/optimize+', `/out:${output}`, ...(defines ? [`/define:${defines}`] : []), ...['System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll', 'WindowsBase.dll', 'UIAutomationClient.dll', 'UIAutomationTypes.dll'].map(dll => `/reference:${ref(dll)}`), source], { timeoutMs: 30000 });
  return output;
}

class NativeDesktopHost {
  child?: ChildProcessWithoutNullStreams;
  pending = new Map<string, { accept(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout; cleanup(): void }>();
  startup?: Promise<void>;
  async start(): Promise<void> {
    if (this.child && !this.child.killed) return;
    if (this.startup) return this.startup;
    this.startup = (async () => {
      compileTask ??= ensureNativeTool().catch(error => { compileTask = undefined; throw error; });
      const executable = await compileTask;
      const child = spawn(executable, [], { cwd: desktopRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.child = child;
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try {
            const response = JSON.parse(line); const pending = this.pending.get(String(response.id)); if (!pending) continue;
            this.pending.delete(String(response.id)); clearTimeout(pending.timer); pending.cleanup();
            if (response.error) pending.reject(new Error(String(response.error.code || response.error.message))); else pending.accept(response.result);
          } catch { this.fail(new Error('native_desktop_invalid_response')); }
        }
      });
      child.stderr.on('data', () => {});
      child.on('error', error => this.fail(error));
      child.on('exit', () => { if (this.child === child) { this.child = undefined; this.fail(new Error('native_desktop_exited')); } });
    })().finally(() => { this.startup = undefined; });
    return this.startup;
  }
  fail(error: Error): void { for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.cleanup(); entry.reject(error); } this.pending.clear(); }
  async request<T = DesktopRecord>(method: string, params: DesktopRecord = {}, signal?: AbortSignal, timeoutMs = 10000): Promise<T> {
    signal?.throwIfAborted(); await this.start(); signal?.throwIfAborted();
    return new Promise((accept, reject) => {
      const id = randomUUID();
      const cancelPath = signal ? join(desktopDataRoot(), `native-cancel-${id}`) : '';
      const abort = () => { const entry = this.pending.get(id); if (!entry) return; if (cancelPath) { writeFileSync(cancelPath, ''); const cleanup = setTimeout(() => { try { unlinkSync(cancelPath); } catch {} }, 30000); cleanup.unref(); } this.pending.delete(id); clearTimeout(entry.timer); entry.cleanup(); reject(signal?.reason || new Error('aborted')); };
      const timer = setTimeout(() => { this.pending.delete(id); signal?.removeEventListener('abort', abort); reject(new Error(`native_desktop_timeout:${method}`)); this.child?.kill(); }, timeoutMs);
      this.pending.set(id, { accept, reject, timer, cleanup: () => signal?.removeEventListener('abort', abort) }); signal?.addEventListener('abort', abort, { once: true });
      this.child!.stdin.write(`${JSON.stringify({ id, method, params: { ...params, cancelPath } })}\n`, error => { if (error) this.fail(error); });
    });
  }
  close(): void { this.child?.stdin.end(); this.child = undefined; this.fail(new Error('native_desktop_closed')); }
}

const host = new NativeDesktopHost();
export async function nativeRequest<T = DesktopRecord>(method: string, params: DesktopRecord = {}, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
  if (process.platform === 'win32') return host.request<T>(method, params, signal, timeoutMs);
  if (process.platform === 'darwin' && method === 'permissions') return JSON.parse(await runProcess(process.env.MAGIC_POINTER_MACOS_HOST || join(desktopRoot, 'native', 'macos', 'magic-pointer-host'), ['--check-permissions'], { signal, timeoutMs: timeoutMs || 5000 })) as T;
  throw new Error(`unsupported_platform:${method}:${process.platform}`);
}
export function closeDesktop(): void { host.close(); selectionHost?.kill(); selectionHost = undefined; }
export async function listWindows(signal?: AbortSignal): Promise<DesktopWindow[]> { return nativeRequest<DesktopWindow[]>('windows', {}, signal); }
export async function listElements(hwnd: number, signal?: AbortSignal): Promise<DesktopElement[]> { return nativeRequest<DesktopElement[]>('elements', { hwnd }, signal); }
export async function captureSurface(bounds: Rect, signal?: AbortSignal): Promise<{ bytes: Buffer; width: number; height: number; source: string; capturedAtUtc: string }> {
  const result = await nativeRequest('capture', { bounds }, signal);
  return { bytes: Buffer.from(result.png, 'base64'), width: result.width, height: result.height, source: result.source, capturedAtUtc: result.capturedAtUtc };
}

let selectionHost: ChildProcessWithoutNullStreams | undefined;
let selectionHostStarting: Promise<void> | undefined;
let probeFailures = 0, probeOpenUntil = 0, selectionRequestSequence = 0;
async function startSelectionHost(): Promise<void> {
  if (selectionHost && !selectionHost.killed) return;
  selectionHostStarting ??= (async () => { const executable = await ensureNativeTool('uia_host', 'RESIDENT_HOST'); selectionHost = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: desktopRoot }); selectionHost.stdout.on('data', () => {}); selectionHost.stderr.on('data', () => {}); selectionHost.on('error', () => { selectionHost = undefined; }); selectionHost.on('exit', () => { selectionHost = undefined; }); })().finally(() => { selectionHostStarting = undefined; });
  return selectionHostStarting;
}

export async function probeSelection(hwnd: number, target: { point?: { x: number; y: number }; region?: { x: number; y: number; width: number; height: number }; signal?: AbortSignal } = {}): Promise<DesktopRecord> {
  target.signal?.throwIfAborted();
  const parts: (string | number)[] = [hwnd];
  if (target.region) parts.push('region', target.region.x, target.region.y, target.region.width, target.region.height); else if (target.point) parts.push(target.point.x, target.point.y);
  if (Date.now() >= probeOpenUntil) {
    try {
      await startSelectionHost();
      const id = String(++selectionRequestSequence);
      const result = await new Promise<DesktopRecord>((accept, reject) => {
        const deadline = Date.now() + 1500;
        const connect = () => {
          target.signal?.throwIfAborted();
          const socket = createConnection(`\\\\.\\pipe\\${process.env.MAGIC_POINTER_UIA_HOST_PIPE || 'MagicPointerUIAHost'}`);
          let text = '';
          const abort = () => socket.destroy(new Error('aborted'));
          target.signal?.addEventListener('abort', abort, { once: true });
          socket.setTimeout(6000, () => socket.destroy(new Error('uia_probe_timeout')));
          socket.on('connect', () => socket.write(`${id}|${parts.join('|')}\n`));
          socket.on('data', chunk => { text += chunk.toString('utf8'); if (text.includes('\n')) { socket.end(); try { const value = JSON.parse(text.split('\n')[0]); if (String(value.id) !== id) throw new Error('uia_response_identity_mismatch'); delete value.id; accept(value); } catch (error) { reject(error); } } });
          socket.on('close', () => target.signal?.removeEventListener('abort', abort));
          socket.on('error', error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && Date.now() < deadline && !target.signal?.aborted) setTimeout(connect, 30); else reject(error); });
        };
        connect();
      });
      probeFailures = 0; return result;
    } catch (error) { if (target.signal?.aborted) throw error; if (++probeFailures >= 3) { probeOpenUntil = Date.now() + 30000; probeFailures = 0; } }
  }
  const executable = await ensureNativeTool('uia_selection_probe');
  return JSON.parse((await runProcess(executable, parts.map(value => value === 'region' ? '--region' : String(value)), { signal: target.signal, timeoutMs: 6000 })).trim());
}

function fingerprint(element: DesktopElement): unknown { return [element.runtime_id, element.role, element.name, element.rect, element.patterns, element.value]; }
function identity(window: DesktopWindow): unknown { return [window.hwnd, window.pid, window.bbox, window.processStartTime]; }
type WindowReadScope = (hwnd: number) => { allowed: boolean; reason: string };
function requireWindowRead(hwnd: number, scope?: WindowReadScope): void {
  const access = scope?.(hwnd);
  if (access && !access.allowed) throw new ActionFailure('permission_denied', access.reason);
}
const effectRank: Effect[] = ['read', 'reversible_write', 'local_irreversible', 'external_send', 'destructive', 'purchase'];
function strongerEffect(left: Effect, right: Effect): Effect { return effectRank.indexOf(left) >= effectRank.indexOf(right) ? left : right; }
function actionEffect(name: string, args: DesktopRecord, session?: DesktopActionSession): Effect {
  if (['list_apps', 'get_app_state', 'find_roots', 'observe_ui', 'search_ui', 'inspect_ui', 'expand_ui', 'read_text', 'wait_for', 'turn_ended'].includes(name)) return 'read';
  const declared = ({ send: 'external_send', submit: 'external_send', delete: 'destructive', run: 'local_irreversible', purchase: 'purchase' } as Record<string, Effect>)[String(args.intent || '')] || 'local_irreversible';
  if (name === 'act_ui') {
    const actions = Array.isArray(args.actions) ? args.actions : [];
    return actions.reduce((effect: Effect, action: DesktopRecord) => {
      const kind = String(action.action || action.kind || '');
      const mapped = ({ click: 'click', press: 'click', keypress: 'press_key', typeText: 'type_text' } as Record<string, string>)[kind] || kind;
      return strongerEffect(effect, actionEffect(mapped, { ...action, snapshot_id: args.snapshot_id || args.state_id }, session));
    }, declared);
  }
  let observed: Effect = 'local_irreversible';
  if (name === 'type_text' && args.submit) observed = 'external_send';
  if (name === 'press_key') {
    const keys = String(args.keys || '').toLowerCase().split(/[+\s]+/).filter(Boolean);
    if (keys.some(key => ['delete', 'del'].includes(key))) observed = 'destructive';
    else if (keys.some(key => ['enter', 'return'].includes(key)) && !keys.includes('shift')) observed = 'external_send';
  }
  if (['click', 'perform_secondary_action'].includes(name)) {
    const snapshot = session?.snapshots.get(String(args.snapshot_id || args.state_id || ''));
    const index = args.index ?? (String(args.ref || '').startsWith('@e') ? Number(String(args.ref).slice(2)) : undefined);
    const candidates = snapshot?.elements.filter(element => index !== undefined ? element.index === Number(index)
      : Number.isFinite(args.x) && Number.isFinite(args.y) && element.rect[0] <= args.x && args.x < element.rect[2] && element.rect[1] <= args.y && args.y < element.rect[3]) || [];
    const labels = candidates.map(element => String(element.name || '')).join(' ').toLowerCase();
    if (['delete', 'remove', '删除', '永久移除', '清空'].some(word => labels.includes(word))) observed = 'destructive';
    else if (['send', 'submit', '发送', '提交', '发布'].some(word => labels.includes(word))) observed = 'external_send';
  }
  return strongerEffect(declared, observed);
}

export class DesktopActionSession {
  readonly snapshots = new Map<string, DesktopSnapshot>();
  readonly roots = new Map<string, number>();
  readonly observation = { windows: listWindows, elements: listElements };
  constructor(readonly sessionId: string = randomUUID(), readonly originWindowHwnd?: number) {}
  rootRef(hwnd: number): string { for (const [ref, value] of this.roots) if (value === hwnd) return ref; const ref = `@r${this.roots.size + 1}`; this.roots.set(ref, hwnd); return ref; }
  async observe(args: DesktopRecord = {}, signal?: AbortSignal, readScope?: WindowReadScope): Promise<DesktopSnapshot> {
    const windows = (await this.observation.windows(signal)).filter(row => !/^Magic Pointer(?: |$)/i.test(row.title));
    const id = args.hwnd || (args.root ? this.roots.get(args.root) : undefined) || Number(String(args.window_id || '').replace(/^w-/, ''));
    const candidates = windows.filter(window => !id || window.hwnd === Number(id)).filter(window => args.pid === undefined || window.pid === Number(args.pid)).filter(window => !args.app || `${window.process_name} ${window.title}`.toLowerCase().includes(String(args.app).toLowerCase()));
    const window = candidates.find(row => !id && row.hwnd === this.originWindowHwnd) || candidates.find(row => row.focused) || candidates[0];
    if (!window) throw new ActionFailure('tool_error', 'window not found');
    requireWindowRead(window.hwnd, readScope);
    const mode = String(args.mode || 'ax'); if (mode === 'all') throw new Error("mode 'all' is illegal");
    const elements = ['image', 'visual'].includes(mode) ? [] : await this.observation.elements(window.hwnd, signal);
    const snapshot_id = randomUUID();
    const snapshot: DesktopSnapshot = { snapshot_id, state_id: snapshot_id, window, windows: [window], elements, root_ref: this.rootRef(window.hwnd), mode };
    if (['full', 'image', 'visual'].includes(mode)) snapshot.surface = (await captureSurface(window.bbox, signal)).bytes;
    this.snapshots.set(snapshot_id, snapshot);
    while (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.keys().next().value!);
    for (const old of [...this.snapshots.values()].slice(0, -8)) delete old.surface;
    return snapshot;
  }
  async requireSnapshot(id: unknown, signal?: AbortSignal, indexes: number[] = []): Promise<DesktopSnapshot> {
    const snapshot = this.snapshots.get(String(id || ''));
    if (!snapshot) throw new ActionFailure('stale_snapshot', 'snapshot_id is required; call Observe again');
    const live = await nativeRequest<DesktopWindow>('window', { hwnd: snapshot.window.hwnd }, signal);
    if (!isDeepStrictEqual(identity(live), identity(snapshot.window))) throw new ActionFailure('stale_snapshot', 'window moved, resized, or changed process; call Observe again');
    if (indexes.length) {
      const elements = await listElements(live.hwnd, signal);
      for (const index of indexes) {
        const original = snapshot.elements.find(row => row.index === index), current = elements.find(row => row.index === index);
        if (!original || !current || !isDeepStrictEqual(fingerprint(original), fingerprint(current))) throw new ActionFailure('stale_snapshot', `element ${index} changed; call Observe again`);
      }
    }
    return snapshot;
  }
  element(snapshot: DesktopSnapshot, args: DesktopRecord): DesktopElement | undefined {
    const index = args.index ?? (args.ref ? Number(String(args.ref).replace(/^@e/, '')) : undefined);
    if (index === undefined) return undefined;
    const element = snapshot.elements.find(row => row.index === Number(index));
    if (!element) throw new ActionFailure('stale_snapshot', 'element ref is stale');
    return element;
  }
  async point(snapshot: DesktopSnapshot, args: DesktopRecord, signal?: AbortSignal): Promise<{ x: number; y: number; element?: DesktopElement }> {
    const element = this.element(snapshot, args);
    if (element && (args.x !== undefined || args.y !== undefined)) throw new Error('pass exactly one of index/ref or x/y coordinates');
    let x: number, y: number;
    if (element) { await this.requireSnapshot(snapshot.snapshot_id, signal, [element.index]); x = Math.round((element.rect[0] + element.rect[2]) / 2); y = Math.round((element.rect[1] + element.rect[3]) / 2); }
    else {
      x = Number(args.x); y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('pass index/ref or both x and y');
      if (!snapshot.surface) throw new ActionFailure('stale_snapshot', 'coordinate actions require Observe(mode=full)');
      const sharp = (await import('sharp')).default;
      const live = await captureSurface(snapshot.window.bbox, signal); const [left, top, right, bottom] = snapshot.window.bbox;
      const region = { left: Math.max(0, Math.round(x - left - 32)), top: Math.max(0, Math.round(y - top - 32)), width: 0, height: 0 };
      region.width = Math.min(65, right - left - region.left); region.height = Math.min(65, bottom - top - region.top);
      if (region.width <= 0 || region.height <= 0) throw new ActionFailure('stale_snapshot', 'point outside surface');
      const [before, after] = await Promise.all([sharp(snapshot.surface).extract(region).raw().toBuffer(), sharp(live.bytes).extract(region).raw().toBuffer()]);
      if (!before.equals(after)) throw new ActionFailure('stale_snapshot', 'target pixels changed since snapshot; call Observe again');
    }
    const [l, t, r, b] = snapshot.window.bbox;
    if (x < l || x >= r || y < t || y >= b) throw new ActionFailure('stale_snapshot', 'point outside target window');
    return { x, y, element };
  }
  async call(name: string, args: DesktopRecord = {}, signal?: AbortSignal, readScope?: WindowReadScope): Promise<DesktopRecord> {
    signal?.throwIfAborted();
    const discoverable = (window: DesktopWindow) => readScope?.(window.hwnd).allowed === false ? { ...window, title: '' } : window;
    if (name === 'list_apps') return { apps: (await this.observation.windows(signal)).map(discoverable), usedBackend: 'win32_windows' };
    if (name === 'find_roots') {
      const windows = (await this.observation.windows(signal)).map(discoverable);
      const roots = windows.filter(row => (!args.text || `${row.title} ${row.process_name}`.toLowerCase().includes(String(args.text).toLowerCase())) && (!args.pid || row.pid === Number(args.pid)) && (!args.app || String(row.process_name).toLowerCase().includes(String(args.app).toLowerCase()))).map(row => ({ ...row, root_ref: this.rootRef(row.hwnd), window_id: `w-${row.hwnd}`, kind: 'window' }));
      return { roots: roots.slice(0, 32), total: roots.length, usedBackend: 'win32_windows' };
    }
    if (name === 'get_app_state' || name === 'observe_ui') {
      const snapshot = await this.observe(args, signal, readScope); const { surface, ...publicSnapshot } = snapshot;
      return { ...publicSnapshot, ...(surface ? { image: surface.toString('base64'), mimeType: 'image/png' } : {}), outline: snapshot.elements.slice(0, 80).map(row => ({ ...row, ref: `@e${row.index}` })), usedBackend: 'native_uia' };
    }
    if (name === 'launch_app') return nativeRequest('launch', { app: args.app }, signal);
    if (name === 'turn_ended') return { ok: true };
    if (name === 'activate_window') {
      const snapshot = await this.observe(args, signal);
      return nativeRequest('input', { action: name, window: snapshot.window }, signal);
    }
    if (['search_ui', 'inspect_ui', 'expand_ui', 'read_text', 'wait_for'].includes(name)) {
      const prior = this.snapshots.get(String(args.snapshot_id || args.state_id || ''));
      if (prior) requireWindowRead(prior.window.hwnd, readScope);
    }
    const snapshot = await this.requireSnapshot(args.snapshot_id || args.state_id, signal);
    if (['search_ui', 'inspect_ui', 'expand_ui', 'read_text'].includes(name)) {
      let elements = snapshot.elements;
      if (name === 'search_ui') elements = elements.filter(row => (!args.text || `${row.name} ${row.value || ''} ${row.text || ''}`.toLowerCase().includes(String(args.text).toLowerCase())) && (!args.role || row.role === args.role) && (!args.capability || row.patterns.some(pattern => pattern.toLowerCase().includes(String(args.capability).toLowerCase()))));
      else { const element = this.element(snapshot, args); if (!element) throw new Error('ref required'); if (name === 'read_text') return { text: element.text || element.value || element.name, state_id: snapshot.state_id, ref: args.ref, usedBackend: 'native_uia' }; elements = name === 'expand_ui' ? elements.filter(row => row.index === element.index || row.parent_index === element.index) : [element]; }
      return { state_id: snapshot.state_id, elements: elements.map(row => ({ ...row, ref: `@e${row.index}` })), usedBackend: 'native_uia' };
    }
    if (name === 'wait_for') {
      const started = Date.now(), timeout = Math.min(60000, Number(args.timeout_ms || 5000)); let current = snapshot;
      do { current = await this.observe({ hwnd: snapshot.window.hwnd }, signal, readScope); const matched = matchesCondition(current.elements, args); if (matched) return { matched, state_id: current.state_id, elapsedMs: Date.now() - started, usedBackend: 'native_uia' }; await delay(Math.min(150, Math.max(1, timeout - (Date.now() - started))), signal); } while (Date.now() - started < timeout);
      return { matched: false, state_id: current.state_id, elapsedMs: Date.now() - started, usedBackend: 'native_uia' };
    }
    if (name === 'act_ui') {
      const results: DesktopRecord[] = []; let current = snapshot;
      for (const action of args.actions || []) {
        signal?.throwIfAborted();
        results.push(await this.call(String(action.action || action.kind), { ...action, snapshot_id: current.snapshot_id }, signal));
        current = await this.observe({ hwnd: snapshot.window.hwnd, mode: snapshot.mode }, signal);
      }
      return { state_id: current.state_id, actions: results, verification: args.expect ? { matched: matchesCondition(current.elements, args.expect), status: 'checked' } : { matched: false, status: 'unavailable' }, usedBackend: 'native_desktop' };
    }
    const element = this.element(snapshot, args);
    if (['set_value', 'perform_secondary_action'].includes(name)) {
      if (!element) throw new Error('element index/ref required'); await this.requireSnapshot(snapshot.snapshot_id, signal, [element.index]);
      const result = await nativeRequest('uia', { action: name === 'set_value' ? 'value' : args.action || 'invoke', element, value: args.value }, signal);
      const confirm = name === 'set_value' ? await nativeRequest('uia', { action: 'read_value', element }, signal) : null;
      return { ...result, verification: { matched: confirm ? String(confirm.value) === String(args.value) : false, status: confirm ? 'checked' : 'unavailable' } };
    }
    if (name === 'press_key' && /(^|[+\s])(win|meta|super|lwin|rwin)([+\s]|$)/i.test(String(args.keys))) throw new ActionFailure('permission_denied', 'Win/Meta/Super chords are rejected');
    let coordinates: DesktopRecord = {};
    if (['click', 'drag', 'scroll', 'select_text'].includes(name) || name === 'type_text' && (element || args.x !== undefined)) coordinates = await this.point(snapshot, args, signal);
    if (name === 'select_text' && element) { try { return await nativeRequest('uia', { action: 'select', element }, signal); } catch { signal?.throwIfAborted(); } }
    if (name === 'drag') { const target = await this.point(snapshot, { index: args.to_index, x: args.to_x, y: args.to_y }, signal); coordinates.to_x = target.x; coordinates.to_y = target.y; }
    if (name === 'type_text' || name === 'select_text') {
      if ('x' in coordinates) await nativeRequest('input', { action: 'click', ...coordinates, window: snapshot.window }, signal);
      if (name === 'select_text') return nativeRequest('input', { action: 'press_key', keys: 'ctrl+a', window: snapshot.window }, signal);
      let previous: DesktopRecord | undefined;
      if (element && !args.clear) try { previous = await nativeRequest('uia', { action: 'read_value', element }, signal); } catch { signal?.throwIfAborted(); }
      const result = await nativeRequest('input', { ...args, action: name, window: snapshot.window }, signal);
      let matched = false;
      if (element) try {
        const confirm = await nativeRequest('uia', { action: 'read_value', element }, signal); const actual = String(confirm.value), text = String(args.text || '');
        matched = args.clear ? actual === text : !!previous && Array.from({ length: Math.max(0, actual.length - text.length + 1) }, (_, i) => i).some(i => actual.slice(i, i + text.length) === text && actual.slice(0, i) + actual.slice(i + text.length) === String(previous!.value));
      } catch { signal?.throwIfAborted(); }
      if (args.submit && matched) await nativeRequest('input', { action: 'press_key', keys: 'enter', window: snapshot.window }, signal);
      return { ...result, verification: { matched, status: matched ? 'matched' : 'unavailable' }, submitted: !!args.submit && matched, submit_skip_reason: args.submit && !matched ? 'verification_unavailable' : null };
    }
    return nativeRequest('input', { ...args, ...coordinates, action: name, window: snapshot.window }, signal);
  }
}

function matchesCondition(elements: DesktopElement[], condition: DesktopRecord): boolean {
  if (![condition.text, condition.role, condition.value].some(value => value !== undefined && value !== null)) return false;
  return elements.some(row => (condition.text === undefined || `${row.name} ${row.text || ''}`.includes(String(condition.text))) && (condition.role === undefined || row.role === condition.role) && (condition.value === undefined || String(row.value) === String(condition.value)));
}
export function delay(ms: number, signal?: AbortSignal): Promise<void> { signal?.throwIfAborted(); return new Promise((accept, reject) => { const abort = () => { clearTimeout(timer); reject(signal?.reason || new Error('aborted')); }; const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); accept(); }, ms); signal?.addEventListener('abort', abort, { once: true }); }); }
const sessions = new Map<string, DesktopActionSession>();
export function desktopSession(sessionId = 'default', originWindowHwnd?: number): DesktopActionSession { let session = sessions.get(sessionId); if (!session) { session = new DesktopActionSession(sessionId, originWindowHwnd); sessions.set(sessionId, session); } return session; }
export async function observeDesktop(args: DesktopRecord = {}, signal?: AbortSignal): Promise<DesktopRecord> { return desktopSession(args.sessionId).call('get_app_state', args, signal); }
export async function executeDesktopAction(name: string, args: DesktopRecord, signal?: AbortSignal): Promise<DesktopRecord> { return desktopSession(args.sessionId).call(name, args, signal); }

export function registerDesktopTools(registry: ToolRegistry, session = desktopSession(), authorizeAccess?: (request: AccessRequest) => { allowed: boolean; reason: string }): void {
  const readScope: WindowReadScope | undefined = authorizeAccess ? hwnd => authorizeAccess({ action: 'read', windowIds: [`w-${hwnd}`] }) : undefined;
  registry.register({ name: 'choose_ui_target', description: 'Resolve a target within an observed state. Unique exact labels are local; configured Jev uses a 900 ms deadline. Returns a reference or ambiguity and never acts.', input_schema: { type: 'object', properties: { state_id: { type: 'string' }, target: { type: 'string' }, candidate_refs: { type: 'array', items: { type: 'string' } } }, required: ['state_id', 'target'], additionalProperties: false }, effect: 'read', deferred: true, is_concurrency_safe: true, execute: async (args: DesktopRecord, context) => { const prior = session.snapshots.get(String(args.state_id || '')); if (prior) requireWindowRead(prior.window.hwnd, readScope); const snapshot = await session.requireSnapshot(args.state_id, context.signal); const rows = snapshot.elements.map(row => ({ ...row, ref: `@e${row.index}` })).filter(row => !args.candidate_refs || args.candidate_refs.includes(row.ref)); return chooseUiTarget(args.target, rows, snapshot.state_id, context.signal); } });
  const string = { type: 'string' }, number = { type: 'number' }, integer = { type: 'integer' }, boolean = { type: 'boolean' };
  const common = { snapshot_id: string, state_id: string, index: integer, ref: string, x: number, y: number };
  const schemas: Record<string, DesktopRecord> = {
    list_apps: {}, launch_app: { app: string }, activate_window: { window_id: string, pid: integer, app: string },
    get_app_state: { window_id: string, pid: integer, app: string, mode: { enum: ['ax', 'text', 'image', 'full'] } },
    find_roots: { text: string, app: string, pid: integer, kind: string }, observe_ui: { root: string, mode: { enum: ['fused', 'visual', 'ax', 'full'] } },
    search_ui: { ...common, text: string, role: string, capability: string }, inspect_ui: common, expand_ui: { ...common, depth: integer }, read_text: common,
    wait_for: { ...common, text: string, role: string, value: string, timeout_ms: integer },
    click: { ...common, button: { enum: ['left', 'right', 'middle'] }, count: integer }, type_text: { ...common, text: string, clear: boolean, submit: boolean },
    press_key: { ...common, keys: string }, scroll: { ...common, dx: integer, dy: integer }, set_value: { ...common, value: string },
    perform_secondary_action: { ...common, action: { enum: ['invoke', 'toggle', 'expand', 'collapse', 'select', 'focus'] } }, select_text: common,
    drag: { ...common, to_index: integer, to_x: number, to_y: number, duration_ms: integer, path: { type: 'array', items: { type: 'object', properties: { x: number, y: number } } } },
    act_ui: { ...common, actions: { type: 'array', minItems: 1, items: { type: 'object' } }, expect: { type: 'object' } }, turn_ended: {},
  };
  for (const [name, properties] of Object.entries(schemas)) {
    const effect = actionEffect(name, {});
    const targetAction = ['click', 'type_text', 'press_key', 'perform_secondary_action', 'act_ui'].includes(name);
    if (['click', 'type_text', 'press_key', 'perform_secondary_action', 'act_ui'].includes(name)) properties.intent = { type: 'string', enum: ['input', 'send', 'submit', 'delete', 'run', 'purchase'] };
    registry.register({ name, description: `${name.replaceAll('_', ' ')} on the current desktop. Use observed state_id and element ref; coordinates need a full image observation. Actions revalidate the target and return honest verification.`, input_schema: { type: 'object', properties, required: [], additionalProperties: false }, effect, effect_for: args => actionEffect(name, args, session),
      access_for: targetAction ? args => { const snapshot = session.snapshots.get(String(args.snapshot_id || args.state_id || '')); return { action: 'patch', windowIds: [snapshot?.window.hwnd ? `w-${snapshot.window.hwnd}` : 'unbound-live-surface'] }; } : undefined,
      is_concurrency_safe: effect === 'read', resource_keys: effect === 'read' ? [] : ['desktop:input'], used_backend: 'native_desktop', timeout_ms: 65000, deferred: !['list_apps', 'get_app_state'].includes(name), execute: (args, context) => session.call(name, args, context.signal, readScope) } as ToolSpec);
  }
}
