const canvas = document.getElementById('trail') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const sweepCanvas = document.getElementById('sweep-layer') as HTMLCanvasElement;
const sweepRenderer = new globalThis.MagicSweepVisual.SweepRenderer(sweepCanvas);
const guideTriangle = document.getElementById('guide-triangle') as HTMLElement;
const hint = document.getElementById('hint') as HTMLElement;

let dpr = window.devicePixelRatio || 1;
let drawing = false;
let activePointerId: number | null = null;
let points: OverlayPoint[] = [];
let lastPointer: OverlayPoint | null = null;
let trailAlpha = 1;
let fadeRaf: number | null = null;
let captureMode = false;
let submitting = false;
// Committed strokes of the current chain. The user can circle several
// regions before the session finalizes ("circle this, and this, then run
// the command"); a configurable inactivity window decides when the chain
// ends and the unified gesture is submitted.
let strokes: OverlayStroke[] = [];
let chainTimer: ReturnType<typeof setTimeout> | null = null;
let chainHintTimer: ReturnType<typeof setTimeout> | null = null;
let chainDeadlineAt = 0;
const DEFAULT_CHAIN_GAP_MS = 2500;
let gestureChainGapMs = DEFAULT_CHAIN_GAP_MS;
let renderRaf: number | null = null;
let pulseRaf: number | null = null;
let lastPulseFrame = 0;
let observerMode = false;
let gestureMode = false;
let gestureToken: string | null = null;
let gestureAcceptAt = 0;
/** @type {string} */
let gestureLineStyle = 'demo6_band';
let gestureLineWidth = 22;
/** @type {string} */
let gestureInteractionMode = 'exclusive_overlay';
let hintTimer: ReturnType<typeof setTimeout> | null = null;
let gestureGraceTimer: ReturnType<typeof setTimeout> | null = null;
/** @type {string} */
let currentWorkflow = 'generic';

// ── Clicky 式引导小三角 ──────────────────────────────────────────────
// 默认不出现。回答带了 [POINT] 指点（overlay:guide-point）时才浮现，
// 从当前光标沿贝塞尔弧线飞向目标，短暂停留后彻底退出。
let guideTarget: { x: number; y: number } | null = null;        // { x, y } 指点目标（overlay 局部坐标）
let guideFlight: GuideFlight | null = null;        // { t, from, to, ctrl, startedAt, duration }
let guideHideTimer: ReturnType<typeof setTimeout> | null = null;     // 到达后停留定时器
const GUIDE_FLIGHT_MS = 620;

interface OverlayPoint { x: number; y: number; t: number; }
interface OverlayStroke {
  points: OverlayPoint[];
  kind?: unknown;
  semanticPoint?: OverlayPoint;
}
interface GuideFlight {
  t: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
  ctrl: { x: number; y: number };
  startedAt: number;
  duration: number;
}

function onGuidePoint(payload: Record<string, unknown> | null | undefined) {
  if (!payload || !Number.isFinite(Number(payload.x)) || !Number.isFinite(Number(payload.y))) return;
  // 上一枚三角的停留定时器还挂着：不清掉的话，新的一枚刚到就会被
  // 旧定时器在旧时刻抹掉——连续两枚 [POINT] 时第二枚几乎看不见。
  if (guideHideTimer) clearTimeout(guideHideTimer);
  guideHideTimer = null;
  const bounds = overlayBounds();
  const tx = Number(payload.x) - bounds.x;
  const ty = Number(payload.y) - bounds.y;
  const from = lastPointer || { x: tx, y: ty };
  // 二次贝塞尔：控制点在起点终点连线中点上方，画出一条弧线（clicky 同款）
  const ctrl = {
    x: (from.x + tx) / 2,
    y: (from.y + ty) / 2 - Math.max(90, Math.abs(tx - from.x) * 0.35),
  };
  guideTarget = { x: tx, y: ty };
  guideFlight = {
    t: 0, from: { ...from }, to: { x: tx, y: ty }, ctrl,
    startedAt: performance.now(), duration: GUIDE_FLIGHT_MS,
  };
}

