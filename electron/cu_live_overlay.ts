'use strict';

import path from 'node:path';

export interface CuTeachStep {
  kind?: string;
  x: number;
  y: number;
  label: string;
  screen?: number;
  caption?: string;
  sentence?: string;
}

export type CuOverlayMode = 'idle' | 'autopilot' | 'teach' | 'record';

export interface RecordedDemoStep {
  x: number;
  y: number;
  label: string;
  windowTitle: string;
  screen: number;
  at: number;
}

export interface CuOverlayState {
  mode: CuOverlayMode;
  windowTitle: string;
  actionLabel: string;
  stepIndex: number;
  paused: boolean;
  teachSteps: readonly CuTeachStep[];
  teachIndex: number;
  recordTitle: string;
  recordStartedAt: number;
  recordedSteps: readonly RecordedDemoStep[];
}

export class CuOverlayController {
  private state: CuOverlayState = {
    mode: 'idle',
    windowTitle: '',
    actionLabel: '',
    stepIndex: 0,
    paused: false,
    teachSteps: [],
    teachIndex: 0,
    recordTitle: '',
    recordStartedAt: 0,
    recordedSteps: [],
  };

  getState(): CuOverlayState {
    return {...this.state};
  }

  startAutopilot(input: {
    windowTitle?: string;
    actionLabel?: string;
    stepIndex?: number;
  }): CuOverlayState {
    this.state = {
      ...this.state,
      mode: 'autopilot',
      windowTitle: String(input.windowTitle || '').trim().slice(0, 80),
      actionLabel: String(input.actionLabel || '执行桌面操作').trim().slice(0, 120),
      stepIndex: Math.max(1, Math.floor(Number(input.stepIndex) || 1)),
      paused: false,
    };
    return this.getState();
  }

  pauseForTakeover(): CuOverlayState {
    if (this.state.mode === 'autopilot') {
      this.state = {...this.state, paused: true};
    }
    return this.getState();
  }

  resumeAutopilot(): CuOverlayState {
    if (this.state.mode === 'autopilot') {
      this.state = {...this.state, paused: false};
    }
    return this.getState();
  }

  startTeach(steps: readonly CuTeachStep[]): CuOverlayState {
    const clean = Array.isArray(steps) ? steps.slice(0, 40) : [];
    this.state = {
      ...this.state,
      mode: clean.length > 0 ? 'teach' : 'idle',
      teachSteps: clean,
      teachIndex: 0,
      paused: false,
    };
    return this.getState();
  }

  currentTeachStep(): CuTeachStep | null {
    if (this.state.mode !== 'teach') {
      return null;
    }
    return this.state.teachSteps[this.state.teachIndex] ?? null;
  }

  nextTeachStep(): CuTeachStep | null {
    if (this.state.mode !== 'teach' || !this.state.teachSteps.length) {
      return null;
    }
    const next = Math.min(
      this.state.teachSteps.length - 1,
      this.state.teachIndex + 1,
    );
    this.state = {...this.state, teachIndex: next};
    return this.state.teachSteps[next] ?? null;
  }

  prevTeachStep(): CuTeachStep | null {
    if (this.state.mode !== 'teach' || !this.state.teachSteps.length) {
      return null;
    }
    const prev = Math.max(0, this.state.teachIndex - 1);
    this.state = {...this.state, teachIndex: prev};
    return this.state.teachSteps[prev] ?? null;
  }

  exitTeach(): CuOverlayState {
    this.state = {
      ...this.state,
      mode: 'idle',
      teachSteps: [],
      teachIndex: 0,
    };
    return this.getState();
  }

  startRecord(title = '桌面操作示范'): CuOverlayState {
    this.state = {
      ...this.state,
      mode: 'record',
      recordTitle: String(title || '桌面操作示范').trim().slice(0, 80),
      recordStartedAt: Date.now(),
      recordedSteps: [],
      paused: false,
    };
    return this.getState();
  }

