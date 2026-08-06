/* ============================================================
   工作室 Studio
   ------------------------------------------------------------
   头像/球：这里是本地占位实现，接口对齐 @oreo-design/avatar。
   装了包之后把 makeOrb 换成：
     import { createAvatar } from "@oreo-design/avatar";
     const makeOrb = (seed, size) =>
       createAvatar({ shape: "bloom", palette: "rose-milk",
                      variantId: seed, drift: 8, size }).svg;
   ============================================================ */

/* ---- 确定性哈希 ---- */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed) {
  let s = hash(String(seed)) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

function makeOrb(seed, size = 64) {
  const r = rng(seed);
  // 色相对：黄绿 ↔ 青蓝 那一段最耐看；由种子在这个区间里取一对，
  // 中间再插一个过渡色，所以三段之间没有硬边。
  const h1 = 68 + Math.floor(r() * 32);            // 68–100  黄绿
  const h3 = 178 + Math.floor(r() * 38);           // 178–216 青蓝
  const h2 = Math.round((h1 + h3) / 2);            // 中间色
  const A = `hsl(${h1} 62% 68%)`;
  const M = `hsl(${h2} 56% 66%)`;
  const B = `hsl(${h3} 60% 66%)`;
  const id = 'o' + hash(seed).toString(36);
  const dur = (7 + r() * 5).toFixed(1);            // 7–12s，一屏里不齐步走

  // 渐变轴：从右下角指向左上角，色带因此平行于反对角线。
  // 跨度取两倍并让色序首尾同色，平移整整一个周期就能无缝循环。
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="${id}g" x1="1.5" y1="1.5" x2="-0.5" y2="-0.5">
        <stop offset="0"    stop-color="${A}"/>
        <stop offset="0.17" stop-color="${M}"/>
        <stop offset="0.33" stop-color="${B}"/>
        <stop offset="0.50" stop-color="${M}"/>
        <stop offset="0.67" stop-color="${A}"/>
        <stop offset="0.83" stop-color="${M}"/>
        <stop offset="1"    stop-color="${B}"/>
        <animateTransform attributeName="gradientTransform" type="translate"
          values="0 0; -0.667 -0.667" dur="${dur}s" repeatCount="indefinite"/>
      </linearGradient>
      <radialGradient id="${id}s" cx="50%" cy="50%" r="52%">
        <stop offset="0"   stop-color="#fff" stop-opacity=".34"/>
        <stop offset="0.55" stop-color="#fff" stop-opacity=".10"/>
        <stop offset="1"   stop-color="#fff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <circle cx="32" cy="32" r="32" fill="url(#${id}g)"/>
    <circle cx="32" cy="32" r="32" fill="url(#${id}s)"/>
  </svg>`;
}

/* ---- 缩略图占位：暖调抽象，不是灰块 ---- */
function makeShot(seed) {
  const r = rng('shot' + seed);
  const h = Math.floor(r() * 360);
  const a = `hsl(${h} 26% 84%)`;
  const b = `hsl(${(h + 26) % 360} 20% 73%)`;
  const c = `hsl(${(h + 52) % 360} 16% 63%)`;
  return `radial-gradient(72% 60% at ${20 + r() * 40}% ${16 + r() * 30}%, ${a}, transparent 68%),`
       + `radial-gradient(64% 56% at ${52 + r() * 34}% ${58 + r() * 30}%, ${c}, transparent 66%),`
       + `linear-gradient(${Math.floor(r() * 360)}deg, ${a}, ${b})`;
}

/* ============================================================
   数据
   ============================================================ */

/* ============================================================
   渲染
   ============================================================ */

function icon(id, cls = '') {
  return `<svg class="${cls}"><use href="#${id}"/></svg>`;
}

function renderOrbs() {
  document.querySelectorAll('.orb[data-seed]').forEach(el => {
    if (!el.childElementCount) el.innerHTML = makeOrb(el.dataset.seed, 64);
  });
  ['hero-avatar', 'side-avatar'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.childElementCount) el.innerHTML = makeOrb('zjz65', 64);
  });
}

const KIND_TAG = { 灵感:'tag-indigo', 交接:'tag-teal', 凭证:'tag-amber', 素材:'tag-teal', 片段:'tag-amber' };

/* ---- 布局：簇内按行打包，簇之间在世界坐标里松散排布 ---- */
const PAD = 24, GAP = 16, CLUSTER_GAP = 48, ROW_MAX = 420;

function layoutBurst(b) {
  let x = PAD, y = PAD + 8, rowH = 0, w = 0;
  const placed = b.items.map(it => {
    const iw = it.t === 'shot' ? it.w : 210;
    const ih = (it.t === 'shot' ? it.h : 62) + (it.desc || it.t === 'shot' ? 34 : 20);
    if (x > PAD && x + iw > ROW_MAX) { x = PAD; y += rowH + GAP; rowH = 0; }
    const node = { ...it, x, y, w: iw, h: ih };
    x += iw + GAP; rowH = Math.max(rowH, ih); w = Math.max(w, x - GAP + PAD);
    return node;
  });
  return { ...b, nodes: placed, w, h: y + rowH + PAD };
}

async function renderStash() {
  const world = document.getElementById('canvas-world');
  if (!world || world.childElementCount) return;

  const bursts = await Data.stash();
  document.getElementById('stash-count').textContent =
    bursts.reduce((n, b) => n + b.items.length, 0) + ' 项';
  if (!bursts.length) {
    world.innerHTML = '<span class="canvas-empty">收藏箱还是空的。截个图，或者复制一张图片，它就会落到这里。</span>';
    return;
  }
  const laid = bursts.map(layoutBurst);
  let cx = 60, cy = 60, colH = 0, maxW = 0;
  laid.forEach(b => {
    if (cx > 60 && cx + b.w > 1560) { cx = 60; cy += colH + CLUSTER_GAP; colH = 0; }
    b.cx = cx; b.cy = cy;
    cx += b.w + CLUSTER_GAP; colH = Math.max(colH, b.h); maxW = Math.max(maxW, cx);
  });

  world.innerHTML = laid.map(b => {
    const nodes = b.nodes.map(n => {
      const body = n.t === 'shot'
        ? `<span class="node-shot" style="width:${n.w}px;height:${n.h - 34}px;background-image:${makeShot(n.desc)}"></span>
           <span class="node-desc">${n.desc}</span>`
        : `<span class="node-note">${n.text}</span>`;
      return `<span class="node" style="left:${b.cx + n.x}px;top:${b.cy + n.y}px">
        <span class="node-cap">${icon(b.icon)}${b.time}<span class="kind ${KIND_TAG[b.kind]}">${b.kind}</span></span>
        ${body}
      </span>`;
    }).join('');
    return `<span class="cluster" style="left:${b.cx - PAD}px;top:${b.cy - 6}px;width:${b.w}px;height:${b.h}px">
        <span class="cluster-label">${icon('ic-stash')}${b.title} · ${b.items.length}</span>
      </span>${nodes}`;
  }).join('');

  world.dataset.width = maxW + 60;
  world.dataset.height = cy + colH + 60;
  renderStashList(laid);
  fitCanvas();
}

function renderStashList(laid) {
  const list = document.getElementById('stash-list');
  if (!list || list.childElementCount) return;
  const byTime = {};
  laid.forEach(b => { (byTime[/[今昨前]|月/.test(b.time) ? b.time : '今天'] ||= []).push(b); });
  list.innerHTML = Object.entries(byTime).map(([day, bs]) =>
    `<div class="stash-day">${day}<em>· ${bs.reduce((n, b) => n + b.items.length, 0)} 项</em></div>` +
    bs.map(b => b.items.map(it => `<button class="stash-row">
        <span class="sq" style="background-image:${it.t === 'shot' ? makeShot(it.desc) : 'none'}"></span>
        <span class="txt">${it.desc || it.text}</span>
        <span class="src">${b.app}</span>
        <span class="kind ${KIND_TAG[b.kind]}">${b.kind}</span>
        <span class="t">${b.time}</span>
      </button>`).join('')).join('')
  ).join('');
}

/* ---- 平移与缩放 ---- */
let cam = { x: 0, y: 0, k: 1 };
function applyCam() {
  const w = document.getElementById('canvas-world');
  if (!w) return;
  w.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`;
  const cv = document.getElementById('canvas');
  if (cv) cv.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
  if (cv) cv.style.backgroundSize = `${22 * cam.k}px ${22 * cam.k}px`;
  const zv = document.getElementById('zoom-val');
  if (zv) zv.textContent = Math.round(cam.k * 100) + '%';
}
function fitCanvas() {
  const cv = document.getElementById('canvas'), w = document.getElementById('canvas-world');
  if (!cv || !w) return;
  const ww = +w.dataset.width || 1200, wh = +w.dataset.height || 800;
  const r = cv.getBoundingClientRect();
  // 以宽度为准，别缩得太小；高度不够就靠拖动看
  cam.k = Math.max(.62, Math.min(1, (r.width - 130) / ww));
  cam.x = Math.max(78, (r.width - ww * cam.k) / 2);
  cam.y = Math.max(20, (r.height - wh * cam.k) / 2);
  applyCam();
}
function bindCanvas() {
  const cv = document.getElementById('canvas');
  if (!cv || cv.dataset.bound) return;
  cv.dataset.bound = '1';
  let drag = null;
  cv.addEventListener('pointerdown', e => {
    if (e.target.closest('.canvas-rail, .canvas-zoom, .node')) return;
    drag = { x: e.clientX - cam.x, y: e.clientY - cam.y };
    cv.classList.add('is-panning');
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', e => {
    if (!drag) return;
    cam.x = e.clientX - drag.x; cam.y = e.clientY - drag.y; applyCam();
  });
  cv.addEventListener('pointerup', () => { drag = null; cv.classList.remove('is-panning'); });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = Math.max(.25, Math.min(2.4, cam.k * (e.deltaY < 0 ? 1.11 : 0.9)));
    cam.x = mx - (mx - cam.x) * (k / cam.k);
    cam.y = my - (my - cam.y) * (k / cam.k);
    cam.k = k; applyCam();
  }, { passive: false });
  document.getElementById('canvas-fit')?.addEventListener('click', fitCanvas);
  document.getElementById('zoom-in')?.addEventListener('click', () => { cam.k = Math.min(2.4, cam.k * 1.2); applyCam(); });
  document.getElementById('zoom-out')?.addEventListener('click', () => { cam.k = Math.max(.25, cam.k / 1.2); applyCam(); });
}

