import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {
  ActionFailure,
  type Effect,
  type ToolRegistry,
  type ToolSpec,
} from './tools';
import {
  desktopRuntimeRoot,
  ensureNativeTool,
  type DesktopRecord,
} from './desktop';

export interface CuDesktopWindow {
  hwnd: number;
  window_id: string;
  pid: number;
  process_name: string;
  title: string;
  bbox: [number, number, number, number];
  focused?: boolean;
  minimized?: boolean;
  z_order?: number;
  desktop: 'agent';
}

export class CuDesktopHostClient {
  private child?: ChildProcessWithoutNullStreams;
  private startup?: Promise<void>;
  private readonly pending = new Map<
    string,
    {
      accept(value: any): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
      cleanup(): void;
    }
  >();

  async start(): Promise<void> {
    if (this.child && !this.child.killed) {
      return;
    }
    if (this.startup) {
      return this.startup;
    }
    this.startup = (async () => {
      const executable = await ensureNativeTool('cu_desktop_host');
      const child = spawn(executable, [], {
        cwd: desktopRuntimeRoot(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) {
            continue;
          }
          try {
            const response = JSON.parse(line) as DesktopRecord;
            const entry = this.pending.get(String(response.id));
            if (!entry) {
              continue;
            }
            this.pending.delete(String(response.id));
            clearTimeout(entry.timer);
            entry.cleanup();
            if (response.error) {
              entry.reject(
                new Error(
                  String(response.error.code || response.error.message),
                ),
              );
            } else {
              entry.accept(response.result);
            }
          } catch {
            this.failAll(new Error('cu_desktop_invalid_response'));
          }
        }
      });
      child.stderr.on('data', () => {});
      child.on('error', error => this.failAll(error));
      child.on('exit', () => {
        if (this.child === child) {
          this.child = undefined;
          this.failAll(new Error('cu_desktop_exited'));
        }
      });
    })().finally(() => {
      this.startup = undefined;
    });
    return this.startup;
  }

  private failAll(error: Error): void {
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
    timeoutMs = 20000,
  ): Promise<T> {
    signal?.throwIfAborted();
    await this.start();
    signal?.throwIfAborted();
    return new Promise((accept, reject) => {
      const id = randomUUID();
      const abort = () => {
        const entry = this.pending.get(id);
        if (!entry) {
          return;
        }
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.cleanup();
        reject(signal?.reason || new Error('aborted'));
      };
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) {
          return;
        }
        this.pending.delete(id);
        entry.cleanup();
        reject(new Error(`cu_desktop_timeout:${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        accept,
        reject,
        timer,
        cleanup: () => signal?.removeEventListener('abort', abort),
      });
      signal?.addEventListener('abort', abort, {once: true});
      this.child!.stdin.write(
        `${JSON.stringify({id, method, params})}\n`,
        error => {
          if (error) {
            this.failAll(error);
          }
        },
      );
    });
  }

  async open(
    params: {width?: number; height?: number; name?: string} = {},
    signal?: AbortSignal,
  ): Promise<DesktopRecord> {
    return this.request('open', params, signal);
  }

  async launch(
    params: {app: string; args?: string; cwd?: string},
    signal?: AbortSignal,
  ): Promise<DesktopRecord & {pid: number; window?: CuDesktopWindow}> {
    return this.request('launch', params, signal, 25000);
  }

  async windows(signal?: AbortSignal): Promise<CuDesktopWindow[]> {
    return this.request<CuDesktopWindow[]>('windows', {}, signal);
  }

  async elements(
    hwnd: number,
    limit = 400,
    signal?: AbortSignal,
  ): Promise<DesktopRecord[]> {
    const res = await this.request<{elements: DesktopRecord[]}>(
      'elements',
      {hwnd, limit},
      signal,
    );
    return Array.isArray(res.elements) ? res.elements : [];
  }

  async capture(
    params: {quality?: number} = {},
    signal?: AbortSignal,
  ): Promise<DesktopRecord> {
    return this.request('capture', params, signal);
  }

  async resize(
    width: number,
    height: number,
    signal?: AbortSignal,
  ): Promise<DesktopRecord> {
    return this.request('resize', {width, height}, signal);
  }

  async inspectAx(
    hwnd?: number,
    limit = 120,
    signal?: AbortSignal,
  ): Promise<DesktopRecord> {
    return this.request('inspect_ax', {hwnd: hwnd ?? 0, limit}, signal);
  }

  async act(
    params: DesktopRecord,
    signal?: AbortSignal,
  ): Promise<DesktopRecord> {
    return this.request('act', params, signal);
  }

  async close(): Promise<void> {
    if (!this.child) {
      return;
    }
    try {
      await this.request('close', {}, undefined, 4000);
    } catch {}
    try {
      this.child?.stdin.end();
      this.child?.kill();
    } catch {}
    this.child = undefined;
    this.failAll(new Error('cu_desktop_closed'));
  }
}

let sharedLocalClient: CuDesktopHostClient | undefined;
function localClient(): CuDesktopHostClient {
  sharedLocalClient ??= new CuDesktopHostClient();
  return sharedLocalClient;
}

export async function callCuDesktopDaemonRpc(
  method: string,
  params: DesktopRecord = {},
  signal?: AbortSignal,
): Promise<DesktopRecord> {
  const daemonUrl = process.env.MAGIC_POINTER_CU_DAEMON_URL;
  const daemonToken = process.env.MAGIC_POINTER_CU_DAEMON_TOKEN;
  if (daemonUrl && daemonToken) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const mergedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    try {
      const res = await fetch(`${daemonUrl.replace(/\/$/, '')}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mp-cu-token': daemonToken,
        },
        body: JSON.stringify({method, params}),
        signal: mergedSignal,
      });
      const json = (await res.json()) as DesktopRecord;
      if (!res.ok || json.error) {
        throw new ActionFailure(
          'tool_error',
          String(json.error || `cu_daemon_http_${res.status}`),
        );
      }
      return json.result ?? json;
    } finally {
      clearTimeout(timer);
    }
  }
  const client = localClient();
  if (method === 'status') {
    const ping = await client.request('ping', {}, signal).catch(() => ({
      open: false,
    }));
    const windows = ping.open ? await client.windows(signal).catch(() => []) : [];
    return {
      ok: true,
      active: Boolean(ping.open),
      windows,
    };
  }
  if (method === 'list_windows' || method === 'windows') {
    const ping = await client.request('ping', {}, signal).catch(() => ({
      open: false,
    }));
    if (!ping.open) {
      return {windows: [], count: 0, active: false, usedBackend: 'cu_second_desktop'};
    }
    const windows = await client.windows(signal);
    return {windows, count: windows.length, active: true, usedBackend: 'cu_second_desktop'};
  }
  if (method === 'screenshot' || method === 'capture') {
    await client.open({}, signal);
    const shot = await client.capture(params, signal);
    return {
      ...shot,
      imageLabel: `Isolated Second Desktop (${shot.width}x${shot.height})`,
      usedBackend: 'cu_second_desktop',
    };
  }
  if (method === 'resize') {
    return client.resize(
      Number(params.width) || 1280,
      Number(params.height) || 720,
      signal,
    );
  }
  if (method === 'inspect_ax') {
    return client.inspectAx(
      Number(params.hwnd) || undefined,
      Number(params.limit) || 120,
      signal,
    );
  }
  if (method === 'batch_act') {
    const steps = Array.isArray(params.steps) ? (params.steps as DesktopRecord[]) : [];
    const results: DesktopRecord[] = [];
    for (let i = 0; i < Math.min(16, steps.length); i++) {
      signal?.throwIfAborted();
      const step = steps[i] || {};
      const action = String(step.action || '').toLowerCase();
      if (action === 'wait') {
        const ms = Math.max(50, Math.min(3000, Number(step.ms) || 400));
        await new Promise(resolve => setTimeout(resolve, ms));
        results.push({index: i, ok: true, action: 'wait', ms});
        continue;
      }
      if (action === 'launch') {
        const launched = await client.launch(
          {
            app: String(step.app || ''),
            args: typeof step.args === 'string' ? step.args : undefined,
            cwd: typeof step.cwd === 'string' ? step.cwd : undefined,
          },
          signal,
        );
        results.push({index: i, ...launched});
        if (launched.ok === false) {
          break;
        }
        continue;
      }
      const res = await client.act(step, signal);
      results.push({index: i, ...res});
      if (res.ok === false) {
        break;
      }
    }
    const shot =
      params.includeScreenshot !== false
        ? await client.capture({}, signal).catch(() => null)
        : null;
    return {
      ok: results.length > 0 && results.every(r => r.ok !== false),
      completedCount: results.filter(r => r.ok !== false).length,
      results,
      ...(shot && shot.image
        ? {
            image: shot.image,
            mimeType: shot.mimeType || 'image/jpeg',
            imageLabel: `Isolated Second Desktop (${shot.width}x${shot.height})`,
            windows: shot.windows,
          }
        : {}),
      usedBackend: 'cu_second_desktop',
    };
  }
  if (method === 'close') {
    await client.close();
    return {ok: true, active: false, usedBackend: 'cu_second_desktop'};
  }
  return client.request(method, params, signal);
}

