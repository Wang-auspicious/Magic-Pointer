import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import {createConnection} from 'node:net';
import {
  existsSync,
  mkdirSync,
  statSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import {resolve, join, dirname, basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {
  ActionFailure,
  type ToolRegistry,
  type ToolSpec,
  type Effect,
} from './tools';
import type {AccessRequest} from './context';
import {chooseUiTarget} from './desktop_selector';

export type DesktopRecord = Record<string, any>;
export type Rect = [number, number, number, number];
export interface DesktopWindow extends DesktopRecord {
  hwnd: number;
  pid: number;
  bbox: Rect;
  title: string;
  processStartTime?: string;
}
export interface DesktopElement extends DesktopRecord {
  index: number;
  hwnd: number;
  name: string;
  role: string;
  rect: Rect;
  runtime_id: number[];
  patterns: string[];
}
export interface DesktopSnapshot {
  snapshot_id: string;
  state_id: string;
  window: DesktopWindow;
  windows: DesktopWindow[];
  elements: ElementList;
  root_ref: string;
  mode: string;
  surface?: Buffer;
  markedImage?: Buffer;
  imageScale?: number;
  marks?: ObservationMark[];
}
export interface ObservationMark {
  ref: string;
  role: string;
  name: string;
  imageRect: Rect;
}
type SurfaceCapture = (
  bounds: Rect,
  signal?: AbortSignal,
  hwnd?: number,
) => Promise<{
  bytes: Buffer;
  width: number;
  height: number;
  source: string;
  capturedAtUtc: string;
}>;

const MAX_OBSERVATION_EDGE = 1600;
const ACTIONABLE_ROLES = new Set([
  'button',
  'edit',
  'hyperlink',
  'checkbox',
  'radiobutton',
  'combobox',
  'listitem',
  'menuitem',
  'tabitem',
  'treeitem',
  'dataitem',
  'splitbutton',
  'slider',
  'spinner',
  'document',
]);
const ACTIONABLE_PATTERNS = [
  'Invoke',
  'Value',
  'Toggle',
  'SelectionItem',
  'ExpandCollapse',
  'RangeValue',
];
function actionable(element: DesktopElement, window: DesktopWindow): boolean {
  const [l, t, r, b] = element.rect;
  const [wl, wt, wr, wb] = window.bbox;
  if (
    element.offscreen ||
    r - l < 4 ||
    b - t < 4 ||
    r <= wl ||
    b <= wt ||
    l >= wr ||
    t >= wb
  ) {
    return false;
  }
  if ((r - l) * (b - t) >= (wr - wl) * (wb - wt) * 0.9) {
    return false;
  }
  return (
    ACTIONABLE_ROLES.has(element.role) ||
    (element.patterns || []).some(pattern =>
      ACTIONABLE_PATTERNS.includes(pattern),
    )
  );
}

export interface SnappedDesktopControl {
  ref: string;
  name: string;
  role: string;
  distancePx: number;
}

/**
 * Clicky-inspired magnetic small-control snapping (MIT, external/clicky-windows).
 * When a vision model supplies raw coordinates within <= 30 px of a compact
 * actionable UIA control (rejecting large containers > 600x360), snap to that
 * control's exact center to eliminate near-miss clicks.
 */
export function snapDesktopPointToElement(
  x: number,
  y: number,
  elements: readonly DesktopElement[],
  window: DesktopWindow,
  maxDistancePx = 30,
): {
  x: number;
  y: number;
  element?: DesktopElement;
  snappedControl?: SnappedDesktopControl;
} {
  let best: DesktopElement | undefined;
  let bestDist = maxDistancePx;
  let bestCx = x;
  let bestCy = y;
  for (const el of elements) {
    if (!actionable(el, window)) {
      continue;
    }
    const [l, t, r, b] = el.rect;
    const width = r - l;
    const height = b - t;
    if (width <= 0 || height <= 0 || width > 600 || height > 360) {
      continue;
    }
    const cx = Math.round((l + r) / 2);
    const cy = Math.round((t + b) / 2);
    const dist = Math.hypot(cx - x, cy - y);
    if (dist <= bestDist) {
      bestDist = dist;
      best = el;
      bestCx = cx;
      bestCy = cy;
    }
  }
  if (!best) {
    return {x, y};
  }
  return {
    x: bestCx,
    y: bestCy,
    element: best,
    snappedControl: {
      ref: `@e${best.index}`,
      name: String(best.name || best.role || '').slice(0, 64),
      role: best.role,
      distancePx: Math.round(bestDist * 10) / 10,
    },
  };
}
/** Screenshot the model actually looks at: bounded size, with each actionable UIA element boxed and labelled by its ref. */
export async function markedObservationImage(
  surface: Buffer,
  window: DesktopWindow,
  elements: DesktopElement[],
): Promise<{bytes: Buffer; scale: number; marks: ObservationMark[]}> {
  const sharp = (await import('sharp')).default;
  const meta = await sharp(surface).metadata();
  const width = meta.width || 1;
  const height = meta.height || 1;
  const scale = Math.min(1, MAX_OBSERVATION_EDGE / Math.max(width, height));
  const [left, top] = window.bbox;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const marks: ObservationMark[] = elements
    .filter(element => actionable(element, window))
    .slice(0, 80)
    .map(element => ({
      ref: `@e${element.index}`,
      role: element.role,
      name: String(element.name || '').slice(0, 60),
      imageRect: [
        Math.round((element.rect[0] - left) * scale),
        Math.round((element.rect[1] - top) * scale),
        Math.round((element.rect[2] - left) * scale),
        Math.round((element.rect[3] - top) * scale),
      ] as Rect,
    }));
  const colors = [
    '#e53935',
    '#1e88e5',
    '#43a047',
    '#fb8c00',
    '#8e24aa',
    '#00897b',
  ];
  const svg = marks
    .map((mark, index) => {
      const [x1, y1, x2, y2] = mark.imageRect;
      const color = colors[index % colors.length];
      const label = mark.ref.slice(1);
      const lw = 7 * label.length + 6;
      const ly = Math.max(0, y1 - 14);
      return `<rect x="${x1}" y="${y1}" width="${Math.max(1, x2 - x1)}" height="${Math.max(1, y2 - y1)}" fill="none" stroke="${color}" stroke-width="2"/><rect x="${x1}" y="${ly}" width="${lw}" height="14" fill="${color}"/><text x="${x1 + 3}" y="${ly + 11}" fill="#fff" font-family="Consolas,monospace" font-size="11">${label}</text>`;
    })
    .join('');
  let image = sharp(surface).resize(w, h);
  if (svg) {
    image = sharp(await image.png().toBuffer()).composite([
      {
        input: Buffer.from(
          `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`,
        ),
      },
    ]);
  }
  return {bytes: await image.png().toBuffer(), scale, marks};
}
/** Pixel patches differ only when a meaningful share changed; a caret blink or hover tint is not a new screen. */
export function patchesDiffer(
  before: Buffer,
  after: Buffer,
  channels: number,
): boolean {
  if (before.length !== after.length) {
    return true;
  }
  let changed = 0;
  const pixels = before.length / channels;
  for (let i = 0; i < before.length; i += channels) {
    let delta = 0;
    for (let c = 0; c < channels; c++) {
      delta = Math.max(delta, Math.abs(before[i + c] - after[i + c]));
    }
    if (delta > 32) {
      changed++;
    }
  }
  return changed / pixels > 0.08;
}

let desktopRoot = resolve(__dirname, '..', '..');
if (basename(desktopRoot) === 'build') {
  desktopRoot = resolve(desktopRoot, '..');
}
export function configureDesktop(root: string): void {
  desktopRoot = resolve(root);
}
export function desktopRuntimeRoot(): string {
  return desktopRoot;
}
export function desktopDataRoot(): string {
  return process.env.MAGIC_POINTER_USER_DATA_DIR
    ? join(process.env.MAGIC_POINTER_USER_DATA_DIR, 'runtime')
    : join(desktopRoot, 'data', 'runtime');
}

export function runProcess(
  file: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    input?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<string> {
  return new Promise((accept, reject) => {
    const child = execFile(
      file,
      args,
      {
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: options.timeoutMs ?? 15000,
        signal: options.signal,
        cwd: options.cwd ?? desktopRoot,
        env: options.env ?? process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${file}: ${stderr.trim() || stdout.trim() || error.message}`,
            ),
          );
        } else {
          accept(stdout.replace(/^\uFEFF/, ''));
        }
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

export async function runPowerShellJson(
  script: string,
  signal?: AbortSignal,
  timeoutMs = 15000,
): Promise<DesktopRecord> {
  if (process.platform !== 'win32') {
    throw new Error(`unsupported_platform:powershell:${process.platform}`);
  }
  const prefix =
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$ErrorActionPreference="Stop"\n';
  const output = await runProcess(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(prefix + script, 'utf16le').toString('base64'),
    ],
    {signal, timeoutMs},
  );
  const lines = output.trim().split(/\r?\n/);
  return JSON.parse(lines.at(-1) || '{}') as DesktopRecord;
}

const compileTasks = new Map<string, Promise<string>>();
export async function ensureNativeTool(
  name = 'desktop_host',
  defines?: string,
): Promise<string> {
  const key = `${name}:${defines || ''}`;
  const existing = compileTasks.get(key);
  if (existing) {
    return existing;
  }
  const task = compileNativeToolUncached(name, defines).catch(error => {
    compileTasks.delete(key);
    throw error;
  });
  compileTasks.set(key, task);
  return task;
}

async function compileNativeToolUncached(
  name = 'desktop_host',
  defines?: string,
): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error(`unsupported_platform:${name}:${process.platform}`);
  }
  const source = join(
    desktopRoot,
    'scripts',
    `${name === 'uia_host' ? 'uia_selection_probe' : name}.cs`,
  );
  const output = join(desktopDataRoot(), `${name}.exe`);
  if (
    existsSync(output) &&
    (!existsSync(source) ||
      statSync(output).mtimeMs >= statSync(source).mtimeMs)
  ) {
    return output;
  }
  mkdirSync(dirname(output), {recursive: true});
  const framework = join(
    process.env.WINDIR || 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
  );
  const references = join(
    process.env.ProgramFiles || 'C:\\Program Files',
    'Reference Assemblies',
    'Microsoft',
    'Framework',
    '.NETFramework',
  );
  const versions = existsSync(references)
    ? readdirSync(references)
        .filter(value => /^v4/.test(value))
        .sort()
        .reverse()
    : [];
  const ref = (dll: string) => {
    for (const version of versions) {
      for (const folder of ['', 'Profile\\Client']) {
        const candidate = join(references, version, folder, dll);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
    const wpf = join(framework, 'WPF', dll);
    return existsSync(wpf) ? wpf : join(framework, dll);
  };
  await runProcess(
    join(framework, 'csc.exe'),
    [
      '/nologo',
      '/target:exe',
      '/platform:x64',
      '/optimize+',
      `/out:${output}`,
      ...(defines ? [`/define:${defines}`] : []),
      ...[
        'System.Core.dll',
        'System.Drawing.dll',
        'System.Windows.Forms.dll',
        'System.Web.Extensions.dll',
        'WindowsBase.dll',
        'UIAutomationClient.dll',
        'UIAutomationTypes.dll',
      ].map(dll => `/reference:${ref(dll)}`),
      source,
    ],
    {timeoutMs: 30000},
  );
  return output;
}

class NativeDesktopHost {
  child?: ChildProcessWithoutNullStreams;
  pending = new Map<
    string,
    {
      accept(value: any): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
      cleanup(): void;
    }
  >();
  startup?: Promise<void>;
  async start(): Promise<void> {
    if (this.child && !this.child.killed) {
      return;
    }
    if (this.startup) {
      return this.startup;
    }
    this.startup = (async () => {
      const executable = await ensureNativeTool('desktop_host');
      const child = spawn(executable, [], {
        cwd: desktopRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          try {
            const response = JSON.parse(line);
            const pending = this.pending.get(String(response.id));
            if (!pending) {
              continue;
            }
            this.pending.delete(String(response.id));
            clearTimeout(pending.timer);
            pending.cleanup();
            if (response.error) {
              pending.reject(
                new Error(
                  String(response.error.code || response.error.message),
                ),
              );
            } else {
              pending.accept(response.result);
            }
          } catch {
            this.fail(new Error('native_desktop_invalid_response'));
          }
        }
      });
      child.stderr.on('data', () => {});
      child.on('error', error => this.fail(error));
      child.on('exit', () => {
        if (this.child === child) {
          this.child = undefined;
          this.fail(new Error('native_desktop_exited'));
        }
      });
    })().finally(() => {
      this.startup = undefined;
    });
    return this.startup;
  }
  fail(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.cleanup();
      entry.reject(error);
    }
    this.pending.clear();
  }
  async request<T = DesktopRecord>(
    method: string,
    params: DesktopRecord = {},
    signal?: AbortSignal,
    timeoutMs = 10000,
  ): Promise<T> {
    signal?.throwIfAborted();
    await this.start();
    signal?.throwIfAborted();
    return new Promise((accept, reject) => {
      const id = randomUUID();
      const cancelPath = signal
        ? join(desktopDataRoot(), `native-cancel-${id}`)
        : '';
      const abort = () => {
        const entry = this.pending.get(id);
        if (!entry) {
          return;
        }
        if (cancelPath) {
          writeFileSync(cancelPath, '');
          const cleanup = setTimeout(() => {
            try {
              unlinkSync(cancelPath);
            } catch {}
          }, 30000);
          cleanup.unref();
        }
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.cleanup();
        reject(signal?.reason || new Error('aborted'));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener('abort', abort);
        reject(new Error(`native_desktop_timeout:${method}`));
        this.child?.kill();
        // Killing the host mid-input could leave keys or buttons down system-wide; a fresh host releases them.
        if (method === 'input') {
          setTimeout(() => {
            this.request('release_input', {}, undefined, 5000).catch(() => {});
          }, 50).unref();
        }
      }, timeoutMs);
      this.pending.set(id, {
        accept,
        reject,
        timer,
        cleanup: () => signal?.removeEventListener('abort', abort),
      });
      signal?.addEventListener('abort', abort, {once: true});
      this.child!.stdin.write(
        `${JSON.stringify({id, method, params: {...params, cancelPath}})}\n`,
        error => {
          if (error) {
            this.fail(error);
          }
        },
      );
    });
  }
  close(): void {
    this.child?.stdin.end();
    this.child = undefined;
    this.fail(new Error('native_desktop_closed'));
  }
}

const host = new NativeDesktopHost();
export async function nativeRequest<T = DesktopRecord>(
  method: string,
  params: DesktopRecord = {},
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  if (process.platform === 'win32') {
    return host.request<T>(method, params, signal, timeoutMs);
  }
  if (process.platform === 'darwin' && method === 'permissions') {
    return JSON.parse(
      await runProcess(
        process.env.MAGIC_POINTER_MACOS_HOST ||
          join(desktopRoot, 'native', 'macos', 'magic-pointer-host'),
        ['--check-permissions'],
        {signal, timeoutMs: timeoutMs || 5000},
      ),
    ) as T;
  }
  throw new Error(`unsupported_platform:${method}:${process.platform}`);
}
export function desktopBusyResult(error: unknown): DesktopRecord | null {
  if (!(error instanceof Error) || error.message !== 'computer_use_busy') {
    return null;
  }
  return {
    awaitingUserInput: true,
    kind: 'desktop_wait',
    question: '等你空出桌面后继续任务？',
    options: ['继续任务', '由我接管'],
    notExecuted: true,
    waitingForDesktop: true,
    usedBackend: 'native_desktop',
  };
}
export async function waitForDesktop(
  action: () => Promise<DesktopRecord>,
  signal?: AbortSignal,
): Promise<DesktopRecord> {
  const deadline = Date.now() + 30000;
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await action();
    } catch (error) {
      signal?.throwIfAborted();
      const waiting = desktopBusyResult(error);
      if (!waiting) {
        throw error;
      }
      if (Date.now() >= deadline) {
        return waiting;
      }
      await delay(250, signal);
    }
  }
}
function elevatedTarget(): ActionFailure {
  return new ActionFailure(
    'permission_denied',
    'target window runs as administrator; Windows drops input from Magic Pointer. Ask the user to do this step or run Magic Pointer as administrator.',
  );
}
function interruptedDesktopInput(): Error {
  const error = new Error(
    'computer_use_interrupted: inspect the current desktop before continuing',
  );
  error.name = 'AbortError';
  return error;
}
function escapedDesktopInput(): Error {
  const error = new Error(
    'computer_use_escape_stop: user pressed Escape to stop desktop automation',
  );
  error.name = 'AbortError';
  return error;
}
async function desktopInput(
  params: DesktopRecord,
  signal?: AbortSignal,
  allowWait = true,
): Promise<DesktopRecord> {
  try {
    return await (allowWait
      ? waitForDesktop(() => nativeRequest('input', params, signal), signal)
      : nativeRequest('input', params, signal));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'computer_use_escape_stop'
    ) {
      nativeRequest('release_input', {}).catch(() => {});
      throw escapedDesktopInput();
    }
    if (
      error instanceof Error &&
      error.message === 'computer_use_interrupted'
    ) {
      throw interruptedDesktopInput();
    }
    if (error instanceof Error && error.message === 'target_elevated') {
      throw elevatedTarget();
    }
    const waiting = allowWait ? desktopBusyResult(error) : null;
    if (waiting) {
      return waiting;
    }
    if (!allowWait && desktopBusyResult(error)) {
      throw interruptedDesktopInput();
    }
    throw error;
  }
}
async function runInputWithObstructionRetry(
  params: DesktopRecord,
  signal?: AbortSignal,
  allowWait = true,
): Promise<DesktopRecord> {
  try {
    return await nonDisruptiveInput(params, signal, allowWait);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (
      params.window?.hwnd &&
      params.delivery !== 'background' &&
      !params.screen_direct &&
      (msg.startsWith('target_obscured') || msg === 'focus_lost')
    ) {
      await desktopInput(
        {action: 'activate_window', window: params.window},
        signal,
      ).catch(() => {});
      await delay(80, signal);
      return nonDisruptiveInput(params, signal, allowWait);
    }
    throw error;
  }
}
async function nonDisruptiveInput(
  params: DesktopRecord,
  signal?: AbortSignal,
  allowWait = true,
): Promise<DesktopRecord> {
  const delivery = String(params.delivery || 'foreground');
  const action = String(params.action || '');
  const canTryBackground =
    delivery === 'background' &&
    ['click', 'type_text', 'press_key', 'scroll'].includes(action) &&
    Number(params.window?.hwnd || 0) > 0;
  if (canTryBackground) {
    try {
      const bg = await nativeRequest<DesktopRecord>('bg_input', params, signal);
      if (bg && bg.ok && !bg.needsForeground) {
        return {
          ...bg,
          delivery:
            bg.usedBackend === 'win32_bg_uia'
              ? 'background_uia'
              : 'background_message',
          disruptedUser: false,
        };
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'target_elevated') {
        throw elevatedTarget();
      }
      signal?.throwIfAborted();
    }
    if (delivery === 'background') {
      return {
        ok: false,
        needsForeground: true,
        delivery: 'background_unavailable',
        disruptedUser: false,
        usedBackend: 'native_desktop',
      };
    }
  }
  const fg = await desktopInput(params, signal, allowWait);
  return {
    ...fg,
    delivery: fg.waitingForDesktop ? 'waiting' : 'cooperative_foreground',
  };
}
export function closeDesktop(): void {
  host.close();
  selectionHost?.kill();
  selectionHost = undefined;
}
export async function listWindows(
  signal?: AbortSignal,
): Promise<DesktopWindow[]> {
  return nativeRequest<DesktopWindow[]>('windows', {}, signal);
}
export async function inspectTrayIcons(
  signal?: AbortSignal,
): Promise<DesktopRecord> {
  return nativeRequest<DesktopRecord>('tray_icons', {}, signal);
}
export async function desktopOverview(
  options: {includeClipboard?: boolean} = {},
  signal?: AbortSignal,
): Promise<DesktopRecord> {
  return nativeRequest<DesktopRecord>(
    'desktop_overview',
    {includeClipboard: options.includeClipboard === true},
    signal,
  );
}
export async function inspectAtPoint(
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<DesktopRecord> {
  return nativeRequest<DesktopRecord>(
    'element_at',
    {x: Math.round(x), y: Math.round(y)},
    signal,
  );
}
async function captureScaledScreenFrame(
  bounds: Rect,
  signal?: AbortSignal,
): Promise<{
  image: string;
  mimeType: string;
  width: number;
  height: number;
} | null> {
  try {
    const frame = await captureSurface(bounds, signal);
    const sharp = (await import('sharp')).default;
    const maxW = Math.min(MAX_OBSERVATION_EDGE, Math.max(1, frame.width));
    const maxH = Math.min(MAX_OBSERVATION_EDGE, Math.max(1, frame.height));
    const jpg = await sharp(frame.bytes)
      .resize({
        width: maxW,
        height: maxH,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({quality: 84})
      .toBuffer({resolveWithObject: true});
    return {
      image: jpg.data.toString('base64'),
      mimeType: 'image/jpeg',
      width: jpg.info.width,
      height: jpg.info.height,
    };
  } catch {
    return null;
  }
}
/** The whole UIA tree of a window; `truncated` says the walk stopped early (row limit, deadline on a hung target, or a mid-walk error) so a missing element is not read as absent. */
export type ElementList = DesktopElement[] & {
  truncated?: 'limit' | 'deadline' | 'error';
};
export async function listElements(
  hwnd: number,
  signal?: AbortSignal,
  limit?: number,
): Promise<ElementList> {
  const result = await nativeRequest<{
    elements: DesktopElement[];
    truncated?: ElementList['truncated'] | null;
  }>('elements', {hwnd, ...(limit ? {limit} : {})}, signal);
  const elements: ElementList = result.elements;
  if (result.truncated) {
    elements.truncated = result.truncated;
  }
  return elements;
}
/** One observed element as it is now, found by runtime id; a vanished element rejects with `stale_element`. */
export function readElement(
  element: DesktopElement,
  signal?: AbortSignal,
): Promise<DesktopElement> {
  return nativeRequest<DesktopElement>('element', {element}, signal);
}

export async function executeGuidedClickStep(input: {
  x: number;
  y: number;
  displayBounds?: [number, number, number, number];
}): Promise<{
  ok: boolean;
  clicked: {x: number; y: number};
  snappedControl?: SnappedDesktopControl;
  visualDelta: {screenChanged: boolean; method: string; elapsedMs: number};
  error?: string;
}> {
  const started = Date.now();
  let targetX = Math.round(Number(input.x));
  let targetY = Math.round(Number(input.y));
  let snappedControl: SnappedDesktopControl | undefined;
  let targetWindow: DesktopWindow | undefined;
  try {
    const windows = await listWindows();
    targetWindow = windows.find(
      w =>
        w.pid !== process.pid &&
        Array.isArray(w.bbox) &&
        w.bbox.length === 4 &&
        targetX >= w.bbox[0] &&
        targetX <= w.bbox[2] &&
        targetY >= w.bbox[1] &&
        targetY <= w.bbox[3],
    );
    if (targetWindow) {
      const elements = await listElements(targetWindow.hwnd).catch(() => []);
      const snapped = snapDesktopPointToElement(
        targetX,
        targetY,
        elements,
        targetWindow,
      );
      if (snapped.snappedControl) {
        targetX = snapped.x;
        targetY = snapped.y;
        snappedControl = snapped.snappedControl;
      }
    }
  } catch {
    /* Fall back to raw target coordinates if window/UIA inspection fails. */
  }
  const bbox: [number, number, number, number] = targetWindow?.bbox ??
    input.displayBounds ?? [
      Math.max(0, targetX - 160),
      Math.max(0, targetY - 120),
      targetX + 160,
      targetY + 120,
    ];
  let beforeBytes: Buffer | null = null;
  try {
    const beforeFrame = await captureSurface(
      bbox,
      undefined,
      targetWindow?.hwnd,
    );
    beforeBytes = beforeFrame.bytes;
  } catch {
    beforeBytes = null;
  }
  try {
    const clickRes = await desktopInput({
      action: 'click',
      button: 'left',
      count: 1,
      x: targetX,
      y: targetY,
      ...(targetWindow ? {window: targetWindow} : {}),
    });
    if (clickRes.waitingForDesktop) {
      return {
        ok: false,
        clicked: {x: targetX, y: targetY},
        ...(snappedControl ? {snappedControl} : {}),
        visualDelta: {
          screenChanged: false,
          method: 'desktop_busy',
          elapsedMs: Date.now() - started,
        },
        error: 'desktop_busy',
      };
    }
  } catch (error) {
    return {
      ok: false,
      clicked: {x: targetX, y: targetY},
      ...(snappedControl ? {snappedControl} : {}),
      visualDelta: {
        screenChanged: false,
        method: 'click_failed',
        elapsedMs: Date.now() - started,
      },
      error: error instanceof Error ? error.message : String(error),
    };
  }
  let screenChanged = false;
  let method = 'capture_unavailable';
  if (beforeBytes) {
    try {
      await delay(140);
      const afterFrame = await captureSurface(
        bbox,
        undefined,
        targetWindow?.hwnd,
      );
      const sharp = (await import('sharp')).default;
      const [beforeRaw, afterRaw] = await Promise.all([
        sharp(beforeBytes)
          .resize(320, 180, {fit: 'fill'})
          .raw()
          .toBuffer({resolveWithObject: true}),
        sharp(afterFrame.bytes)
          .resize(320, 180, {fit: 'fill'})
          .raw()
          .toBuffer(),
      ]);
      screenChanged = patchesDiffer(
        beforeRaw.data,
        afterRaw,
        beforeRaw.info.channels,
      );
      method = 'guided_step_pixel_diff';
    } catch {
      screenChanged = true;
      method = 'window_closed_or_resized';
    }
  }
  return {
    ok: true,
    clicked: {x: targetX, y: targetY},
    ...(snappedControl ? {snappedControl} : {}),
    visualDelta: {screenChanged, method, elapsedMs: Date.now() - started},
  };
}
export async function captureSurface(
  bounds: Rect,
  signal?: AbortSignal,
  hwnd?: number,
): Promise<{
  bytes: Buffer;
  width: number;
  height: number;
  source: string;
  capturedAtUtc: string;
}> {
  const result = await nativeRequest(
    'capture',
    {bounds, ...(hwnd ? {hwnd} : {})},
    signal,
  );
  return {
    bytes: Buffer.from(result.png, 'base64'),
    width: result.width,
    height: result.height,
    source: result.source,
    capturedAtUtc: result.capturedAtUtc,
  };
}

let selectionHost: ChildProcessWithoutNullStreams | undefined;
let selectionHostStarting: Promise<void> | undefined;
let probeFailures = 0;
let probeOpenUntil = 0;
let selectionRequestSequence = 0;
async function startSelectionHost(): Promise<void> {
  if (selectionHost && !selectionHost.killed) {
    return;
  }
  selectionHostStarting ??= (async () => {
    const executable = await ensureNativeTool('uia_host', 'RESIDENT_HOST');
    selectionHost = spawn(executable, [], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: desktopRoot,
    });
    selectionHost.stdout.on('data', () => {});
    selectionHost.stderr.on('data', () => {});
    selectionHost.on('error', () => {
      selectionHost = undefined;
    });
    selectionHost.on('exit', () => {
      selectionHost = undefined;
    });
  })().finally(() => {
    selectionHostStarting = undefined;
  });
  return selectionHostStarting;
}

export async function probeSelection(
  hwnd: number,
  target: {
    point?: {x: number; y: number};
    region?: {x: number; y: number; width: number; height: number};
    signal?: AbortSignal;
  } = {},
): Promise<DesktopRecord> {
  target.signal?.throwIfAborted();
  const parts: Array<string | number> = [hwnd];
  if (target.region) {
    parts.push(
      'region',
      target.region.x,
      target.region.y,
      target.region.width,
      target.region.height,
    );
  } else if (target.point) {
    parts.push(target.point.x, target.point.y);
  }
  if (Date.now() >= probeOpenUntil) {
    try {
      await startSelectionHost();
      const id = String(++selectionRequestSequence);
      const result = await new Promise<DesktopRecord>((accept, reject) => {
        const deadline = Date.now() + 1500;
        const connect = () => {
          target.signal?.throwIfAborted();
          const socket = createConnection(
            `\\\\.\\pipe\\${process.env.MAGIC_POINTER_UIA_HOST_PIPE || 'MagicPointerUIAHost'}`,
          );
          let text = '';
          const abort = () => socket.destroy(new Error('aborted'));
          target.signal?.addEventListener('abort', abort, {once: true});
          socket.setTimeout(6000, () =>
            socket.destroy(new Error('uia_probe_timeout')),
          );
          socket.on('connect', () =>
            socket.write(`${id}|${parts.join('|')}\n`),
          );
          socket.on('data', chunk => {
            text += chunk.toString('utf8');
            if (text.includes('\n')) {
              socket.end();
              try {
                const value = JSON.parse(text.split('\n')[0]);
                if (String(value.id) !== id) {
                  throw new Error('uia_response_identity_mismatch');
                }
                delete value.id;
                accept(value);
              } catch (error) {
                reject(error);
              }
            }
          });
          socket.on('close', () =>
            target.signal?.removeEventListener('abort', abort),
          );
          socket.on('error', error => {
            if (
              (error as NodeJS.ErrnoException).code === 'ENOENT' &&
              Date.now() < deadline &&
              !target.signal?.aborted
            ) {
              setTimeout(connect, 30);
            } else {
              reject(error);
            }
          });
        };
        connect();
      });
      probeFailures = 0;
      return result;
    } catch (error) {
      if (target.signal?.aborted) {
        throw error;
      }
      if (++probeFailures >= 3) {
        probeOpenUntil = Date.now() + 30000;
        probeFailures = 0;
      }
    }
  }
  const executable = await ensureNativeTool('uia_selection_probe');
  return JSON.parse(
    (
      await runProcess(
        executable,
        parts.map(value => (value === 'region' ? '--region' : String(value))),
        {signal: target.signal, timeoutMs: 6000},
      )
    ).trim(),
  );
}

function fingerprint(element: DesktopElement): unknown {
  return [
    element.runtime_id,
    element.role,
    element.name,
    element.rect,
    element.patterns,
    element.value,
  ];
}
function identity(window: DesktopWindow): unknown {
  return [window.hwnd, window.pid, window.bbox, window.processStartTime];
}
type WindowReadScope = (hwnd: number) => {allowed: boolean; reason: string};
function requireWindowRead(hwnd: number, scope?: WindowReadScope): void {
  const access = scope?.(hwnd);
  if (access && !access.allowed) {
    throw new ActionFailure('permission_denied', access.reason);
  }
}
export function isWindowProcessAlive(pid: unknown): boolean {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) {
    return false;
  }
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

const effectRank: Effect[] = [
  'read',
  'reversible_write',
  'local_irreversible',
  'external_send',
  'destructive',
  'purchase',
];
function strongerEffect(left: Effect, right: Effect): Effect {
  return effectRank.indexOf(left) >= effectRank.indexOf(right) ? left : right;
}
const MESSAGING_PROCESS_RE =
  /(wechat|weixin|qq|dingtalk|feishu|lark|slack|teams|discord|telegram|outlook|thunderbird|foxmail|whatsapp)/i;

function actionEffect(
  name: string,
  args: DesktopRecord,
  session?: DesktopActionSession,
): Effect {
  if (
    [
      'list_apps',
      'list_windows',
      'get_app_state',
      'find_roots',
      'observe_ui',
      'search_ui',
      'inspect_ui',
      'expand_ui',
      'read_text',
      'wait_for',
      'turn_ended',
    ].includes(name)
  ) {
    return 'read';
  }
  const declared =
    (
      {
        send: 'external_send',
        submit: 'external_send',
        delete: 'destructive',
        run: 'local_irreversible',
        purchase: 'purchase',
      } as Record<string, Effect>
    )[String(args.intent || '')] || 'reversible_write';
  if (name === 'act_ui') {
    const actions = Array.isArray(args.actions) ? args.actions : [];
    return actions.reduce((effect: Effect, action: DesktopRecord) => {
      const kind = String(action.action || action.kind || '');
      const mapped =
        (
          {
            click: 'click',
            press: 'click',
            keypress: 'press_key',
            typeText: 'type_text',
          } as Record<string, string>
        )[kind] || kind;
      return strongerEffect(
        effect,
        actionEffect(
          mapped,
          {...action, snapshot_id: args.snapshot_id || args.state_id},
          session,
        ),
      );
    }, declared);
  }
  let observed: Effect = 'reversible_write';
  if (name === 'window_manage' && args.action === 'close') {
    observed = 'local_irreversible';
  }
  if ((name === 'type_text' || name === 'paste') && args.submit) {
    const snap = session?.snapshots.get(
      String(args.snapshot_id || args.state_id || ''),
    );
    if (
      args.intent === 'send' ||
      args.intent === 'submit' ||
      (snap?.window &&
        snap.window.desktop !== 'agent' &&
        MESSAGING_PROCESS_RE.test(String(snap.window.process_name || '')))
    ) {
      observed = 'external_send';
    }
  }
  if (name === 'press_key') {
    const keys = String(args.keys || '')
      .toLowerCase()
      .split(/[+\s]+/)
      .filter(Boolean);
    if (keys.some(key => ['delete', 'del'].includes(key))) {
      observed = 'destructive';
    } else if (
      keys.some(key => ['enter', 'return'].includes(key)) &&
      !keys.includes('shift')
    ) {
      const snap = session?.snapshots.get(
        String(args.snapshot_id || args.state_id || ''),
      );
      if (
        snap?.window &&
        snap.window.desktop !== 'agent' &&
        MESSAGING_PROCESS_RE.test(String(snap.window.process_name || ''))
      ) {
        observed = 'external_send';
      }
    }
  }
  if (['click', 'perform_secondary_action'].includes(name)) {
    const snapshot = session?.snapshots.get(
      String(args.snapshot_id || args.state_id || ''),
    );
    const index =
      args.index ??
      (String(args.ref || '').startsWith('@e')
        ? Number(String(args.ref).slice(2))
        : undefined);
    const candidates =
      snapshot?.elements.filter(element =>
        index !== undefined
          ? element.index === Number(index)
          : Number.isFinite(args.x) &&
            Number.isFinite(args.y) &&
            element.rect[0] <= args.x &&
            args.x < element.rect[2] &&
            element.rect[1] <= args.y &&
            args.y < element.rect[3],
      ) || [];
    const labels = candidates
      .map(element => String(element.name || ''))
      .join(' ')
      .toLowerCase();
    if (
      ['delete', 'remove', '删除', '永久移除', '清空'].some(word =>
        labels.includes(word),
      )
    ) {
      observed = 'destructive';
    } else if (
      ['send', 'submit', '发送', '提交', '发布'].some(word =>
        labels.includes(word),
      )
    ) {
      observed = 'external_send';
    }
  }
  return strongerEffect(declared, observed);
}

export interface DesktopCursorEvent {
  action: 'approach' | 'click' | 'move' | 'guide' | 'clear';
  x: number;
  y: number;
  caption?: string;
  nextStep?: string;
  windowTitle?: string;
  phase?: 'thinking' | 'acting';
  button?: string;
  count?: number;
  ttlMs?: number;
}

export interface CachedScreenshotRegion {
  id: string;
  bounds: Rect;
  width: number;
  height: number;
  scale: number;
  hwnd?: number;
  kind: 'screen' | 'zoom' | 'window' | 'frozen_frame';
  createdAt: number;
}

export class DesktopActionSession {
  readonly snapshots = new Map<string, DesktopSnapshot>();
  readonly screenshotCache = new Map<string, CachedScreenshotRegion>();
  private screenshotSeq = 0;
  readonly roots = new Map<string, number>();
  lastScreenBounds: Rect = [0, 0, 1920, 1080];
  onCursorEvent?: (event: DesktopCursorEvent) => void;
  readonly observation = {
    windows: listWindows,
    elements: listElements,
    element: readElement,
  };
  constructor(
    readonly sessionId: string = randomUUID(),
    readonly originWindowHwnd?: number,
  ) {}
  registerScreenshot(meta: {
    id?: string;
    bounds: Rect;
    width: number;
    height: number;
    scale?: number;
    hwnd?: number;
    kind: 'screen' | 'zoom' | 'window' | 'frozen_frame';
  }): string {
    const id = String(meta.id || `shot-${++this.screenshotSeq}`);
    const [left, top, right, bottom] = meta.bounds;
    const spanW = Math.max(1, right - left);
    const width = Math.max(1, Math.round(meta.width));
    const height = Math.max(1, Math.round(meta.height));
    const scale =
      typeof meta.scale === 'number' &&
      Number.isFinite(meta.scale) &&
      meta.scale > 0
        ? meta.scale
        : width / spanW;
    this.screenshotCache.set(id, {
      id,
      bounds: [
        Math.round(left),
        Math.round(top),
        Math.round(right),
        Math.round(bottom),
      ],
      width,
      height,
      scale,
      ...(meta.hwnd ? {hwnd: meta.hwnd} : {}),
      kind: meta.kind,
      createdAt: Date.now(),
    });
    while (this.screenshotCache.size > 32) {
      let evictKey: string | undefined;
      for (const k of this.screenshotCache.keys()) {
        if (k !== 'pointer_frozen_frame') {
          evictKey = k;
          break;
        }
      }
      if (!evictKey) {
        break;
      }
      this.screenshotCache.delete(evictKey);
    }
    return id;
  }
  resolveScreenshotPoint(
    screenshotId: string,
    x: number,
    y: number,
  ): {x: number; y: number; bounds: Rect; hwnd?: number} {
    const entry = this.screenshotCache.get(String(screenshotId || '').trim());
    if (!entry) {
      throw new ActionFailure(
        'stale_snapshot',
        `screenshot_id '${String(screenshotId)}' not found; call see_screen, zoom_screen, or get_app_state again`,
      );
    }
    const rawX = Number(x);
    const rawY = Number(y);
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
      throw new Error('pass finite x and y coordinates for screenshot_id');
    }
    const [left, top, right, bottom] = entry.bounds;
    const bw = Math.max(1, right - left);
    const bh = Math.max(1, bottom - top);
    const sx =
      entry.width > 0
        ? Math.round(left + (rawX / entry.width) * bw)
        : Math.round(left + rawX / (entry.scale || 1));
    const sy =
      entry.height > 0
        ? Math.round(top + (rawY / entry.height) * bh)
        : Math.round(top + rawY / (entry.scale || 1));
    return {
      x: sx,
      y: sy,
      bounds: entry.bounds,
      ...(entry.hwnd ? {hwnd: entry.hwnd} : {}),
    };
  }
  seedFrozenFrame(snapshot: Record<string, unknown>): string | null {
    if (!snapshot || typeof snapshot !== 'object') {
      return null;
    }
    const tw =
      snapshot.target_window && typeof snapshot.target_window === 'object'
        ? (snapshot.target_window as DesktopRecord)
        : undefined;
    const rawBounds = Array.isArray(snapshot.selection_crop_bounds)
      ? snapshot.selection_crop_bounds
      : Array.isArray(snapshot.crop_bounds)
        ? snapshot.crop_bounds
        : Array.isArray(tw?.bbox)
          ? tw.bbox
          : null;
    if (!rawBounds || rawBounds.length !== 4) {
      return null;
    }
    const nums = rawBounds.map(v => Number(v));
    if (nums.some(v => !Number.isFinite(v))) {
      return null;
    }
    const [l, t, r, b] = nums as Rect;
    if (r <= l || b <= t) {
      return null;
    }
    const width = Number(snapshot.selection_crop_width) || r - l;
    const height = Number(snapshot.selection_crop_height) || b - t;
    const hwndVal = Number(
      tw?.hwnd || snapshot.target_window_hwnd || snapshot.hwnd || 0,
    );
    return this.registerScreenshot({
      id: 'pointer_frozen_frame',
      bounds: [l, t, r, b],
      width,
      height,
      ...(Number.isFinite(hwndVal) && hwndVal > 0 ? {hwnd: hwndVal} : {}),
      kind: 'frozen_frame',
    });
  }
  emitCursor(event: DesktopCursorEvent): void {
    try {
      this.onCursorEvent?.(event);
    } catch {
      /* Visual cursor overlay failures must never abort CU actions. */
    }
  }
  windowCenter(window: DesktopWindow): {x: number; y: number} {
    const [l, t, r, b] = window.bbox;
    return {
      x: Math.round((l + r) / 2),
      y: Math.round((t + b) / 2),
    };
  }
  cursorCaption(
    name: string,
    args: DesktopRecord,
    window?: DesktopWindow,
    element?: DesktopElement,
  ): string {
    const custom = String(args.label || '').trim();
    if (custom) {
      return custom.slice(0, 32);
    }
    const winLabel = String(
      window?.title || window?.process_name || '窗口',
    ).slice(0, 14);
    switch (name) {
      case 'click':
        return element?.name
          ? `点击「${String(element.name).slice(0, 14)}」`
          : args.button === 'right'
            ? '右键点击'
            : Number(args.count) === 2
              ? '双击'
              : '点击';
      case 'type_text':
        return `输入「${String(args.text || '').slice(0, 12)}」`;
      case 'paste':
        return `粘贴「${String(args.text || '').slice(0, 12)}」`;
      case 'move':
        return '移动光标';
      case 'press_key':
        return `按键 ${String(args.keys || '').slice(0, 14)}`;
      case 'scroll':
        return '滚动浏览';
      case 'drag':
        return '拖拽操作';
      case 'set_value':
        return element?.name
          ? `填写「${String(element.name).slice(0, 12)}」`
          : '填写内容';
      case 'perform_secondary_action':
        return `执行 ${String(args.action || '操作').slice(0, 12)}`;
      case 'observe_ui':
      case 'get_app_state':
        return `查看「${winLabel}」`;
      case 'activate_window':
        return `切换「${winLabel}」`;
      case 'launch_app':
        return `打开 ${String(args.app || '应用').slice(0, 14)}`;
      case 'window_manage':
        return `调整「${winLabel}」`;
      default:
        return name;
    }
  }
  rootRef(hwnd: number): string {
    for (const [ref, value] of this.roots) {
      if (value === hwnd) {
        return ref;
      }
    }
    const ref = `@r${this.roots.size + 1}`;
    this.roots.set(ref, hwnd);
    return ref;
  }
  resolveScreenPoint(
    args: DesktopRecord,
    keys: [string, string] = ['x', 'y'],
  ): {x: number; y: number} {
    const rawX = Number(args[keys[0]]);
    const rawY = Number(args[keys[1]]);
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
      throw new Error(`pass numeric ${keys[0]} and ${keys[1]}`);
    }
    if (args.coordinate_space === 'normalized') {
      const [left, top, right, bottom] = this.lastScreenBounds;
      const width = Math.max(1, right - left);
      const height = Math.max(1, bottom - top);
      const nx = Math.max(0, Math.min(1000, rawX));
      const ny = Math.max(0, Math.min(1000, rawY));
      return {
        x: Math.round(left + (nx / 1000) * width),
        y: Math.round(top + (ny / 1000) * height),
      };
    }
    return {x: Math.round(rawX), y: Math.round(rawY)};
  }
  toScreen(
    snapshot: DesktopSnapshot,
    args: DesktopRecord,
    keys: [string, string] = ['x', 'y'],
  ): {x: number; y: number} {
    const x = Number(args[keys[0]]);
    const y = Number(args[keys[1]]);
    if (args.coordinate_space === 'normalized') {
      const [left, top, right, bottom] = snapshot.window.bbox;
      const width = Math.max(1, right - left);
      const height = Math.max(1, bottom - top);
      const nx = Math.max(0, Math.min(1000, x));
      const ny = Math.max(0, Math.min(1000, y));
      return {
        x: Math.round(left + (nx / 1000) * width),
        y: Math.round(top + (ny / 1000) * height),
      };
    }
    if (args.coordinate_space !== 'image') {
      return {x, y};
    }
    if (!snapshot.imageScale) {
      throw new ActionFailure(
        'stale_snapshot',
        'image coordinates need an observation that returned an image',
      );
    }
    return {
      x: Math.round(snapshot.window.bbox[0] + x / snapshot.imageScale),
      y: Math.round(snapshot.window.bbox[1] + y / snapshot.imageScale),
    };
  }
  async resolveWindow(
    args: DesktopRecord = {},
    signal?: AbortSignal,
  ): Promise<DesktopWindow> {
    const allWindows = await this.observation.windows(signal);
    const appQuery = String(args.app || '').trim().toLowerCase();
    const windows = appQuery.includes('magic pointer')
      ? allWindows
      : allWindows.filter(row => !/^Magic Pointer(?: |$)/i.test(row.title));
    const id =
      args.hwnd ||
      (args.root ? this.roots.get(args.root) : undefined) ||
      Number(String(args.window_id || '').replace(/^w-/, ''));
    const titleQuery = String(args.title || '').trim().toLowerCase();
    const candidates = windows
      .filter(window => !id || window.hwnd === Number(id))
      .filter(
        window => args.pid === undefined || window.pid === Number(args.pid),
      )
      .filter(
        window =>
          !appQuery ||
          `${window.process_name} ${window.title}`
            .toLowerCase()
            .includes(appQuery),
      )
      .filter(
        window =>
          !titleQuery ||
          String(window.title || '')
            .toLowerCase()
            .includes(titleQuery),
      );
    const window =
      candidates.find(
        row =>
          !id &&
          !appQuery &&
          !titleQuery &&
          row.hwnd === this.originWindowHwnd &&
          isWindowProcessAlive(row.pid),
      ) ||
      candidates.find(row => row.focused) ||
      candidates[0];
    if (!window && id && !appQuery && !titleQuery) {
      const priorSnap = [...this.snapshots.values()]
        .reverse()
        .find(s => s.window.hwnd === Number(id));
      if (priorSnap) {
        const procLower = String(
          priorSnap.window.process_name || '',
        ).toLowerCase();
        const titleLower = String(priorSnap.window.title || '').toLowerCase();
        const sameProc = windows.filter(
          w =>
            (args.pid === undefined || w.pid === Number(args.pid)) &&
            String(w.process_name || '').toLowerCase() === procLower &&
            isWindowProcessAlive(w.pid),
        );
        const rehydrated =
          (titleLower
            ? sameProc.find(w =>
                String(w.title || '')
                  .toLowerCase()
                  .includes(titleLower.slice(0, 24)),
              )
            : undefined) ||
          sameProc.find(w => w.focused) ||
          sameProc[0];
        if (rehydrated) {
          return rehydrated;
        }
      }
    }
    if (!window) {
      const availableSummary = windows
        .slice(0, 12)
        .map(
          w =>
            `"${w.title || '(untitled)'}" [${w.process_name || 'app'} hwnd:${w.hwnd} pid:${w.pid}]`,
        )
        .join('; ');
      throw new ActionFailure(
        'tool_error',
        availableSummary
          ? `window not found. Available windows: ${availableSummary}`
          : 'window not found (no visible windows)',
      );
    }
    return window;
  }
  async observe(
    args: DesktopRecord = {},
    signal?: AbortSignal,
    readScope?: WindowReadScope,
    capture: SurfaceCapture = captureSurface,
    autoBindTarget?: (window: DesktopWindow) => unknown | Promise<unknown>,
  ): Promise<DesktopSnapshot> {
    const window = await this.resolveWindow(args, signal);
    if (autoBindTarget && readScope?.(window.hwnd).allowed === false) {
      await autoBindTarget(window);
    }
    requireWindowRead(window.hwnd, readScope);
    const mode = String(args.mode || 'ax');
    if (mode === 'all') {
      throw new Error("mode 'all' is illegal");
    }
    const elements = ['image', 'visual'].includes(mode)
      ? []
      : await this.observation.elements(window.hwnd, signal);
    const snapshot_id = randomUUID();
    const snapshot: DesktopSnapshot = {
      snapshot_id,
      state_id: snapshot_id,
      window,
      windows: [window],
      elements,
      root_ref: this.rootRef(window.hwnd),
      mode,
    };
    // A tree with almost nothing actionable (self-drawn Qt/Electron/game UI) is useless on its own: add pixels.
    const sparse =
      args.pixels !== false &&
      elements.filter(element => actionable(element, window)).length < 3;
    const explicit = ['full', 'image', 'visual'].includes(mode);
    if (explicit || sparse) {
      try {
        snapshot.surface = (
          await capture(window.bbox, signal, window.hwnd)
        ).bytes;
      } catch (error) {
        signal?.throwIfAborted();
        if (explicit) {
          throw error;
        }
      }
    }
    if (snapshot.surface) {
      try {
        const marked = await markedObservationImage(
          snapshot.surface,
          window,
          elements,
        );
        Object.assign(snapshot, {
          markedImage: marked.bytes,
          imageScale: marked.scale,
          marks: marked.marks,
        });
      } catch {
        signal?.throwIfAborted();
      }
    }
    this.snapshots.set(snapshot_id, snapshot);
    while (this.snapshots.size > 32) {
      this.snapshots.delete(this.snapshots.keys().next().value!);
    }
    for (const old of [...this.snapshots.values()].slice(0, -8)) {
      delete old.surface;
      delete old.markedImage;
    }
    return snapshot;
  }
  async requireSnapshot(
    id: unknown,
    signal?: AbortSignal,
    indexes: number[] = [],
  ): Promise<DesktopSnapshot> {
    const snapshot = this.snapshots.get(String(id || ''));
    if (!snapshot) {
      throw new ActionFailure(
        'stale_snapshot',
        'snapshot_id is required; call Observe again',
      );
    }
    const live = await nativeRequest<DesktopWindow>(
      'window',
      {hwnd: snapshot.window.hwnd},
      signal,
    );
    if (!isDeepStrictEqual(identity(live), identity(snapshot.window))) {
      throw new ActionFailure(
        'stale_snapshot',
        'window moved, resized, or changed process; call Observe again',
      );
    }
    if (indexes.length) {
      for (const index of indexes) {
        const original = snapshot.elements.find(row => row.index === index);
        const current =
          original &&
          (await this.observation
            .element(original, signal)
            .catch((error: Error) => {
              if (
                /stale_element|element_lookup_timeout|uia_deadline/.test(
                  error.message,
                )
              ) {
                return undefined;
              }
              throw error;
            }));
        if (
          !original ||
          !current ||
          !isDeepStrictEqual(fingerprint(original), fingerprint(current))
        ) {
          throw new ActionFailure(
            'stale_snapshot',
            `element ${index} changed; call Observe again`,
          );
        }
      }
    }
    return snapshot;
  }
  element(
    snapshot: DesktopSnapshot,
    args: DesktopRecord,
  ): DesktopElement | undefined {
    const index =
      args.index ??
      (args.ref ? Number(String(args.ref).replace(/^@e/, '')) : undefined);
    if (index === undefined) {
      return undefined;
    }
    const element = snapshot.elements.find(row => row.index === Number(index));
    if (!element) {
      throw new ActionFailure('stale_snapshot', 'element ref is stale');
    }
    return element;
  }
  actionTarget(snapshot: DesktopSnapshot, args: DesktopRecord): DesktopRecord {
    return {
      windowHwnd: snapshot.window.hwnd,
      pid: snapshot.window.pid,
      stateId: snapshot.state_id,
      ...(args.ref
        ? {ref: String(args.ref)}
        : args.index !== undefined
          ? {index: Number(args.index)}
          : {}),
      ...(Number.isFinite(args.x) && Number.isFinite(args.y)
        ? {x: Number(args.x), y: Number(args.y)}
        : {}),
    };
  }
  async point(
    snapshot: DesktopSnapshot,
    args: DesktopRecord,
    signal?: AbortSignal,
  ): Promise<{
    x: number;
    y: number;
    element?: DesktopElement;
    snappedControl?: SnappedDesktopControl;
    pixelDriftDetected?: boolean;
  }> {
    const element = this.element(snapshot, args);
    if (element && (args.x !== undefined || args.y !== undefined)) {
      throw new Error('pass exactly one of index/ref or x/y coordinates');
    }
    let x: number;
    let y: number;
    let resolvedElement = element;
    let snappedControl: SnappedDesktopControl | undefined;
    let pixelDriftDetected = false;
    if (resolvedElement) {
      await this.requireSnapshot(snapshot.snapshot_id, signal, [
        resolvedElement.index,
      ]);
      x = Math.round((resolvedElement.rect[0] + resolvedElement.rect[2]) / 2);
      y = Math.round((resolvedElement.rect[1] + resolvedElement.rect[3]) / 2);
    } else {
      if (
        typeof args.screenshot_id === 'string' &&
        args.screenshot_id.trim() &&
        Number.isFinite(Number(args.x)) &&
        Number.isFinite(Number(args.y))
      ) {
        ({x, y} = this.resolveScreenshotPoint(
          String(args.screenshot_id),
          Number(args.x),
          Number(args.y),
        ));
      } else {
        ({x, y} = this.toScreen(snapshot, args));
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error('pass index/ref or both x and y');
      }
      if (!snapshot.surface) {
        throw new ActionFailure(
          'stale_snapshot',
          'coordinate actions require an observation with an image (mode=full)',
        );
      }
      const snapped = snapDesktopPointToElement(
        x,
        y,
        snapshot.elements,
        snapshot.window,
      );
      if (snapped.snappedControl) {
        x = snapped.x;
        y = snapped.y;
        resolvedElement = snapped.element;
        snappedControl = snapped.snappedControl;
      }
      const [left, top, right, bottom] = snapshot.window.bbox;
      if (x < left || x >= right || y < top || y >= bottom) {
        return {x, y, element: resolvedElement, snappedControl};
      }
      const sharp = (await import('sharp')).default;
      const live = await captureSurface(
        snapshot.window.bbox,
        signal,
        snapshot.window.hwnd,
      );
      const region = {
        left: Math.max(0, Math.round(x - left - 32)),
        top: Math.max(0, Math.round(y - top - 32)),
        width: 0,
        height: 0,
      };
      region.width = Math.min(65, right - left - region.left);
      region.height = Math.min(65, bottom - top - region.top);
      if (region.width <= 0 || region.height <= 0) {
        throw new ActionFailure('stale_snapshot', 'point outside surface');
      }
      const [before, after] = await Promise.all([
        sharp(snapshot.surface)
          .extract(region)
          .raw()
          .toBuffer({resolveWithObject: true}),
        sharp(live.bytes).extract(region).raw().toBuffer(),
      ]);
      if (patchesDiffer(before.data, after, before.info.channels)) {
        if (args.strict_pixel_guard === true) {
          throw new ActionFailure(
            'stale_snapshot',
            'target pixels changed since snapshot; call Observe again',
          );
        }
        // Self-drawn players/canvases/animations continuously mutate pixels; log drift without blocking interaction.
        pixelDriftDetected = true;
      }
    }
    return {
      x,
      y,
      element: resolvedElement,
      snappedControl,
      ...(pixelDriftDetected ? {pixelDriftDetected} : {}),
    };
  }
  async call(
    name: string,
    args: DesktopRecord = {},
    signal?: AbortSignal,
    readScope?: WindowReadScope,
    autoBindTarget?: (window: DesktopWindow) => unknown | Promise<unknown>,
  ): Promise<DesktopRecord> {
    signal?.throwIfAborted();
    const discoverable = (window: DesktopWindow) =>
      !autoBindTarget && readScope?.(window.hwnd).allowed === false
        ? {...window, title: ''}
        : window;
    if (name === 'list_apps' || name === 'list_windows') {
      const rows = (await this.observation.windows(signal))
        .map(discoverable)
        .map(row => ({
          ...row,
          window_id: row.window_id || `w-${row.hwnd}`,
          desktop: row.desktop || 'default',
        }));
      return name === 'list_windows'
        ? {windows: rows, count: rows.length, usedBackend: 'win32_windows'}
        : {apps: rows, usedBackend: 'win32_windows'};
    }
    if (name === 'window_manage') {
      const window = await this.resolveWindow(args, signal);
      if (autoBindTarget) {
        await autoBindTarget(window);
      }
      requireWindowRead(window.hwnd, readScope);
      const center = this.windowCenter(window);
      this.emitCursor({
        action: 'move',
        ...center,
        caption: this.cursorCaption(name, args, window),
        nextStep: String(args.next_step || '').trim() || undefined,
        windowTitle: window.title || window.process_name,
        phase: 'acting',
      });
      const res = await nativeRequest<DesktopRecord>(
        'window_manage',
        {
          hwnd: window.hwnd,
          action: String(args.action || 'restore'),
          ...(args.x !== undefined ? {x: Number(args.x)} : {}),
          ...(args.y !== undefined ? {y: Number(args.y)} : {}),
          ...(args.width !== undefined ? {width: Number(args.width)} : {}),
          ...(args.height !== undefined ? {height: Number(args.height)} : {}),
        },
        signal,
      );
      return {
        ...res,
        window,
        usedBackend: 'win32_window_manage',
      };
    }
    if (name === 'find_roots') {
      const windows = (await this.observation.windows(signal)).map(
        discoverable,
      );
      const roots = windows
        .filter(
          row =>
            (!args.text ||
              `${row.title} ${row.process_name}`
                .toLowerCase()
                .includes(String(args.text).toLowerCase())) &&
            (!args.pid || row.pid === Number(args.pid)) &&
            (!args.app ||
              String(row.process_name)
                .toLowerCase()
                .includes(String(args.app).toLowerCase())),
        )
        .map(row => ({
          ...row,
          root_ref: this.rootRef(row.hwnd),
          window_id: `w-${row.hwnd}`,
          kind: 'window',
        }));
      return {
        roots: roots.slice(0, 32),
        total: roots.length,
        usedBackend: 'win32_windows',
      };
    }
    if (name === 'get_app_state' || name === 'observe_ui') {
      const snapshot = await this.observe(
        args,
        signal,
        readScope,
        captureSurface,
        autoBindTarget,
      );
      const center = this.windowCenter(snapshot.window);
      this.emitCursor({
        action: 'move',
        ...center,
        caption: this.cursorCaption(name, args, snapshot.window),
        nextStep: String(args.next_step || '').trim() || undefined,
        windowTitle: snapshot.window.title || snapshot.window.process_name,
        phase: 'thinking',
      });
      const {
        surface: _surface,
        markedImage,
        marks: _marks,
        ...publicSnapshot
      } = snapshot;
      const [winLeft, winTop, winRight, winBottom] = snapshot.window.bbox;
      const screenshotId = markedImage
        ? this.registerScreenshot({
            bounds: snapshot.window.bbox,
            width: Math.max(
              1,
              Math.round((winRight - winLeft) * (snapshot.imageScale || 1)),
            ),
            height: Math.max(
              1,
              Math.round((winBottom - winTop) * (snapshot.imageScale || 1)),
            ),
            scale: snapshot.imageScale || 1,
            hwnd: snapshot.window.hwnd,
            kind: 'window',
          })
        : undefined;
      const image = markedImage
        ? {
            image: markedImage.toString('base64'),
            mimeType: 'image/png',
            ...(screenshotId ? {screenshot_id: screenshotId} : {}),
            imageLabel: `${snapshot.window.title || snapshot.window.process_name} (state ${snapshot.state_id}); boxes are labelled with element refs`,
            imageSpace: {
              scale: snapshot.imageScale,
              origin: snapshot.window.bbox.slice(0, 2),
              hint: "click by ref when a box covers the target; otherwise pass the image x/y with coordinate_space:'image' or screenshot_id",
            },
          }
        : {};
      const priority = (row: DesktopElement) =>
        row.focused
          ? 3
          : actionable(row, snapshot.window)
            ? 2
            : row.name
              ? 1
              : 0;
      const outline = [...snapshot.elements]
        .sort((a, b) => priority(b) - priority(a))
        .slice(0, 120)
        .map(row => ({
          ref: `@e${row.index}`,
          role: row.role,
          name: row.name,
          ...(row.value ? {value: String(row.value).slice(0, 200)} : {}),
          rect: row.rect,
          ...(row.focused ? {focused: true} : {}),
          ...(row.enabled === false ? {enabled: false} : {}),
          ...(row.parent_index ? {parent: `@e${row.parent_index}`} : {}),
        }));
      const truncated = snapshot.elements.truncated
        ? {
            elementsTruncated: `UIA walk stopped early (${snapshot.elements.truncated}); an element missing from this state may still exist: use the image or observe again`,
          }
        : {};
      return {
        ...publicSnapshot,
        elements: undefined,
        elementCount: snapshot.elements.length,
        ...truncated,
        ...image,
        outline,
        usedBackend: markedImage ? 'native_uia+pixels' : 'native_uia',
      };
    }
    if (name === 'launch_app') {
      try {
        const result = await waitForDesktop(
          () => nativeRequest('launch', {app: args.app}, signal),
          signal,
        );
        if (result.waitingForDesktop) {
          return result;
        }
        const windows = await this.observation.windows(signal);
        const matches = windows.filter(
          row =>
            String(row.process_name)
              .replace(/\.exe$/i, '')
              .toLowerCase() ===
            basename(String(args.app))
              .replace(/\.exe$/i, '')
              .toLowerCase(),
        );
        const window =
          windows.find(row => row.pid === result.pid) ||
          (matches.length === 1 ? matches[0] : undefined);
        if (window) {
          this.emitCursor({
            action: 'move',
            ...this.windowCenter(window),
            caption: this.cursorCaption(name, args, window),
            nextStep: String(args.next_step || '').trim() || undefined,
            windowTitle: window.title || window.process_name,
            phase: 'acting',
          });
        }
        return {
          ...result,
          ...(window ? {window} : {}),
          verification: {
            matched: !!window,
            method: 'win32_window_after_launch',
            scope: 'application_state',
          },
        };
      } catch (error) {
        const waiting = desktopBusyResult(error);
        if (waiting) {
          return waiting;
        }
        throw error;
      }
    }
    if (name === 'turn_ended') {
      return {ok: true};
    }
    if (name === 'activate_window') {
      const window = await this.resolveWindow(args, signal);
      const center = this.windowCenter(window);
      this.emitCursor({
        action: 'move',
        ...center,
        caption: this.cursorCaption(name, args, window),
        nextStep: String(args.next_step || '').trim() || undefined,
        windowTitle: window.title || window.process_name,
        phase: 'acting',
      });
      const result = await desktopInput({action: name, window}, signal);
      if (result.waitingForDesktop) {
        return result;
      }
      if (!result.ok) {
        throw new ActionFailure(
          'tool_error',
          'Could not bring the requested window to the foreground.',
        );
      }
      const current = await nativeRequest<DesktopWindow>(
        'window',
        {hwnd: window.hwnd},
        signal,
      );
      return {
        ...result,
        window: current,
        verification: {
          matched: current.focused === true,
          method: 'win32_foreground_window',
          scope: 'application_state',
        },
      };
    }
    if (
      [
        'search_ui',
        'inspect_ui',
        'expand_ui',
        'read_text',
        'wait_for',
      ].includes(name)
    ) {
      const prior = this.snapshots.get(
        String(args.snapshot_id || args.state_id || ''),
      );
      if (prior) {
        requireWindowRead(prior.window.hwnd, readScope);
      }
    }
    const hasScreenshotId =
      typeof args.screenshot_id === 'string' &&
      args.screenshot_id.trim().length > 0;
    if (
      ['click', 'move', 'scroll', 'drag'].includes(name) &&
      (hasScreenshotId ||
        args.coordinate_space === 'screen' ||
        args.coordinate_space === 'normalized') &&
      Number.isFinite(Number(args.x)) &&
      Number.isFinite(Number(args.y)) &&
      !args.snapshot_id &&
      !args.state_id &&
      !args.ref &&
      args.index === undefined
    ) {
      const resolvedStart = hasScreenshotId
        ? this.resolveScreenshotPoint(
            String(args.screenshot_id),
            Number(args.x),
            Number(args.y),
          )
        : this.resolveScreenPoint(args);
      const sx = resolvedStart.x;
      const sy = resolvedStart.y;
      const dragTo =
        name === 'drag'
          ? hasScreenshotId
            ? this.resolveScreenshotPoint(
                String(args.screenshot_id),
                Number(args.to_x),
                Number(args.to_y),
              )
            : this.resolveScreenPoint(args, ['to_x', 'to_y'])
          : undefined;
      const mappedPath =
        name === 'drag' && Array.isArray(args.path)
          ? (args.path as DesktopRecord[])
              .map(pt =>
                hasScreenshotId
                  ? this.resolveScreenshotPoint(
                      String(args.screenshot_id),
                      Number(pt.x),
                      Number(pt.y),
                    )
                  : this.resolveScreenPoint({
                      ...pt,
                      coordinate_space: args.coordinate_space,
                    }),
              )
              .map(pt => ({x: pt.x, y: pt.y}))
          : undefined;
      const caption =
        String(args.label || '').trim() ||
        (name === 'click'
          ? args.button === 'right'
            ? '右键点击'
            : Number(args.count) === 2
              ? '双击'
              : '点击屏幕'
          : name === 'scroll'
            ? '滚动画面'
            : name === 'drag'
              ? '拖拽操作'
              : '移动光标');
      const nextStep = String(args.next_step || '').trim() || undefined;
      if (name === 'click') {
        this.emitCursor({
          action: 'approach',
          x: sx,
          y: sy,
          caption,
          nextStep,
          phase: 'acting',
        });
        this.emitCursor({
          action: 'click',
          x: sx,
          y: sy,
          button: args.button === 'right' ? 'right' : 'left',
          count: Number(args.count) || 1,
          caption,
          nextStep,
          phase: 'acting',
        });
      } else {
        this.emitCursor({
          action: 'move',
          x: sx,
          y: sy,
          caption,
          nextStep,
          phase: 'acting',
        });
      }
      const result = await nonDisruptiveInput(
        {
          action: name,
          x: sx,
          y: sy,
          ...(dragTo ? {to_x: dragTo.x, to_y: dragTo.y} : {}),
          ...(mappedPath && mappedPath.length > 1 ? {path: mappedPath} : {}),
          ...(args.button ? {button: args.button} : {}),
          ...(args.count !== undefined ? {count: Number(args.count)} : {}),
          ...(args.dx !== undefined ? {dx: Number(args.dx)} : {}),
          ...(args.dy !== undefined ? {dy: Number(args.dy)} : {}),
          ...(args.duration_ms !== undefined
            ? {duration_ms: Number(args.duration_ms)}
            : {}),
          ...(args.restore_cursor !== undefined
            ? {restore_cursor: Boolean(args.restore_cursor)}
            : {}),
          delivery: 'foreground',
          screen_direct: true,
        },
        signal,
      );
      return {
        ...result,
        x: sx,
        y: sy,
        ...(dragTo ? {to_x: dragTo.x, to_y: dragTo.y} : {}),
        ...(hasScreenshotId
          ? {screenshot_id: String(args.screenshot_id)}
          : {}),
        coordinate_space: hasScreenshotId
          ? 'screenshot'
          : String(args.coordinate_space),
        verification: {
          matched: true,
          method: 'win32_send_input',
          scope: 'ui_action_readback',
        },
      };
    }
    if (
      (['type_text', 'press_key'].includes(name) || name === 'paste') &&
      !args.snapshot_id &&
      !args.state_id &&
      !args.ref &&
      args.index === undefined &&
      !args.hwnd &&
      !args.window_id &&
      !args.pid &&
      !args.app
    ) {
      const hasPoint =
        Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y));
      const pt = hasPoint
        ? hasScreenshotId
          ? this.resolveScreenshotPoint(
              String(args.screenshot_id),
              Number(args.x),
              Number(args.y),
            )
          : this.resolveScreenPoint(args)
        : {
            x: Math.round(
              (this.lastScreenBounds[0] + this.lastScreenBounds[2]) / 2,
            ),
            y: Math.round(
              (this.lastScreenBounds[1] + this.lastScreenBounds[3]) / 2,
            ),
          };
      const caption = this.cursorCaption(name, args);
      const nextStep = String(args.next_step || '').trim() || undefined;
      this.emitCursor({
        action: 'move',
        x: pt.x,
        y: pt.y,
        caption,
        nextStep,
        phase: 'acting',
      });
      if (name === 'type_text' && hasPoint) {
        const clicked = await nonDisruptiveInput(
          {
            action: 'click',
            x: pt.x,
            y: pt.y,
            delivery: 'foreground',
            screen_direct: true,
          },
          signal,
        );
        if (clicked.waitingForDesktop) {
          return clicked;
        }
      }
      const result = await nonDisruptiveInput(
        {
          ...args,
          ...(hasPoint ? {x: pt.x, y: pt.y} : {}),
          ...(name === 'paste' && args.format ? {format: String(args.format)} : {}),
          action: name,
          delivery: 'foreground',
          screen_direct: true,
        },
        signal,
      );
      if (result.waitingForDesktop) {
        return result;
      }
      if (name === 'type_text' && args.submit === true) {
        await nonDisruptiveInput(
          {
            action: 'press_key',
            keys: 'enter',
            delivery: 'foreground',
            screen_direct: true,
          },
          signal,
          false,
        );
      }
      return {
        ...result,
        ...(hasPoint ? {x: pt.x, y: pt.y} : {}),
        ...(hasScreenshotId
          ? {screenshot_id: String(args.screenshot_id)}
          : {}),
        submitted:
          name === 'type_text' || name === 'paste' ? Boolean(args.submit) : false,
        usedBackend: result.usedBackend || 'win32_send_input',
        verification: {
          matched: true,
          method: 'win32_send_input',
          scope: 'ui_action_readback',
        },
      };
    }
    const snapshot = await this.requireSnapshot(
      args.snapshot_id || args.state_id,
      signal,
    );
    if (['search_ui', 'inspect_ui', 'expand_ui', 'read_text'].includes(name)) {
      let elements = snapshot.elements;
      if (name === 'search_ui') {
        elements = elements.filter(
          row =>
            (!args.text ||
              `${row.name} ${row.value || ''} ${row.text || ''}`
                .toLowerCase()
                .includes(String(args.text).toLowerCase())) &&
            (!args.role || row.role === args.role) &&
            (!args.capability ||
              row.patterns.some(pattern =>
                pattern
                  .toLowerCase()
                  .includes(String(args.capability).toLowerCase()),
              )),
        );
      } else {
        const element = this.element(snapshot, args);
        if (!element) {
          throw new Error('ref required');
        }
        if (name === 'read_text') {
          return {
            text: element.text || element.value || element.name,
            state_id: snapshot.state_id,
            ref: args.ref,
            usedBackend: 'native_uia',
          };
        }
        elements =
          name === 'expand_ui'
            ? elements.filter(
                row =>
                  row.index === element.index ||
                  row.parent_index === element.index,
              )
            : [element];
      }
      return {
        state_id: snapshot.state_id,
        elements: elements.map(row => ({...row, ref: `@e${row.index}`})),
        usedBackend: 'native_uia',
      };
    }
    if (name === 'wait_for') {
      const started = Date.now();
      const timeout = Math.min(60000, Number(args.timeout_ms || 5000));
      let current = snapshot;
      const baselineMatched = matchesCondition(snapshot.elements, args);
      const observed = (matched: boolean) => ({
        matched,
        state_id: current.state_id,
        elapsedMs: Date.now() - started,
        usedBackend: 'native_uia',
        ...(args.verify_call_id
          ? {
              verification: {
                matched: matched && !baselineMatched,
                forCallId: String(args.verify_call_id),
                ...(Number.isInteger(args.verify_action_index)
                  ? {forActionIndex: Number(args.verify_action_index)}
                  : {}),
                windowHwnd: snapshot.window.hwnd,
                pid: snapshot.window.pid,
                stateId: snapshot.state_id,
                observedStateId: current.state_id,
                method: 'uia_condition_wait',
                scope: 'ui_postcondition',
                status: !matched
                  ? 'timed_out'
                  : baselineMatched
                    ? 'preexisting_condition'
                    : 'checked',
                condition: {
                  text: args.text,
                  role: args.role,
                  value: args.value,
                },
              },
            }
          : {}),
      });
      do {
        current = await this.observe(
          {hwnd: snapshot.window.hwnd, pixels: false},
          signal,
          readScope,
        );
        if (matchesCondition(current.elements, args)) {
          return observed(true);
        }
        await delay(
          Math.min(150, Math.max(1, timeout - (Date.now() - started))),
          signal,
        );
      } while (Date.now() - started < timeout);
      return observed(false);
    }
    if (name === 'act_ui') {
      const results: DesktopRecord[] = [];
      const actionResults: DesktopRecord[] = [];
      const beforeActions: DesktopSnapshot[] = [];
      let current = snapshot;
      for (const [index, action] of (args.actions || []).entries()) {
        signal?.throwIfAborted();
        const kind = String(action.action || action.kind);
        const before = current;
        const effect = actionEffect(
          kind,
          {...action, snapshot_id: before.snapshot_id},
          this,
        );
        const result = await this.call(
          kind,
          {...action, snapshot_id: current.snapshot_id},
          signal,
        );
        if (result.waitingForDesktop) {
          if (results.length) {
            throw interruptedDesktopInput();
          }
          return result;
        }
        beforeActions.push(before);
        results.push(result);
        const submitted =
          action.submit === true ||
          result.submitted === true ||
          ['external_send', 'purchase'].includes(effect);
        const inputVerified = result.verification?.matched === true;
        actionResults.push({
          index,
          name: kind,
          effect,
          actionTarget:
            result.actionTarget || this.actionTarget(before, action),
          verification: {
            matched: inputVerified && !submitted,
            method: String(
              result.verification?.method || 'native_action_readback',
            ),
            scope: submitted
              ? 'input_only_not_delivery'
              : String(result.verification?.scope || 'ui_action_readback'),
          },
          inputVerified,
          submit: submitted,
          intent: action.intent || null,
        });
        current = await this.observe(
          {hwnd: snapshot.window.hwnd, mode: snapshot.mode},
          signal,
        );
      }
      const expectedIndex = Number.isInteger(args.verify_action_index)
        ? Number(args.verify_action_index)
        : actionResults.length === 1
          ? 0
          : -1;
      const expected =
        args.expect &&
        expectedIndex >= 0 &&
        expectedIndex < actionResults.length
          ? actionResults[expectedIndex]
          : null;
      if (expected) {
        const matched = matchesCondition(current.elements, args.expect);
        const baselineMatched = matchesCondition(
          beforeActions[expectedIndex].elements,
          args.expect,
        );
        expected.postcondition = {
          matched: matched && !baselineMatched && !expected.submit,
          method: 'uia_condition_after_action',
          scope: expected.submit
            ? 'input_only_not_delivery'
            : 'ui_postcondition',
          status: !matched
            ? 'not_met'
            : baselineMatched
              ? 'preexisting_condition'
              : 'checked',
          windowHwnd: snapshot.window.hwnd,
          pid: snapshot.window.pid,
          stateId: beforeActions[expectedIndex].state_id,
        };
      }
      return {
        state_id: current.state_id,
        actions: results,
        actionResults,
        verification: {
          matched: false,
          status: 'per_action_required',
          scope: 'batch_not_verified',
        },
        usedBackend: 'native_desktop',
      };
    }
    const element = this.element(snapshot, args);
    if (['set_value', 'perform_secondary_action'].includes(name)) {
      if (!element) {
        throw new Error('element index/ref required');
      }
      await this.requireSnapshot(snapshot.snapshot_id, signal, [element.index]);
      const elX = Math.round((element.rect[0] + element.rect[2]) / 2);
      const elY = Math.round((element.rect[1] + element.rect[3]) / 2);
      this.emitCursor({
        action: 'move',
        x: elX,
        y: elY,
        caption: this.cursorCaption(name, args, snapshot.window, element),
        nextStep: String(args.next_step || '').trim() || undefined,
        windowTitle: snapshot.window.title || snapshot.window.process_name,
        phase: 'acting',
      });
      let result: DesktopRecord;
      try {
        result = await nativeRequest(
          'uia',
          {
            action: name === 'set_value' ? 'value' : args.action || 'invoke',
            element,
            value: args.value,
          },
          signal,
        );
      } catch (error) {
        const waiting =
          name === 'perform_secondary_action' && args.action === 'focus'
            ? desktopBusyResult(error)
            : null;
        if (waiting) {
          return waiting;
        }
        throw error;
      }
      const confirm =
        name === 'set_value'
          ? await nativeRequest('uia', {action: 'read_value', element}, signal)
          : null;
      return {
        ...result,
        actionTarget: this.actionTarget(snapshot, args),
        verification: {
          matched: confirm
            ? String(confirm.value) === String(args.value)
            : false,
          status: confirm ? 'checked' : 'unavailable',
        },
      };
    }
    if (
      name === 'press_key' &&
      /(^|[+\s])(win|meta|super|lwin|rwin)([+\s]|$)/i.test(String(args.keys))
    ) {
      throw new ActionFailure(
        'permission_denied',
        'Win/Meta/Super chords are rejected',
      );
    }
    let coordinates: DesktopRecord = {};
    if (
      ['click', 'move', 'drag', 'scroll', 'select_text'].includes(name) ||
      ((name === 'type_text' || name === 'paste') &&
        (element || args.x !== undefined))
    ) {
      coordinates = await this.point(snapshot, args, signal);
    }
    if (name === 'select_text' && element) {
      try {
        return await nativeRequest('uia', {action: 'select', element}, signal);
      } catch {
        signal?.throwIfAborted();
      }
    }
    if (name === 'drag') {
      const target = await this.point(
        snapshot,
        {
          index: args.to_index,
          x: args.to_x,
          y: args.to_y,
          coordinate_space: args.coordinate_space,
          ...(args.screenshot_id ? {screenshot_id: args.screenshot_id} : {}),
          ...(args.strict_pixel_guard !== undefined
            ? {strict_pixel_guard: args.strict_pixel_guard}
            : {}),
        },
        signal,
      );
      coordinates.to_x = target.x;
      coordinates.to_y = target.y;
      if (Array.isArray(args.path)) {
        coordinates.path = (args.path as DesktopRecord[]).map(pt =>
          typeof args.screenshot_id === 'string' && args.screenshot_id.trim()
            ? (() => {
                const mapped = this.resolveScreenshotPoint(
                  String(args.screenshot_id),
                  Number(pt.x),
                  Number(pt.y),
                );
                return {x: mapped.x, y: mapped.y};
              })()
            : this.toScreen(snapshot, {
                ...pt,
                coordinate_space: args.coordinate_space,
              }),
        );
      }
    }
    if (name === 'paste') {
      const fallbackCenter = this.windowCenter(snapshot.window);
      const px = Number.isFinite(Number(coordinates.x))
        ? Number(coordinates.x)
        : fallbackCenter.x;
      const py = Number.isFinite(Number(coordinates.y))
        ? Number(coordinates.y)
        : fallbackCenter.y;
      this.emitCursor({
        action: 'move',
        x: px,
        y: py,
        caption: this.cursorCaption(
          name,
          args,
          snapshot.window,
          coordinates.element || element,
        ),
        nextStep: String(args.next_step || '').trim() || undefined,
        windowTitle: snapshot.window.title || snapshot.window.process_name,
        phase: 'acting',
      });
      const result = await runInputWithObstructionRetry(
        {
          ...args,
          ...coordinates,
          action: 'paste',
          format: args.format === 'html' ? 'html' : 'text',
          window: snapshot.window,
        },
        signal,
      );
      if (result.waitingForDesktop) {
        return result;
      }
      return {
        ...result,
        actionTarget: this.actionTarget(snapshot, args),
        ...(coordinates.pixelDriftDetected ? {pixelDriftDetected: true} : {}),
        submitted: Boolean(args.submit),
        verification: {
          matched: true,
          method: 'win32_clipboard_paste',
          scope: 'ui_action_readback',
        },
      };
    }
    if (name === 'type_text' || name === 'select_text') {
      const fallbackCenter = this.windowCenter(snapshot.window);
      const tx = Number.isFinite(Number(coordinates.x))
        ? Number(coordinates.x)
        : fallbackCenter.x;
      const ty = Number.isFinite(Number(coordinates.y))
        ? Number(coordinates.y)
        : fallbackCenter.y;
      this.emitCursor({
        action: 'move',
        x: tx,
        y: ty,
        caption: this.cursorCaption(
          name,
          args,
          snapshot.window,
          coordinates.element || element,
        ),
        nextStep: String(args.next_step || '').trim() || undefined,
        windowTitle: snapshot.window.title || snapshot.window.process_name,
        phase: 'acting',
      });
      let acted = false;
      if ('x' in coordinates) {
        const clicked = await runInputWithObstructionRetry(
          {
            action: 'click',
            ...coordinates,
            ...(element ? {element} : {}),
            ...(args.delivery ? {delivery: args.delivery} : {}),
            window: snapshot.window,
          },
          signal,
        );
        if (clicked.waitingForDesktop) {
          return clicked;
        }
        acted = true;
      }
      if (name === 'select_text') {
        return desktopInput(
          {action: 'press_key', keys: 'ctrl+a', window: snapshot.window},
          signal,
          !acted,
        );
      }
      let previous: DesktopRecord | undefined;
      if (element && !args.clear) {
        try {
          previous = await nativeRequest(
            'uia',
            {action: 'read_value', element},
            signal,
          );
        } catch {
          signal?.throwIfAborted();
        }
      }
      const result = await runInputWithObstructionRetry(
        {
          ...args,
          ...coordinates,
          ...(element ? {element} : {}),
          action: name,
          window: snapshot.window,
        },
        signal,
        !acted,
      );
      if (result.waitingForDesktop) {
        return result;
      }
      let matched = false;
      if (element) {
        try {
          const confirm = await nativeRequest(
            'uia',
            {action: 'read_value', element},
            signal,
          );
          const actual = String(confirm.value);
          const text = String(args.text || '');
          matched = args.clear
            ? actual === text
            : !!previous &&
              Array.from(
                {length: Math.max(0, actual.length - text.length + 1)},
                (_, i) => i,
              ).some(
                i =>
                  actual.slice(i, i + text.length) === text &&
                  actual.slice(0, i) + actual.slice(i + text.length) ===
                    String(previous!.value),
              );
        } catch {
          signal?.throwIfAborted();
        }
      }
      if (args.submit && (matched || !element)) {
        await runInputWithObstructionRetry(
          {
            action: 'press_key',
            keys: 'enter',
            ...(args.delivery ? {delivery: args.delivery} : {}),
            window: snapshot.window,
          },
          signal,
          false,
        );
      }
      const submitted = !!args.submit && (matched || !element);
      return {
        ...result,
        actionTarget: this.actionTarget(snapshot, args),
        ...(coordinates.pixelDriftDetected ? {pixelDriftDetected: true} : {}),
        verification: {matched, status: matched ? 'matched' : 'unavailable'},
        submitted,
        submit_skip_reason:
          args.submit && element && !matched
            ? 'verification_unavailable'
            : null,
      };
    }
    const center = this.windowCenter(snapshot.window);
    const curX = Number.isFinite(Number(coordinates.x))
      ? Number(coordinates.x)
      : center.x;
    const curY = Number.isFinite(Number(coordinates.y))
      ? Number(coordinates.y)
      : center.y;
    const cursorCaption = this.cursorCaption(
      name,
      args,
      snapshot.window,
      coordinates.element || element,
    );
    const nextStep = String(args.next_step || '').trim() || undefined;
    const windowTitle = snapshot.window.title || snapshot.window.process_name;
    if (name === 'click') {
      this.emitCursor({
        action: 'approach',
        x: curX,
        y: curY,
        caption: cursorCaption,
        nextStep,
        windowTitle,
        phase: 'acting',
      });
      this.emitCursor({
        action: 'click',
        x: curX,
        y: curY,
        button: args.button === 'right' ? 'right' : 'left',
        count: Number(args.count) || 1,
        caption: cursorCaption,
        nextStep,
        windowTitle,
        phase: 'acting',
      });
    } else if (['press_key', 'scroll', 'drag', 'move'].includes(name)) {
      this.emitCursor({
        action: 'move',
        x: curX,
        y: curY,
        caption: cursorCaption,
        nextStep,
        windowTitle,
        phase: 'acting',
      });
    }
    const result = await runInputWithObstructionRetry(
      {
        ...args,
        ...coordinates,
        ...(element ? {element} : {}),
        action: name,
        window: snapshot.window,
      },
      signal,
    );
    if (result.waitingForDesktop) {
      return result;
    }
    let visualDelta: DesktopRecord | undefined;
    if (
      snapshot.surface &&
      ['click', 'press_key', 'scroll', 'drag'].includes(name)
    ) {
      const checkStart = Date.now();
      try {
        await delay(110, signal);
        const afterFrame = await captureSurface(
          snapshot.window.bbox,
          signal,
          snapshot.window.hwnd,
        );
        const sharp = (await import('sharp')).default;
        const [beforeRaw, afterRaw] = await Promise.all([
          sharp(snapshot.surface)
            .resize(320, 180, {fit: 'fill'})
            .raw()
            .toBuffer({resolveWithObject: true}),
          sharp(afterFrame.bytes)
            .resize(320, 180, {fit: 'fill'})
            .raw()
            .toBuffer(),
        ]);
        const screenChanged = patchesDiffer(
          beforeRaw.data,
          afterRaw,
          beforeRaw.info.channels,
        );
        visualDelta = {
          screenChanged,
          method: 'window_pixel_diff',
          elapsedMs: Date.now() - checkStart,
        };
      } catch {
        visualDelta = {
          screenChanged: true,
          method: 'window_closed_or_resized',
          elapsedMs: Date.now() - checkStart,
        };
      }
    }
    return {
      ...result,
      actionTarget: this.actionTarget(snapshot, args),
      ...(coordinates.pixelDriftDetected ? {pixelDriftDetected: true} : {}),
      ...(coordinates.snappedControl
        ? {snappedControl: coordinates.snappedControl}
        : {}),
      ...(visualDelta ? {visualDelta} : {}),
    };
  }
}

function matchesCondition(
  elements: DesktopElement[],
  condition: DesktopRecord,
): boolean {
  if (
    ![condition.text, condition.role, condition.value].some(
      value => value !== undefined && value !== null,
    )
  ) {
    return false;
  }
  return elements.some(
    row =>
      (condition.text === undefined ||
        `${row.name} ${row.text || ''}`.includes(String(condition.text))) &&
      (condition.role === undefined || row.role === condition.role) &&
      (condition.value === undefined ||
        String(row.value) === String(condition.value)),
  );
}
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((accept, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason || new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      accept();
    }, ms);
    signal?.addEventListener('abort', abort, {once: true});
  });
}
const sessions = new Map<string, DesktopActionSession>();
export function desktopSession(
  sessionId = 'default',
  originWindowHwnd?: number,
): DesktopActionSession {
  let session = sessions.get(sessionId);
  if (!session) {
    session = new DesktopActionSession(sessionId, originWindowHwnd);
    sessions.set(sessionId, session);
  }
  return session;
}
export async function observeDesktop(
  args: DesktopRecord = {},
  signal?: AbortSignal,
): Promise<DesktopRecord> {
  return desktopSession(args.sessionId).call('get_app_state', args, signal);
}
export async function executeDesktopAction(
  name: string,
  args: DesktopRecord,
  signal?: AbortSignal,
): Promise<DesktopRecord> {
  return desktopSession(args.sessionId).call(name, args, signal);
}

export function registerDesktopTools(
  registry: ToolRegistry,
  session = desktopSession(),
  authorizeAccess?: (request: AccessRequest) => {
    allowed: boolean;
    reason: string;
  },
  acquireTarget?: (window: DesktopWindow) => unknown | Promise<unknown>,
  onGuide?: (guide: {
    x: number;
    y: number;
    caption: string;
    ttlMs: number;
  }) => void,
  options?: {
    eagerDesktopTools?: boolean;
    autoBindWindows?: boolean;
    onCursorEvent?: (event: DesktopCursorEvent) => void;
  },
): void {
  if (options?.onCursorEvent) {
    session.onCursorEvent = options.onCursorEvent;
  }
  const autoBindTarget =
    options?.autoBindWindows && acquireTarget ? acquireTarget : undefined;
  const eagerTools = options?.eagerDesktopTools === true;
  const readScope: WindowReadScope | undefined = authorizeAccess
    ? hwnd => authorizeAccess({action: 'read', windowIds: [`w-${hwnd}`]})
    : undefined;
  registry.register({
    name: 'choose_ui_target',
    description:
      'Resolve a target within an observed state. Unique exact labels are local; configured Jev uses a 900 ms deadline. Returns a reference or ambiguity and never acts.',
    input_schema: {
      type: 'object',
      properties: {
        state_id: {type: 'string'},
        target: {type: 'string'},
        candidate_refs: {type: 'array', items: {type: 'string'}},
      },
      required: ['state_id', 'target'],
      additionalProperties: false,
    },
    effect: 'read',
    deferred: true,
    is_concurrency_safe: true,
    execute: async (args: DesktopRecord, context) => {
      const prior = session.snapshots.get(String(args.state_id || ''));
      if (prior) {
        requireWindowRead(prior.window.hwnd, readScope);
      }
      const snapshot = await session.requireSnapshot(
        args.state_id,
        context.signal,
      );
      const rows = snapshot.elements
        .map(row => ({...row, ref: `@e${row.index}`}))
        .filter(
          row => !args.candidate_refs || args.candidate_refs.includes(row.ref),
        );
      return chooseUiTarget(
        args.target,
        rows,
        snapshot.state_id,
        context.signal,
      );
    },
  });
  const string = {type: 'string'};
  const number = {type: 'number'};
  const integer = {type: 'integer'};
  const boolean = {type: 'boolean'};
  const common = {
    snapshot_id: string,
    state_id: string,
    screenshot_id: string,
    strict_pixel_guard: boolean,
    index: integer,
    ref: string,
    x: number,
    y: number,
    coordinate_space: {
      enum: ['screen', 'image', 'normalized'],
      description:
        "x/y read off the returned screenshot are 'image'; 0-1000 window-relative coordinates are 'normalized'; default 'screen' physical pixels",
    },
  };
  if (onGuide) {
    registry.register({
      name: 'point_ui',
      description:
        'Visually point out one verified UI target when the user asks where it is or how to find it. Requires a current observed state and an element ref or image coordinate. Shows a short temporary label; never moves the OS mouse or clicks. This is guidance, not proof that an action succeeded.',
      input_schema: {
        type: 'object',
        properties: {
          ...common,
          caption: {type: 'string'},
          ttl_ms: {type: 'integer', minimum: 800, maximum: 4000},
        },
        required: ['state_id'],
        additionalProperties: false,
      },
      effect: 'read',
      deferred: true,
      is_concurrency_safe: true,
      used_backend: 'native_desktop_visual_guide',
      timeout_ms: 10000,
      execute: async (args: DesktopRecord, context) => {
        const stateId = args.snapshot_id || args.state_id;
        const prior = session.snapshots.get(String(stateId || ''));
        if (prior) {
          requireWindowRead(prior.window.hwnd, readScope);
        }
        const snapshot = await session.requireSnapshot(stateId, context.signal);
        requireWindowRead(snapshot.window.hwnd, readScope);
        const point = await session.point(snapshot, args, context.signal);
        const [left, top, right, bottom] = snapshot.window.bbox;
        if (
          point.x < left ||
          point.x >= right ||
          point.y < top ||
          point.y >= bottom
        ) {
          throw new ActionFailure(
            'stale_snapshot',
            'point outside observed window',
          );
        }
        const caption = String(args.caption || point.element?.name || '这里')
          .trim()
          .slice(0, 64);
        const ttlMs = Math.max(
          800,
          Math.min(4000, Number(args.ttl_ms) || 2500),
        );
        onGuide({x: point.x, y: point.y, caption, ttlMs});
        return {
          stateId: snapshot.state_id,
          windowId: `w-${snapshot.window.hwnd}`,
          point: {x: point.x, y: point.y},
          target: point.element
            ? {ref: `@e${point.element.index}`, name: point.element.name}
            : null,
          usedBackend: point.element
            ? 'uia_ref+visual_guide'
            : 'revalidated_pixels+visual_guide',
          action: 'visual_guidance_only',
          nativeInput: false,
        };
      },
    });
  }
  registry.register({
    name: 'Pointer.guide',
    description:
      'Fly Clicky visual guide pointer to an on-screen target (accepts element ref/state_id or normalized 0..1000 / pixel x,y coordinates) with a short teaching caption without sending OS input.',
    input_schema: {
      type: 'object',
      properties: {
        ...common,
        normalized: boolean,
        screen: integer,
        label: string,
        caption: string,
        ttl_ms: {type: 'integer', minimum: 800, maximum: 4000},
      },
      required: [],
      additionalProperties: false,
    },
    effect: 'read',
    deferred: false,
    is_concurrency_safe: true,
    used_backend: 'native_desktop_visual_guide',
    timeout_ms: 10000,
    execute: async (args: DesktopRecord, context) => {
      const stateId = args.snapshot_id || args.state_id;
      let gx = Number(args.x);
      let gy = Number(args.y);
      let elementName = '';
      if (stateId) {
        const prior = session.snapshots.get(String(stateId));
        if (prior) {
          requireWindowRead(prior.window.hwnd, readScope);
        }
        const snapshot = await session.requireSnapshot(stateId, context.signal);
        requireWindowRead(snapshot.window.hwnd, readScope);
        const pt = await session.point(snapshot, args, context.signal);
        gx = pt.x;
        gy = pt.y;
        elementName = pt.element?.name || '';
      } else {
        if (!Number.isFinite(gx) || !Number.isFinite(gy)) {
          throw new Error('pass state_id+ref or finite x and y coordinates');
        }
        const isNormalized =
          args.normalized !== false &&
          args.coordinate_space !== 'screen' &&
          gx >= 0 &&
          gx <= 1000 &&
          gy >= 0 &&
          gy <= 1000;
        if (isNormalized) {
          const latest = [...session.snapshots.values()].at(-1);
          const bbox = latest?.window.bbox ?? [0, 0, 1920, 1080];
          gx = Math.round(bbox[0] + (gx / 1000) * (bbox[2] - bbox[0]));
          gy = Math.round(bbox[1] + (gy / 1000) * (bbox[3] - bbox[1]));
        }
      }
      const caption = String(
        args.caption || args.label || elementName || '这里',
      )
        .trim()
        .slice(0, 64);
      const ttlMs = Math.max(
        800,
        Math.min(4000, Number(args.ttl_ms) || 3200),
      );
      onGuide?.({x: Math.round(gx), y: Math.round(gy), caption, ttlMs});
      return {
        ok: true,
        pointed: {x: Math.round(gx), y: Math.round(gy), label: caption},
        usedBackend: 'native_desktop_visual_guide',
        action: 'visual_guidance_only',
        nativeInput: false,
      };
    },
  });
  const schemas: Record<string, DesktopRecord> = {
    list_apps: {},
    list_windows: {},
    launch_app: {app: string, label: string, next_step: string},
    activate_window: {
      window_id: string,
      hwnd: integer,
      pid: integer,
      app: string,
      label: string,
      next_step: string,
    },
    window_manage: {
      window_id: string,
      hwnd: integer,
      pid: integer,
      app: string,
      label: string,
      next_step: string,
      action: {
        enum: ['minimize', 'maximize', 'restore', 'close', 'move_resize'],
      },
      x: integer,
      y: integer,
      width: integer,
      height: integer,
    },
    get_app_state: {
      window_id: string,
      hwnd: integer,
      pid: integer,
      app: string,
      pixels: boolean,
      mode: {enum: ['ax', 'text', 'image', 'full']},
      label: string,
      next_step: string,
    },
    find_roots: {text: string, app: string, pid: integer, kind: string},
    observe_ui: {
      root: string,
      hwnd: integer,
      pixels: boolean,
      mode: {enum: ['fused', 'visual', 'ax', 'full']},
      label: string,
      next_step: string,
    },
    search_ui: {...common, text: string, role: string, capability: string},
    inspect_ui: common,
    expand_ui: {...common, depth: integer},
    read_text: common,
    wait_for: {
      ...common,
      text: string,
      role: string,
      value: string,
      timeout_ms: integer,
      verify_call_id: string,
      verify_action_index: integer,
    },
    click: {
      ...common,
      button: {enum: ['left', 'right', 'middle']},
      count: integer,
      delivery: {enum: ['auto', 'background', 'foreground']},
      label: string,
      next_step: string,
    },
    move: {
      ...common,
      duration_ms: integer,
      label: string,
      next_step: string,
    },
    paste: {
      ...common,
      text: string,
      format: {enum: ['text', 'html']},
      clear: boolean,
      submit: boolean,
      delivery: {enum: ['auto', 'background', 'foreground']},
      label: string,
      next_step: string,
    },
    type_text: {
      ...common,
      text: string,
      clear: boolean,
      submit: boolean,
      delivery: {enum: ['auto', 'background', 'foreground']},
      label: string,
      next_step: string,
    },
    press_key: {
      ...common,
      keys: string,
      delivery: {enum: ['auto', 'background', 'foreground']},
      label: string,
      next_step: string,
    },
    scroll: {
      ...common,
      dx: integer,
      dy: integer,
      delivery: {enum: ['auto', 'background', 'foreground']},
      label: string,
      next_step: string,
    },
    set_value: {...common, value: string, label: string, next_step: string},
    perform_secondary_action: {
      ...common,
      action: {
        enum: ['invoke', 'toggle', 'expand', 'collapse', 'select', 'focus'],
      },
      label: string,
      next_step: string,
    },
    select_text: common,
    drag: {
      ...common,
      to_index: integer,
      to_x: number,
      to_y: number,
      duration_ms: integer,
      path: {
        type: 'array',
        items: {type: 'object', properties: {x: number, y: number}},
      },
      label: string,
      next_step: string,
    },
    act_ui: {
      ...common,
      actions: {type: 'array', minItems: 1, items: {type: 'object'}},
      expect: {type: 'object'},
      verify_action_index: integer,
    },
    turn_ended: {},
  };
  for (const [name, properties] of Object.entries(schemas)) {
    const effect = actionEffect(name, {});
    const targetAction = [
      'click',
      'type_text',
      'paste',
      'press_key',
      'perform_secondary_action',
      'act_ui',
      'window_manage',
    ].includes(name);
    if (
      [
        'click',
        'type_text',
        'paste',
        'press_key',
        'perform_secondary_action',
        'act_ui',
      ].includes(name)
    ) {
      properties.intent = {
        type: 'string',
        enum: ['input', 'send', 'submit', 'delete', 'run', 'purchase'],
      };
    }
    registry.register({
      name,
      description: `${name.replaceAll('_', ' ')} on the current desktop.${name === 'get_app_state' ? ' Returns the element outline and, for mode=full or when the accessibility tree is too sparse to act on (self-drawn apps), a screenshot with every actionable element boxed and labelled by its ref.' : ''} Prefer element refs; for targets only visible in the screenshot pass its pixel x/y with coordinate_space:'image'. Menus and popups of the same app are part of the observed surface. Actions revalidate the target and return honest verification.${name === 'wait_for' ? ' To verify a prior UI action, pass its tool call ID as verify_call_id with the same pre-action state_id and an explicit text, role or value condition. This verifies a new UI condition, never external delivery.' : name === 'act_ui' ? ' Each action returns separate verification. For a final expect with multiple actions, set verify_action_index to the action it checks.' : ''}`,
      input_schema: {
        type: 'object',
        properties,
        required: [],
        additionalProperties: false,
      },
      effect,
      effect_for: args => actionEffect(name, args, session),
      access_for: targetAction
        ? args => {
            if (autoBindTarget) {
              return {action: 'patch'};
            }
            const snapshot = session.snapshots.get(
              String(args.snapshot_id || args.state_id || ''),
            );
            const explicitHwnd =
              snapshot?.window.hwnd || Number(args.hwnd || 0) || undefined;
            return {
              action: 'patch',
              windowIds: [
                explicitHwnd
                  ? `w-${explicitHwnd}`
                  : 'unbound-live-surface',
              ],
            };
          }
        : undefined,
      is_concurrency_safe: effect === 'read',
      resource_keys: effect === 'read' ? [] : ['desktop:input'],
      used_backend: 'native_desktop',
      timeout_ms: 65000,
      deferred: eagerTools
        ? false
        : !['list_apps', 'list_windows', 'get_app_state', 'launch_app'].includes(
            name,
          ),
      execute: async (args, context) => {
        const result = await session.call(
          name,
          args,
          context.signal,
          readScope,
          autoBindTarget,
        );
        if (
          ['launch_app', 'activate_window', 'window_manage'].includes(name) &&
          result.ok === true &&
          result.window &&
          (autoBindTarget || result.verification?.matched === true)
        ) {
          await acquireTarget?.(result.window);
        }
        return result;
      },
    } as ToolSpec);
  }

  registry.register({
    name: 'see_screen',
    description:
      'Capture whole-computer situational awareness in one call: full-display screenshot (<=1600px), monitor/virtualScreen geometry, live cursor position, window under cursor, foreground window, top-40 Z-order windows (with minimized flag), active popup menus / tray overflow / shell overlays with UIA menu items, and optional clipboard preview.',
    input_schema: {
      type: 'object',
      properties: {
        display_index: integer,
        region: {type: 'array', items: integer, minItems: 4, maxItems: 4},
        include_image: boolean,
        include_clipboard: boolean,
        label: string,
      },
      required: [],
      additionalProperties: false,
    },
    effect: 'read',
    is_concurrency_safe: true,
    used_backend: 'native_see_screen',
    timeout_ms: 20000,
    deferred: eagerTools ? false : true,
    execute: async (args: DesktopRecord, context) => {
      const overview = await desktopOverview(
        {includeClipboard: args.include_clipboard === true},
        context.signal,
      );
      const monitors = Array.isArray(overview.monitors)
        ? (overview.monitors as Array<{
            index?: number;
            primary?: boolean;
            bbox: Rect;
          }>)
        : [];
      const chosenMonitor =
        typeof args.display_index === 'number'
          ? monitors.find(m => m.index === args.display_index) || monitors[0]
          : monitors.find(m => m.primary) || monitors[0];
      const screenBounds: Rect =
        Array.isArray(args.region) && args.region.length === 4
          ? [
              Math.round(Number(args.region[0])),
              Math.round(Number(args.region[1])),
              Math.round(Number(args.region[2])),
              Math.round(Number(args.region[3])),
            ]
          : chosenMonitor?.bbox ||
            (Array.isArray(overview.virtualScreen) &&
            overview.virtualScreen.length === 4
              ? (overview.virtualScreen as Rect)
              : [0, 0, 1920, 1080]);
      session.lastScreenBounds = screenBounds;
      const shot =
        args.include_image === false
          ? null
          : await captureScaledScreenFrame(screenBounds, context.signal);
      const screenshotId = shot
        ? session.registerScreenshot({
            bounds: screenBounds,
            width: shot.width,
            height: shot.height,
            kind: 'screen',
          })
        : undefined;
      return {
        ...overview,
        screenBounds,
        screenWidth: Math.max(1, screenBounds[2] - screenBounds[0]),
        screenHeight: Math.max(1, screenBounds[3] - screenBounds[1]),
        ...(shot
          ? {
              screenshot_id: screenshotId,
              image: shot.image,
              mimeType: shot.mimeType,
              imageWidth: shot.width,
              imageHeight: shot.height,
              imageLabel: `Screen Overview (${screenBounds[2] - screenBounds[0]}x${screenBounds[3] - screenBounds[1]})`,
            }
          : {}),
        usedBackend: 'native_see_screen',
      };
    },
  } as ToolSpec);

  registry.register({
    name: 'inspect_at',
    description:
      'Universal UIA hit-test at any physical screen (x, y) or 0..1000 normalized screen coordinate: returns the control under that point (name, role, value, bbox, center), its parent container, up to 24 visible sibling items (menus, tabs, buttons, list rows), and its hosting window.',
    input_schema: {
      type: 'object',
      properties: {
        x: number,
        y: number,
        coordinate_space: {enum: ['screen', 'normalized']},
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    effect: 'read',
    is_concurrency_safe: true,
    used_backend: 'win32_element_at',
    deferred: eagerTools ? false : true,
    execute: async (args: DesktopRecord, context) => {
      const {x, y} = session.resolveScreenPoint({
        coordinate_space: args.coordinate_space || 'screen',
        x: args.x,
        y: args.y,
      });
      return inspectAtPoint(x, y, context.signal);
    },
  } as ToolSpec);

  registry.register({
    name: 'inspect_tray',
    description:
      'Inspect the Windows taskbar, notification chevron (Show hidden icons), visible/overflow system tray icons with screen (x, y) centers, and any open tray context-menu items.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    effect: 'read',
    is_concurrency_safe: true,
    used_backend: 'win32_tray_uia',
    deferred: eagerTools ? false : true,
    execute: async (_args: DesktopRecord, context) =>
      inspectTrayIcons(context.signal),
  } as ToolSpec);

  registry.register({
    name: 'zoom_screen',
    description:
      'Capture a native-resolution zoomed crop of a specific screen region [x1, y1, x2, y2] (or a window-relative region inside hwnd) for reading small text, icons, or UI controls clearly.',
    input_schema: {
      type: 'object',
      properties: {
        bbox: {type: 'array', items: integer, minItems: 4, maxItems: 4},
        region: {type: 'array', items: integer, minItems: 4, maxItems: 4},
        hwnd: integer,
        window_id: string,
        label: string,
      },
      required: [],
      additionalProperties: false,
    },
    effect: 'read',
    deferred: !eagerTools,
    is_concurrency_safe: true,
    used_backend: 'native_desktop_zoom',
    timeout_ms: 20000,
    execute: async (args: DesktopRecord, context) => {
      let win: DesktopWindow | undefined;
      if (args.hwnd || args.window_id || !Array.isArray(args.bbox)) {
        win = await session.resolveWindow(args, context.signal);
        if (autoBindTarget && readScope?.(win.hwnd).allowed === false) {
          await autoBindTarget(win);
        }
        requireWindowRead(win.hwnd, readScope);
      }
      let targetBbox: Rect;
      let cropInWindow:
        | {left: number; top: number; width: number; height: number}
        | undefined;
      if (Array.isArray(args.region) && args.region.length === 4 && win) {
        const [wl, wt, wr, wb] = win.bbox;
        const ww = Math.max(1, wr - wl);
        const wh = Math.max(1, wb - wt);
        const rx1 = Math.max(0, Math.min(ww - 1, Math.round(Number(args.region[0]))));
        const ry1 = Math.max(0, Math.min(wh - 1, Math.round(Number(args.region[1]))));
        const rx2 = Math.max(rx1 + 16, Math.min(ww, Math.round(Number(args.region[2]))));
        const ry2 = Math.max(ry1 + 16, Math.min(wh, Math.round(Number(args.region[3]))));
        targetBbox = [wl + rx1, wt + ry1, wl + rx2, wt + ry2];
        cropInWindow = {left: rx1, top: ry1, width: rx2 - rx1, height: ry2 - ry1};
      } else if (Array.isArray(args.bbox) && args.bbox.length === 4) {
        const x1 = Math.round(Number(args.bbox[0]));
        const y1 = Math.round(Number(args.bbox[1]));
        const x2 = Math.max(x1 + 16, Math.round(Number(args.bbox[2])));
        const y2 = Math.max(y1 + 16, Math.round(Number(args.bbox[3])));
        targetBbox = [x1, y1, x2, y2];
      } else if (win) {
        targetBbox = win.bbox;
      } else {
        throw new Error('pass bbox [x1,y1,x2,y2] or hwnd+region');
      }
      session.emitCursor({
        action: 'move',
        x: Math.round((targetBbox[0] + targetBbox[2]) / 2),
        y: Math.round((targetBbox[1] + targetBbox[3]) / 2),
        caption: String(args.label || '放大查看细节').slice(0, 24),
        windowTitle: win?.title || win?.process_name,
        phase: 'thinking',
      });
      const sharp = (await import('sharp')).default;
      const frame = await captureSurface(
        win && cropInWindow ? win.bbox : targetBbox,
        context.signal,
        win?.hwnd,
      );
      let pipeline = sharp(frame.bytes);
      if (cropInWindow) {
        const w = Math.min(cropInWindow.width, Math.max(1, frame.width - cropInWindow.left));
        const h = Math.min(cropInWindow.height, Math.max(1, frame.height - cropInWindow.top));
        pipeline = pipeline.extract({
          left: Math.max(0, Math.min(frame.width - 1, cropInWindow.left)),
          top: Math.max(0, Math.min(frame.height - 1, cropInWindow.top)),
          width: Math.max(1, w),
          height: Math.max(1, h),
        });
      }
      const jpg = await pipeline.jpeg({quality: 90}).toBuffer({resolveWithObject: true});
      const screenshotId = session.registerScreenshot({
        bounds: targetBbox,
        width: jpg.info.width,
        height: jpg.info.height,
        ...(win?.hwnd ? {hwnd: win.hwnd} : {}),
        kind: 'zoom',
      });
      return {
        ok: true,
        screenshot_id: screenshotId,
        image: jpg.data.toString('base64'),
        mimeType: 'image/jpeg',
        width: jpg.info.width,
        height: jpg.info.height,
        bbox: targetBbox,
        imageLabel: `Zoomed Screen Region (${jpg.info.width}x${jpg.info.height})`,
        usedBackend: 'native_desktop_zoom',
      };
    },
  } as ToolSpec);

  const batchStepProps = {
    action: {
      enum: [
        'click',
        'double_click',
        'right_click',
        'move',
        'drag',
        'type_text',
        'paste',
        'press_key',
        'scroll',
        'wait',
        'activate_window',
        'launch_app',
      ],
    },
    ...common,
    to_x: number,
    to_y: number,
    button: {enum: ['left', 'right', 'middle']},
    count: integer,
    text: string,
    format: {enum: ['text', 'html']},
    clear: boolean,
    submit: boolean,
    keys: string,
    dx: integer,
    dy: integer,
    ms: integer,
    app: string,
    hwnd: integer,
    window_id: string,
    delivery: {enum: ['auto', 'background', 'foreground']},
    label: string,
    next_step: string,
    intent: {
      type: 'string',
      enum: ['input', 'send', 'submit', 'delete', 'run', 'purchase'],
    },
  };

  registry.register({
    name: 'desktop_batch',
    description:
      'Execute up to 12 ordered GUI actions (click, type_text, press_key, scroll, wait, activate_window, launch_app) on the real desktop in a single turn with live animated cursor narration and an optional end screenshot.',
    input_schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            type: 'object',
            properties: batchStepProps,
            required: ['action'],
            additionalProperties: false,
          },
        },
        hwnd: integer,
        window_id: string,
        snapshot_id: string,
        state_id: string,
        include_screenshot: boolean,
      },
      required: ['steps'],
      additionalProperties: false,
    },
    effect: 'reversible_write',
    effect_for: (args: DesktopRecord): Effect => {
      const steps = Array.isArray(args.steps)
        ? (args.steps as DesktopRecord[])
        : [];
      let strongest: Effect = 'reversible_write';
      for (const step of steps) {
        const rawAction = String(step?.action || '');
        const mappedName =
          rawAction === 'double_click' || rawAction === 'right_click'
            ? 'click'
            : rawAction;
        strongest = strongerEffect(
          strongest,
          actionEffect(
            mappedName,
            {...step, snapshot_id: step.snapshot_id || args.snapshot_id || args.state_id},
            session,
          ),
        );
      }
      return strongest;
    },
    deferred: !eagerTools,
    resource_keys: ['desktop:input'],
    used_backend: 'native_desktop_batch',
    timeout_ms: 90000,
    execute: async (args: DesktopRecord, context) => {
      const rawSteps = Array.isArray(args.steps)
        ? (args.steps as DesktopRecord[]).slice(0, 12)
        : [];
      let currentSnapshotId = String(args.snapshot_id || args.state_id || '');
      let lastHwnd = Number(args.hwnd || 0) || undefined;
      const results: DesktopRecord[] = [];
      for (let i = 0; i < rawSteps.length; i++) {
        context.signal.throwIfAborted();
        const step = {...rawSteps[i]};
        const rawAction = String(step.action || '');
        if (rawAction === 'wait') {
          const waitMs = Math.max(50, Math.min(3000, Number(step.ms) || 400));
          await delay(waitMs, context.signal);
          results.push({index: i, ok: true, action: 'wait', ms: waitMs});
          continue;
        }
        let toolName = rawAction;
        if (rawAction === 'double_click') {
          toolName = 'click';
          step.button = 'left';
          step.count = 2;
        } else if (rawAction === 'right_click') {
          toolName = 'click';
          step.button = 'right';
          step.count = 1;
        }
        if (
          ['click', 'right_click', 'double_click', 'move', 'scroll', 'drag', 'paste'].includes(
            rawAction,
          ) &&
          Number.isFinite(Number(step.x)) &&
          Number.isFinite(Number(step.y)) &&
          !currentSnapshotId &&
          !step.snapshot_id &&
          !step.state_id &&
          !step.screenshot_id &&
          !step.ref &&
          step.index === undefined &&
          !step.coordinate_space
        ) {
          step.coordinate_space = 'screen';
        }
        const hasStepShot =
          typeof step.screenshot_id === 'string' &&
          step.screenshot_id.trim().length > 0;
        const screenDirect =
          (hasStepShot ||
            step.coordinate_space === 'screen' ||
            step.coordinate_space === 'normalized') &&
          !step.hwnd;
        const callArgs: DesktopRecord = {
          ...step,
          ...(lastHwnd && !step.hwnd && !screenDirect ? {hwnd: lastHwnd} : {}),
          ...(args.window_id && !step.window_id && !screenDirect
            ? {window_id: args.window_id}
            : {}),
          ...(currentSnapshotId &&
          !step.snapshot_id &&
          !step.state_id &&
          !screenDirect
            ? {snapshot_id: currentSnapshotId}
            : {}),
        };
        const res = await session.call(
          toolName,
          callArgs,
          context.signal,
          readScope,
          autoBindTarget,
        );
        results.push({index: i, action: rawAction, ...res});
        if (res.waitingForDesktop) {
          break;
        }
        if (typeof res.state_id === 'string') {
          currentSnapshotId = res.state_id;
        }
        if (res.window?.hwnd) {
          lastHwnd = Number(res.window.hwnd);
        }
      }
      const stoppedEarly = results.some(r => Boolean(r.waitingForDesktop));
      const finalState =
        !stoppedEarly && args.include_screenshot !== false && (lastHwnd || currentSnapshotId)
          ? await session
              .call(
                'get_app_state',
                {
                  ...(lastHwnd ? {hwnd: lastHwnd} : {}),
                  mode: 'full',
                  pixels: true,
                },
                context.signal,
                readScope,
                autoBindTarget,
              )
              .catch(() => null)
          : null;
      const finalScreenShot =
        !stoppedEarly &&
        args.include_screenshot !== false &&
        !finalState?.image
          ? await captureScaledScreenFrame(
              session.lastScreenBounds,
              context.signal,
            )
          : null;
      const finalScreenShotId = finalScreenShot
        ? session.registerScreenshot({
            bounds: session.lastScreenBounds,
            width: finalScreenShot.width,
            height: finalScreenShot.height,
            kind: 'screen',
          })
        : undefined;
      return {
        ok: results.length > 0 && !stoppedEarly,
        completedCount: results.length,
        results,
        ...(finalState?.image
          ? {
              state_id: finalState.state_id,
              ...(finalState.screenshot_id
                ? {screenshot_id: finalState.screenshot_id}
                : {}),
              image: finalState.image,
              mimeType: finalState.mimeType,
              imageLabel: finalState.imageLabel,
              imageSpace: finalState.imageSpace,
            }
          : finalScreenShot
            ? {
                screenshot_id: finalScreenShotId,
                image: finalScreenShot.image,
                mimeType: finalScreenShot.mimeType,
                screenBounds: session.lastScreenBounds,
                imageLabel: `Screen After Batch (${session.lastScreenBounds[2] - session.lastScreenBounds[0]}x${session.lastScreenBounds[3] - session.lastScreenBounds[1]})`,
              }
            : {}),
        usedBackend: 'native_desktop_batch',
      };
    },
  } as ToolSpec);
}