async function renderTimeline(force) {
  const tl = document.getElementById('tl');
  if (!tl || (tl.childElementCount && !force)) return;
  const days = await Data.timeline();
  if (!days.length) {
    tl.innerHTML = '<div class="tl-inner"><div class="view-empty">还没有记录。划一笔问点什么，这里就会长出来。</div></div>';
    return;
  }
  tl.innerHTML = '<div class="tl-inner">' + days.map((d) =>
    `<div class="tl-day">${dayLabel(d.at || d.items[0]?.updatedAt)}</div>` + d.items.map((c, i) =>
      `<button class="tl-row enter" data-open="${c.id}" style="animation-delay:${Math.min(i, 6) * 40}ms">
        <span class="tl-rail"><span class="orb">${makeOrb(c.objectKey || c.id, 64)}</span><span class="line"></span></span>
        <span class="tl-body">
          <span class="q">${esc(c.title)}</span>
          <span class="src">${icon('ic-window')}${esc(c.subtitle || '')}</span>
          <span class="out">${(c.outcomes || []).map((t) => `<span class="pill">${esc(t)}</span>`).join('')}
            ${c.turns > 1 ? `<span class="pill">${c.turns} 轮</span>` : ''}</span>
        </span>
        <span class="tl-time">${formatTime(c.updatedAt)}</span>
      </button>`).join('')).join('') + '</div>';
}

