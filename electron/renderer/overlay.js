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

  // Closer to the reference: the glow is visible, but not a huge marker.
  stroke(32, 'rgba(147, 197, 253, 0.20)', 22);
  stroke(19, 'rgba(96, 165, 250, 0.34)', 15);
  stroke(9, 'rgba(37, 99, 235, 0.72)', 8);
  stroke(2.6, 'rgba(248, 251, 255, 0.94)', 3);

  ctx.restore();
}

function drawPointer(p) {
  if (!p) return;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(-0.10);
  ctx.beginPath();
  // Native cursor on Windows is usually 32x32. This is slightly larger only
  // because of the glow/stroke, not a giant custom cursor.
  ctx.moveTo(0, 0);
  ctx.lineTo(23, 10);
  ctx.lineTo(11, 15);
  ctx.lineTo(17, 32);
  ctx.lineTo(8, 35);
  ctx.lineTo(2, 17);
  ctx.closePath();
  ctx.shadowColor = 'rgba(37, 99, 235, .62)';
  ctx.shadowBlur = 12;
  ctx.fillStyle = 'rgba(255, 255, 255, .98)';
  ctx.strokeStyle = 'rgba(37, 99, 235, .94)';
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
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

window.addEventListener('pointerdown', (e) => {
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
