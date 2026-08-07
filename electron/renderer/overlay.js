const canvas = document.getElementById('trail');
const ctx = canvas.getContext('2d');
const sweepCanvas = document.getElementById('sweep-layer');
const sweepRenderer = new globalThis.MagicSweepVisual.SweepRenderer(sweepCanvas);
const hint = document.getElementById('hint');

let dpr = window.devicePixelRatio || 1;
let drawing = false;
let activePointerId = null;
let points = [];
let lastPointer = null;
let trailAlpha = 1;
let fadeRaf = null;
let captureMode = false;
let submitting = false;
// Committed strokes of the current chain. The user can circle several
// regions before the session finalizes ("circle this, and this, then run
// the command"); a configurable inactivity window decides when the chain
// ends and the unified gesture is submitted.
let strokes = [];
let chainTimer = null;
let chainHintTimer = null;
let chainDeadlineAt = 0;
const DEFAULT_CHAIN_GAP_MS = 2500;
let gestureChainGapMs = DEFAULT_CHAIN_GAP_MS;
let renderRaf = null;
let pulseRaf = null;
let lastPulseFrame = 0;
let observerMode = false;
let gestureMode = false;
let gestureToken = null;
let gestureAcceptAt = 0;
let gestureLineStyle = 'demo6_band';
let gestureLineWidth = 22;
let gestureInteractionMode = 'exclusive_overlay';
let hintTimer = null;
let gestureGraceTimer = null;
let currentWorkflow = 'generic';

// ── Clicky 式引导小三角 ──────────────────────────────────────────────
// 默认不出现。回答带了 [POINT] 指点（overlay:guide-point）时才浮现，
// 从蓝边光标旁沿贝塞尔弧线飞向目标，然后停留到下一轮。
let guideTarget = null;        // { x, y } 指点目标（overlay 局部坐标）
let guideFlight = null;        // { t, from, to, ctrl, startedAt, duration }
const GUIDE_TRIANGLE_SIZE = 15;
const GUIDE_FLIGHT_MS = 620;

