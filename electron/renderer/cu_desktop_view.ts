'use strict';

interface CuPoint {
  x: number;
  y: number;
}

interface CuMappedPoint {
  x: number;
  y: number;
  inside: boolean;
}

interface CuCursorSnapshot {
  x: number;
  y: number;
  visible: boolean;
  pressing?: boolean;
  action?: string;
  label?: string;
}

interface CuHumanSnapshot {
  x: number;
  y: number;
  visible: boolean;
  active?: boolean;
  pressing?: boolean;
}

interface CuDesktopViewStatus {
  active: boolean;
  paused: boolean;
  desktopName?: string;
  width: number;
  height: number;
  fps: number;
  windows: Array<{hwnd: number; title: string; process_name?: string}>;
  agentCursor: CuCursorSnapshot;
  humanCursor: CuHumanSnapshot;
  lastAction?: string;
}

interface CuDesktopBridge {
  status?: () => Promise<{ok?: boolean; status?: CuDesktopViewStatus; frame?: any}>;
  open?: (opts?: {width?: number; height?: number}) => Promise<any>;
  resize?: (opts?: {width?: number; height?: number}) => Promise<any>;
  close?: () => Promise<any>;
  launch?: (payload: {app: string; args?: string}) => Promise<any>;
  pause?: (paused: boolean) => Promise<any>;
  humanInput?: (payload: Record<string, unknown>) => Promise<any>;
  setStreamVisible?: (visible: boolean) => Promise<any>;
  snapshot?: () => Promise<any>;
  onFrame?: (cb: (frame: any) => void) => () => void;
  onState?: (cb: (state: CuDesktopViewStatus) => void) => () => void;
  onCursor?: (
    cb: (cursors: {
      agentCursor?: CuCursorSnapshot;
      humanCursor?: CuHumanSnapshot;
    }) => void,
  ) => () => void;
}

interface CuDesktopViewApi {
  computeAdaptiveDesktopSize: (
    panelW: number,
    panelH: number,
  ) => {width: number; height: number};
  mapCanvasPointToDesktop: (
    clientX: number,
    clientY: number,
    canvasW: number,
    canvasH: number,
    desktopW: number,
    desktopH: number,
  ) => CuMappedPoint;
  stepCursorLerp: (
    current: CuPoint,
    target: CuPoint,
    alpha?: number,
  ) => CuPoint;
  normalizeKeyboardEvent: (ev: {
    key: string;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  }) => {kind: 'keydown' | 'type_text'; keys?: string; text?: string} | null;
  mount: (
    host: HTMLElement | null,
    options?: {
      language?: () => string;
      onStateChange?: (state: CuDesktopViewStatus) => void;
    },
  ) => void;
  setVisible: (visible: boolean) => void;
  getStatus: () => CuDesktopViewStatus;
  isActive: () => boolean;
}

declare global {
  interface Window {
    CuDesktopView?: CuDesktopViewApi;
  }
  var CuDesktopView: CuDesktopViewApi | undefined;
}

