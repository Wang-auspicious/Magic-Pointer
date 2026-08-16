/* Magic Pointer Studio: real data renderers mounted inside the shared Oreo shell. */

/* ---- DSH 主题引导：默认跟随系统（deepseek-harness boot-theme.ts 同款行为），
   设置里改了主题后由 settings.ts 同步 body[data-ds-dark-theme]。 ---- */
(function bootTheme() {
  const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.style.colorScheme = systemDark ? 'dark' : 'light';
  document.body.toggleAttribute('data-ds-dark-theme', systemDark);
})();

/* ---- 确定性哈希 ---- */
function hash(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed: unknown) {
  let s = hash(String(seed)) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

function objectMark(seed: unknown) {
  const label = String(seed || 'MP').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || 'MP';
  return `<span class="object-mark">${esc(label)}</span>`;
}

/* ---- 缩略图占位：暖调抽象，不是灰块 ---- */
function makeShot(seed: unknown) {
  const r = rng('shot' + String(seed));
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

function icon(id: string, cls = '') {
  return `<svg class="${cls}"><use href="#${id}"/></svg>`;
}

const KIND_TAG: Record<string, string> = { 灵感:'tag-indigo', 交接:'tag-teal', 凭证:'tag-amber', 素材:'tag-teal', 片段:'tag-amber' };

/* ---- 布局：簇内按行打包，簇之间在世界坐标里松散排布 ---- */
const PAD = 24, GAP = 16, CLUSTER_GAP = 48, ROW_MAX = 420;

// 收藏箱顶部的分类 tab。上一版点击只切 is-on 样式，内容一动没动——filter
// 永远为空，等于按钮是假的。这里记下选中的分类，renderStash 按它过滤。
let stashKindFilter = '';

// 画布上摆过的收藏节点：Data.stash() 的条目加上布局坐标。
interface StashBurstNode {
  t: string; w?: number; h?: number; desc?: string; src?: string; text?: string; media?: string; summary?: string;
  imageW?: number; imageH?: number;
  x: number; y: number;
}
interface LaidBurst extends MagicPointerStashEntry {
  nodes: StashBurstNode[];
  w: number; h: number;
  cx?: number; cy?: number;
}

function layoutBurst(b: MagicPointerStashEntry): LaidBurst {
  let x = PAD, y = PAD + 8, rowH = 0, w = 0;
  const placed: StashBurstNode[] = b.items.map(it => {
    const imageW = it.t === 'shot' ? Math.max(220, Math.min(300, Number(it.w) || 240)) : 240;
    const imageH = it.t === 'shot' ? Math.max(130, Math.min(210, Number(it.h) || 160)) : 0;
    const summaryHeight = it.summary ? 66 : 0;
    const iw = imageW;
    // 只有截图有说明行（+34）。文字节点不渲染 desc，给它 +34 只是把行高凭空
    // 撑高 14px，簇之间因此出现来路不明的空隙。上一版写成
    // `it.desc || it.t === 'shot' ? 34 : 20`，|| 把三元整体绑错。
    const ih = (it.t === 'shot' ? imageH + 34 + summaryHeight : 82);
    if (x > PAD && x + iw > ROW_MAX) { x = PAD; y += rowH + GAP; rowH = 0; }
    const node = { ...it, x, y, w: iw, h: ih, imageW, imageH };
    x += iw + GAP; rowH = Math.max(rowH, ih); w = Math.max(w, x - GAP + PAD);
    return node;
  });
  return { ...b, nodes: placed, w, h: y + rowH + PAD };
}

async function renderStash(force = false) {
  const world = document.getElementById('canvas-world');
  if (!world || (world.childElementCount && !force)) return;

  const all = await Data.stash();
  const bursts = stashKindFilter ? all.filter(b => b.kind === stashKindFilter) : all;
  document.getElementById('stash-count')!.textContent =
    bursts.reduce((n, b) => n + b.items.length, 0) + ' 项';
  if (!bursts.length) {
    world.innerHTML = stashKindFilter
      ? `<span class="canvas-empty">这个分类里还没有收藏。</span>`
      : '<span class="canvas-empty">收藏箱还是空的。截个图，或者复制一张图片，它就会落到这里。</span>';
    renderStashList([], force);
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
        ? `<span class="node-shot" style="width:${n.imageW}px;height:${n.imageH}px;${n.src ? `background-image:url('file:///${cssUrl(n.src)}');background-size:cover;background-position:center` : `background-image:${makeShot(n.desc)}`}"></span>
           <span class="node-desc">${esc(n.desc)}</span>
           ${n.summary ? `<span class="node-summary">${esc(n.summary)}</span>` : ''}`
        : `<span class="node-note">${esc(n.text)}</span>`;
      return `<span class="node" data-src="${esc(n.src || '')}" data-text="${esc(n.text || '')}" data-summary="${esc(n.summary || '')}" style="left:${(b.cx as number) + n.x}px;top:${(b.cy as number) + n.y}px;width:${n.w}px;height:${n.h}px">
        <span class="node-cap">${icon(b.icon)}${esc(b.time)}<span class="kind ${KIND_TAG[b.kind] || ''}">${esc(b.kind)}</span></span>
        ${body}
      </span>`;
    }).join('');
    return `<span class="cluster" style="left:${(b.cx as number) - PAD}px;top:${(b.cy as number) - 6}px;width:${b.w}px;height:${b.h}px">
        <span class="cluster-label">${icon('ic-stash')}${esc(b.title)} · ${b.items.length}</span>
      </span>${nodes}`;
  }).join('');

  world.dataset.width = String(maxW + 60);
  world.dataset.height = String(cy + colH + 60);
  renderStashList(laid, force);
  resetCanvas();
}

