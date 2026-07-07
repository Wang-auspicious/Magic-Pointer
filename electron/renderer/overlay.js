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
let fadeRaf = null;

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
  if (path.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  function stroke(width, color, blur = 0) {
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length - 1; i++) {
      const midX = (path[i].x + path[i + 1].x) / 2;
      const midY = (path[i].y + path[i + 1].y) / 2;
      ctx.quadraticCurveTo(path[i].x, path[i].y, midX, midY);
    }
    const end = path[path.length - 1];
    ctx.lineTo(end.x, end.y);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.stroke();
  }

  // Softer Gemini-like trail: fewer hard layers, more glow falloff.
  ctx.globalCompositeOperation = 'lighter';
  stroke(42, 'rgba(96, 165, 250, 0.11)', 28);
  stroke(30, 'rgba(96, 165, 250, 0.16)', 20);
  stroke(18, 'rgba(59, 130, 246, 0.28)', 12);
  stroke(7, 'rgba(37, 99, 235, 0.62)', 7);
  stroke(2.2, 'rgba(210, 231, 255, 0.88)', 2);
  ctx.globalCompositeOperation = 'source-over';

  ctx.restore();
}

function drawPointer(p) {
  if (!p) return;
  ctx.save();
  ctx.translate(p.x - 1, p.y - 1);
  ctx.rotate(-0.08);

  // Smooth 32px-class cursor. Tip is at (0,0); body extends down-right like
  // the native cursor, with a complete closed outline and subtle glow.
  const path = new Path2D();
  path.moveTo(0, 0);
  path.quadraticCurveTo(1.5, 0.4, 3.2, 1.3);
  path.lineTo(24, 13.2);
  path.quadraticCurveTo(27.4, 15.1, 26.2, 17.4);
  path.quadraticCurveTo(25.5, 18.6, 23.7, 18.9);
  path.lineTo(14.6, 20.4);
  path.lineTo(20.2, 31.2);
  path.quadraticCurveTo(21.1, 33.0, 19.2, 34.0);
  path.lineTo(13.0, 37.0);
  path.quadraticCurveTo(11.0, 37.9, 10.2, 35.8);
  path.lineTo(4.9, 22.6);
  path.lineTo(0.5, 27.0);
  path.quadraticCurveTo(-1.3, 28.8, -2.0, 26.2);
  path.lineTo(-2.2, 2.4);
  path.quadraticCurveTo(-2.1, -0.4, 0, 0);
  path.closePath();

  ctx.shadowColor = 'rgba(37, 99, 235, .56)';
  ctx.shadowBlur = 10;
  ctx.fillStyle = 'rgba(255, 255, 255, .98)';
  ctx.strokeStyle = 'rgba(37, 99, 235, .92)';
  ctx.lineWidth = 1.8;
  ctx.fill(path);
  ctx.stroke(path);
  ctx.restore();
}

function render() {
  clear();
  if (points.length) drawSmoothPath(points, 1);
  drawPointer(lastPointer);
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
  };
}

function showPill() {
  if (!lastPointer) return;
  const x = Math.min(window.innerWidth - 438, Math.max(18, lastPointer.x + 34));
  const y = Math.min(window.innerHeight - 64, Math.max(18, lastPointer.y - 20));
  pill.style.left = `${x}px`;
  pill.style.top = `${y}px`;
  pill.classList.remove('hidden');
  commandInput.value = '';
  commandInput.focus();
}

function runSelectedCommand(action = 'command') {
  if (!selectedPayload) return;
  const command = commandInput.value.trim();
  window.magicPointer?.done({
    ...selectedPayload,
    action,
    command,
  });
}

function showResult(payload) {
  if (!payload) return;
  const anchor = lastPointer || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
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
  drawing = true;
  points = [];
  selectedPayload = null;
  pill.classList.add('hidden');
  result.classList.add('hidden');
  hint.classList.add('dim');
  addPoint(e);
  render();
});

window.addEventListener('pointermove', (e) => {
  if (!drawing) {
    lastPointer = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (!selectedPayload) {
      clear();
      drawPointer(lastPointer);
    }
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
    showPill();
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.magicPointer?.hide();
  if (e.key.toLowerCase() === 'r') resetOverlay();
  if (e.key === 'Enter' && !pill.classList.contains('hidden')) runSelectedCommand('command');
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
window.magicPointer?.onResult((payload) => showResult(payload));

resize();
