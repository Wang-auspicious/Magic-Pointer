'use strict';

/* Twin cursor（双生鼠标）的窗口与采样层。
 *
 * 这一层只做三件事：开窗、采样、转发。所有判断都在
 * electron/agent_cursor_policy.ts（已单测），这里不写业务逻辑——因为它需要
 * 真实 Electron 才能跑，而本仓库不启 GUI 测试。
 *
 * 三条硬约束，全部有出处：
 *
 * 1. **每屏一个窗口，创建后永不移动。** main.ts:3518-3524 已经记录过：高频
 *    setBounds 会让 Windows 每次重设光标区域，光标在 CSS 光标和原生光标之间
 *    闪。Clicky 也是"每屏一个全屏窗口，buddy 在窗口内移动"
 *    （OverlayWindow.swift:340、:783-808）。
 * 2. **底部留 2px。** 置顶全屏窗口会压掉 Windows 自动隐藏任务栏的呼出热区
 *    （clicky-windows/ui/overlay.py:390-392）。
 * 3. **不做内容保护。** main.ts:895-903 给 overlay/stage 开了
 *    setContentProtection，那是为了不让胶囊污染截图；代理光标正相反——agent
 *    自己的截图里应该看得到它在哪里。
 *
 * 窗口复用 renderer/index.html：不新增渲染页面，所以不需要动 electron/renderer。
 * 没有代理光标时窗口隐藏；装饰层不接收原生鼠标消息，位置仅由采样 IPC 提供。
 */

import path from 'node:path';

import { BrowserWindow, screen } from 'electron';

import {
  AgentDisplay,
  AgentSurfaceBounds,
  CursorSampleGate,
  TASKBAR_SHAVE_PX,
  agentSurfaceBounds,
  agentSurfaceForPoint,
  normalizeAgentCursorCommand,
  parseAgentDisplays,
} from './agent_cursor_policy';

/** 采样周期。openclicky 用 16ms / 62.5Hz（OverlayWindow.swift:1237）。 */
const SAMPLE_INTERVAL_MS = 16;

/**
 * 合并标记的兜底释放时间。
 *
 * Clicky 靠渲染进程 ack 清标记（OverlayWindow.swift:1246-1254），因为它是跨
 * 线程投递。这里 webContents.send 本身已经是队列语义，一个 64ms（4 帧）的兜
 * 底释放就足以防止"忙一下之后攒下的陈旧更新一起回放成卡顿"，又不会在渲染进
 * 程不回话时把光标永久冻住。
 */
const COALESCE_RELEASE_MS = 64;

interface CursorSurface {
  display: AgentDisplay;
  bounds: AgentSurfaceBounds;
  window: BrowserWindow | null;
  gate: CursorSampleGate;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

export interface AgentCursorSurfacesOptions {
  /** renderer/index.html 的绝对路径。 */
  rendererFile: string;
  /** 调试用：把 setBounds / 采样决策写进 electron.log。 */
  log?: (message: string) => void;
}

export class AgentCursorSurfaces {
  private readonly rendererFile: string;
  private readonly logLine: (message: string) => void;
  private surfaces = new Map<string, CursorSurface>();
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private onDisplayChange: (() => void) | null = null;

  constructor(options: AgentCursorSurfacesOptions) {
    this.rendererFile = options.rendererFile;
    this.logLine = options.log || (() => {});
  }

  /** 按当前显示器列表建/拆窗口。创建后不再移动已有窗口。 */
  sync(displaysRaw?: unknown): void {
    const displays: AgentDisplay[] = displaysRaw
      ? parseAgentDisplays(displaysRaw)
      : parseAgentDisplays(screen.getAllDisplays());
    const wanted = new Set(displays.map((display) => display.displayId));
    for (const [displayId, surface] of this.surfaces) {
      if (!wanted.has(displayId)) {
        this.destroySurface(surface);
        this.surfaces.delete(displayId);
      }
    }
    for (const display of displays) {
      const existing = this.surfaces.get(display.displayId);
      if (existing) {
        existing.display = display;
        existing.bounds = agentSurfaceBounds(display, TASKBAR_SHAVE_PX);
        continue;
      }
      const bounds = agentSurfaceBounds(display, TASKBAR_SHAVE_PX);
      const surface: CursorSurface = {
        display,
        bounds,
        window: null,
        gate: new CursorSampleGate(),
        releaseTimer: null,
      };
      surface.window = this.createWindow(surface);
      this.surfaces.set(display.displayId, surface);
    }
  }

  private createWindow(surface: CursorSurface): BrowserWindow {
    const bounds = surface.bounds;
    const window = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      fullscreenable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      alwaysOnTop: true,
      // 不抢焦点的关键标志，等价于 clicky 的 canBecomeKey=false
      // （OverlayWindow.swift:46-52）和 Qt 的 WA_ShowWithoutActivating。
      focusable: false,
      acceptFirstMouse: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // The shared renderer hides the native cursor. Forwarding WM_MOUSEMOVE to
    // this decorative layer lets that CSS cursor compete with the app below.
    // Coordinates already arrive through overlay:cursor; no native forwarding.
    window.setIgnoreMouseEvents(true);
    window.loadFile(this.rendererFile);
    this.logLine(`agent cursor surface ${surface.display.displayId} ${bounds.width}x${bounds.height}@${bounds.x},${bounds.y}`);
    return window;
  }

