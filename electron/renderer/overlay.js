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

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function addPoint(e) {
  const p = { x: e.clientX, y: e.clientY, t: performance.now() };
  const last = points[points.length - 1];
  if (!last || dist(p, last) > 3.5) points.push(p);
  lastPointer = p;
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
  trace(20, 'rgba(77, 144, 255, 0.18)', 30, alpha * 0.92);
  trace(13, 'rgba(63, 133, 255, 0.28)', 20, alpha * 0.72);
  trace(7, 'rgba(49, 119, 255, 0.24)', 9, alpha * 0.55);
  trace(2, 'rgba(230, 244, 255, 0.34)', 3, alpha * 0.40);
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

function drawPointer(p) {
  if (!p || captureMode) return;
  ctx.save();
  ctx.translate(p.x - 1, p.y - 1);
  ctx.rotate(-0.08);

  const path = new Path2D();
  path.moveTo(0, 0);
  path.quadraticCurveTo(1.4, 0.3, 3.0, 1.2);
  path.lineTo(20.5, 11.2);
  path.quadraticCurveTo(23.3, 12.8, 22.2, 14.8);
  path.quadraticCurveTo(21.6, 15.8, 20.1, 16.0);
  path.lineTo(12.5, 17.4);
  path.lineTo(17.2, 26.5);
  path.quadraticCurveTo(18.0, 28.1, 16.4, 28.9);
  path.lineTo(11.2, 31.4);
  path.quadraticCurveTo(9.5, 32.1, 8.8, 30.4);
  path.lineTo(4.2, 19.2);
  path.lineTo(0.4, 23.0);
  path.quadraticCurveTo(-1.1, 24.5, -1.7, 22.3);
  path.lineTo(-1.8, 2.1);
  path.quadraticCurveTo(-1.8, -0.3, 0, 0);
  path.closePath();

  ctx.shadowColor = 'rgba(37, 99, 235, .46)';
  ctx.shadowBlur = 7;
  ctx.fillStyle = 'rgba(255, 255, 255, .98)';
  ctx.strokeStyle = 'rgba(37, 99, 235, .88)';
  ctx.lineWidth = 1.45;
  ctx.fill(path);
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
  const anchor = selectionAnchor || lastPointer || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const x = Math.min(window.innerWidth - 590, Math.max(18, anchor.x + 40));
  const y = Math.min(window.innerHeight - 180, Math.max(18, anchor.y + 48));
  result.style.left = `${x}px`;
  result.style.top = `${y}px`;
  if (payload.ok === null) {
    result.innerHTML = `<div class="title">Thinking</div><div class="muted">${payload.status || 'Processing...'}</div>`;
  } else if (payload.ok) {
    const answer = String(payload.answer || '').slice(0, 1600);
    result.innerHTML = `<div class="title">${escapeHtml(payload.prompt || 'Result')}</div>${escapeHtml(answer)}`;
  } else {
    result.innerHTML = `<div class="title">Bridge error</div><div class="muted">${escapeHtml(payload.error || 'Unknown error')}</div>`;
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
  fadeRaf = null;
  pill.classList.add('hidden');
  result.classList.add('hidden');
  result.textContent = '';
  commandInput.value = '';
  hint.classList.remove('dim');
  clear();
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
  render();
});

window.addEventListener('pointermove', (e) => {
  if (captureMode) return;
  if (!drawing) {
    lastPointer = { x: e.clientX, y: e.clientY, t: performance.now() };
    render();
    return;
  }
  addPoint(e);
  render();
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

window.magicPointer?.onShow(() => resetOverlay());
window.magicPointer?.onHide(() => resetOverlay());
window.magicPointer?.onResult((payload) => {
  requestSeq += 1;
  submitting = false;
  showResult(payload);
});

resize();
