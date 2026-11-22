import {randomBytes, timingSafeEqual} from 'node:crypto';
import http from 'node:http';
import {
  CuDesktopHostClient,
  type CuDesktopWindow,
} from './runtime/cu_desktop_tools';
import type {DesktopRecord} from './runtime/desktop';

export interface CuCursorState {
  x: number;
  y: number;
  visible: boolean;
  pressing: boolean;
  action: string;
  label: string;
  updatedAt: number;
}

export interface CuHumanCursorState {
  x: number;
  y: number;
  visible: boolean;
  active: boolean;
  pressing: boolean;
  lastInputAt: number;
}

export interface CuDesktopStatusSnapshot {
  active: boolean;
  paused: boolean;
  desktopName: string;
  width: number;
  height: number;
  fps: number;
  viewportVisible: boolean;
  windows: CuDesktopWindow[];
  agentCursor: CuCursorState;
  humanCursor: CuHumanCursorState;
  lastAction: string;
}

export interface CuFramePayload {
  mimeType: string;
  image: string;
  width: number;
  height: number;
  fps: number;
  windows: CuDesktopWindow[];
  capturedAt: number;
}

export interface CuDaemonCallbacks {
  onFrame?: (frame: CuFramePayload) => void;
  onState?: (state: CuDesktopStatusSnapshot) => void;
  onCursor?: (cursors: {
    agentCursor: CuCursorState;
    humanCursor: CuHumanCursorState;
  }) => void;
  onOpenViewport?: (reason: string) => void;
  onLog?: (line: string) => void;
}

function nowMs(): number {
  return Date.now();
}

export class CuDesktopDaemon {
  private readonly client = new CuDesktopHostClient();
  private readonly token = randomBytes(24).toString('hex');
  private server?: http.Server;
  private rpcUrl = '';

  private active = false;
  private paused = false;
  private viewportVisible = false;
  private desktopName = 'MagicPointer_AgentDesktop';
  private width = 1280;
  private height = 720;
  private windows: CuDesktopWindow[] = [];
  private fps = 0;
  private lastAction = '';
  private frameTimestamps: number[] = [];
  private streamTimer?: NodeJS.Timeout;
  private captureBusy = false;
  private lastHumanMoveSentAt = 0;
  private lastFrame: CuFramePayload | null = null;

  private agentCursor: CuCursorState = {
    x: 640,
    y: 360,
    visible: false,
    pressing: false,
    action: 'idle',
    label: '',
    updatedAt: 0,
  };

  private humanCursor: CuHumanCursorState = {
    x: 0,
    y: 0,
    visible: false,
    active: false,
    pressing: false,
    lastInputAt: 0,
  };

  constructor(private readonly callbacks: CuDaemonCallbacks = {}) {}