function cuEffectForAct(args: DesktopRecord): Effect {
  const intent = String(args.intent || '').toLowerCase();
  if (intent === 'send' || intent === 'submit') {
    return 'external_send';
  }
  if (intent === 'delete') {
    return 'destructive';
  }
  if (intent === 'purchase') {
    return 'purchase';
  }
  if (args.action === 'close_window') {
    return 'local_irreversible';
  }
  return 'reversible_write';
}

function scaleSecondDesktopCoords(
  args: DesktopRecord,
  desktopWidth = 1280,
  desktopHeight = 720,
): DesktopRecord {
  if (args.coordinate_space !== 'normalized') {
    return args;
  }
  const next = {...args};
  if (Number.isFinite(Number(next.x))) {
    next.x = Math.round(
      (Math.max(0, Math.min(1000, Number(next.x))) / 1000) * desktopWidth,
    );
  }
  if (Number.isFinite(Number(next.y))) {
    next.y = Math.round(
      (Math.max(0, Math.min(1000, Number(next.y))) / 1000) * desktopHeight,
    );
  }
  if (Number.isFinite(Number(next.to_x))) {
    next.to_x = Math.round(
      (Math.max(0, Math.min(1000, Number(next.to_x))) / 1000) * desktopWidth,
    );
  }
  if (Number.isFinite(Number(next.to_y))) {
    next.to_y = Math.round(
      (Math.max(0, Math.min(1000, Number(next.to_y))) / 1000) * desktopHeight,
    );
  }
  return next;
}