/* ---- 侧栏：今天的对话，从真实记录来 ---- */
async function renderSidebar() {
  const host = document.getElementById('side-convos');
  if (!host) return;
  const list = await Data.conversations();
  if (!list.length) {
    host.innerHTML = '<div class="side-empty">还没有对话</div>';
    return;
  }
  const active = host.querySelector('.is-on')?.dataset.open;
  host.innerHTML = list.slice(0, 12).map((c) => `
    <button class="side-item${c.id === active ? ' is-on' : ''}" data-open="${c.id}">
      <span class="orb">${makeOrb(c.objectKey || c.id, 64)}</span>
      <span class="side-text"><b>${esc(c.title)}</b><small>${esc(c.subtitle || '')}</small></span>
    </button>`).join('');
}

/* ---- 打开一条对话 ---- */
async function openConversation(id) {
  const c = await Data.conversation(id);
  if (!c) return;
  show('chat');
  document.querySelectorAll('#side-convos .side-item').forEach((n) =>
    n.classList.toggle('is-on', n.dataset.open === id));

  const head = document.getElementById('chat-title');
  if (head) head.textContent = c.title;
  const org = document.getElementById('chat-origin');
  if (org) {
    org.hidden = false;
    org.innerHTML = `${icon('ic-code')}${esc(c.object?.app || '')}<i>·</i>${esc(c.object?.windowTitle || '')}`
      + (c.object?.label ? `<i>·</i>${esc(c.object.label)}` : '');
  }

  const stream = document.getElementById('stream');
  if (!stream) return;
  const turns = c.turns || [];
  if (!turns.length) {
    stream.innerHTML = '<div class="view-empty">这条还没有内容。</div>';
    return;
  }
  stream.innerHTML = turns.map((t) => `
    <div class="msg-user enter">${esc(t.question)}</div>
    <div class="turn enter">
      ${(t.trace || []).length ? `<div class="trace">${t.trace.map((x) =>
        `<div class="trace-line">${icon('ic-check')}${esc(x.label || x)}</div>`).join('')}</div>` : ''}
      <div class="msg-ai">${esc(t.answer).split('\n').map((x) => `<p>${x}</p>`).join('')}</div>
      ${(t.facts || []).length ? `<div class="card facts">
        <div class="facts-head">${icon('ic-check')}已确认<span class="count">${t.facts.length} 项</span></div>
        ${t.facts.map((f) => `<div class="fact-row">${icon('ic-file')}<span class="label">${esc(f.label)}</span>
          <span class="value">${esc(f.value)}</span></div>`).join('')}
      </div>` : ''}
      ${(t.artifacts || []).map((art) => `<button class="card artifact" data-open-artifact>
        <span class="tile">${icon('ic-code')}</span>
        <span class="side-text"><span class="name">${esc(art.name)}</span>
        <span class="meta">${formatTime(t.at)}</span></span></button>`).join('')}
    </div>`).join('');
  stream.scrollTop = stream.scrollHeight;
}