function renderStashList(laid: LaidBurst[], force = false) {
  const list = document.getElementById('stash-list');
  if (!list || (list.childElementCount && !force)) return;
  const byTime: Record<string, LaidBurst[]> = {};
  laid.forEach(b => { (byTime[/[今昨前]|月/.test(b.time) ? b.time : '今天'] ||= []).push(b); });
  list.innerHTML = Object.entries(byTime).map(([day, bs]) =>
    `<div class="stash-day">${day}<em>· ${bs.reduce((n, b) => n + b.items.length, 0)} 项</em></div>` +
    bs.map(b => b.items.map(it => `<button class="stash-row" data-src="${esc(it.src || '')}" data-text="${esc(it.text || '')}">
        <span class="sq" style="${it.src && /\.(png|jpe?g|gif|webp|bmp)$/i.test(it.src) ? `background-image:url('file:///${cssUrl(it.src)}');background-size:cover;background-position:center` : `background-image:${it.t === 'shot' ? makeShot(it.desc) : 'none'}`}"></span>
        <span class="txt">${esc(it.desc || it.text)}</span>
        <span class="src">${esc(b.app)}</span>
        <span class="kind ${KIND_TAG[b.kind] || ''}">${esc(b.kind)}</span>
        <span class="t">${esc(b.time)}</span>
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
function resetCanvas() {
  cam = { x: 54, y: 54, k: 1 };
  applyCam();
}
function fitCanvas() {
  const cv = document.getElementById('canvas'), w = document.getElementById('canvas-world');
  if (!cv || !w) return;
  const ww = Number(w.dataset.width) || 1200, wh = Number(w.dataset.height) || 800;
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
  let drag: { x: number; y: number } | null = null;
  cv.addEventListener('pointerdown', e => {
    const target = e.target as Element | null;
    if (target && target.closest('.canvas-rail, .canvas-zoom, .node')) return;
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

async function renderTimeline(force = false) {
  const tl = document.getElementById('tl');
  if (!tl || (tl.childElementCount && !force)) return;
  const days = await Data.timeline();
  if (!days.length) {
    tl.innerHTML = '<div class="tl-inner"><div class="view-empty">还没有记录。划一笔问点什么，这里就会长出来。</div></div>';
    return;
  }
  tl.innerHTML = '<div class="tl-inner">' + days.map((d) => {
    const items = (d.items || []) as TimelineConversation[];
    return `<div class="tl-day">${dayLabel(d.at || items[0]?.updatedAt)}</div>` + items.map((c, i) =>
      `<button class="tl-row enter" data-open="${c.id}" style="animation-delay:${Math.min(i, 6) * 40}ms">
        <span class="tl-rail">${objectMark(c.objectKey || c.id)}<span class="line"></span></span>
        <span class="tl-body">
          <span class="q">${esc(c.title)}</span>
          <span class="src">${icon('ic-window')}${esc(c.subtitle || '')}</span>
          <span class="out">${(c.outcomes || []).map((t) => `<span class="pill">${esc(t)}</span>`).join('')}
            ${Number(c.turns) > 1 ? `<span class="pill">${c.turns} 轮</span>` : ''}</span>
        </span>
        <span class="tl-time">${formatTime(c.updatedAt)}</span>
      </button>`).join('');
  }).join('') + '</div>';
}

interface TimelineConversation {
  id?: string;
  title?: string;
  subtitle?: string;
  objectKey?: string;
  outcomes?: string[];
  turns?: number;
  updatedAt?: number;
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
  const active = host.querySelector('.is-on')?.getAttribute('data-open');
  host.innerHTML = list.slice(0, 12).map((c) => `
    <button class="side-item${c.id === active ? ' is-on' : ''}" data-open="${esc(c.id)}">
      ${objectMark(c.objectKey || c.id)}
      <span class="side-text"><b>${esc(c.title)}</b><small>${esc(c.subtitle || '')}</small></span>
    </button>`).join('');
}

/* DSH StatsLine（输入框下统计）：只用真实数据 —— 轮数 + 步骤数。
   没有 token/上下文占用的数据源之前不显示假数字。 */
function renderStatsLine(turns: MagicPointerTurn[]) {
  const host = document.getElementById('stats-line');
  if (!host) return;
  const steps = turns.reduce((n, t) => n + (t.trace || []).length, 0);
  const groups: string[] = [];
  if (turns.length > 0) groups.push(`${turns.length} 轮`);
  if (steps > 0) groups.push(`${steps} 步`);
  host.textContent = groups.join(' · ');
}

/* ---- 打开一条对话 ---- */
let activeConversationId: string | null = null;
/* cardId → DSH 回合节点：后台任务补丁就地换节点，不重建整条流 */
const dshCardNodes = new Map<string, HTMLElement>();

async function openConversation(id: string) {
  const c = await Data.conversation(id);
  if (!c) return;
  activeConversationId = c.id;
  show('chat');
  document.querySelectorAll('#side-convos .side-item').forEach((n) =>
    (n as HTMLElement).classList.toggle('is-on', (n as HTMLElement).dataset.open === id));

  const head = document.getElementById('chat-title');
  if (head) head.textContent = String(c.title);
  const org = document.getElementById('chat-origin');
  const orgText = document.getElementById('chat-origin-text');
  const peek = document.getElementById('chat-peek');
  const peekImage = document.getElementById('peek-image') as HTMLImageElement | null;
  const peekLabel = document.getElementById('peek-label');
  if (org && orgText) {
    org.hidden = false;
    orgText.textContent = [c.object?.app, c.object?.windowTitle, c.object?.label]
      .filter(Boolean).join(' · ') || '当前选区';
  }
  if (peek && peekImage) {
    const imgPath = c.object?.annotatedPath || '';
    if (imgPath) {
      // 划线时标注过的区域截图：主进程把本地路径经 IPC 给出来，渲染层转成
      // file:// 预览。没有这张图就整个藏掉，绝不放一张裂图。
      peekImage.onerror = () => { peek.hidden = true; };
      peekImage.src = 'file:///' + String(imgPath).replace(/\\/g, '/');
      peek.hidden = false;
      if (peekLabel) peekLabel.textContent = c.object?.label || '选区预览';
    } else {
      peek.hidden = true;
      peekImage.removeAttribute('src');
    }
  }

  const stream = document.getElementById('stream');
  if (!stream) return;
  LiveCards.reset();   // 换了一条对话，旧卡的计时器不该继续陪着跑
  dshCardNodes.clear();
  const turns = c.turns || [];
  if (!turns.length) {
    stream.innerHTML = '<div class="view-empty">这条还没有内容。</div>';
    return;
  }
  // 工作室的一轮问答用 DSH 聊天模型渲染（100% 移植 deepseek-harness）：
  // 用户消息 = 右侧 DeepSeek 蓝气泡（r22 + 时钟/复制动作行）；助手 = 正文 +
  // Think 思考行 + 工具调用行（24px 行骨架、IN/OUT 卡、状态点）。
  const flow = document.createElement('div');
  flow.className = 'dsh-flow';
  for (const t of turns) {
    if (t.question) flow.appendChild(DshChat.userNode(String(t.question), t.at));
    const host = document.createElement('div');
    host.className = 'dsh-flow-item';
    for (const node of DshChat.assistantTurnNode({
      answer: t.answer,
      thinking: t.thinking,
      trace: t.trace,
      events: t.events,
      failed: t.failed,
      at: t.at,
    })) host.appendChild(node);
    flow.appendChild(host);
    // 后台任务补丁按舞台同款 cardId 就地落到这个节点：登记代理卡，
    // 补丁来了 replaceWith 重画，不重建整条流。
    const proxy = LiveCards.track(CardModel.normalizeCard({
      id: `${t.at || 0}-a`,
      kind: 'prose',
      state: t.failed ? 'failed' : 'done',
      answer: t.answer || '',
      error: t.failed ? (t.answer || '这次没能完成。') : '',
      steps: (t.trace || []).map((x) => (typeof x === 'string'
        ? { label: x, state: 'done' }
        : { label: x.label, note: x.note || '', state: 'done' })),
    }));
    dshCardNodes.set(proxy.id, host);
  }
  stream.replaceChildren(flow);
  stream.scrollTop = stream.scrollHeight;
  DshChat.bindDelegation(stream);
  renderStatsLine(turns);
  lastAnswerText = (turns[turns.length - 1]?.answer || '').trim();
}

/* 代理卡 → DSH 节点：后台任务补丁（进度/步骤/终态）就地换掉那一轮。 */
function renderDshCardNode(card: MagicPointerCard): HTMLElement {
  const host = document.createElement('div');
  host.className = 'dsh-assistant';
  host.setAttribute('data-dsh-time-root', 'true');
  for (const node of DshChat.assistantTurnNode({
    answer: card.answer,
    failed: card.state === 'failed',
    running: card.state === 'running',
    trace: (card.steps || []).map((x) => (typeof x === 'string'
      ? x
      : { label: String((x as { label?: unknown }).label || ''), note: String((x as { note?: unknown }).note || '') })),
    at: card.startedAt ?? undefined,
  })) host.appendChild(node);
  return host;
}

/* ---- 记忆：反复被指到的对象 ---- */
interface MemoryEntry {
  key?: string;
  subtitle?: string;
  touches?: number;
  lastAt?: number;
  questions?: string[];
  object?: { app?: string; windowTitle?: string; label?: string };
}
async function renderMemory(force = false) {
  const host = document.getElementById('mem-list');
  if (!host || (host.childElementCount && !force)) return;
  const list = (await Data.memories()) as MemoryEntry[];
  if (!list.length) {
    host.innerHTML = '<div class="view-empty">还没有记忆。同一个东西被问过两次以上，它才会记住。</div>';
    return;
  }
  host.innerHTML = list.map((m, i) => `<article class="mem-row enter" style="animation-delay:${Math.min(i,6)*40}ms">
    ${objectMark(m.key)}
    <span class="mem-body">
      <b>${esc(m.object?.windowTitle || m.object?.app || m.key)}</b>
      <small>${esc(m.subtitle || '')}</small>
      <span class="mem-qs">${(m.questions || []).slice(0, 3).map((q) => `<span>${esc(q)}</span>`).join('')}</span>
    </span>
    <span class="mem-n">${m.touches} 次</span>
    <span class="tl-time">${formatTime(m.lastAt)}</span>
  </article>`).join('');
}

/* ---- 产物 ---- */
interface ArtifactEntry {
  name?: string;
  from?: string;
  at?: number;
  conversationId?: string;
}
async function renderArtifacts(force = false) {
  const host = document.getElementById('art-list');
  if (!host || (host.childElementCount && !force)) return;
  const list = (await Data.artifacts()) as ArtifactEntry[];
  if (!list.length) {
    host.innerHTML = '<div class="view-empty">还没有产物。它写出来的东西会存在这里。</div>';
    return;
  }
  host.innerHTML = list.map((a, i) => `<button class="card artifact enter" data-open="${esc(a.conversationId)}"
      style="animation-delay:${Math.min(i,6)*40}ms">
    <span class="tile">${icon('ic-code')}</span>
    <span class="side-text"><span class="name">${esc(a.name)}</span>
      <span class="meta">${formatTime(a.at)} · 来自「${esc(a.from || '')}」</span></span>
  </button>`).join('');
}

function esc(v: unknown) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 本地路径进 CSS url('...')：反斜杠换正斜杠，再转义掉能截断字符串的引号。
// 文件名是用户剪贴板/收藏目录来的，不能假设它干净。
function cssUrl(v: unknown) {
  return String(v == null ? '' : v).replace(/\\/g, '/').replace(/'/g, '%27').replace(/"/g, '%22');
}

/* ============================================================
   交互
   ============================================================ */

const shell = document.getElementById('shell') as HTMLElement;
const aux = document.getElementById('aux') as HTMLElement;
let lastNonSettingsView = 'chat';
const studioShell = globalThis.StudioShell;
const VIEWS: Record<string, string> = Object.fromEntries(
  studioShell.STUDIO_VIEWS.map((view: { id: string }) => [view.id, `view-${view.id}`]),
);

function show(view: string) {
  const current = studioShell.shellState(view);
  view = current.activeView;
  shell.dataset.view = view;
  document.getElementById('workspace-eyebrow')!.textContent = current.eyebrow;
  document.getElementById('workspace-title')!.textContent = current.title;
  document.getElementById('workspace-description')!.textContent = current.description;
  if (view !== 'settings') lastNonSettingsView = view;
  Object.entries(VIEWS).forEach(([k, id]) => {
    document.getElementById(id)!.hidden = (k !== view);
  });
  document.querySelectorAll<HTMLElement>('[data-goto]').forEach((item) => {
    item.classList.toggle('is-on', item.dataset.goto === view);
  });
  if (view === 'stash') { renderStash(true); bindCanvas(); }
  if (view === 'timeline') renderTimeline();
  if (view === 'memory') renderMemory();
  if (view === 'artifacts') renderArtifacts();
  if (view === 'settings') renderSettings();
  if (view !== 'chat') closeAux();
}

function openAux() { aux.hidden = false; shell.classList.add('has-aux'); }
function closeAux() { shell.classList.remove('has-aux'); setTimeout(() => { aux.hidden = true; }, 240); }

document.addEventListener('click', e => {
  const target = e.target as Element | null;
  if (!target) return;
  if (target.closest('[data-settings-close]')) { show(lastNonSettingsView); return; }

  /* 作曲家 `+` 扩展菜单：真实动作（复制最近回答 / 查看来源），点击外部关闭 */
  const addBtn = target.closest<HTMLElement>('#composer-add');
  const addMenu = document.getElementById('composer-add-menu');
  if (addBtn) {
    if (addMenu) {
      const willShow = addMenu.hidden;
      addMenu.hidden = !willShow;
      addBtn.setAttribute('aria-expanded', String(willShow));
    }
    return;
  }
  const composerAct = target.closest<HTMLElement>('[data-composer-act]');
  if (composerAct) {
    if (addMenu) addMenu.hidden = true;
    document.getElementById('composer-add')?.setAttribute('aria-expanded', 'false');
    const act = composerAct.getAttribute('data-composer-act');
    if (act === 'copy-last' && lastAnswerText) {
      void (navigator.clipboard?.writeText(lastAnswerText) || Promise.resolve());
    } else if (act === 'origin') {
      const peek = document.getElementById('chat-peek');
      if (peek) peek.hidden = false;
    }
    return;
  }
  if (addMenu && !addMenu.hidden && !target.closest('#composer-add-menu')) {
    addMenu.hidden = true;
    document.getElementById('composer-add')?.setAttribute('aria-expanded', 'false');
  }

  const open = target.closest<HTMLElement>('[data-open]');
  if (open && open.dataset.open) { openConversation(open.dataset.open); return; }

  // 收藏箱图片节点：左键 → 放大查看；查看窗里可复制图片
  const imgNode = target.closest<HTMLElement>('.node[data-src], .stash-row[data-src]');
  if (imgNode && imgNode.dataset.src && /\.(png|jpe?g|gif|webp|bmp)$/i.test(imgNode.dataset.src)) {
    openStashViewer(imgNode.dataset.src, imgNode.dataset.text || '');
    e.stopPropagation();
    return;
  }

  // 收藏箱文字节点：点击在「一行摘要」和「全文展开」之间切换
  const note = target.closest<HTMLElement>('.node[data-text] .node-note, .stash-row .txt');
  if (note) {
    note.classList.toggle('is-open');
    e.stopPropagation();
    return;
  }

  const goto = target.closest<HTMLElement>('[data-goto]');
  if (goto) { show(goto.dataset.goto || ''); return; }

  if (target.closest('[data-open-artifact]')) { openAux(); return; }
  if (target.closest('#aux-close')) { closeAux(); return; }

  const tab = target.closest<HTMLElement>('.tab');
  if (tab) {
    tab.parentElement!.querySelectorAll('.tab').forEach(t => t.classList.remove('is-on'));
    tab.classList.add('is-on');
    // 分类 tab 不只是高亮自己：收藏箱真的按这个分类过滤。
    stashKindFilter = tab.dataset.kind || '';
    renderStash(true);
    return;
  }
  const mode = target.closest<HTMLElement>('#stash-mode button');
  if (mode) {
    mode.parentElement!.querySelectorAll('button').forEach(b => b.classList.remove('is-on'));
    mode.classList.add('is-on');
    const canvas = mode.dataset.mode === 'canvas';
    document.getElementById('canvas')!.hidden = !canvas;
    document.getElementById('stash-list')!.hidden = canvas;
    if (canvas) fitCanvas();
    return;
  }
  const seg = target.closest<HTMLElement>('.seg-toggle button');
  if (seg) {
    seg.parentElement!.querySelectorAll('button').forEach(b => b.classList.remove('is-on'));
    seg.classList.add('is-on');
    return;
  }
  const notice = target.closest<HTMLElement>('.notice .close');
  if (notice) notice.closest('.notice')!.remove();
});

let studioComposerBusy = false;
let lastAnswerText = '';
/* DSH 输入卡：textarea 随内容长高，14 行封顶（336px，InputBar 同款上限） */
function fitComposer(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(336, ta.scrollHeight)}px`;
}

/* 模型切换器：挂真实当前模型（settings:get 的 modelStatus.displayName） */
async function refreshComposerModel() {
  const sel = document.getElementById('composer-model') as HTMLSelectElement | null;
  if (!sel) return;
  try {
    const api = window.magicPointerDashboard;
    const response = api?.getFabricSettings ? await api.getFabricSettings() : null;
    const name = (response as { modelStatus?: { displayName?: unknown } } | null)?.modelStatus?.displayName;
    const label = name ? String(name) : '默认模型';
    sel.replaceChildren(new Option(label, label));
  } catch {
    sel.replaceChildren(new Option('默认模型', ''));
  }
}

document.querySelectorAll('form.dshw-input-form').forEach(form => {
  const ta = form.querySelector<HTMLTextAreaElement>('textarea');
  if (ta) {
    fitComposer(ta);
    ta.addEventListener('input', () => fitComposer(ta));
    /* Enter 发送 / Shift+Enter 换行；中文输入法组合态不误触发送
       （deepseek-harness InputBar 同款分派：组合态与 Shift 直接放行换行）。 */
    ta.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      (form as HTMLFormElement).requestSubmit();
    });
  }
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const textarea = form.querySelector<HTMLTextAreaElement>('textarea');
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const question = textarea?.value.trim() || '';
    if (!textarea || !question || studioComposerBusy) {
      textarea?.focus();
      return;
    }

    const stream = document.getElementById('stream');
    if (!stream) return;
    let flow = stream.querySelector<HTMLElement>('.dsh-flow');
    if (!flow) {
      flow = document.createElement('div');
      flow.className = 'dsh-flow';
      stream.replaceChildren(...(stream.querySelector('.dshw-blank, .view-empty') ? [] : [...stream.children]), flow);
    }
    flow.appendChild(DshChat.userNode(question));
    const pending = document.createElement('div');
    pending.className = 'dsh-assistant';
    pending.setAttribute('data-dsh-time-root', 'true');
    const pendingBody = document.createElement('div');
    pendingBody.className = 'dsh-assistant-body';
    pendingBody.appendChild(DshChat.turnStatusNode('Thinking'));
    pending.appendChild(pendingBody);
    flow.appendChild(pending);
    stream.scrollTop = stream.scrollHeight;

    textarea.value = '';
    fitComposer(textarea);
    studioComposerBusy = true;
    form.setAttribute('aria-busy', 'true');
    if (submit) submit.disabled = true;
    try {
      const permission = document.getElementById('composer-permission') as HTMLSelectElement | null;
      const response = await Data.sendConversation(
        activeConversationId,
        question,
        permission?.value || 'default',
      );
      if (!response?.ok || !response.conversationId) throw new Error(response?.error || '这次没有答完。');
      activeConversationId = String(response.conversationId);
      await openConversation(activeConversationId);
      await renderSidebar();
    } catch (error) {
      pending.replaceChildren(DshChat.turnErrorNode(error instanceof Error ? error.message : String(error)));
      textarea.value = question;
      fitComposer(textarea);
    } finally {
      studioComposerBusy = false;
      form.removeAttribute('aria-busy');
      if (submit) submit.disabled = false;
      textarea.focus();
    }
  });
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
async function boot(initialView: string) {
  await renderSidebar();
  void refreshComposerModel();
  if (initialView !== 'chat') {
    show(initialView);
    return;
  }
  const list = await Data.conversations();
  if (shell.dataset.view !== 'chat') return;
  if (list.length) await openConversation(list[0].id);
  else startNewChat();
}

/* 新对话：清空当前这一屏，把焦点交回输入框。
   不新建记录——记录在第一次真的问出去之后才产生。 */
function startNewChat() {
  activeConversationId = null;
  document.querySelectorAll('#side-convos .side-item').forEach((n) => n.classList.remove('is-on'));
  const title = document.getElementById('chat-title');
  if (title) title.textContent = '新对话';
  const org = document.getElementById('chat-origin');
  if (org) { org.hidden = true; }
  const peek = document.getElementById('chat-peek');
  if (peek) { peek.hidden = true; }
  const stream = document.getElementById('stream');
  if (stream) {
    stream.innerHTML = Data.isLive()
      ? `<div class="dshw-blank">
           <p>晃动鼠标，或者划过一段文字。</p>
           <p class="sub">它会出现在指针旁边，这里同步显示。</p>
         </div>`
      : `<div class="dshw-blank"><p>还没有对话。</p>
           <p class="sub">在 Electron 里运行时，这里显示的是真实记录。</p></div>`;
  }
  renderStatsLine([]);
  document.querySelector<HTMLTextAreaElement>('.dshw-input')?.focus();
}

document.getElementById('new-chat')?.addEventListener('click', startNewChat);

/* ============================================================
   收藏箱：悬停图片 1 秒 → 视觉模型摘要浮层
   ------------------------------------------------------------
   一次性传很多图时，光看缩略图没法找。停一秒，本地视觉模型给
   三到四句话，知道它是什么。摘要按条目缓存，不重复调模型。
   ============================================================ */
const stashSummaryCache = new Map<string, string>();
let stashHoverTimer: ReturnType<typeof setTimeout> | null = null;
let stashHoverTarget: HTMLElement | null = null;

function stashSummaryEl() {
  let el = document.getElementById('stash-summary');
  if (!el) {
    el = document.createElement('div');
    el.id = 'stash-summary';
    el.className = 'stash-summary';
    document.body.appendChild(el);
  }
  return el;
}

/* ---- 收藏图片大图查看窗：左键放大 + 复制图片 ---- */
function openStashViewer(src: string, desc: string) {
  let viewer = document.getElementById('stash-viewer');
  if (!viewer) {
    viewer = document.createElement('div');
    viewer.id = 'stash-viewer';
    viewer.className = 'stash-viewer';
    viewer.innerHTML = `
      <div class="stash-viewer-card">
        <div class="stash-viewer-head">
          <b class="stash-viewer-title"></b>
          <span class="stash-viewer-actions">
            <button type="button" class="icon-btn is-plain" id="stash-viewer-copy" title="复制图片"><svg><use href="#ic-clip"/></svg></button>
            <button type="button" class="icon-btn is-plain" id="stash-viewer-close" title="关闭"><svg><use href="#ic-x"/></svg></button>
          </span>
        </div>
        <img class="stash-viewer-img" alt="" />
      </div>`;
    document.body.appendChild(viewer);
    viewer.addEventListener('click', (ev) => {
      if (ev.target === viewer) closeStashViewer();
    });
    viewer.querySelector('#stash-viewer-close')!.addEventListener('click', closeStashViewer);
    viewer.querySelector('#stash-viewer-copy')!.addEventListener('click', () => {
      const img = viewer!.querySelector('.stash-viewer-img') as HTMLImageElement | null;
      if (!img || !img.src) return;
      // 把本地图片复制进剪贴板（保留位图，图片编辑器可直接粘贴）
      fetch(img.src).then((r) => r.blob()).then((blob) => {
        navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      }).catch(() => { /* 剪贴板不可用时静默 */ });
    });
  }
  const img = viewer.querySelector('.stash-viewer-img') as HTMLImageElement;
  img.src = 'file:///' + String(src).replace(/\\/g, '/');
  img.alt = desc || '';
  viewer.querySelector('.stash-viewer-title')!.textContent = desc || '收藏图片';
  viewer.classList.add('is-visible');
}

function closeStashViewer() {
  const viewer = document.getElementById('stash-viewer');
  if (viewer) viewer.classList.remove('is-visible');
}

document.addEventListener('mouseover', (e) => {
  const node = (e.target as Element | null)?.closest<HTMLElement>('.node[data-src], .stash-row[data-src]');
  if (!node || node === stashHoverTarget) return;
  if (stashHoverTimer) clearTimeout(stashHoverTimer);
  stashHoverTarget = node;
  const src = node.dataset.src || '';
  if (!src || !/\.(png|jpe?g|gif|webp|bmp)$/i.test(src)) return;
  stashHoverTimer = setTimeout(async () => {
    const el = stashSummaryEl();
    const rect = node.getBoundingClientRect();
    el.style.left = `${Math.min(rect.left, window.innerWidth - 340)}px`;
    el.style.top = `${rect.bottom + 10}px`;
    el.textContent = '正在看这张图…';
    el.classList.add('is-visible');
    // 入库时已自动生成过简介就直接用，不用再等模型
    if (node.dataset.summary) {
      el.textContent = node.dataset.summary;
      return;
    }
    if (stashSummaryCache.has(src)) {
      el.textContent = String(stashSummaryCache.get(src));
      return;
    }
    const summary = await Data.describeStashImage(src);
    if (!summary) {
      el.textContent = '';
      el.classList.remove('is-visible');
      return;
    }
    stashSummaryCache.set(src, summary);
    if (stashHoverTarget === node) el.textContent = summary;
  }, 1000);
});

document.addEventListener('mouseout', (e) => {
  if (!(e.target as Element | null)?.closest('.node[data-src], .stash-row[data-src]')) return;
  if (stashHoverTimer) clearTimeout(stashHoverTimer);
  stashHoverTarget = null;
  const el = document.getElementById('stash-summary');
  if (el) el.classList.remove('is-visible');
});

const initialView = studioShell.normalizeView(new URLSearchParams(location.search).get('view'));
void boot(initialView);

// 新的一轮问答落库之后，侧栏、时间线、记忆、产物都要跟着变，
// 不然工作室永远停在打开那一刻。
Data.onChange(() => {
  renderSidebar();
  renderTimeline(true);
  renderMemory(true);
  renderArtifacts(true);
  refreshStashSummaries();
});

// 收藏箱条目更新（新采集、自动简介生成）时：只更新简介文本，
// 不重绘画布（保住用户的平移/缩放状态）。
function refreshStashSummaries() {
  const world = document.getElementById('canvas-world');
  if (!world) return;
  Data.stash().then((bursts) => {
    const bySrc = new Map();
    for (const b of bursts) {
      for (const it of b.items) {
        if (it.src && it.summary) bySrc.set(it.src, it.summary);
      }
    }
    world.querySelectorAll('.node[data-src]').forEach((node) => {
      const nodeEl = node as HTMLElement;
      const summary = bySrc.get(nodeEl.dataset.src!);
      if (!summary) return;
      if (nodeEl.dataset.summary === summary) return;
      nodeEl.dataset.summary = summary;
      let el = node.querySelector('.node-summary') as HTMLElement | null;
      if (!el) {
        el = document.createElement('span');
        el.className = 'node-summary';
        nodeEl.appendChild(el);
      }
      el.textContent = summary;
    });
  }).catch(() => {});
}

/* 主进程可以直接指定落到哪一屏（托盘「设置…」走这条） */
window.magicPointerDashboard?.onShow?.((payload) => {
  if (payload?.view) show(String(payload.view));
});

/* 后台任务的进度。三个界面收到的是同一份补丁，所以同一次出图
   在哪个窗口看都是同一个进度。工作室的 DSH 回合节点按同款 cardId
   登记在 LiveCards，补丁落地时就地 replaceWith 重画那一轮。 */
if (window.magicPointerDashboard?.onCardPatch) {
  window.magicPointerDashboard.onCardPatch((payload) => {
    if (!payload?.cardId) return;
    const updated = LiveCards.patch(payload.cardId, payload.patch || {});
    const host = dshCardNodes.get(payload.cardId);
    if (host && updated) {
      const replacement = renderDshCardNode(updated);
      host.replaceWith(replacement);
      dshCardNodes.set(payload.cardId, replacement);
    }
  });
}
