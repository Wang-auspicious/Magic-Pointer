const canvas = document.getElementById('trail');
const ctx = canvas.getContext('2d');
const pill = document.getElementById('pill');
const commandInput = document.getElementById('command');
const runButton = document.getElementById('run');
const hint = document.getElementById('hint');
const result = document.getElementById('result');

let dpr = window.devicePixelRatio || 1;
let drawing = false;
let points = [];
let selectedPayload = null;
let lastPointer = null;
let selectionAnchor = null;
let trailAlpha = 1;
let fadeRaf = null;
let captureMode = false;
let requestSeq = 0;
let submitting = false;
let renderRaf = null;
let resultDrag = null;
let pulseRaf = null;
let lastPulseFrame = 0;

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
  ctx.globalCompositeOperation = 'lighter';

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
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.stroke();
  }

  // Gemini-like feel: one broad blurred ribbon with a very gentle inner energy.
  // Keep alpha close between layers so it reads as one soft band, not stacked stripes.
  trace(18, 'rgba(77, 144, 255, 0.20)', 14, alpha * 0.86);
  trace(9, 'rgba(49, 119, 255, 0.30)', 7, alpha * 0.62);
  trace(2, 'rgba(232, 246, 255, 0.38)', 1.5, alpha * 0.34);
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

function drawPointer(p) {
  if (!p || captureMode) return;
  const now = performance.now();
  const pulse = 0.5 + 0.5 * Math.sin(now / 760);
  ctx.save();
  // Google-style concave quadrilateral cursor: white fill, blue outline, soft breathing glow.
  // Hot spot is the upper-left tip. Narrower wings than the previous version.
  ctx.translate(p.x, p.y);
  ctx.rotate(-0.045);
  ctx.scale(0.90, 0.90);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const path = new Path2D();
  path.moveTo(0.0, 0.0);                    // upper-left tip / hot spot
  path.quadraticCurveTo(1.0, -0.9, 2.7, 0.0);
  path.lineTo(28.0, 12.6);                  // right point, pulled inward
  path.quadraticCurveTo(31.0, 14.0, 28.2, 15.7);
  path.lineTo(12.5, 19.2);                  // inward notch / concave corner
  path.lineTo(6.2, 33.5);                   // lower point, pulled upward/inward
  path.quadraticCurveTo(4.7, 36.7, 3.4, 33.2);
  path.lineTo(-1.4, 3.7);
  path.quadraticCurveTo(-1.9, 1.1, 0.0, 0.0);
  path.closePath();

  // Soft breathing halo + crisp blue border.
  ctx.shadowColor = `rgba(37, 99, 235, ${0.34 + pulse * 0.18})`;
  ctx.shadowBlur = 8 + pulse * 5;
  ctx.fillStyle = 'rgba(255, 255, 255, .99)';
  ctx.strokeStyle = 'rgba(37, 99, 235, .94)';
  ctx.lineWidth = 2.15;
  ctx.fill(path);
  ctx.stroke(path);

  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(96, 165, 250, .34)';
  ctx.lineWidth = 0.75;
  ctx.stroke(path);
  ctx.restore();
}

function render() {
  clear();
  if (!captureMode && points.length) drawSmoothPath(points, trailAlpha);
  drawPointer(lastPointer);
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
  return {
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
  };
}

function showPill() {
  const anchor = selectionAnchor || lastPointer;
  if (!anchor) return;
  const x = Math.min(window.innerWidth - 438, Math.max(18, anchor.x + 30));
  const y = Math.min(window.innerHeight - 64, Math.max(18, anchor.y - 18));
  pill.style.left = `${x}px`;
  pill.style.top = `${y}px`;
  pill.classList.remove('hidden');
  commandInput.value = '';
  commandInput.focus();
}

function hideVisualsForCapture() {
  captureMode = true;
  pill.classList.add('hidden');
  result.classList.add('hidden');
  hint.classList.add('dim');
  clear();
}

function restoreAfterCapture(seq) {
  if (seq !== requestSeq) return;
  captureMode = false;
  render();
}

function runSelectedCommand(action = 'command') {
  if (!selectedPayload || submitting) return;
  submitting = true;
  const seq = ++requestSeq;
  if (!selectionAnchor && lastPointer) selectionAnchor = { ...lastPointer };
  const command = commandInput.value.trim();
  const payload = { ...selectedPayload, action, command };

  // Critical: remove our own overlay before Python ImageGrab runs.
  hideVisualsForCapture();
  setTimeout(() => {
    window.magicPointer?.done(payload);
    // Show thinking only after the clean capture should have happened.
    setTimeout(() => {
      if (seq === requestSeq) {
        restoreAfterCapture(seq);
        showResult({ ok: null, status: 'Thinking...' });
      }
    }, 1050);
  }, 260);
}

