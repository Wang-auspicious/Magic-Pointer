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
//
// 常驻跟随模式（guideFollow）：唤醒后三角一直跟在蓝边光标旁——像
// clicky 的伴侣一样住在光标旁边。右键一次本次会话关闭，下次唤醒
// 又出现。有 [POINT] 时优先飞行指向，飞完回到跟随。
let guideTarget = null;        // { x, y } 指点目标（overlay 局部坐标）
let guideFlight = null;        // { t, from, to, ctrl, startedAt, duration }
let guideHideTimer = null;     // 到达后停留定时器
let guideFollow = true;        // 常驻跟随（右键关闭，唤醒重置）
const GUIDE_FLIGHT_MS = 620;

// 跟随弹簧：源码 clicky 用 SwiftUI .spring(response:0.2, dampingFraction:0.6)
// 追光标，我们等价的临界阻尼弹簧——ω = 2π/0.2 ≈ 31.4，k = ω²，c = 2·0.6·ω。
// 硬跟（每帧直接贴目标）会「跳」，弹簧才有 clicky 那种粘着光标又滑过去的
// 质感。鼠标停住后弹簧收敛（位移+速度都小），循环自己停，不空转。
const GUIDE_SPRING_K = 986;
const GUIDE_SPRING_C = 38;
const GUIDE_SPRING_EPS = 0.6;  // 收敛阈值（px / px·s⁻¹）
let guideSpring = { x: 0, y: 0, vx: 0, vy: 0, has: false };
let guideLoopRaf = null;
let lastGuideTick = 0;

function onGuidePoint(payload) {
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
  // 跟随模式：唤醒后常驻（右键关闭）。无跟随且无目标时不画。
  if (!guideFollow && !guideTarget) return;
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
    // 到达目标点：停留 2.5 秒后回到跟随。停留期间弹簧同步到目标点，
    // 这样结束时从「当前位置」平滑回跟光标，不会从老位置飞回来。
    guideFlight = null;
    px = guideTarget.x;
    py = guideTarget.y;
    guideSpring.x = px;
    guideSpring.y = py;
    guideSpring.vx = 0;
    guideSpring.vy = 0;
    guideSpring.has = true;
    if (!guideHideTimer) {
      guideHideTimer = setTimeout(() => {
        guideHideTimer = null;
        guideTarget = null;
        ensureGuideFollowLoop();
        render();
      }, 2500);
    }
  } else if (guideFollow && lastPointer) {
    // 常驻跟随：蓝边光标右下方 35/25px（clicky 的落位），弹簧逼近——
    // 首帧直接落位，之后每帧向目标弹簧插值（见 ensureGuideFollowLoop）。
    const tx = lastPointer.x + 35;
    const ty = lastPointer.y + 25;
    if (!guideSpring.has) {
      guideSpring = { x: tx, y: ty, vx: 0, vy: 0, has: true };
    }
    px = guideSpring.x;
    py = guideSpring.y;
    ensureGuideFollowLoop();
  } else {
    return;
  }
  ctx.save();
  ctx.translate(px, py);
  // clicky 源码的 BlueCursorView 三角：等边三角形，边长 16，旋转 -35°
  // （像光标一样朝左上方），纯蓝填充 + 同色外发光。源码注释说得很清楚：
  // 三角常驻视图树、opacity 交叉淡入（绝不 remove/re-insert，否则闪现）。
  // 我们没有 SwiftUI 的常驻视图，用预渲染离屏 canvas 缓存三角位图
  // （旋转在预渲染时做掉），每帧 drawImage——避免每帧重算 path + shadow。
  ensureGuideFrames();
  ctx.drawImage(guideFrames[0], -guideFrameSize / 2, -guideFrameSize / 2);
  ctx.restore();
}

// ── 预渲染三角位图（等边三角形，源码同款）─────────────────────────
let guideFrames = [];
let guideFrameSize = 0;