  async startRpcServer(): Promise<{url: string; token: string}> {
    if (this.server && this.rpcUrl) {
      return {url: this.rpcUrl, token: this.token};
    }
    const tokenBuf = Buffer.from(this.token, 'utf8');
    this.server = http.createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/rpc') {
        res.writeHead(404).end(JSON.stringify({error: 'not_found'}));
        return;
      }
      const presented = Buffer.from(
        String(req.headers['x-mp-cu-token'] || ''),
        'utf8',
      );
      if (
        presented.length !== tokenBuf.length ||
        !timingSafeEqual(presented, tokenBuf)
      ) {
        res.writeHead(401).end(JSON.stringify({error: 'unauthorized'}));
        return;
      }
      let rawBody = '';
      for await (const chunk of req) {
        rawBody += String(chunk);
        if (rawBody.length > 2 * 1024 * 1024) {
          res.writeHead(413).end(JSON.stringify({error: 'payload_too_large'}));
          return;
        }
      }
      try {
        const parsed = JSON.parse(rawBody || '{}') as {
          method?: string;
          params?: DesktopRecord;
        };
        const result = await this.handleRpc(
          String(parsed.method || ''),
          parsed.params || {},
        );
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({result}));
      } catch (error) {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    });

    await new Promise<void>(resolve => {
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address();
    const port =
      typeof addr === 'object' && addr ? addr.port : 0;
    this.rpcUrl = `http://127.0.0.1:${port}`;
    return {url: this.rpcUrl, token: this.token};
  }

  rpcEnv(): {MAGIC_POINTER_CU_DAEMON_URL?: string; MAGIC_POINTER_CU_DAEMON_TOKEN?: string} {
    if (!this.rpcUrl) {
      return {};
    }
    return {
      MAGIC_POINTER_CU_DAEMON_URL: this.rpcUrl,
      MAGIC_POINTER_CU_DAEMON_TOKEN: this.token,
    };
  }

  status(): CuDesktopStatusSnapshot {
    return {
      active: this.active,
      paused: this.paused,
      desktopName: this.desktopName,
      width: this.width,
      height: this.height,
      fps: this.fps,
      viewportVisible: this.viewportVisible,
      windows: [...this.windows],
      agentCursor: {...this.agentCursor},
      humanCursor: {...this.humanCursor},
      lastAction: this.lastAction,
    };
  }

  latestFrame(): CuFramePayload | null {
    return this.lastFrame;
  }

  setViewportVisible(visible: boolean): void {
    const changed = this.viewportVisible !== visible;
    this.viewportVisible = visible;
    if (changed) {
      this.restartStreamTimer();
      this.emitState();
      if (visible && this.active) {
        void this.captureAndEmitFrame();
      }
    }
  }

  setPaused(paused: boolean): CuDesktopStatusSnapshot {
    this.paused = Boolean(paused);
    this.lastAction = this.paused
      ? 'Paused by user'
      : 'Agent resumed';
    this.emitState();
    return this.status();
  }

  async open(params: {width?: number; height?: number} = {}): Promise<DesktopRecord> {
    const reqW = Number(params.width) || this.width;
    const reqH = Number(params.height) || this.height;
    const res = await this.client.open({
      width: reqW,
      height: reqH,
      name: this.desktopName,
    });
    this.active = true;
    this.paused = false;
    this.desktopName = String(res.desktopName || this.desktopName);
    this.width = Number(res.width) || reqW;
    this.height = Number(res.height) || reqH;
    this.agentCursor = {
      ...this.agentCursor,
      x: Math.round(this.width / 2),
      y: Math.round(this.height / 2),
      visible: true,
      action: 'ready',
      label: 'Second Desktop Ready',
      updatedAt: nowMs(),
    };
    this.lastAction = 'Isolated Second Desktop started';
    this.callbacks.onOpenViewport?.('open');
    this.restartStreamTimer();
    this.emitState();
    this.emitCursor();
    await this.captureAndEmitFrame();
    return {...res, status: this.status()};
  }

  async resize(params: {width?: number; height?: number} = {}): Promise<DesktopRecord> {
    const nextW = Math.max(480, Math.min(1920, Math.round(Number(params.width) || this.width) & ~1));
    const nextH = Math.max(420, Math.min(1200, Math.round(Number(params.height) || this.height) & ~1));
    if (nextW === this.width && nextH === this.height && this.active) {
      return {ok: true, width: this.width, height: this.height, unchanged: true};
    }
    this.width = nextW;
    this.height = nextH;
    let res: DesktopRecord = {ok: true, width: nextW, height: nextH};
    if (this.active) {
      res = await this.client.resize(nextW, nextH);
      this.width = Number(res.width) || nextW;
      this.height = Number(res.height) || nextH;
      this.agentCursor = {
        ...this.agentCursor,
        x:
          this.agentCursor.action === 'ready'
            ? Math.round(this.width / 2)
            : Math.max(0, Math.min(this.width, this.agentCursor.x)),
        y:
          this.agentCursor.action === 'ready'
            ? Math.round(this.height / 2)
            : Math.max(0, Math.min(this.height, this.agentCursor.y)),
      };
      this.windows = await this.client.windows().catch(() => this.windows);
      this.emitCursor();
      this.emitState();
      await this.captureAndEmitFrame();
    } else {
      this.emitState();
    }
    return {...res, status: this.status()};
  }

  async inspectAx(params: {hwnd?: number; limit?: number} = {}): Promise<DesktopRecord> {
    if (!this.active) {
      return {
        ok: false,
        reason: 'desktop_not_active',
        elements: [],
        treeText: '',
        usedBackend: 'cu_second_desktop',
      };
    }
    const res = await this.client.inspectAx(
      Number(params.hwnd) || undefined,
      Number(params.limit) || 120,
    );
    return {
      ...res,
      desktopWidth: this.width,
      desktopHeight: this.height,
      usedBackend: 'cu_second_desktop',
    };
  }

  async batchAct(params: {
    steps?: DesktopRecord[];
    includeScreenshot?: boolean;
  }): Promise<DesktopRecord> {
    if (!this.active) {
      await this.open();
    }
    const steps = Array.isArray(params.steps) ? params.steps.slice(0, 16) : [];
    const results: DesktopRecord[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] || {};
      const action = String(step.action || '').toLowerCase();
      if (action === 'wait') {
        const ms = Math.max(50, Math.min(3000, Number(step.ms) || 400));
        await new Promise(resolve => setTimeout(resolve, ms));
        results.push({index: i, ok: true, action: 'wait', ms});
        continue;
      }
      if (action === 'launch') {
        const launched = await this.launch({
          app: String(step.app || ''),
          args: typeof step.args === 'string' ? step.args : undefined,
          cwd: typeof step.cwd === 'string' ? step.cwd : undefined,
          includeScreenshot: false,
        });
        results.push({index: i, ...launched});
        if (launched.ok === false) {
          break;
        }
        continue;
      }
      const stepRes = await this.actAgent({
        ...step,
        includeScreenshot: false,
        _skipCapture: i + 1 < steps.length && steps.length > 2,
      });
      results.push({index: i, ...stepRes});
      if (stepRes.yieldedToUser || stepRes.ok === false) {
        break;
      }
    }
    const frame = await this.captureAndEmitFrame();
    const allOk = results.length > 0 && results.every(r => r.ok !== false);
    return {
      ok: allOk,
      completedCount: results.filter(r => r.ok !== false).length,
      results,
      windows: this.windows,
      desktopWidth: this.width,
      desktopHeight: this.height,
      ...(params.includeScreenshot !== false && frame
        ? {
            image: frame.image,
            mimeType: frame.mimeType,
            imageLabel: `Isolated Second Desktop (${frame.width}x${frame.height})`,
          }
        : {}),
      usedBackend: 'cu_second_desktop',
    };
  }

  async launch(params: {
    app: string;
    args?: string;
    cwd?: string;
    includeScreenshot?: boolean;
  }): Promise<DesktopRecord> {
    if (!this.active) {
      await this.open();
    }
    this.agentCursor = {
      ...this.agentCursor,
      visible: true,
      action: 'launch',
      label: `Launching ${String(params.app || '').slice(0, 22)}`,
      updatedAt: nowMs(),
    };
    this.lastAction = `Launch ${params.app}`;
    this.emitCursor();
    this.callbacks.onOpenViewport?.('launch');

    const res = await this.client.launch(params);
    if (Array.isArray(res.windows)) {
      this.windows = res.windows as CuDesktopWindow[];
    }
    if (res.window?.bbox) {
      const [l, t, r, b] = res.window.bbox as [number, number, number, number];
      this.agentCursor = {
        ...this.agentCursor,
        x: Math.round((l + r) / 2),
        y: Math.round((t + b) / 2),
        visible: true,
        action: 'ready',
        label: String(res.window.title || params.app).slice(0, 26),
        updatedAt: nowMs(),
      };
    }
    this.emitCursor();
    this.emitState();
    const frame = await this.captureAndEmitFrame();
    return {
      ...res,
      ...(params.includeScreenshot !== false && frame
        ? {
            image: frame.image,
            mimeType: frame.mimeType,
            imageLabel: `Isolated Second Desktop (${frame.width}x${frame.height})`,
          }
        : {}),
    };
  }

  async listWindows(): Promise<{
    windows: CuDesktopWindow[];
    count: number;
    active: boolean;
  }> {
    if (!this.active) {
      return {windows: [], count: 0, active: false};
    }
    this.windows = await this.client.windows();
    return {windows: this.windows, count: this.windows.length, active: true};
  }

  async screenshot(params: {
    hwnd?: number;
    quality?: number;
    includeElements?: boolean;
  } = {}): Promise<DesktopRecord> {
    if (!this.active) {
      await this.open();
    }
    const shot = await this.client.capture({
      quality: Number(params.quality) || 78,
    });
    if (Array.isArray(shot.windows)) {
      this.windows = shot.windows as CuDesktopWindow[];
    }
    const frame: CuFramePayload = {
      mimeType: String(shot.mimeType || 'image/jpeg'),
      image: String(shot.image || ''),
      width: Number(shot.width) || this.width,
      height: Number(shot.height) || this.height,
      fps: this.fps,
      windows: this.windows,
      capturedAt: Number(shot.capturedAt) || nowMs(),
    };
    this.lastFrame = frame;
    this.callbacks.onFrame?.(frame);
    let outline: DesktopRecord[] | undefined;
    if (params.includeElements !== false) {
      const targetHwnd = Number(params.hwnd || this.windows[0]?.hwnd || 0);
      if (targetHwnd > 0) {
        const elems = await this.client.elements(targetHwnd, 120).catch(() => []);
        outline = elems.slice(0, 80);
      }
    }
    return {
      ...shot,
      imageLabel: `Isolated Second Desktop (${frame.width}x${frame.height})`,
      ...(outline ? {outline} : {}),
      usedBackend: 'cu_second_desktop',
    };
  }

  async actAgent(params: DesktopRecord): Promise<DesktopRecord> {
    if (!this.active) {
      await this.open();
    }
    if (this.paused) {
      return {
        ok: false,
        yieldedToUser: true,
        paused: true,
        reason: 'paused_by_user',
        message: 'Second Desktop is paused for manual user collaboration.',
        usedBackend: 'cu_second_desktop',
      };
    }
    // Cooperative soft yield when user is actively pointing/typing in viewport
    const deadline = nowMs() + 1800;
    while (
      !this.paused &&
      nowMs() - this.humanCursor.lastInputAt < 1200 &&
      nowMs() < deadline
    ) {
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    if (this.paused) {
      return {
        ok: false,
        yieldedToUser: true,
        paused: true,
        reason: 'paused_by_user',
        usedBackend: 'cu_second_desktop',
      };
    }

    const action = String(params.action || 'click');
    const tx = Number.isFinite(Number(params.x))
      ? Math.round(Number(params.x))
      : this.agentCursor.x;
    const ty = Number.isFinite(Number(params.y))
      ? Math.round(Number(params.y))
      : this.agentCursor.y;
    const label =
      String(params.label || '').trim().slice(0, 28) ||
      describeAgentAction(action, params);

    this.agentCursor = {
      x: Math.max(0, Math.min(this.width, tx)),
      y: Math.max(0, Math.min(this.height, ty)),
      visible: true,
      pressing: ['click', 'double_click', 'right_click', 'drag'].includes(
        action,
      ),
      action,
      label,
      updatedAt: nowMs(),
    };
    this.lastAction = label;
    this.callbacks.onOpenViewport?.('act');
    this.emitCursor();

    const result = await this.client.act({...params, source: 'agent'});
    if (Array.isArray(this.windows)) {
      this.windows = await this.client.windows().catch(() => this.windows);
    }

    this.agentCursor = {
      ...this.agentCursor,
      pressing: false,
      updatedAt: nowMs(),
    };
    this.emitCursor();
    this.emitState();

    const skipCapture = Boolean(params._skipCapture);
    const frame = skipCapture ? this.lastFrame : await this.captureAndEmitFrame();
    return {
      ...result,
      agentCursor: this.agentCursor,
      disruptedUser: false,
      ...(params.includeScreenshot === true && frame
        ? {
            image: frame.image,
            mimeType: frame.mimeType,
            imageLabel: `Isolated Second Desktop (${frame.width}x${frame.height})`,
          }
        : {}),
      usedBackend: 'cu_second_desktop',
    };
  }

  async handleHumanInput(input: DesktopRecord): Promise<DesktopRecord> {
    if (!this.active) {
      return {ok: false, reason: 'desktop_not_active'};
    }
    const kind = String(input.kind || '');
    const t = nowMs();
    if (kind === 'leave') {
      this.humanCursor = {
        ...this.humanCursor,
        visible: false,
        active: false,
        pressing: false,
      };
      this.emitCursor();
      return {ok: true};
    }

    const x = Number.isFinite(Number(input.x))
      ? Math.max(0, Math.min(this.width, Math.round(Number(input.x))))
      : this.humanCursor.x;
    const y = Number.isFinite(Number(input.y))
      ? Math.max(0, Math.min(this.height, Math.round(Number(input.y))))
      : this.humanCursor.y;

    this.humanCursor = {
      x,
      y,
      visible: true,
      active: kind !== 'move',
      pressing:
        kind === 'down'
          ? true
          : kind === 'up'
            ? false
            : this.humanCursor.pressing,
      lastInputAt: kind === 'move' ? this.humanCursor.lastInputAt : t,
    };
    this.emitCursor();

    if (kind === 'move') {
      if (t - this.lastHumanMoveSentAt < 35) {
        return {ok: true, throttled: true};
      }
      this.lastHumanMoveSentAt = t;
      await this.client
        .act({action: 'move', x, y, source: 'human'})
        .catch(() => {});
      return {ok: true};
    }

    if (kind === 'click' || kind === 'down') {
      if (kind === 'down') {
        return {ok: true};
      }
      const res = await this.client.act({
        action:
          input.button === 'right'
            ? 'right_click'
            : input.count === 2
              ? 'double_click'
              : 'click',
        x,
        y,
        button: input.button || 'left',
        count: input.count || 1,
        source: 'human',
      });
      await this.captureAndEmitFrame();
      return res;
    }

    if (kind === 'dblclick') {
      const res = await this.client.act({
        action: 'double_click',
        x,
        y,
        source: 'human',
      });
      await this.captureAndEmitFrame();
      return res;
    }

    if (kind === 'contextmenu') {
      const res = await this.client.act({
        action: 'right_click',
        x,
        y,
        source: 'human',
      });
      await this.captureAndEmitFrame();
      return res;
    }

    if (kind === 'wheel') {
      const res = await this.client.act({
        action: 'scroll',
        x,
        y,
        dy: Number(input.dy) || -120,
        source: 'human',
      });
      await this.captureAndEmitFrame();
      return res;
    }

    if (kind === 'type_text') {
      const res = await this.client.act({
        action: 'type_text',
        text: String(input.text || ''),
        source: 'human',
      });
      await this.captureAndEmitFrame();
      return res;
    }

    if (kind === 'keydown') {
      const res = await this.client.act({
        action: 'press_key',
        keys: String(input.keys || input.key || ''),
        source: 'human',
      });
      await this.captureAndEmitFrame();
      return res;
    }

    return {ok: true};
  }

  async close(): Promise<DesktopRecord> {
    this.stopStreamTimer();
    this.active = false;
    this.paused = false;
    this.windows = [];
    this.fps = 0;
    this.lastFrame = null;
    this.agentCursor = {...this.agentCursor, visible: false, action: 'idle'};
    this.humanCursor = {...this.humanCursor, visible: false, active: false};
    this.lastAction = 'Second Desktop closed';
    await this.client.close().catch(() => {});
    this.emitCursor();
    this.emitState();
    return {ok: true, active: false, usedBackend: 'cu_second_desktop'};
  }

  async shutdown(): Promise<void> {
    await this.close();
    if (this.server) {
      await new Promise<void>(resolve => {
        this.server!.close(() => resolve());
      });
      this.server = undefined;
      this.rpcUrl = '';
    }
  }

  private async handleRpc(
    method: string,
    params: DesktopRecord,
  ): Promise<DesktopRecord> {
    switch (method) {
      case 'open':
        return this.open(params);
      case 'resize':
        return this.resize(params);
      case 'launch':
        return this.launch(params as {app: string; args?: string; cwd?: string});
      case 'list_windows':
      case 'windows':
        return this.listWindows();
      case 'inspect_ax':
        return this.inspectAx(params as {hwnd?: number; limit?: number});
      case 'screenshot':
      case 'capture':
        return this.screenshot(params);
      case 'act':
        return this.actAgent(params);
      case 'batch_act':
        return this.batchAct(
          params as {steps?: DesktopRecord[]; includeScreenshot?: boolean},
        );
      case 'status':
        return this.status();
      case 'close':
        return this.close();
      default:
        throw new Error(`unknown_cu_daemon_method:${method}`);
    }
  }

  private restartStreamTimer(): void {
    this.stopStreamTimer();
    if (!this.active) {
      return;
    }
    const intervalMs = this.viewportVisible ? 105 : 950;
    this.streamTimer = setInterval(() => {
      void this.captureAndEmitFrame();
    }, intervalMs);
    this.streamTimer.unref();
  }

  private stopStreamTimer(): void {
    if (this.streamTimer) {
      clearInterval(this.streamTimer);
      this.streamTimer = undefined;
    }
  }

  private async captureAndEmitFrame(): Promise<CuFramePayload | null> {
    if (!this.active || this.captureBusy) {
      return this.lastFrame;
    }
    this.captureBusy = true;
    try {
      const shot = await this.client.capture({
        quality: this.viewportVisible ? 76 : 60,
      });
      const ts = nowMs();
      this.frameTimestamps.push(ts);
      this.frameTimestamps = this.frameTimestamps.filter(t => ts - t < 1500);
      this.fps = Math.round(
        (this.frameTimestamps.length / 1.5) * 10,
      ) / 10;
      if (Array.isArray(shot.windows)) {
        this.windows = shot.windows as CuDesktopWindow[];
      }
      const frame: CuFramePayload = {
        mimeType: String(shot.mimeType || 'image/jpeg'),
        image: String(shot.image || ''),
        width: Number(shot.width) || this.width,
        height: Number(shot.height) || this.height,
        fps: this.fps,
        windows: this.windows,
        capturedAt: Number(shot.capturedAt) || ts,
      };
      this.lastFrame = frame;
      this.callbacks.onFrame?.(frame);
      return frame;
    } catch (error) {
      this.callbacks.onLog?.(
        `cu_desktop capture error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.lastFrame;
    } finally {
      this.captureBusy = false;
    }
  }

  private emitState(): void {
    this.callbacks.onState?.(this.status());
  }

  private emitCursor(): void {
    this.callbacks.onCursor?.({
      agentCursor: {...this.agentCursor},
      humanCursor: {...this.humanCursor},
    });
  }
}

function describeAgentAction(action: string, params: DesktopRecord): string {
  switch (action) {
    case 'click':
      return 'Clicking';
    case 'double_click':
      return 'Double-clicking';
    case 'right_click':
      return 'Right-clicking';
    case 'type_text':
      return `Typing "${String(params.text || '').slice(0, 14)}"`;
    case 'press_key':
      return `Key: ${String(params.keys || '').slice(0, 14)}`;
    case 'scroll':
      return 'Scrolling';
    case 'drag':
      return 'Dragging';
    default:
      return action;
  }
}
