'use strict';


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

const SAMPLE_INTERVAL_MS = 16;

const COALESCE_RELEASE_MS = 64;

interface CursorSurface {
  display: AgentDisplay;
  bounds: AgentSurfaceBounds;
  window: BrowserWindow | null;
  gate: CursorSampleGate;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

export interface AgentCursorSurfacesOptions {
  rendererFile: string;
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

  ack(displayId: string): void {
    const surface = this.surfaces.get(displayId);
    if (surface) surface.gate.ack();
  }

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

  startSampling(): void {
    if (this.sampleTimer) return;
    if (![...this.surfaces.values()].some(surface => surface.window?.isVisible())) return;
    this.sampleTimer = setInterval(() => {
      this.sample(screen.getCursorScreenPoint());
    }, SAMPLE_INTERVAL_MS);
    if (typeof this.sampleTimer.unref === 'function') this.sampleTimer.unref();
  }

  stopSampling(): void {
    if (!this.sampleTimer) return;
    clearInterval(this.sampleTimer);
    this.sampleTimer = null;
  }

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

  surfaceBounds(): AgentSurfaceBounds[] {
    return [...this.surfaces.values()].map((surface) => surface.bounds);
  }
}

module.exports = { AgentCursorSurfaces, SAMPLE_INTERVAL_MS, COALESCE_RELEASE_MS };
