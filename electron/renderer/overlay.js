const canvas = document.getElementById('trail');
const ctx = canvas.getContext('2d');
const hint = document.getElementById('hint');

let dpr = window.devicePixelRatio || 1;
let drawing = false;
let activePointerId = null;
let points = [];
let lastPointer = null;
let trailAlpha = 1;
let fadeRaf = null;
let captureMode = false;
let requestSeq = 0;
let submitting = false;
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

function resize() {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  clear();
}

function clear() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
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

function addPoint(e) {
  const batch = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
  for (const ev of batch) {
    const p = { x: ev.clientX, y: ev.clientY, t: performance.now() };
    const last = points[points.length - 1];
    if (!last || dist(p, last) > 4.2) points.push(p);
    lastPointer = p;
  }
}

function drawSmoothPath(path, alpha = 1) {
  if (path.length < 2 || alpha <= 0.02) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'source-over';

  function trace(width, color, blur = 0, a = alpha) {
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
    trace(gestureLineWidth, 'rgba(49, 119, 255, 0.34)', 0, alpha);
    trace(Math.max(1.15, gestureLineWidth * 0.22), 'rgba(226, 241, 255, 0.64)', 0, alpha);
  } else {
    trace(gestureLineWidth, 'rgba(92, 160, 255, 0.18)', 0, alpha);
    trace(gestureLineWidth * 0.72, 'rgba(73, 145, 255, 0.17)', 0, alpha);
    trace(Math.max(1.2, gestureLineWidth * 0.075), 'rgba(225, 241, 255, 0.38)', 0, alpha);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

function drawPointer(p) {
  if (!p || captureMode) return;
  // Native Windows cursor mode: do not override system cursor.
  // Preloaded blue-white pointer used only for visual feedback if needed.
  // Full-screen Overlay ensures visual/delay effect matches native.
  // Right-click exit restores normal mouse.
  const now = performance.now();
  const pulse = 0.5 + 0.5 * Math.sin(now / 430);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(-0.045);
  ctx.scale(0.74, 0.92);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

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

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.46 + pulse * 0.46;
  ctx.shadowColor = `rgba(37, 99, 235, ${0.72 + pulse * 0.24})`;
  ctx.shadowBlur = 20 + pulse * 20;
  ctx.strokeStyle = `rgba(59, 130, 246, ${0.42 + pulse * 0.30})`;
  ctx.lineWidth = 9.5;
  ctx.stroke(path);
  ctx.restore();

  ctx.shadowColor = `rgba(37, 99, 235, ${0.52 + pulse * 0.34})`;
  ctx.shadowBlur = 12 + pulse * 12;
  ctx.fillStyle = 'rgba(255, 255, 255, .99)';
  ctx.strokeStyle = 'rgba(37, 99, 235, .96)';
  ctx.lineWidth = 2.15;
  ctx.fill(path);
  ctx.stroke(path);

  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(147, 197, 253, .42)';
  ctx.lineWidth = 0.75;
  ctx.stroke(path);
  ctx.restore();
}

function drawObserverAura(p) {
  if (!p) return;
  const now = performance.now();
  const pulse = 0.5 + 0.5 * Math.sin(now / 420);
  ctx.save();
  ctx.translate(p.x + 2, p.y + 2);
  ctx.globalCompositeOperation = 'lighter';

  const outer = ctx.createRadialGradient(0, 0, 2, 0, 0, 20 + pulse * 4);
  outer.addColorStop(0, `rgba(191, 219, 254, ${0.20 + pulse * 0.08})`);
  outer.addColorStop(0.42, `rgba(59, 130, 246, ${0.14 + pulse * 0.08})`);
  outer.addColorStop(1, 'rgba(37, 99, 235, 0)');
  ctx.fillStyle = outer;
  ctx.beginPath();
  ctx.arc(0, 0, 24 + pulse * 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = `rgba(96, 165, 250, ${0.24 + pulse * 0.12})`;
  ctx.lineWidth = 1.2;
  ctx.shadowColor = 'rgba(37, 99, 235, 0.32)';
  ctx.shadowBlur = 10 + pulse * 5;
  ctx.beginPath();
  ctx.arc(0, 0, 9 + pulse * 1.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function render() {
  clear();
  if (gestureMode) {
    if (Date.now() < gestureAcceptAt) return;
    if (points.length) drawSmoothPath(points, trailAlpha);
    return;
  }
  if (!captureMode && points.length) drawSmoothPath(points, trailAlpha);
  if (observerMode) drawObserverAura(lastPointer);
  else drawPointer(lastPointer);
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
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const geometry = globalThis.GestureCapture?.summarizeGesture(points) || {};
  return {
    ...geometry,
    points: [...points],
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

function hideVisualsForCapture() {
  captureMode = true;
  hint.classList.add('dim');
  clear();
}

function restoreAfterCapture(seq) {
  if (seq !== requestSeq) return;
  captureMode = false;
  render();
}

function submitGesture() {
  if (submitting || points.length < 1) return;
  submitting = true;
  const seq = ++requestSeq;
  const payload = { ...computeSelectionPayload(), workflow: currentWorkflow };

  // Critical: remove our own overlay before Python ImageGrab runs.
  hideVisualsForCapture();
  requestAnimationFrame(() => {
    window.magicPointer?.done(payload);
    if (!gestureMode) {
      // Runtime-issue capture may remain open while its bridge runs.
      setTimeout(() => restoreAfterCapture(seq), 1050);
    }
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
  lastPointer = null;
  trailAlpha = 1;
  captureMode = false;
  requestSeq += 1;
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
  if (fadeRaf) cancelAnimationFrame(fadeRaf);
  drawing = true;
  activePointerId = e.pointerId;
  try { canvas.setPointerCapture(e.pointerId); } catch (_error) { /* best effort */ }
  if (gestureMode) window.magicPointer?.gestureStarted(gestureToken);
  points = [];
  trailAlpha = 1;
  hint.classList.add('dim');
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
    lastPointer = { x: e.clientX, y: e.clientY, t: performance.now() };
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
  addPoint(e);
  render();
  // Restore mouse capture after release to prevent revert to normal mouse
  if (window.magicPointer && typeof window.magicPointer.syncHitRegions === 'function') {
    window.magicPointer.syncHitRegions();
  }
  // Circle capture: hand the drawn region to the main process, which routes
  // the outcome to the PointerStage surface.
  if (points.length >= 1) {
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

window.addEventListener('keydown', (e) => {
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