// 跟随弹簧循环：每帧向 (光标+35/25) 弹簧插值并重绘；收敛或失去跟随
// 条件（目标消失/右键关闭）时自停。onCursor 每次移动都会重启它。
function ensureGuideFollowLoop() {
  if (guideLoopRaf || !guideFollow || guideTarget) return;
  const step = (now) => {
    guideLoopRaf = null;
    if (!guideFollow || guideTarget || !guideSpring.has || !lastPointer) {
      guideSpring.has = false;
      return;
    }
    const dt = lastGuideTick ? Math.min(0.05, (now - lastGuideTick) / 1000) : 1 / 60;
    lastGuideTick = now;
    const tx = lastPointer.x + 35;
    const ty = lastPointer.y + 25;
    // 半隐式欧拉：先速度后位移，阻尼稳定
    guideSpring.vx += (GUIDE_SPRING_K * (tx - guideSpring.x) - GUIDE_SPRING_C * guideSpring.vx) * dt;
    guideSpring.vy += (GUIDE_SPRING_K * (ty - guideSpring.y) - GUIDE_SPRING_C * guideSpring.vy) * dt;
    guideSpring.x += guideSpring.vx * dt;
    guideSpring.y += guideSpring.vy * dt;
    const dx = tx - guideSpring.x;
    const dy = ty - guideSpring.y;
    render();
    if (Math.abs(dx) > GUIDE_SPRING_EPS || Math.abs(dy) > GUIDE_SPRING_EPS
      || Math.abs(guideSpring.vx) > GUIDE_SPRING_EPS || Math.abs(guideSpring.vy) > GUIDE_SPRING_EPS) {
      guideLoopRaf = requestAnimationFrame(step);
    } else {
      // 收敛：位置落定，循环自停（画布保留最终帧，不闪）
      guideSpring.vx = 0;
      guideSpring.vy = 0;
    }
  };
  guideLoopRaf = requestAnimationFrame(step);
}

function ensureGuideFrames() {
  if (guideFrames.length) return;
  // 离屏 4x 渲染（64px 画布，16px 三角 + 光晕余量），再缩到 48px 位图。
  // 等边三角形：边长 16，高 = 16 × √3/2 ≈ 13.86（源码 Triangle shape 同款）。
  const size = 64;
  guideFrameSize = size;
  const off = document.createElement('canvas');
  off.width = size;
  off.height = size;
  const g = off.getContext('2d');
  g.save();
  g.translate(size / 2, size / 2);
  // 旋转 -35°：像光标一样朝左上方（源码 triangleRotationDegrees = -35）
  g.rotate((-35 * Math.PI) / 180);
  // 等边三角，边长 16px——源码 BlueCursorView 的原尺寸
  const edge = 16;
  const height = edge * Math.sqrt(3) / 2;
  // 顶点朝上：顶 y = -高×2/3，底 y = +高×1/3（源码比例）
  g.fillStyle = '#2477e8';
  g.shadowColor = '#2477e8';
  // 光晕克制：源码 16px 三角配 radius 8；22px 三角该配 ~11，但大光晕
  // 会把小三角糊成一团（之前 12 就糊成胶囊了），收到 5 保留锐利边缘
  g.shadowBlur = 5;
  g.beginPath();
  g.moveTo(0, -height * (2 / 3));
  g.lineTo(-edge / 2, height / 3);
  g.lineTo(edge / 2, height / 3);
  g.closePath();
  g.fill();
  g.restore();
  // 缩到 48px（三角 16px + 光晕 32px 余量）
  const final = document.createElement('canvas');
  final.width = 48;
  final.height = 48;
  const fg = final.getContext('2d');
  fg.drawImage(off, 0, 0, 48, 48);
  guideFrames = [final];
  // 绘制偏移用最终位图尺寸，不是大画布尺寸
  guideFrameSize = 48;
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

function drawHitTestPixel(p) {
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
      // Keep the transparent window hit-testable without painting a second
      // cursor over the preloaded CSS cursor (armed-cursor.png).
      drawHitTestPixel(lastPointer);
    }
    // 唤醒后常驻跟随的三角（gesture 模式下也画——划线时伴侣不消失）
    drawGuideTriangle();
    return;
  }
  if (!captureMode && points.length) drawSmoothPath(points, trailAlpha);
  // 不画 canvas 鼠标——光标由 CSS armed-cursor（用户满意版原样）。
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
  guideTarget = null;
  guideFlight = null;
  guideSpring.has = false;
  guideSpring.vx = 0;
  guideSpring.vy = 0;
  if (guideHideTimer) clearTimeout(guideHideTimer);
  guideHideTimer = null;
  // 每次唤醒（onShow→resetOverlay）常驻跟随重新开启；右键可关。
  guideFollow = true;
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
  if (e.button === 2) {
    // 右键一次：本次会话关闭常驻跟随三角（下次唤醒又出现）
    guideFollow = false;
    guideTarget = null;
    guideFlight = null;
    guideSpring.has = false;
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
  if (gestureMode) return;
  lastPointer = { x: Number(payload.x) || 0, y: Number(payload.y) || 0, t: performance.now() };
  // 鼠标一动，跟随弹簧立刻重新跑起来（循环收敛自停）
  if (guideFollow && !guideTarget) ensureGuideFollowLoop();
  scheduleRender();
});
window.magicPointer?.onGuidePoint?.((payload) => {
  onGuidePoint(payload);
  // 飞行是持续动画（620ms），不是一帧——持续 rAF 直到到达/超时，
  // 否则三角只在起点闪一帧就消失。
  function guideTick() {
    render();
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