/* ---- 记忆：反复被指到的对象 ---- */
async function renderMemory(force) {
  const host = document.getElementById('mem-list');
  if (!host || (host.childElementCount && !force)) return;
  const list = await Data.memories();
  if (!list.length) {
    host.innerHTML = '<div class="view-empty">还没有记忆。同一个东西被问过两次以上，它才会记住。</div>';
    return;
  }
  host.innerHTML = list.map((m, i) => `<button class="mem-row enter" style="animation-delay:${Math.min(i,6)*40}ms">
    <span class="orb">${makeOrb(m.key, 64)}</span>
    <span class="mem-body">
      <b>${esc(m.object?.windowTitle || m.object?.app || m.key)}</b>
      <small>${esc(m.subtitle || '')}</small>
      <span class="mem-qs">${(m.questions || []).slice(0, 3).map((q) => `<span>${esc(q)}</span>`).join('')}</span>
    </span>
    <span class="mem-n">${m.touches} 次</span>
    <span class="tl-time">${formatTime(m.lastAt)}</span>
  </button>`).join('');
}

/* ---- 产物 ---- */
async function renderArtifacts(force) {
  const host = document.getElementById('art-list');
  if (!host || (host.childElementCount && !force)) return;
  const list = await Data.artifacts();
  if (!list.length) {
    host.innerHTML = '<div class="view-empty">还没有产物。它写出来的东西会存在这里。</div>';
    return;
  }
  host.innerHTML = list.map((a, i) => `<button class="card artifact enter" data-open="${a.conversationId}"
      style="animation-delay:${Math.min(i,6)*40}ms">
    <span class="tile">${icon('ic-code')}</span>
    <span class="side-text"><span class="name">${esc(a.name)}</span>
      <span class="meta">${formatTime(a.at)} · 来自「${esc(a.from || '')}」</span></span>
  </button>`).join('');
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ============================================================
   交互
   ============================================================ */

const hero = document.getElementById('hero');
const shell = document.getElementById('shell');
const aux = document.getElementById('aux');
const VIEWS = { chat: 'view-chat', stash: 'view-stash', timeline: 'view-timeline',
                memory: 'view-memory', artifacts: 'view-artifacts', settings: 'view-settings' };

function show(view) {
  if (view === 'hero') {
    hero.hidden = false;
    shell.hidden = true;
    return;
  }
  hero.hidden = true;
  shell.hidden = false;
  Object.entries(VIEWS).forEach(([k, id]) => {
    document.getElementById(id).hidden = (k !== view);
  });
  if (view === 'stash') { renderStash(); bindCanvas(); }
  if (view === 'timeline') renderTimeline();
  if (view === 'memory') renderMemory();
  if (view === 'artifacts') renderArtifacts();
  if (view === 'settings') renderSettings();
  if (view !== 'chat') closeAux();
}

function openAux() { aux.hidden = false; shell.classList.add('has-aux'); }
function closeAux() { shell.classList.remove('has-aux'); setTimeout(() => { aux.hidden = true; }, 240); }

document.addEventListener('click', e => {
  const open = e.target.closest('[data-open]');
  if (open && open.dataset.open) { openConversation(open.dataset.open); return; }

  const goto = e.target.closest('[data-goto]');
  if (goto) { show(goto.dataset.goto); return; }

  if (e.target.closest('[data-open-artifact]')) { openAux(); return; }
  if (e.target.closest('#aux-close')) { closeAux(); return; }

  const tab = e.target.closest('.tab');
  if (tab) {
    tab.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('is-on'));
    tab.classList.add('is-on');
    return;
  }
  const mode = e.target.closest('#stash-mode button');
  if (mode) {
    mode.parentElement.querySelectorAll('button').forEach(b => b.classList.remove('is-on'));
    mode.classList.add('is-on');
    const canvas = mode.dataset.mode === 'canvas';
    document.getElementById('canvas').hidden = !canvas;
    document.getElementById('stash-list').hidden = canvas;
    if (canvas) fitCanvas();
    return;
  }
  const seg = e.target.closest('.seg-toggle button');
  if (seg) {
    seg.parentElement.querySelectorAll('button').forEach(b => b.classList.remove('is-on'));
    seg.classList.add('is-on');
    return;
  }
  const notice = e.target.closest('.notice .close');
  if (notice) notice.closest('.notice').remove();
});