  recordStep(input: {
    x: number;
    y: number;
    label?: string;
    windowTitle?: string;
    screen?: number;
  }): RecordedDemoStep | null {
    if (this.state.mode !== 'record') {
      return null;
    }
    const stepNumber = this.state.recordedSteps.length + 1;
    const x = Math.max(0, Math.min(1000, Math.round(Number(input.x) || 0)));
    const y = Math.max(0, Math.min(1000, Math.round(Number(input.y) || 0)));
    const windowTitle = String(input.windowTitle || '').trim().slice(0, 60);
    const label = String(
      input.label || (windowTitle ? `在「${windowTitle}」操作第 ${stepNumber} 步` : `步骤 ${stepNumber}`),
    )
      .replace(/[:[\]\r\n]+/g, ' ')
      .trim()
      .slice(0, 60);
    const step: RecordedDemoStep = {
      x,
      y,
      label,
      windowTitle,
      screen: Math.max(1, Math.floor(Number(input.screen) || 1)),
      at: Date.now(),
    };
    this.state = {
      ...this.state,
      recordedSteps: [...this.state.recordedSteps, step],
    };
    return step;
  }

  finishRecord(): {title: string; steps: readonly RecordedDemoStep[]} {
    const title = this.state.recordTitle || '桌面操作示范';
    const steps = this.state.recordedSteps;
    this.state = {
      ...this.state,
      mode: 'idle',
      recordTitle: '',
      recordStartedAt: 0,
      recordedSteps: [],
    };
    return {title, steps};
  }

  discardRecord(): CuOverlayState {
    this.state = {
      ...this.state,
      mode: 'idle',
      recordTitle: '',
      recordStartedAt: 0,
      recordedSteps: [],
    };
    return this.getState();
  }

  stop(): CuOverlayState {
    this.state = {
      ...this.state,
      mode: 'idle',
      paused: false,
      actionLabel: '',
      windowTitle: '',
    };
    return this.getState();
  }
}

export function formatRecordedTourMarkdown(
  title: string,
  steps: readonly RecordedDemoStep[],
): string {
  const safeTitle = String(title || '桌面操作示范').trim();
  if (!steps.length) {
    return `已结束「${safeTitle}」录制（未捕获到步骤）。`;
  }
  const lines = [
    `已完成「${safeTitle}」示范录制（共 ${steps.length} 步），点击下方任意步骤即可用飞指光标重放或一键代操作：`,
    '',
  ];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const cleanLabel = step.label.replace(/[:[\]\r\n]+/g, ' ').trim();
    const ctx = step.windowTitle ? `（窗口：${step.windowTitle}）` : '';
    lines.push(
      `${i + 1}. [POINT:${step.x},${step.y}:${cleanLabel}:screen${step.screen}] ${cleanLabel}${ctx}`,
    );
  }
  return lines.join('\n');
}

export class CuLiveOverlayWindow {
  private win: Electron.BrowserWindow | null = null;
  private readonly rendererFile: string;

  constructor(rendererFile: string) {
    this.rendererFile = rendererFile;
  }

  sync(state: CuOverlayState): void {
    if (state.mode === 'idle') {
      if (this.win && !this.win.isDestroyed()) {
        this.win.hide();
      }
      return;
    }
    // Lazy require electron so pure Node unit tests can import CuOverlayController cleanly.
    const {BrowserWindow, screen} = require('electron') as typeof import('electron');
    if (!this.win || this.win.isDestroyed()) {
      const display = screen.getPrimaryDisplay();
      const wa = display.workArea;
      const width = 560;
      const height = 74;
      const x = Math.round(wa.x + (wa.width - width) / 2);
      const y = Math.round(wa.y + wa.height - height - 18);
      this.win = new BrowserWindow({
        x,
        y,
        width,
        height,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: false,
        movable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        show: false,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      this.win.setAlwaysOnTop(true, 'screen-saver');
      this.win.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true});
      this.win.loadFile(this.rendererFile);
      this.win.once('ready-to-show', () => {
        if (this.win && !this.win.isDestroyed()) {
          this.win.showInactive();
          this.win.webContents.send('cu-overlay:state', state);
        }
      });
      return;
    }
    if (!this.win.isVisible()) {
      this.win.showInactive();
    }
    this.win.webContents.send('cu-overlay:state', state);
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
  }
}