function showResult(payload) {
  if (!payload) return;
  captureMode = false;
  const alreadyVisible = !result.classList.contains('hidden');
  if (!alreadyVisible) {
    const anchor = selectionAnchor || lastPointer || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const x = Math.min(window.innerWidth - 590, Math.max(18, anchor.x + 40));
    const y = Math.min(window.innerHeight - 180, Math.max(18, anchor.y + 48));
    result.style.left = `${x}px`;
    result.style.top = `${y}px`;
  }
  if (payload.ok === null) {
    result.innerHTML = `<div class="title thinking-title" data-drag-handle="true"><span class="spinner" aria-hidden="true"></span>Thinking</div><div class="content muted">${escapeHtml(payload.status || 'Processing...')}</div>`;
  } else if (payload.ok) {
    const answer = String(payload.answer || '').slice(0, 1600);
    result.innerHTML = `<div class="title" data-drag-handle="true">${escapeHtml(payload.prompt || 'Result')}</div><div class="content">${escapeHtml(answer)}</div>`;
  } else {
    result.innerHTML = `<div class="title" data-drag-handle="true">Bridge error</div><div class="content muted">${escapeHtml(payload.error || 'Unknown error')}</div>`;
  }
  result.classList.remove('hidden');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function resetOverlay() {
  points = [];
  selectedPayload = null;
  lastPointer = null;
  selectionAnchor = null;
  trailAlpha = 1;
  captureMode = false;
  requestSeq += 1;
  submitting = false;
  if (fadeRaf) cancelAnimationFrame(fadeRaf);
  if (renderRaf) cancelAnimationFrame(renderRaf);
  fadeRaf = null;
  renderRaf = null;
  resultDrag = null;
  pill.classList.add('hidden');
  result.classList.add('hidden');
  result.textContent = '';
  commandInput.value = '';
  hint.classList.remove('dim');
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
  if (e.target.closest('#pill') || e.target.closest('#result')) return;
  if (fadeRaf) cancelAnimationFrame(fadeRaf);
  captureMode = false;
  drawing = true;
  points = [];
  selectedPayload = null;
  selectionAnchor = null;
  trailAlpha = 1;
  pill.classList.add('hidden');
  result.classList.add('hidden');
  hint.classList.add('dim');
  addPoint(e);
  scheduleRender();
});

window.addEventListener('pointermove', (e) => {
  if (captureMode) return;
  if (!drawing) {
    lastPointer = { x: e.clientX, y: e.clientY, t: performance.now() };
    scheduleRender();
    return;
  }
  addPoint(e);
  scheduleRender();
});

window.addEventListener('pointerup', (e) => {
  if (!drawing) return;
  drawing = false;
  addPoint(e);
  render();
  if (points.length >= 2) {
    selectedPayload = computeSelectionPayload();
    selectionAnchor = lastPointer ? { ...lastPointer } : null;
    showPill();
    fadeTrail(900);
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.magicPointer?.hide();
  if (e.key.toLowerCase() === 'r' && e.target !== commandInput) resetOverlay();
  // Enter inside the input is handled by commandInput below. Do not bubble-submit twice.
  if (e.key === 'Enter' && e.target !== commandInput && !pill.classList.contains('hidden')) runSelectedCommand('command');
});

pill.addEventListener('pointerdown', (e) => e.stopPropagation());
pill.addEventListener('click', (e) => e.stopPropagation());
runButton.addEventListener('click', () => runSelectedCommand('command'));
commandInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    runSelectedCommand('command');
  }
});


result.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('[data-drag-handle="true"]');
  if (e.button !== 0 || !handle) return;
  e.preventDefault();
  const rect = result.getBoundingClientRect();
  resultDrag = {
    pointerId: e.pointerId,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
  };
  result.setPointerCapture(e.pointerId);
  result.classList.add('dragging');
});

result.addEventListener('pointermove', (e) => {
  if (!resultDrag || resultDrag.pointerId !== e.pointerId) return;
  const maxX = Math.max(18, window.innerWidth - result.offsetWidth - 18);
  const maxY = Math.max(18, window.innerHeight - result.offsetHeight - 18);
  const x = Math.min(maxX, Math.max(18, e.clientX - resultDrag.offsetX));
  const y = Math.min(maxY, Math.max(18, e.clientY - resultDrag.offsetY));
  result.style.left = `${x}px`;
  result.style.top = `${y}px`;
  lastPointer = { x: e.clientX, y: e.clientY, t: performance.now() };
  scheduleRender();
});

function stopResultDrag(e) {
  if (!resultDrag || resultDrag.pointerId !== e.pointerId) return;
  try { result.releasePointerCapture(e.pointerId); } catch (_) {}
  resultDrag = null;
  result.classList.remove('dragging');
}
result.addEventListener('pointerup', stopResultDrag);
result.addEventListener('pointercancel', stopResultDrag);

window.magicPointer?.onShow(() => { resetOverlay(); startPulseLoop(); });
window.magicPointer?.onHide(() => { stopPulseLoop(); resetOverlay(); });
window.magicPointer?.onResult((payload) => {
  requestSeq += 1;
  submitting = false;
  showResult(payload);
});

resize();
