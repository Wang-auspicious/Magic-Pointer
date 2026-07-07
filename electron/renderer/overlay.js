const canvas = document.getElementById('trail');
const ctx = canvas.getContext('2d');
const pill = document.getElementById('pill');
const hint = document.getElementById('hint');

let dpr = window.devicePixelRatio || 1;
let drawing = false;
let points = [];
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
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
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

  // Reference-like stack: broad glow, blue body, white hot core.
  stroke(54, 'rgba(147, 197, 253, 0.20)', 34);
  stroke(34, 'rgba(96, 165, 250, 0.36)', 24);
  stroke(18, 'rgba(37, 99, 235, 0.68)', 14);
  stroke(5, 'rgba(248, 251, 255, 0.92)', 5);

  ctx.restore();
}

function drawPointer(p) {
  if (!p) return;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(-0.18);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(35, 15);
  ctx.lineTo(17, 22);
  ctx.lineTo(26, 47);
  ctx.lineTo(12, 52);
  ctx.lineTo(4, 25);
  ctx.lineTo(0, 0);
  ctx.closePath();
  ctx.shadowColor = 'rgba(37, 99, 235, .82)';
  ctx.shadowBlur = 22;
  ctx.fillStyle = 'rgba(255, 255, 255, .96)';
  ctx.strokeStyle = 'rgba(37, 99, 235, .98)';
  ctx.lineWidth = 3;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function render() {
  clear();
  if (points.length) drawSmoothPath(points, 1);
  drawPointer(lastPointer);
}

function showPill() {
  if (!lastPointer) return;
  const x = Math.min(window.innerWidth - 430, Math.max(18, lastPointer.x + 56));
  const y = Math.min(window.innerHeight - 100, Math.max(18, lastPointer.y - 34));
  pill.style.left = `${x}px`;
  pill.style.top = `${y}px`;
  pill.classList.remove('hidden');
}

function resetOverlay() {
  points = [];
  lastPointer = null;
  pill.classList.add('hidden');
  hint.classList.remove('dim');
  clear();
}

window.addEventListener('resize', resize);
window.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (fadeRaf) cancelAnimationFrame(fadeRaf);
  drawing = true;
  points = [];
  pill.classList.add('hidden');
  hint.classList.add('dim');
  addPoint(e);
  render();
});

window.addEventListener('pointermove', (e) => {
  if (!drawing) {
    lastPointer = { x: e.clientX, y: e.clientY, t: performance.now() };
    clear();
    drawPointer(lastPointer);
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
  showPill();
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  window.magicPointer?.done({
    points,
    bbox: {
      x1: Math.min(...xs),
      y1: Math.min(...ys),
      x2: Math.max(...xs),
      y2: Math.max(...ys),
    },
  });
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.magicPointer?.hide();
  if (e.key.toLowerCase() === 'r') resetOverlay();
});

pill.addEventListener('click', (e) => {
  const action = e.target?.dataset?.action;
  if (!action) return;
  window.magicPointer?.done({ action, points });
});

window.magicPointer?.onShow(() => resetOverlay());
window.magicPointer?.onHide(() => resetOverlay());

resize();