// ── Hermes drive 回放：结构化元素框 + 语义句柄标签 ─────────────────
// 主进程在圈选快照落地后发 overlay:element-ghosts（策略层已换算成本
// overlay 本地 DIP 矩形）。错峰浮现 → 驻留 → 淡出，动画结束整层自动清。
const ghostLayer = document.getElementById('element-ghosts') as HTMLElement;
let ghostTimer: ReturnType<typeof setTimeout> | null = null;

function onElementGhosts(payload: Record<string, unknown> | null | undefined) {
  if (!ghostLayer || !payload) return;
  if (ghostTimer) clearTimeout(ghostTimer);
  ghostTimer = null;
  ghostLayer.replaceChildren();
  const ghosts = Array.isArray(payload.ghosts) ? payload.ghosts : [];
  const holdMs = Math.max(0, Number(payload.holdMs) || 0);
  const fadeMs = Math.max(0, Number(payload.fadeMs) || 0);
  if (!ghosts.length) {
    ghostLayer.hidden = true;
    return;
  }
  const total = holdMs + fadeMs;
  for (const ghost of ghosts) {
    const rect = (ghost as { rect?: { x: number; y: number; width: number; height: number } }).rect;
    if (!rect) continue;
    const box = document.createElement('div');
    box.className = 'element-ghost';
    box.style.left = `${rect.x}px`;
    box.style.top = `${rect.y}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    box.style.setProperty('--ghost-delay', `${Number((ghost as { delayMs?: unknown }).delayMs) || 0}ms`);
    box.style.setProperty('--ghost-total', `${total}ms`);
    ghostLayer.appendChild(box);
  }
  ghostLayer.hidden = false;
  ghostTimer = setTimeout(() => {
    ghostLayer.replaceChildren();
    ghostLayer.hidden = true;
    ghostTimer = null;
  }, total + Math.max(...ghosts.map((g) => Number((g as { delayMs?: unknown }).delayMs) || 0)) + 60);
}

function overlayBounds() {
  const canvasRect = ctx.canvas.getBoundingClientRect();
  return { x: canvasRect.left, y: canvasRect.top, width: canvasRect.width, height: canvasRect.height };
}

// 二次贝塞尔插值（纯函数，可单测）：B(t) = (1-t)²P0 + 2(1-t)t·P1 + t²·P2
// @ts-ignore -- tests/guide_flight_test.js vm-extracts this exact function
// text (no TS syntax allowed inside); TS 6 ignores JSDoc @param in .ts files.
function guideFlightPoint(from, ctrl, to, t) {
  const u = 1 - t;
  return {
    x: u * u * from.x + 2 * u * t * ctrl.x + t * t * to.x,
    y: u * u * from.y + 2 * u * t * ctrl.y + t * t * to.y,
  };
}

function updateGuideTriangle() {
  // Demand-driven only: waking the selection overlay never starts Clicky.
  if (!guideTarget) {
    guideTriangle.dataset.visible = 'false';
    return;
  }
  const now = performance.now();
  let px;
  let py;
  if (guideTarget && guideFlight && now < guideFlight.startedAt + guideFlight.duration) {
    // 飞行中：贝塞尔插值
    const t = Math.min(1, (now - guideFlight.startedAt) / guideFlight.duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const { from, to, ctrl } = guideFlight;
    const pos = guideFlightPoint(from, ctrl, to, eased);
    px = pos.x;
    py = pos.y;
  } else if (guideTarget) {
    // 到达目标点：停留 2.5 秒后结束这次引导并销毁临时 overlay。
    guideFlight = null;
    px = guideTarget.x;
    py = guideTarget.y;
    if (!guideHideTimer) {
      guideHideTimer = setTimeout(() => {
        guideHideTimer = null;
        guideTarget = null;
        updateGuideTriangle();
        window.magicPointer?.guideFinished();
      }, 2500);
    }
  } else {
    return;
  }
  guideTriangle.dataset.visible = 'true';
  guideTriangle.style.transform = `translate3d(${px - 24}px, ${py - 24}px, 0)`;
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sweepRenderer.resize(window.innerWidth, window.innerHeight, dpr);
  clear();
}

function clear() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  sweepRenderer.clear();
}

function scheduleRender() {
  if (renderRaf) return;
  renderRaf = requestAnimationFrame(() => {
    renderRaf = null;
    render();
  });
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function addPoint(e: PointerEvent, { force = false }: { force?: boolean } = {}) {
  const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
  const batch = coalesced.length ? coalesced : [e];
  for (let index = 0; index < batch.length; index += 1) {
    const ev = batch[index];
    const p = { x: ev.clientX, y: ev.clientY, t: performance.now() };
    const last = points[points.length - 1];
    if (!last || dist(p, last) > 4.2 || (force && index === batch.length - 1)) points.push(p);
    lastPointer = p;
  }
}

function drawSmoothPath(path: OverlayPoint[], alpha = 1) {
  if (path.length < 2 || alpha <= 0.02) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'source-over';

  function trace(width: number, color: string, a = alpha) {
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length - 1; i++) {
      const midX = (path[i].x + path[i + 1].x) / 2;
      const midY = (path[i].y + path[i + 1].y) / 2;
      ctx.quadraticCurveTo(path[i].x, path[i].y, midX, midY);
    }
    const end = path[path.length - 1];
    ctx.lineTo(end.x, end.y);
    ctx.globalAlpha = a;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.stroke();
  }

  // Demo 6 default: one text-row-high translucent band with round ends.
  // No canvas shadow: Windows transparent surfaces can retain rectangular
  // backing-store ghosts around blurred strokes.
  if (gestureLineStyle === 'thin') {
    trace(gestureLineWidth, 'rgba(49, 119, 255, 0.34)', alpha);
    trace(Math.max(1.15, gestureLineWidth * 0.22), 'rgba(226, 241, 255, 0.64)', alpha);
  } else {
    trace(gestureLineWidth, 'rgba(92, 160, 255, 0.18)', alpha);
    trace(gestureLineWidth * 0.72, 'rgba(73, 145, 255, 0.17)', alpha);
    trace(Math.max(1.2, gestureLineWidth * 0.075), 'rgba(225, 241, 255, 0.38)', alpha);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

function drawHitTestPixel(p: OverlayPoint | null) {
  if (!p || captureMode) return;
  ctx.save();
  ctx.globalAlpha = 0.012;
  ctx.fillStyle = '#2f7bff';
  ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
  ctx.restore();
}

function render() {
  if (gestureMode) {
    // 唤醒瞬间（gestureAcceptAt 之前）不可画：不清屏直接返回——
    // 清了又不画就是黑屏闪一帧，三角在唤醒时「闪现」的根源。
    if (Date.now() < gestureAcceptAt) return;
    clear();
    if (strokes.length) {
      for (let index = 0; index < strokes.length; index += 1) {
        const stroke = strokes[index];
        const semanticPoint = stroke.semanticPoint || stroke.points[Math.floor(stroke.points.length / 2)];
        if (stroke.kind === 'point') {
          drawPointTarget(stroke.semanticPoint);
          drawStrokeMarker(index + 1, pointMarkerAnchor(semanticPoint));
        } else {
          drawStrokeMarker(index + 1, semanticPoint);
        }
      }
    }
    if (points.length) {
      if (gestureLineStyle === 'demo6_band') {
        sweepRenderer.render([{ points, opacity: trailAlpha, head: drawing }], gestureLineWidth);
      } else {
        drawSmoothPath(points, trailAlpha);
      }
    } else if (!strokes.length) {
      // Keep the transparent window hit-testable before the first stroke.
      drawHitTestPixel(lastPointer);
    }
    return;
  }
  if (!captureMode && points.length) drawSmoothPath(points, trailAlpha);
  // 不画 canvas 鼠标——光标由操作系统原生 cursor 资源渲染。
}

function fadeTrail(duration = 760) {
  if (fadeRaf) cancelAnimationFrame(fadeRaf);
  const start = performance.now();
  const from = trailAlpha;
  function tick(now: number) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    trailAlpha = from * (1 - eased);
    render();
    if (t < 1) fadeRaf = requestAnimationFrame(tick);
    else {
      trailAlpha = 0;
      render();
    }
  }
  fadeRaf = requestAnimationFrame(tick);
}

function computeSelectionPayload() {
  const allPoints = strokes.length ? strokes.flatMap((s) => s.points) : points;
  const xs = allPoints.map((p) => p.x);
  const ys = allPoints.map((p) => p.y);
  const geometry = globalThis.GestureCapture?.summarizeGesture(
    points,
    strokes.map((s) => ({ points: s.points })),
  ) || {};
  return {
    ...geometry,
    points: [...allPoints],
    strokes: strokes.map((s) => ({ points: [...s.points] })),
    bbox: {
      x1: Math.min(...xs),
      y1: Math.min(...ys),
      x2: Math.max(...xs),
      y2: Math.max(...ys),
    },
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    },
    selectionGestureToken: gestureToken,
  };
}

// @ts-ignore -- same reason as guideFlightPoint: inside the vm-extracted
// slice of tests/overlay_static_test.js, so no TS parameter syntax allowed.
function showChainHint(count) {
  if (!gestureMode) return;
  hint.textContent = `已圈选 ${count} 处 · 继续圈选其他内容，或按 Enter 完成`;
  hint.classList.remove('dim');
  if (chainHintTimer) clearTimeout(chainHintTimer);
  chainHintTimer = setTimeout(() => hint.classList.add('dim'), 1600);
}

function scheduleChainFinalize() {
  if (chainTimer) clearTimeout(chainTimer);
  const delay = globalThis.GestureCapture.chainFinalizeDelay({
    now: performance.now(),
    deadlineAt: chainDeadlineAt,
  });
  chainTimer = setTimeout(() => {
    chainTimer = null;
    finalizeGesture();
  }, delay);
}

function finalizeGesture() {
  if (chainTimer) {
    clearTimeout(chainTimer);
    chainTimer = null;
  }
  if (chainHintTimer) {
    clearTimeout(chainHintTimer);
    chainHintTimer = null;
    hint.classList.add('dim');
  }
  if (!strokes.length || submitting) return;
  chainDeadlineAt = 0;
  const graceRemaining = gestureAcceptAt - Date.now();
  if (gestureMode && graceRemaining > 0) {
    if (gestureGraceTimer) clearTimeout(gestureGraceTimer);
    gestureGraceTimer = setTimeout(() => {
      gestureGraceTimer = null;
      render();
      submitGesture();
    }, graceRemaining);
  } else {
    submitGesture();
  }
}

function hideVisualsForCapture() {
  captureMode = true;
  hint.classList.add('dim');
  clear();
}

function submitGesture() {
  if (submitting || !strokes.length) return;
  submitting = true;
  const payload = { ...computeSelectionPayload(), workflow: currentWorkflow };

  // Critical: remove our own overlay before Python ImageGrab runs.
  hideVisualsForCapture();
  requestAnimationFrame(() => {
    window.magicPointer?.done(payload);
  });
}

function resetOverlay() {
  if (activePointerId !== null) {
    try {
      if (canvas.hasPointerCapture(activePointerId)) canvas.releasePointerCapture(activePointerId);
    } catch (_error) { /* the window may already be hidden */ }
  }
  drawing = false;
  activePointerId = null;
  points = [];
  strokes = [];
  guideTarget = null;
  guideFlight = null;
  updateGuideTriangle();
  if (guideHideTimer) clearTimeout(guideHideTimer);
  guideHideTimer = null;
  if (chainTimer) clearTimeout(chainTimer);
  chainTimer = null;
  chainDeadlineAt = 0;
  if (chainHintTimer) clearTimeout(chainHintTimer);
  chainHintTimer = null;
  lastPointer = null;
  trailAlpha = 1;
  captureMode = false;
  submitting = false;
  if (fadeRaf) cancelAnimationFrame(fadeRaf);
  if (renderRaf) cancelAnimationFrame(renderRaf);
  if (gestureGraceTimer) clearTimeout(gestureGraceTimer);
  fadeRaf = null;
  renderRaf = null;
  gestureGraceTimer = null;
  hint.classList.add('dim');
  document.body.dataset.mode = 'idle';
  clear();
}

function drawStrokeMarker(index: number, point: { x: number; y: number } | null | undefined) {
  if (!point) return;
  const radius = 14;
  ctx.save();
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(37, 99, 235, 0.94)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(index), point.x, point.y + 0.5);
  ctx.restore();
}

function drawPointTarget(point: OverlayPoint | null | undefined) {
  if (!point) return;
  // A quick click has no stroke body, so give it an unmistakable target glow
  // beneath the armed cursor. The former 13 DIP feather was effectively
  // invisible on light windows and made the detached sequence badge look like
  // the only feedback.
  const radius = 38;
  const color = '47, 124, 246';
  const feather = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
  feather.addColorStop(0, `rgba(${color}, 0.74)`);
  feather.addColorStop(0.18, `rgba(${color}, 0.66)`);
  feather.addColorStop(0.52, `rgba(${color}, 0.28)`);
  feather.addColorStop(1, `rgba(${color}, 0)`);
  ctx.save();
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = feather;
  ctx.fill();
  ctx.restore();
}

function pointMarkerAnchor(point: OverlayPoint | null | undefined): { x: number; y: number } | null | undefined {
  if (!point) return point;
  const xOffset = point.x > window.innerWidth - 48 ? -24 : 24;
  const yOffset = point.y < 48 ? 24 : -24;
  return { x: point.x + xOffset, y: point.y + yOffset };
}


function startPulseLoop() {
  if (pulseRaf) return;
  function tick(now: number) {
    if (now - lastPulseFrame > 33) {
      lastPulseFrame = now;
      if (!captureMode) render();
    }
    pulseRaf = requestAnimationFrame(tick);
  }
  pulseRaf = requestAnimationFrame(tick);
}

function stopPulseLoop() {
  if (pulseRaf) cancelAnimationFrame(pulseRaf);
  pulseRaf = null;
  lastPulseFrame = 0;
}

window.addEventListener('resize', resize);
window.addEventListener('contextmenu', (e) => { e.preventDefault(); window.magicPointer?.hide(); });

window.addEventListener('pointerdown', (e) => {
  if (e.button === 2) {
    guideTarget = null;
    guideFlight = null;
    window.magicPointer?.hide();
    return;
  }
  if (e.button !== 0) return;
  if (gestureMode && gestureInteractionMode === 'pass_through') return;
  if (observerMode || captureMode || submitting) return;
  if (drawing) return;
  if (chainTimer) {
    clearTimeout(chainTimer);
    chainTimer = null;
  }
  if (chainHintTimer) {
    clearTimeout(chainHintTimer);
    chainHintTimer = null;
    hint.classList.add('dim');
  }
  if (fadeRaf) cancelAnimationFrame(fadeRaf);
  drawing = true;
  activePointerId = e.pointerId;
  try { canvas.setPointerCapture(e.pointerId); } catch (_error) { /* best effort */ }
  if (gestureMode) window.magicPointer?.gestureStarted(gestureToken);
  points = [];
  trailAlpha = 1;
  addPoint(e);
  const graceRemaining = gestureAcceptAt - Date.now();
  if (gestureMode && graceRemaining > 0) {
    if (gestureGraceTimer) clearTimeout(gestureGraceTimer);
    gestureGraceTimer = setTimeout(() => {
      gestureGraceTimer = null;
      if (drawing) scheduleRender();
    }, graceRemaining);
  } else {
    scheduleRender();
  }
  e.stopPropagation();
  e.preventDefault();
});

window.addEventListener('pointermove', (e) => {
  if (captureMode) return;
  if (!drawing) {
    const nextPointer = { x: e.clientX, y: e.clientY, t: performance.now() };
    const continuesChain = strokes.length > 0 && chainTimer && globalThis.GestureCapture
      .pointerContinuesGestureChain(lastPointer, nextPointer);
    lastPointer = nextPointer;
    // Deliberate travel toward another target is activity, while tiny pointer
    // jitter is not. The hard deadline still bounds the total inter-stroke gap.
    if (continuesChain) scheduleChainFinalize();
    scheduleRender();
    return;
  }
  if (activePointerId !== null && e.pointerId !== activePointerId) return;
  addPoint(e);
  scheduleRender();
  e.stopPropagation();
  e.preventDefault();
});

window.addEventListener('pointerup', (e) => {
  if (!drawing) return;
  if (activePointerId !== null && e.pointerId !== activePointerId) return;
  drawing = false;
  activePointerId = null;
  try { canvas.releasePointerCapture(e.pointerId); } catch (_error) { /* best effort */ }
  addPoint(e, { force: true });
  render();
  // Restore mouse capture after release to prevent revert to normal mouse
  if (window.magicPointer && typeof window.magicPointer.syncHitRegions === 'function') {
    window.magicPointer.syncHitRegions();
  }
  // Chain capture: commit the stroke, notify main (keeps the arm alive),
  // and let the user keep circling. The rolling inactivity window or the
  // Enter key finalizes the whole chain into one unified gesture.
  if (points.length >= 1) {
    // TS 6 的解析器不接受换行开头的 `as` 断言，所以这一行必须连写。
    const strokeSummary = (globalThis.GestureCapture?.summarizeGesture?.(points, null) || {}) as Record<string, unknown>;
    strokes.push({
      points: [...points],
      kind: strokeSummary.kind,
      semanticPoint: (strokeSummary.semanticPoint as OverlayPoint | undefined)
        || points[Math.floor(points.length / 2)],
    });
    if (gestureMode) {
      window.magicPointer?.gestureStroke(gestureToken, strokes.length);
      showChainHint(strokes.length);
      chainDeadlineAt = performance.now() + gestureChainGapMs;
      scheduleChainFinalize();
      fadeTrail(128);
    } else {
      submitGesture();
    }
  }
  e.stopPropagation();
  e.preventDefault();
});

window.addEventListener('pointercancel', (e) => {
  if (!drawing || (activePointerId !== null && e.pointerId !== activePointerId)) return;
  drawing = false;
  activePointerId = null;
  points = [];
  clear();
  e.stopPropagation();
  e.preventDefault();
});

// Finalize the chain when the window is hidden externally (right-click or
// Escape) so the renderer never submits a half-drawn chain later.
// 这里曾另挂了一份 onHide 做链/三角清理——和下方 onHide 里的 resetOverlay
// 完全重复（resetOverlay 已经清 chainTimer/chainHintTimer/guideTarget/
// guideFlight/guideHideTimer/chainDeadlineAt），已合并，只留一份。

window.magicPointer?.onGestureSubmit((payload) => {
  if (!gestureMode || String(payload?.token || '') !== String(gestureToken || '')) return;
  finalizeGesture();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    finalizeGesture();
    return;
  }
  if (e.key === 'Escape') window.magicPointer?.hide();
  if (e.key.toLowerCase() === 'r') resetOverlay();
});

window.magicPointer?.onShow((payload) => {
  resetOverlay();
  observerMode = payload?.observerMode === true;
  gestureMode = payload?.gestureMode === true;
  gestureToken = payload?.selectionGestureToken ? String(payload.selectionGestureToken) : null;
  gestureAcceptAt = Number(payload?.gestureAcceptAt) || 0;
  gestureLineStyle = payload?.gestureLineStyle === 'thin' ? 'thin' : 'demo6_band';
  gestureLineWidth = Math.max(3, Math.min(40, Number(payload?.gestureLineWidth) || 22));
  gestureChainGapMs = Math.max(1500, Math.min(30000,
    Number(payload?.gestureChainGapMs) || DEFAULT_CHAIN_GAP_MS));
  gestureInteractionMode = payload?.gestureInteractionMode === 'pass_through'
    ? 'pass_through'
    : 'exclusive_overlay';
  currentWorkflow = String(payload?.workflow || 'generic');
  document.body.dataset.mode = gestureMode ? 'gesture' : observerMode ? 'observer' : 'capture';
  if (hintTimer) clearTimeout(hintTimer);
  if (currentWorkflow === 'runtime_issue') {
    hint.textContent = '圈出运行中的问题，然后说你期望什么';
    hint.classList.remove('dim');
    hintTimer = setTimeout(() => hint.classList.add('dim'), 1800);
  } else {
    hint.classList.add('dim');
  }
  if (!gestureMode) startPulseLoop();
  if (gestureMode) window.magicPointer?.gestureReady(gestureToken);
});
window.magicPointer?.onCursor((payload) => {
  if (!payload) return;
  lastPointer = { x: Number(payload.x) || 0, y: Number(payload.y) || 0, t: performance.now() };
  if (gestureMode) return;
  scheduleRender();
});
window.magicPointer?.onElementGhosts?.((payload) => {
  onElementGhosts(payload);
});
window.magicPointer?.onGuidePoint?.((payload) => {
  onGuidePoint(payload);
  // 飞行是持续动画（620ms），不是一帧——持续 rAF 直到到达/超时，
  // 否则三角只在起点闪一帧就消失。
  function guideTick() {
    updateGuideTriangle();
    const stillFlying = guideFlight && performance.now() < guideFlight.startedAt + guideFlight.duration;
    if (stillFlying) requestAnimationFrame(guideTick);
  }
  requestAnimationFrame(guideTick);
});
window.magicPointer?.onGestureInput((payload) => {
  if (
    !gestureMode
    || gestureInteractionMode !== 'pass_through'
    || String(payload?.token || '') !== String(gestureToken || '')
  ) return;
  const phase = String(payload?.phase || '');
  if (phase === 'start') {
    drawing = true;
    points = [];
    trailAlpha = 1;
    submitting = false;
    clear();
    return;
  }
  if (phase === 'point' && payload?.point) {
    const point = {
      x: Number((payload.point as { x?: unknown }).x) || 0,
      y: Number((payload.point as { y?: unknown }).y) || 0,
      t: Number((payload.point as { t?: unknown }).t) || performance.now(),
    };
    const previous = points[points.length - 1];
    if (!previous || dist(point, previous) > 0.5) points.push(point);
    lastPointer = point;
    scheduleRender();
    return;
  }
  if (phase === 'end') {
    drawing = false;
    render();
    fadeTrail(128);
  }
});
window.magicPointer?.onHide(() => {
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = null;
  stopPulseLoop();
  resetOverlay();
  gestureMode = false;
  gestureToken = null;
  gestureAcceptAt = 0;
  gestureLineStyle = 'demo6_band';
  gestureInteractionMode = 'exclusive_overlay';
});

resize();
window.magicPointer?.ready?.();