(() => {
  function computeAdaptiveDesktopSize(
    panelW: number,
    panelH: number,
  ): {width: number; height: number} {
    const safeW = Math.max(240, Number(panelW) || 420);
    const safeH = Math.max(240, Number(panelH) || 620);
    const aspect = Math.max(0.45, Math.min(2.4, safeW / safeH));
    let w = Math.max(700, Math.min(1440, Math.round(safeW * 1.75)));
    let h = Math.round(w / aspect);
    if (h > 1080) {
      h = 1080;
      w = Math.max(640, Math.min(1440, Math.round(h * aspect)));
    }
    if (h < 520) {
      h = 520;
      w = Math.max(640, Math.min(1440, Math.round(h * aspect)));
    }
    w = Math.max(640, Math.min(1440, w & ~1));
    h = Math.max(520, Math.min(1080, h & ~1));
    return {width: w, height: h};
  }

  function containRect(
    canvasW: number,
    canvasH: number,
    desktopW: number,
    desktopH: number,
  ): {offX: number; offY: number; drawW: number; drawH: number; scale: number} {
    const safeCW = Math.max(1, Number(canvasW) || 1);
    const safeCH = Math.max(1, Number(canvasH) || 1);
    const safeDW = Math.max(1, Number(desktopW) || 1280);
    const safeDH = Math.max(1, Number(desktopH) || 720);
    const scale = Math.min(safeCW / safeDW, safeCH / safeDH);
    const drawW = safeDW * scale;
    const drawH = safeDH * scale;
    return {
      offX: (safeCW - drawW) / 2,
      offY: (safeCH - drawH) / 2,
      drawW,
      drawH,
      scale,
    };
  }

  function mapCanvasPointToDesktop(
    clientX: number,
    clientY: number,
    canvasW: number,
    canvasH: number,
    desktopW: number,
    desktopH: number,
  ): CuMappedPoint {
    const {offX, offY, drawW, drawH, scale} = containRect(
      canvasW,
      canvasH,
      desktopW,
      desktopH,
    );
    const inside =
      clientX >= offX &&
      clientX <= offX + drawW &&
      clientY >= offY &&
      clientY <= offY + drawH;
    const rawX = (clientX - offX) / Math.max(0.0001, scale);
    const rawY = (clientY - offY) / Math.max(0.0001, scale);
    const safeDW = Math.max(1, Number(desktopW) || 1280);
    const safeDH = Math.max(1, Number(desktopH) || 720);
    return {
      x: Math.max(0, Math.min(safeDW, Math.round(rawX))),
      y: Math.max(0, Math.min(safeDH, Math.round(rawY))),
      inside,
    };
  }

  function stepCursorLerp(
    current: CuPoint,
    target: CuPoint,
    alpha = 0.32,
  ): CuPoint {
    const a = Math.max(0.05, Math.min(1, Number(alpha) || 0.32));
    return {
      x: current.x + (target.x - current.x) * a,
      y: current.y + (target.y - current.y) * a,
    };
  }

  const NAMED_KEYS: Record<string, string> = {
    Enter: 'enter',
    Backspace: 'backspace',
    Tab: 'tab',
    Escape: 'esc',
    Delete: 'delete',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ArrowUp: 'up',
    ArrowDown: 'down',
    Home: 'home',
    End: 'end',
    PageUp: 'pageup',
    PageDown: 'pagedown',
    ' ': 'space',
  };

  function normalizeKeyboardEvent(ev: {
    key: string;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  }): {kind: 'keydown' | 'type_text'; keys?: string; text?: string} | null {
    const key = String(ev?.key || '');
    if (
      !key ||
      ['Control', 'Shift', 'Alt', 'Meta', 'CapsLock'].includes(key)
    ) {
      return null;
    }
    const named = NAMED_KEYS[key];
    if (ev.ctrlKey || ev.altKey) {
      const mods: string[] = [];
      if (ev.ctrlKey) {
        mods.push('ctrl');
      }
      if (ev.altKey) {
        mods.push('alt');
      }
      if (ev.shiftKey) {
        mods.push('shift');
      }
      mods.push(named || key.toLowerCase());
      return {kind: 'keydown', keys: mods.join('+')};
    }
    if (named && named !== 'space') {
      return {kind: 'keydown', keys: named};
    }
    if (key.length === 1) {
      return {kind: 'type_text', text: key};
    }
    return null;
  }

  let hostEl: HTMLElement | null = null;
  let stageEl: HTMLElement | null = null;
  let emptyStageEl: HTMLElement | null = null;
  let canvasEl: HTMLCanvasElement | null = null;
  let stageObserver: ResizeObserver | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let viewportMode: 'fit' | 'wide' = 'fit';
  let rafId = 0;
  let panelVisible = false;
  let statusState: CuDesktopViewStatus = {
    active: false,
    paused: false,
    desktopName: 'MagicPointer_AgentDesktop',
    width: 1280,
    height: 720,
    fps: 0,
    windows: [],
    agentCursor: {
      x: 640,
      y: 360,
      visible: false,
      pressing: false,
      action: 'idle',
      label: '',
    },
    humanCursor: {x: 0, y: 0, visible: false, active: false, pressing: false},
    lastAction: '',
  };

  let onStateChangeCb: ((s: CuDesktopViewStatus) => void) | undefined;
  let langFn: () => string = () => 'zh-CN';
  let latestImage: HTMLImageElement | null = null;
  let latestFrameUrl = '';
  let agentRenderPos: CuPoint = {x: 640, y: 360};
  const ripples: Array<{
    x: number;
    y: number;
    color: string;
    startedAt: number;
  }> = [];
  let prevAgentPressing = false;
  let unsubs: Array<() => void> = [];
  let lastHumanMoveTs = 0;

  function bridge(): CuDesktopBridge | undefined {
    const win =
      typeof window !== 'undefined'
        ? (window as unknown as {
            magicPointerDashboard?: {cuDesktop?: CuDesktopBridge};
          })
        : undefined;
    return win?.magicPointerDashboard?.cuDesktop;
  }

  function isZh(): boolean {
    return langFn() === 'zh-CN';
  }

  function drawPointerVector(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    fill: string,
    label: string,
    labelBg: string,
  ): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 17);
    ctx.lineTo(4.5, 13.5);
    ctx.lineTo(8.5, 20);
    ctx.lineTo(11, 18.8);
    ctx.lineTo(7.2, 12.4);
    ctx.lineTo(12.5, 12.4);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = fill;
    ctx.fill();

    if (label) {
      ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
      const padX = 8;
      const textW = Math.min(180, ctx.measureText(label).width);
      const pillX = 14;
      const pillY = 14;
      const pillW = textW + padX * 2;
      const pillH = 22;
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillW, pillH, 6);
      ctx.fillStyle = labelBg;
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, pillX + padX, pillY + pillH / 2, 180);
    }
    ctx.restore();
  }

  function renderCanvasFrame(): void {
    if (!canvasEl || !statusState.active) {
      rafId = 0;
      return;
    }
    const rect = canvasEl.getBoundingClientRect();
    const cssW = Math.max(240, Math.round(rect.width || canvasEl.clientWidth || 600));
    const cssH = Math.max(180, Math.round(rect.height || canvasEl.clientHeight || 380));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);
    if (canvasEl.width !== targetW || canvasEl.height !== targetH) {
      canvasEl.width = targetW;
      canvasEl.height = targetH;
    }
    const ctx = canvasEl.getContext('2d');
    if (!ctx) {
      rafId = 0;
      return;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#eae7e0';
    ctx.fillRect(0, 0, cssW, cssH);

    const fit = containRect(cssW, cssH, statusState.width, statusState.height);
    if (latestImage && latestImage.complete && latestImage.naturalWidth > 0) {
      ctx.drawImage(latestImage, fit.offX, fit.offY, fit.drawW, fit.drawH);
    } else {
      ctx.fillStyle = '#f5f3ee';
      ctx.fillRect(fit.offX, fit.offY, fit.drawW, fit.drawH);
      ctx.fillStyle = '#73716b';
      ctx.font = '500 13px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        isZh() ? '正在连接协同桌面画面…' : 'Connecting second desktop stream…',
        cssW / 2,
        cssH / 2,
      );
      ctx.textAlign = 'start';
    }

    const now = performance.now();
    // Ripples
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i]!;
      const age = (now - rp.startedAt) / 420;
      if (age >= 1) {
        ripples.splice(i, 1);
        continue;
      }
      const rx = fit.offX + rp.x * fit.scale;
      const ry = fit.offY + rp.y * fit.scale;
      ctx.beginPath();
      ctx.arc(rx, ry, 5 + age * 18, 0, Math.PI * 2);
      ctx.strokeStyle = rp.color;
      ctx.globalAlpha = 1 - age;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Agent smooth virtual cursor (#d97757)
    if (statusState.agentCursor.visible) {
      agentRenderPos = stepCursorLerp(
        agentRenderPos,
        statusState.agentCursor,
        0.28,
      );
      const ax = fit.offX + agentRenderPos.x * fit.scale;
      const ay = fit.offY + agentRenderPos.y * fit.scale;
      drawPointerVector(
        ctx,
        ax,
        ay,
        '#d97757',
        statusState.agentCursor.label || (isZh() ? 'AI 光标' : 'Agent'),
        'rgba(24, 24, 23, 0.86)',
      );
    }

    // User collaborative cursor (#3b82f6)
    if (statusState.humanCursor.visible) {
      const hx = fit.offX + statusState.humanCursor.x * fit.scale;
      const hy = fit.offY + statusState.humanCursor.y * fit.scale;
      drawPointerVector(
        ctx,
        hx,
        hy,
        '#2563eb',
        isZh() ? '你' : 'You',
        'rgba(37, 99, 235, 0.92)',
      );
    }

    ctx.restore();
    if (panelVisible && statusState.active) {
      rafId = requestAnimationFrame(renderCanvasFrame);
    } else {
      rafId = 0;
    }
  }

  function ensurePaintLoop(): void {
    if (!rafId && typeof requestAnimationFrame === 'function' && statusState.active) {
      rafId = requestAnimationFrame(renderCanvasFrame);
    }
  }

  function applyFrame(frame: any): void {
    if (!frame || typeof frame.image !== 'string' || !frame.image) {
      return;
    }
    const url = `data:${frame.mimeType || 'image/jpeg'};base64,${frame.image}`;
    if (url === latestFrameUrl) {
      return;
    }
    latestFrameUrl = url;
    const img = new Image();
    img.onload = () => {
      latestImage = img;
      if (typeof frame.width === 'number' && frame.width > 0) {
        statusState.width = frame.width;
      }
      if (typeof frame.height === 'number' && frame.height > 0) {
        statusState.height = frame.height;
      }
      if (canvasEl && statusState.active && !rafId) {
        renderCanvasFrame();
      }
    };
    img.src = url;
    if (typeof frame.fps === 'number') {
      statusState.fps = frame.fps;
      updateMetaDom();
    }
    if (Array.isArray(frame.windows)) {
      statusState.windows = frame.windows;
      updateMetaDom();
    }
  }

  function syncDesiredResolution(force = false): void {
    if (!statusState.active || !stageEl) {
      return;
    }
    const target =
      viewportMode === 'wide'
        ? {width: 1280, height: 720}
        : computeAdaptiveDesktopSize(
            stageEl.clientWidth || hostEl?.clientWidth || 420,
            stageEl.clientHeight || Math.max(360, (hostEl?.clientHeight || 640) - 130),
          );
    if (
      !force &&
      Math.abs(target.width - statusState.width) < 24 &&
      Math.abs(target.height - statusState.height) < 24
    ) {
      return;
    }
    if (
      target.width === statusState.width &&
      target.height === statusState.height
    ) {
      return;
    }
    void bridge()?.resize?.(target);
  }

  function scheduleAdaptiveResize(): void {
    if (resizeTimer) {
      clearTimeout(resizeTimer);
    }
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (panelVisible && statusState.active && viewportMode === 'fit') {
        syncDesiredResolution(false);
      }
    }, 200);
  }

  function updateMetaDom(): void {
    if (!hostEl) {
      return;
    }
    const statusDot = hostEl.querySelector<HTMLElement>('[data-cu-status-dot]');
    const statusLabel = hostEl.querySelector<HTMLElement>(
      '[data-cu-status-label]',
    );
    const fpsEl = hostEl.querySelector<HTMLElement>('[data-cu-fps]');
    const winEl = hostEl.querySelector<HTMLElement>('[data-cu-active-window]');
    const pauseBtn = hostEl.querySelector<HTMLButtonElement>(
      '[data-cu-action="pause"]',
    );
    const fitBtn = hostEl.querySelector<HTMLButtonElement>(
      '[data-cu-action="fit-mode"]',
    );

    if (statusDot) {
      statusDot.dataset.state = !statusState.active
        ? 'idle'
        : statusState.paused
          ? 'paused'
          : 'live';
    }
    if (statusLabel) {
      statusLabel.textContent = !statusState.active
        ? isZh()
          ? '未启动'
          : 'Standby'
        : statusState.paused
          ? isZh()
            ? '已暂停 · 你正在接管'
            : 'Paused · Your Control'
          : isZh()
            ? '协同桌面运行中'
            : 'Second Desktop Live';
    }
    if (fpsEl) {
      fpsEl.textContent = statusState.active
        ? `${statusState.fps.toFixed(0)} FPS`
        : '';
      fpsEl.hidden = !statusState.active;
    }
    if (winEl) {
      const topWin =
        statusState.windows.find(w => (w as any).focused) ||
        statusState.windows[0];
      winEl.textContent = topWin?.title || statusState.lastAction || '';
    }
    if (pauseBtn) {
      pauseBtn.textContent = statusState.paused
        ? isZh()
          ? '继续 AI'
          : 'Resume'
        : isZh()
          ? '暂停协同'
          : 'Pause';
    }
    if (fitBtn) {
      fitBtn.dataset.mode = viewportMode;
      fitBtn.textContent =
        viewportMode === 'fit'
          ? isZh()
            ? '铺满面板'
            : 'Fit'
          : '16:9';
      fitBtn.title =
        viewportMode === 'fit'
          ? isZh()
            ? '当前自适应铺满右侧栏，点击切换为 16:9'
            : 'Adaptive panel fill active — click for 16:9'
          : isZh()
            ? '当前 16:9 宽屏，点击切换为自适应铺满面板'
            : '16:9 widescreen active — click to fill panel';
    }
    if (emptyStageEl) {
      emptyStageEl.hidden =
        !statusState.active || statusState.windows.length > 0;
    }
  }

  function renderStructure(): void {
    if (!hostEl) {
      return;
    }
    const zh = isZh();
    const active = statusState.active;

    hostEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'mp-cu-view';
    wrap.dataset.active = String(active);

    // Top control strip
    const topBar = document.createElement('div');
    topBar.className = 'mp-cu-topbar';
    const leftMeta = document.createElement('div');
    leftMeta.className = 'mp-cu-meta';
    leftMeta.innerHTML = `<span class="mp-cu-status-dot" data-cu-status-dot></span><strong data-cu-status-label></strong><span class="mp-cu-fps" data-cu-fps></span>`;

    const actions = document.createElement('div');
    actions.className = 'mp-cu-actions';
    if (active) {
      const fitBtn = document.createElement('button');
      fitBtn.type = 'button';
      fitBtn.className = 'mp-cu-btn mp-cu-fit-btn';
      fitBtn.dataset.cuAction = 'fit-mode';
      fitBtn.addEventListener('click', () => {
        viewportMode = viewportMode === 'fit' ? 'wide' : 'fit';
        updateMetaDom();
        syncDesiredResolution(true);
      });
      const pauseBtn = document.createElement('button');
      pauseBtn.type = 'button';
      pauseBtn.className = 'mp-cu-btn';
      pauseBtn.dataset.cuAction = 'pause';
      pauseBtn.addEventListener('click', () => {
        void bridge()?.pause?.(!statusState.paused);
      });
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'mp-cu-btn mp-cu-btn-ghost';
      closeBtn.dataset.cuAction = 'close';
      closeBtn.textContent = zh ? '关闭桌面' : 'Close';
      closeBtn.addEventListener('click', () => {
        void bridge()?.close?.();
      });
      actions.append(fitBtn, pauseBtn, closeBtn);
    }
    topBar.append(leftMeta, actions);
    wrap.appendChild(topBar);

    if (stageObserver) {
      stageObserver.disconnect();
      stageObserver = null;
    }

    if (!active) {
      const empty = document.createElement('div');
      empty.className = 'mp-cu-empty';
      empty.innerHTML = `
        <div class="mp-cu-empty-card">
          <h3>${zh ? '独立协同第二桌面' : 'Isolated Second Desktop'}</h3>
          <p>${
            zh
              ? 'AI 在隐藏的独立 Windows 桌面中运行真实软件并在此实时串流画面，你的物理鼠标与当前窗口全程不被抢占。鼠标移入画布即可与 AI 双光标实时协同。'
              : 'The agent runs real Windows apps in a separate hidden desktop and streams live here—your physical mouse and active windows stay 100% undisturbed. Move your pointer into this canvas anytime to collaborate live.'
          }</p>
          <button type="button" id="cu-desktop-start-btn" class="mp-cu-btn-primary">${
            zh ? '启动第二桌面' : 'Start Isolated Desktop'
          }</button>
        </div>
      `;
      empty
        .querySelector('#cu-desktop-start-btn')
        ?.addEventListener('click', () => {
          const initialSize =
            viewportMode === 'wide'
              ? {width: 1280, height: 720}
              : computeAdaptiveDesktopSize(
                  hostEl?.clientWidth || 420,
                  Math.max(360, (hostEl?.clientHeight || 640) - 130),
                );
          void bridge()?.open?.(initialSize);
        });
      wrap.appendChild(empty);
      hostEl.appendChild(wrap);
      stageEl = null;
      emptyStageEl = null;
      canvasEl = null;
      updateMetaDom();
      return;
    }

    // Quick-launch strip
    const launchBar = document.createElement('form');
    launchBar.className = 'mp-cu-launchbar';
    const quickRow = document.createElement('div');
    quickRow.className = 'mp-cu-quick-pills';
    const quickApps = [
      {app: 'notepad', label: zh ? '记事本' : 'Notepad'},
      {app: 'msedge', label: zh ? '浏览器' : 'Edge'},
      {app: 'explorer', label: zh ? '文件' : 'Files'},
      {app: 'powershell', label: zh ? '终端' : 'Terminal'},
    ];
    for (const qa of quickApps) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mp-cu-chip';
      btn.dataset.cuQuickApp = qa.app;
      btn.textContent = qa.label;
      btn.addEventListener('click', () => {
        void bridge()?.launch?.({app: qa.app});
      });
      quickRow.appendChild(btn);
    }
    const customRow = document.createElement('div');
    customRow.className = 'mp-cu-launch-custom';
    const appInput = document.createElement('input');
    appInput.type = 'text';
    appInput.className = 'mp-cu-launch-input';
    appInput.placeholder = zh ? '输入程序名或网址回车打开…' : 'Launch app or URL…';
    const goBtn = document.createElement('button');
    goBtn.type = 'submit';
    goBtn.className = 'mp-cu-btn';
    goBtn.textContent = zh ? '打开' : 'Open';
    customRow.append(appInput, goBtn);
    launchBar.append(quickRow, customRow);
    launchBar.addEventListener('submit', ev => {
      ev.preventDefault();
      const val = appInput.value.trim();
      if (!val) {
        return;
      }
      appInput.value = '';
      void bridge()?.launch?.({app: val});
    });
    wrap.appendChild(launchBar);

    // Interactive Dual-Cursor Canvas Stage
    const stage = document.createElement('div');
    stage.className = 'mp-cu-stage';
    const canvas = document.createElement('canvas');
    canvas.id = 'cu-desktop-canvas';
    canvas.className = 'mp-cu-desktop-canvas';
    canvas.tabIndex = 0;

    const toDesktopPt = (ev: MouseEvent): CuMappedPoint => {
      const rect = canvas.getBoundingClientRect();
      return mapCanvasPointToDesktop(
        ev.clientX - rect.left,
        ev.clientY - rect.top,
        rect.width,
        rect.height,
        statusState.width,
        statusState.height,
      );
    };

    canvas.addEventListener('pointermove', ev => {
      const pt = toDesktopPt(ev);
      if (!pt.inside) {
        statusState.humanCursor = {...statusState.humanCursor, visible: false};
        return;
      }
      statusState.humanCursor = {
        ...statusState.humanCursor,
        x: pt.x,
        y: pt.y,
        visible: true,
      };
      const t = performance.now();
      if (t - lastHumanMoveTs >= 32) {
        lastHumanMoveTs = t;
        void bridge()?.humanInput?.({kind: 'move', x: pt.x, y: pt.y});
      }
    });

    canvas.addEventListener('pointerleave', () => {
      statusState.humanCursor = {...statusState.humanCursor, visible: false};
      void bridge()?.humanInput?.({kind: 'leave'});
    });

    canvas.addEventListener('click', ev => {
      canvas.focus();
      const pt = toDesktopPt(ev);
      if (!pt.inside) {
        return;
      }
      ripples.push({
        x: pt.x,
        y: pt.y,
        color: '#2563eb',
        startedAt: performance.now(),
      });
      void bridge()?.humanInput?.({
        kind: 'click',
        x: pt.x,
        y: pt.y,
        button: ev.button === 2 ? 'right' : 'left',
      });
    });

    canvas.addEventListener('dblclick', ev => {
      const pt = toDesktopPt(ev);
      if (!pt.inside) {
        return;
      }
      void bridge()?.humanInput?.({kind: 'dblclick', x: pt.x, y: pt.y});
    });

    canvas.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      const pt = toDesktopPt(ev);
      if (!pt.inside) {
        return;
      }
      void bridge()?.humanInput?.({kind: 'contextmenu', x: pt.x, y: pt.y});
    });

    canvas.addEventListener(
      'wheel',
      ev => {
        ev.preventDefault();
        const pt = toDesktopPt(ev);
        if (!pt.inside) {
          return;
        }
        const dy = ev.deltaY > 0 ? -120 : 120;
        void bridge()?.humanInput?.({kind: 'wheel', x: pt.x, y: pt.y, dy});
      },
      {passive: false},
    );

    canvas.addEventListener('keydown', ev => {
      const mapped = normalizeKeyboardEvent({
        key: ev.key,
        ctrlKey: ev.ctrlKey,
        altKey: ev.altKey,
        shiftKey: ev.shiftKey,
      });
      if (!mapped) {
        return;
      }
      ev.preventDefault();
      void bridge()?.humanInput?.(mapped);
    });

    stage.appendChild(canvas);

    const emptyOverlay = document.createElement('div');
    emptyOverlay.className = 'mp-cu-stage-empty';
    emptyOverlay.hidden = statusState.windows.length > 0;
    emptyOverlay.innerHTML = `
      <div class="mp-cu-stage-empty-card">
        <span class="mp-cu-stage-badge">${zh ? '已隔离 · 零打扰' : 'Isolated · Non-Disruptive'}</span>
        <h4>${zh ? '第二桌面已就绪' : 'Second Desktop Ready'}</h4>
        <p>${
          zh
            ? '选一个常用软件直接打开，或在左侧让 AI 启动目标应用，全程不会动你的主桌面鼠标。'
            : 'Launch an app below or ask Magic Pointer in chat—your main desktop mouse and focus stay untouched.'
        }</p>
        <div class="mp-cu-stage-quick"></div>
      </div>
    `;
    const overlayQuick = emptyOverlay.querySelector('.mp-cu-stage-quick');
    if (overlayQuick) {
      for (const qa of quickApps) {
        const qbtn = document.createElement('button');
        qbtn.type = 'button';
        qbtn.className = 'mp-cu-chip';
        qbtn.textContent = qa.label;
        qbtn.addEventListener('click', () => {
          void bridge()?.launch?.({app: qa.app});
        });
        overlayQuick.appendChild(qbtn);
      }
    }
    stage.appendChild(emptyOverlay);
    wrap.appendChild(stage);

    const footer = document.createElement('div');
    footer.className = 'mp-cu-footer';
    footer.innerHTML = `<span class="mp-cu-active-win" data-cu-active-window></span><span class="mp-cu-legend"><i class="mp-cu-dot-agent"></i>AI <i class="mp-cu-dot-you"></i>${zh ? '你（点击画面可直接协同输入）' : 'You (click inside to collaborate)'}</span>`;
    wrap.appendChild(footer);

    hostEl.appendChild(wrap);
    stageEl = stage;
    emptyStageEl = emptyOverlay;
    canvasEl = canvas;

    if (typeof ResizeObserver === 'function') {
      stageObserver = new ResizeObserver(() => {
        scheduleAdaptiveResize();
      });
      stageObserver.observe(stage);
    }

    updateMetaDom();
    ensurePaintLoop();
    scheduleAdaptiveResize();
  }

  function applyState(next: CuDesktopViewStatus): void {
    const wasActive = statusState.active;
    const prevPress = prevAgentPressing;
    statusState = {...statusState, ...next};
    if (next.agentCursor?.pressing && !prevPress) {
      ripples.push({
        x: next.agentCursor.x,
        y: next.agentCursor.y,
        color: '#d97757',
        startedAt: performance.now(),
      });
    }
    prevAgentPressing = Boolean(next.agentCursor?.pressing);
    onStateChangeCb?.(statusState);
    if (wasActive !== statusState.active || !canvasEl) {
      renderStructure();
    } else {
      updateMetaDom();
      ensurePaintLoop();
    }
  }

  function mount(
    host: HTMLElement | null,
    options?: {
      language?: () => string;
      onStateChange?: (state: CuDesktopViewStatus) => void;
    },
  ): void {
    hostEl = host;
    if (options?.language) {
      langFn = options.language;
    }
    onStateChangeCb = options?.onStateChange;
    for (const unsub of unsubs) {
      try {
        unsub();
      } catch {}
    }
    unsubs = [];

    const api = bridge();
    if (api?.onFrame) {
      unsubs.push(api.onFrame(applyFrame));
    }
    if (api?.onState) {
      unsubs.push(api.onState(applyState));
    }
    if (api?.onCursor) {
      unsubs.push(
        api.onCursor(cursors => {
          if (cursors?.agentCursor) {
            if (cursors.agentCursor.pressing && !prevAgentPressing) {
              ripples.push({
                x: cursors.agentCursor.x,
                y: cursors.agentCursor.y,
                color: '#d97757',
                startedAt: performance.now(),
              });
            }
            prevAgentPressing = Boolean(cursors.agentCursor.pressing);
            statusState.agentCursor = cursors.agentCursor;
          }
          if (cursors?.humanCursor) {
            statusState.humanCursor = cursors.humanCursor;
          }
          ensurePaintLoop();
        }),
      );
    }
    renderStructure();
    void api?.status?.().then(res => {
      if (res?.status) {
        applyState(res.status);
      }
      if (res?.frame) {
        applyFrame(res.frame);
      }
    });
  }

  function setVisible(visible: boolean): void {
    panelVisible = Boolean(visible);
    void bridge()?.setStreamVisible?.(panelVisible);
    if (panelVisible && statusState.active) {
      ensurePaintLoop();
      if (viewportMode === 'fit') {
        scheduleAdaptiveResize();
      }
    }
  }

  const exported: CuDesktopViewApi = {
    computeAdaptiveDesktopSize,
    mapCanvasPointToDesktop,
    stepCursorLerp,
    normalizeKeyboardEvent,
    mount,
    setVisible,
    getStatus: () => ({...statusState}),
    isActive: () => statusState.active,
  };

  globalThis.CuDesktopView = exported;
  if (typeof module === 'object' && module.exports) {
    module.exports = exported;
  }
})();