/* 输入框随内容长高 */
document.addEventListener('input', e => {
  const ta = e.target.closest('textarea');
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
});

/* Hero 提交 → 进工作态 */
document.getElementById('hero-composer')?.addEventListener('submit', e => {
  e.preventDefault();
  show('chat');
});

/* 进行中卡：演示分段推进 */
(function tickRun() {
  const segs = document.querySelectorAll('#demo-run .seg');
  if (!segs.length) return;
  let n = 3;
  setInterval(() => {
    n = n >= 5 ? 1 : n + 1;
    segs.forEach((s, i) => s.classList.toggle('is-on', i < n));
  }, 2600);
})();

/* 开机：侧栏 + 打开最近那条。
   在此之前 #stream 里是一份静态样例——它只该在没有任何记录时用来占位，
   绝不能在有真实记录时还挂在那儿骗人。 */
async function boot() {
  await renderSidebar();
  const list = await Data.conversations();
  if (list.length) await openConversation(list[0].id);
  else startNewChat();
  renderOrbs();
}

/* 新对话：清空当前这一屏，把焦点交回输入框。
   不新建记录——记录在第一次真的问出去之后才产生。 */
function startNewChat() {
  document.querySelectorAll('#side-convos .side-item').forEach((n) => n.classList.remove('is-on'));
  const title = document.getElementById('chat-title');
  if (title) title.textContent = '新对话';
  const org = document.getElementById('chat-origin');
  if (org) { org.hidden = true; }
  const stream = document.getElementById('stream');
  if (stream) {
    stream.innerHTML = Data.isLive()
      ? `<div class="chat-blank">
           <p>晃动鼠标，或者划过一段文字。</p>
           <p class="sub">它会出现在指针旁边，这里同步显示。</p>
         </div>`
      : `<div class="chat-blank"><p>还没有对话。</p>
           <p class="sub">在 Electron 里运行时，这里显示的是真实记录。</p></div>`;
  }
  document.querySelector('.composer textarea')?.focus();
}

document.getElementById('new-chat')?.addEventListener('click', startNewChat);

boot();

// 新的一轮问答落库之后，侧栏、时间线、记忆、产物都要跟着变，
// 不然工作室永远停在打开那一刻。
Data.onChange(() => {
  renderSidebar();
  renderTimeline(true);
  renderMemory(true);
  renderArtifacts(true);
});

/* 调试用：?view=stash / ?view=timeline / ?view=chat / ?view=settings */
const q = new URLSearchParams(location.search).get('view');
if (q) show(q);

/* 主进程可以直接指定落到哪一屏（托盘「设置…」走这条） */
window.magicPointerDashboard?.onShow?.((payload) => {
  if (payload?.view) show(payload.view);
});