export interface RegisterCuDesktopToolsOptions {
  eager?: boolean;
  callDaemon?: (
    method: string,
    params: DesktopRecord,
    signal?: AbortSignal,
  ) => Promise<DesktopRecord>;
}

export function registerCuDesktopTools(
  registry: ToolRegistry,
  options: RegisterCuDesktopToolsOptions = {},
): void {
  const deferred = !options.eager;
  const invoke = options.callDaemon ?? callCuDesktopDaemonRpc;

  const string = {type: 'string'};
  const number = {type: 'number'};
  const integer = {type: 'integer'};
  const boolean = {type: 'boolean'};

  const register = (spec: ToolSpec) => {
    registry.register({
      ...spec,
      used_backend: 'cu_second_desktop',
      deferred,
      timeout_ms: spec.timeout_ms ?? 35000,
    });
  };

  register({
    name: 'DesktopWorkspace.open',
    description:
      'Open or ensure the Isolated Second Desktop workspace (1280x720) and dock its live dual-cursor viewport inside Magic Pointer Studio. Runs completely off the user’s primary desktop with zero cursor or focus disruption.',
    input_schema: {
      type: 'object',
      properties: {
        width: integer,
        height: integer,
      },
      required: [],
      additionalProperties: false,
    },
    effect: 'reversible_write',
    resource_keys: ['cu:second_desktop'],
    execute: async (args, context) =>
      invoke('open', args, context.signal),
  });

  register({
    name: 'DesktopWorkspace.launch',
    description:
      'Launch any Windows application, executable path, document, or URL inside the Isolated Second Desktop (e.g., "notepad", "msedge", "https://...", "powershell", "calc", "explorer", or a full path). Chromium browsers automatically start isolated with software compositing so every frame streams cleanly.',
    input_schema: {
      type: 'object',
      properties: {
        app: string,
        args: string,
        cwd: string,
        includeScreenshot: boolean,
      },
      required: ['app'],
      additionalProperties: false,
    },
    effect: 'reversible_write',
    resource_keys: ['cu:second_desktop'],
    execute: async (args, context) =>
      invoke('launch', args, context.signal),
  });

  register({
    name: 'DesktopWorkspace.list_windows',
    description:
      'List all visible windows running inside the Isolated Second Desktop workspace.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    effect: 'read',
    is_concurrency_safe: true,
    execute: async (args, context) =>
      invoke('list_windows', args, context.signal),
  });

  register({
    name: 'DesktopWorkspace.screenshot',
    description:
      'Capture the current 1280x720 composite screenshot of the Isolated Second Desktop and optionally read UI Automation elements for an hwnd.',
    input_schema: {
      type: 'object',
      properties: {
        hwnd: integer,
        quality: integer,
        includeElements: boolean,
      },
      required: [],
      additionalProperties: false,
    },
    effect: 'read',
    is_concurrency_safe: true,
    execute: async (args, context) =>
      invoke('screenshot', args, context.signal),
  });

  const singleActionProps = {
    action: {
      enum: [
        'click',
        'double_click',
        'right_click',
        'move',
        'drag',
        'type_text',
        'press_key',
        'scroll',
        'focus_window',
        'resize_window',
        'close_window',
      ],
    },
    x: number,
    y: number,
    to_x: number,
    to_y: number,
    width: integer,
    height: integer,
    coordinate_space: {enum: ['desktop', 'normalized']},
    button: {enum: ['left', 'right', 'middle']},
    count: integer,
    text: string,
    clear: boolean,
    submit: boolean,
    keys: string,
    dy: integer,
    hwnd: integer,
    label: string,
  };

  register({
    name: 'DesktopWorkspace.act',
    description:
      'Execute a GUI action (or ordered batch of actions) inside the Isolated Second Desktop without moving the user’s physical mouse. Moves the virtual orange Agent Cursor visibly in Studio’s live viewport, yields politely if the user clicks Pause/intervenes in the viewport, and returns updated verification/screenshot.',
    input_schema: {
      type: 'object',
      properties: {
        ...singleActionProps,
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: {
            type: 'object',
            properties: singleActionProps,
            required: ['action'],
            additionalProperties: false,
          },
        },
        intent: {
          enum: ['input', 'send', 'submit', 'delete', 'purchase'],
        },
        includeScreenshot: boolean,
      },
      required: [],
      additionalProperties: false,
    },
    effect: 'reversible_write',
    effect_for: cuEffectForAct,
    resource_keys: ['cu:second_desktop'],
    execute: async (args, context) => {
      if (Array.isArray(args.actions) && args.actions.length > 0) {
        const results: DesktopRecord[] = [];
        for (const step of args.actions) {
          context.signal.throwIfAborted();
          const scaled = scaleSecondDesktopCoords(step as DesktopRecord);
          results.push(await invoke('act', scaled, context.signal));
        }
        const screenshot =
          args.includeScreenshot !== false
            ? await invoke('screenshot', {}, context.signal).catch(() => null)
            : null;
        return {
          ok: results.every(r => r.ok !== false),
          steps: results,
          ...(screenshot && screenshot.image
            ? {
                image: screenshot.image,
                mimeType: screenshot.mimeType || 'image/jpeg',
                imageLabel: screenshot.imageLabel,
                windows: screenshot.windows,
              }
            : {}),
          usedBackend: 'cu_second_desktop',
        };
      }
      const scaled = scaleSecondDesktopCoords(args);
      return invoke('act', scaled, context.signal);
    },
  });

  register({
    name: 'DesktopWorkspace.inspect_ui',
    description:
      'Inspect the interactive UI Automation accessibility tree ([e1], [e2], ...) and exact desktop click coordinates (x, y) for an open window inside the Isolated Second Desktop. Call this before clicking when coordinates are uncertain.',
    input_schema: {
      type: 'object',
      properties: {
        hwnd: integer,
        limit: integer,
      },
      required: [],
      additionalProperties: false,
    },
    effect: 'read',
    is_concurrency_safe: true,
    execute: async (args, context) =>
      invoke('inspect_ax', args, context.signal),
  });

  register({
    name: 'DesktopWorkspace.close',
    description:
      'Close the Isolated Second Desktop workspace and terminate all apps spawned inside it cleanly.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    effect: 'reversible_write',
    resource_keys: ['cu:second_desktop'],
    execute: async (args, context) =>
      invoke('close', args, context.signal),
  });

  const batchStepProps = {
    ...singleActionProps,
    action: {
      enum: [
        'click',
        'double_click',
        'right_click',
        'move',
        'drag',
        'type_text',
        'press_key',
        'scroll',
        'focus_window',
        'resize_window',
        'close_window',
        'wait',
        'launch',
      ],
    },
    ms: integer,
    app: string,
    args: string,
    cwd: string,
    intent: {
      enum: ['input', 'send', 'submit', 'delete', 'purchase'],
    },
  };

  register({
    name: 'DesktopWorkspace.batch',
    description:
      'Execute up to 16 sequential GUI steps inside the Isolated Second Desktop in a single turn (clicks, typing, shortcuts, waits, launches) with optional final screenshot, eliminating extra round-trips.',
    input_schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: {
            type: 'object',
            properties: batchStepProps,
            required: ['action'],
            additionalProperties: false,
          },
        },
        includeScreenshot: boolean,
      },
      required: ['steps'],
      additionalProperties: false,
    },
    effect: 'reversible_write',
    effect_for: (args: DesktopRecord): Effect => {
      const steps = Array.isArray(args.steps)
        ? (args.steps as DesktopRecord[])
        : [];
      for (const s of steps) {
        const eff = cuEffectForAct(s);
        if (eff !== 'reversible_write') {
          return eff;
        }
      }
      return 'reversible_write';
    },
    resource_keys: ['cu:second_desktop'],
    timeout_ms: 55000,
    execute: async (args, context) => {
      const rawSteps = Array.isArray(args.steps)
        ? (args.steps as DesktopRecord[])
        : [];
      const scaledSteps = rawSteps.map(s => scaleSecondDesktopCoords(s));
      return invoke(
        'batch_act',
        {
          steps: scaledSteps,
          includeScreenshot: args.includeScreenshot !== false,
        },
        context.signal,
      );
    },
  });
}