  private destroySurface(surface: CursorSurface): void {
    if (surface.releaseTimer) clearTimeout(surface.releaseTimer);
    surface.releaseTimer = null;
    const window = surface.window;
    surface.window = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  /** 采样一次指针位置，投递给覆盖它的那块屏。 */
  sample(point: { x: number; y: number }): boolean {
    const displays = [...this.surfaces.values()].map((surface) => surface.display);
    const routed = agentSurfaceForPoint(displays, point, TASKBAR_SHAVE_PX);
    if (!routed) return false;
    const surface = this.surfaces.get(routed.surface.displayId);
    if (!surface || !surface.window || surface.window.isDestroyed() || !surface.window.isVisible()) return false;
    if (!surface.gate.accept(point)) return false;
    surface.window.webContents.send('overlay:cursor', {
      x: routed.localX,
      y: routed.localY,
      globalX: point.x,
      globalY: point.y,
      t: Date.now(),
      displayId: routed.surface.displayId,
    });
    if (surface.releaseTimer) clearTimeout(surface.releaseTimer);
    surface.releaseTimer = setTimeout(() => {
      surface.releaseTimer = null;
      surface.gate.ack();
    }, COALESCE_RELEASE_MS);
    return true;
  }

  /** 渲染进程确认消费后调用（可选；未确认时由兜底定时器释放）。 */
  ack(displayId: string): void {
    const surface = this.surfaces.get(displayId);
    if (surface) surface.gate.ack();
  }

  /** 把一条代理光标指令广播给所有屏。 */
  command(raw: unknown): boolean {
    const command = normalizeAgentCursorCommand(raw);
    if (!command) return false;
    let delivered = false;
    for (const surface of this.surfaces.values()) {
      const window = surface.window;
      if (!window || window.isDestroyed()) continue;
      if (command.kind === 'clear' || command.kind === 'release' || command.kind === 'hold') {
        window.webContents.send('overlay:agent-cursor', command);
        if (command.kind === 'clear') window.hide();
        delivered = true;
        continue;
      }
      // 坐标是屏幕坐标：只发给拥有它的那块屏，发出去的必须是该屏的本地坐标。
      const displays = [...this.surfaces.values()].map((entry) => entry.display);
      const routed = agentSurfaceForPoint(displays, { x: command.x, y: command.y }, TASKBAR_SHAVE_PX);
      if (!routed || routed.surface.displayId !== surface.display.displayId) continue;
      if (!window.isVisible()) window.showInactive();
      window.webContents.send('overlay:agent-cursor', {
        ...command,
        x: routed.localX,
        y: routed.localY,
      });
      delivered = true;
    }
    if (command.kind === 'clear') this.stopSampling();
    else if (delivered) this.startSampling();
    return delivered;
  }

  /** 起一个独立的 16ms 采样定时器。 */
  startSampling(): void {
    if (this.sampleTimer) return;
    if (![...this.surfaces.values()].some(surface => surface.window?.isVisible())) return;
    this.sampleTimer = setInterval(() => {
      this.sample(screen.getCursorScreenPoint());
    }, SAMPLE_INTERVAL_MS);
    // 定时器不应该让进程活着：这是一个纯装饰性的循环。
    if (typeof this.sampleTimer.unref === 'function') this.sampleTimer.unref();
  }

  stopSampling(): void {
    if (!this.sampleTimer) return;
    clearInterval(this.sampleTimer);
    this.sampleTimer = null;
  }

  /** 显示器增删/分辨率变化时重建窗口并重新开始采样。 */
  watchDisplays(resync: () => void): void {
    this.onDisplayChange = resync;
    screen.on('display-added', this.onDisplayChange);
    screen.on('display-removed', this.onDisplayChange);
    screen.on('display-metrics-changed', this.onDisplayChange);
  }

  dispose(): void {
    this.stopSampling();
    if (this.onDisplayChange) {
      screen.removeListener('display-added', this.onDisplayChange);
      screen.removeListener('display-removed', this.onDisplayChange);
      screen.removeListener('display-metrics-changed', this.onDisplayChange);
      this.onDisplayChange = null;
    }
    for (const surface of this.surfaces.values()) this.destroySurface(surface);
    this.surfaces.clear();
  }

  /** 测试/诊断用：当前每屏窗口的矩形。 */
  surfaceBounds(): AgentSurfaceBounds[] {
    return [...this.surfaces.values()].map((surface) => surface.bounds);
  }
}

module.exports = { AgentCursorSurfaces, SAMPLE_INTERVAL_MS, COALESCE_RELEASE_MS };