function onGuidePoint(payload) {
  if (!payload || !Number.isFinite(Number(payload.x)) || !Number.isFinite(Number(payload.y))) return;
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

function overlayBounds() {
  const canvasRect = ctx.canvas.getBoundingClientRect();
  return { x: canvasRect.left, y: canvasRect.top, width: canvasRect.width, height: canvasRect.height };
}

// 二次贝塞尔插值（纯函数，可单测）：B(t) = (1-t)²P0 + 2(1-t)t·P1 + t²·P2
function guideFlightPoint(from, ctrl, to, t) {
  const u = 1 - t;
  return {
    x: u * u * from.x + 2 * u * t * ctrl.x + t * t * to.x,
    y: u * u * from.y + 2 * u * t * ctrl.y + t * t * to.y,
  };
}

function drawGuideTriangle() {
  if (!guideTarget) return;
  const now = performance.now();
  let px;
  let py;
  if (guideFlight && now < guideFlight.startedAt + guideFlight.duration) {
    // 飞行中：贝塞尔插值
    const t = Math.min(1, (now - guideFlight.startedAt) / guideFlight.duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const { from, to, ctrl } = guideFlight;
    const pos = guideFlightPoint(from, ctrl, to, eased);
    px = pos.x;
    py = pos.y;
  } else {
    guideFlight = null;
    px = guideTarget.x;
    py = guideTarget.y;
  }
  // 蓝边光标旁的小三角：默认在光标右下方 35/25px（clicky 的落位），
  // 飞行时画在轨迹上
  if (!guideFlight) {
    const base = lastPointer || { x: px, y: py };
    px = base.x + 35;
    py = base.y + 25;
  }
  ctx.save();
  ctx.translate(px, py);
  // 发光层
  ctx.shadowColor = 'rgba(92, 160, 255, 0.65)';
  ctx.shadowBlur = 12;
  ctx.fillStyle = 'rgba(92, 160, 255, 0.9)';
  ctx.beginPath();
  ctx.moveTo(0, -GUIDE_TRIANGLE_SIZE / 2);
  ctx.lineTo(GUIDE_TRIANGLE_SIZE, 0);
  ctx.lineTo(0, GUIDE_TRIANGLE_SIZE / 2);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  // 白色内芯，让它在深色背景上也分明
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(0, -GUIDE_TRIANGLE_SIZE / 4);
  ctx.lineTo(GUIDE_TRIANGLE_SIZE / 2, 0);
  ctx.lineTo(0, GUIDE_TRIANGLE_SIZE / 4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ── OffscreenCanvas pre-rendered pointer & aura frame cache ──────────
// Avoids per-frame Path2D construction, createRadialGradient, shadowBlur,
// and quadraticCurveTo calls — the main render loop only calls drawImage().
const POINTER_FRAME_COUNT = 6;
const AURA_FRAME_COUNT = 6;
let pointerFrames = [];
let auraFrames = [];
let pointerFrameWidth = 0;
let pointerFrameHeight = 0;
let auraFrameWidth = 0;
let auraFrameHeight = 0;

function buildPointerFrames() {
  pointerFrames = [];
  const w = 48; const h = 68;  // enough for the rotated arrow + shadow
  pointerFrameWidth = w;
  pointerFrameHeight = h;
  const originX = 6; const originY = 5;  // where (0,0) of the path maps
  for (let i = 0; i < POINTER_FRAME_COUNT; i++) {
    const pulse = i / (POINTER_FRAME_COUNT - 1);  // 0.0 … 1.0
    const offscreen = new OffscreenCanvas(w, h);
    const oc = offscreen.getContext('2d');
    oc.translate(originX, originY);
    oc.rotate(-0.045);
    oc.scale(0.74, 0.92);
    oc.lineJoin = 'round';
    oc.lineCap = 'round';

    const path = new Path2D();
    path.moveTo(0.0, 0.0);
    path.quadraticCurveTo(0.8, -0.7, 2.2, 0.0);
    path.lineTo(22.4, 18.8);
    path.quadraticCurveTo(24.8, 20.5, 21.6, 21.2);
    path.lineTo(10.9, 20.4);
    path.lineTo(5.6, 30.0);
    path.quadraticCurveTo(4.5, 32.7, 3.4, 29.8);
    path.lineTo(-1.0, 3.5);
    path.quadraticCurveTo(-1.9, 1.1, 0.0, 0.0);
    path.closePath();

    // outer glow
    oc.save();
    oc.globalCompositeOperation = 'lighter';
    oc.globalAlpha = 0.46 + pulse * 0.46;
    oc.shadowColor = `rgba(37, 99, 235, ${0.72 + pulse * 0.24})`;
    oc.shadowBlur = 20 + pulse * 20;
    oc.strokeStyle = `rgba(59, 130, 246, ${0.42 + pulse * 0.30})`;
    oc.lineWidth = 9.5;
    oc.stroke(path);
    oc.restore();

    // main fill
    oc.shadowColor = `rgba(37, 99, 235, ${0.52 + pulse * 0.34})`;
    oc.shadowBlur = 12 + pulse * 12;
    oc.fillStyle = 'rgba(255, 255, 255, .99)';
    oc.strokeStyle = 'rgba(37, 99, 235, .96)';
    oc.lineWidth = 2.15;
    oc.fill(path);
    oc.stroke(path);

    // inner highlight
    oc.shadowBlur = 0;
    oc.strokeStyle = 'rgba(147, 197, 253, .42)';
    oc.lineWidth = 0.75;
    oc.stroke(path);

    pointerFrames.push(offscreen);
  }
}

function buildAuraFrames() {
  auraFrames = [];
  const w = 56; const h = 56;
  auraFrameWidth = w;
  auraFrameHeight = h;
  const cx = w / 2; const cy = h / 2;
  for (let i = 0; i < AURA_FRAME_COUNT; i++) {
    const pulse = i / (AURA_FRAME_COUNT - 1);
    const offscreen = new OffscreenCanvas(w, h);
    const oc = offscreen.getContext('2d');
    oc.translate(cx, cy);
    oc.globalCompositeOperation = 'lighter';

    const radius = 20 + pulse * 4;
    if (typeof oc.createRadialGradient === 'function') {
      const grad = oc.createRadialGradient(0, 0, 2, 0, 0, radius);
      grad.addColorStop(0, `rgba(191, 219, 254, ${0.20 + pulse * 0.08})`);
      grad.addColorStop(0.42, `rgba(59, 130, 246, ${0.14 + pulse * 0.08})`);
      grad.addColorStop(1, 'rgba(37, 99, 235, 0)');
      oc.fillStyle = grad;
      oc.beginPath();
      oc.arc(0, 0, radius, 0, Math.PI * 2);
      oc.fill();
    }

    oc.strokeStyle = `rgba(96, 165, 250, ${0.24 + pulse * 0.12})`;
    oc.lineWidth = 1.2;
    oc.shadowColor = 'rgba(37, 99, 235, 0.32)';
    oc.shadowBlur = 10 + pulse * 5;
    oc.beginPath();
    oc.arc(0, 0, 9 + pulse * 1.5, 0, Math.PI * 2);
    oc.stroke();

    auraFrames.push(offscreen);
  }
}

function ensureFrameCache() {
  if (pointerFrames.length === 0) buildPointerFrames();
  if (auraFrames.length === 0) buildAuraFrames();
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  pointerFrames = [];  // invalidate — DPR may have changed
  auraFrames = [];
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

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function addPoint(e, { force = false } = {}) {
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

function drawSmoothPath(path, alpha = 1) {
  if (path.length < 2 || alpha <= 0.02) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'source-over';

  function trace(width, color, a = alpha) {
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

function drawPointer(p) {
  if (!p || captureMode) return;
  ensureFrameCache();
  if (pointerFrames.length === 0) return;
  const now = performance.now();
  const pulse = 0.5 + 0.5 * Math.sin(now / 430);
  const idx = Math.min(pointerFrames.length - 1, Math.round(pulse * (pointerFrames.length - 1)));
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.drawImage(
    pointerFrames[idx],
    -pointerFrameWidth / 2 + 2,   // offset to align path origin with cursor hotspot
    -pointerFrameHeight / 2 + 2,
  );
  ctx.restore();
}

function drawHitTestPixel(p) {
  if (!p || captureMode) return;
  ctx.save();
  ctx.globalAlpha = 0.012;
  ctx.fillStyle = '#2f7bff';
  ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
  ctx.restore();
}

function drawObserverAura(p) {
  if (!p) return;
  ensureFrameCache();
  if (auraFrames.length === 0) return;
  const now = performance.now();
  const pulse = 0.5 + 0.5 * Math.sin(now / 420);
  const idx = Math.min(auraFrames.length - 1, Math.round(pulse * (auraFrames.length - 1)));
  ctx.save();
  ctx.translate(p.x + 2 - auraFrameWidth / 2, p.y + 2 - auraFrameHeight / 2);
  ctx.drawImage(auraFrames[idx], 0, 0);
  ctx.restore();
}

function render() {
  clear();
  if (gestureMode) {
    if (Date.now() < gestureAcceptAt) return;
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
      // Keep the transparent window hit-testable without painting a second
      // cursor over the preloaded CSS cursor (armed-cursor.png).
      drawHitTestPixel(lastPointer);
    }
    return;
  }
  if (!captureMode && points.length) drawSmoothPath(points, trailAlpha);
  if (observerMode) drawObserverAura(lastPointer);
  else drawPointer(lastPointer);
  // 引导小三角画在光标之上（默认不出现，有 [POINT] 指点才浮现）
  drawGuideTriangle();
}

function fadeTrail(duration = 760) {
  if (fadeRaf) cancelAnimationFrame(fadeRaf);
  const start = performance.now();
  const from = trailAlpha;
  function tick(now) {
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

function drawStrokeMarker(index, point) {
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

function drawPointTarget(point) {
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

function pointMarkerAnchor(point) {
  if (!point) return point;
  const xOffset = point.x > window.innerWidth - 48 ? -24 : 24;
  const yOffset = point.y < 48 ? 24 : -24;
  return { x: point.x + xOffset, y: point.y + yOffset };
}


function startPulseLoop() {
  if (pulseRaf) return;
  function tick(now) {
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
  if (e.button === 2) { window.magicPointer?.hide(); return; }
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
    const strokeSummary = globalThis.GestureCapture?.summarizeGesture?.(points, null) || {};
    strokes.push({
      points: [...points],
      kind: strokeSummary.kind,
      semanticPoint: strokeSummary.semanticPoint || points[Math.floor(points.length / 2)],
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
window.magicPointer?.onHide(() => {
  if (chainTimer) clearTimeout(chainTimer);
  chainTimer = null;
  chainDeadlineAt = 0;
  if (chainHintTimer) clearTimeout(chainHintTimer);
  chainHintTimer = null;
  guideTarget = null;
  guideFlight = null;
});

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
  if (gestureMode) return;
  lastPointer = { x: Number(payload.x) || 0, y: Number(payload.y) || 0, t: performance.now() };
  scheduleRender();
});
window.magicPointer?.onGuidePoint?.((payload) => {
  onGuidePoint(payload);
  scheduleRender();
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
      x: Number(payload.point.x) || 0,
      y: Number(payload.point.y) || 0,
      t: Number(payload.point.t) || performance.now(),
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
