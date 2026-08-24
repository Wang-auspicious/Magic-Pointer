/* Magic Pointer Studio: real data renderers mounted inside the shared Oreo shell. */

/* ---- DSH Studio 参考图首屏是 dark：先同步落 dark，避免 Electron 的亮色
   标题栏/首帧闪过；设置水合后仍由 settings.ts 接管用户主动选择。 ---- */
(function bootTheme() {
  document.documentElement.style.colorScheme = 'dark';
  document.documentElement.dataset.theme = 'dark';
  document.body.setAttribute('data-ds-dark-theme', '');
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

/* ---- 侧栏：DSH WorkspaceBrowser——按真实来源工作区分组。 ---- */
let sidebarQuery = '';
let sidebarRecentOnly = false;
const expandedWorkspaces = new Map<string, boolean>();
interface SidebarWorkspaceGroup {
  key: string;
  label: string;
  workspaceRoot: string;
  items: MagicPointerConversation[];
}
interface SidebarGroupModule {
  groupConversations(rows: readonly MagicPointerConversation[]): { key: string; label: string; items: MagicPointerConversation[] }[];
  filterConversations(rows: readonly MagicPointerConversation[], query: string): MagicPointerConversation[];
  groupByWorkspace(rows: readonly MagicPointerConversation[]): SidebarWorkspaceGroup[];
}
const sidebarGroups = (globalThis as { SidebarGroups?: SidebarGroupModule }).SidebarGroups!;

function relativeTimeLabel(at: number, now = Date.now()): string {
  const diff = Math.max(0, now - at);
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  if (diff < MIN) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天`;
  if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))} 月`;
  return `${Math.floor(diff / (365 * DAY))} 年`;
}

function conversationNode(c: { id?: string; title?: string; updatedAt?: number }, active?: string): HTMLElement {
  const row = document.createElement('button');
  row.className = 'side-item' + (c.id === active ? ' is-on' : '');
  row.dataset.open = String(c.id || '');
  row.type = 'button';
  // DSH 会话行：状态点 + 标题 + 相对时间（hover 换成省略号动作槽）。
  const dot = document.createElement('span');
  dot.className = 'side-dot';
  dot.setAttribute('aria-hidden', 'true');
  const title = document.createElement('span');
  title.className = 'side-title';
  title.textContent = String(c.title || '未命名对话');
  const time = document.createElement('span');
  time.className = 'side-time';
  time.textContent = c.updatedAt ? relativeTimeLabel(c.updatedAt) : '';
  const actions = document.createElement('span');
  actions.className = 'side-actions';
  const ellipsis = document.createElement('button');
  ellipsis.type = 'button';
  ellipsis.setAttribute('aria-label', '更多');
  ellipsis.innerHTML = icon('dsh-ellipsis');
  actions.appendChild(ellipsis);
  row.append(dot, title, time, actions);
  return row;
}

async function renderSidebar() {
  const host = document.getElementById('side-convos');
  if (!host) return;
  const list = await Data.conversations();
  const active = host.querySelector('.is-on')?.getAttribute('data-open')
    ?? activeConversationId
    ?? list[0]?.id
    ?? undefined;
  const nodes: HTMLElement[] = [];
  let filtered = sidebarGroups.filterConversations(list, sidebarQuery);
  if (sidebarRecentOnly) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    filtered = filtered.filter((conversation) => Number(conversation.updatedAt) >= cutoff);
  }
  // Codex WorkspaceBrowser 语义：组头是线程绑定的真实工作区（文件夹名），
  // 不再拿屏幕 app 名冒充工作区。未绑定的落「默认工作区」。
  const wsGroups = sidebarGroups.groupByWorkspace(filtered as Array<MagicPointerConversation & { workspaceRoot?: string }>);
  const groups = wsGroups.map((g) => ({ key: g.workspaceRoot || '__default__', label: g.label, items: g.items as MagicPointerConversation[] }));
  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'side-empty';
    empty.textContent = list.length ? '没有匹配的对话。' : '还没有对话';
    nodes.push(empty);
  }
  for (const group of groups) {
    const project = document.createElement('section');
    project.className = 'dshw-project';
    const open = expandedWorkspaces.get(group.key) !== false;
    project.classList.toggle('is-active', group.items.some((conversation) => conversation.id === active));
    project.dataset.open = String(open);
    project.dataset.workspace = group.key;
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'dshw-project-row';
    head.dataset.workspaceToggle = group.key;
    head.setAttribute('aria-expanded', String(open));
    const folderIcon = open ? 'ic-dsh-folder-open' : 'ic-dsh-folder-close';
    head.innerHTML = `<span class="dshw-project-slot dshw-project-folder">${icon(folderIcon)}</span><span class="dshw-project-slot dshw-project-chevron">${icon('ic-dsh-triangle-right', open ? 'is-open' : '')}</span><span class="dshw-project-name"></span>`;
    head.querySelector<HTMLElement>('.dshw-project-name')!.textContent = group.label;
    const sessions = document.createElement('div');
    sessions.className = 'dshw-project-sessions';
    for (const c of group.items) sessions.appendChild(conversationNode(c, active));
    project.append(head, sessions);
    nodes.push(project);
  }
  host.replaceChildren(...nodes);
}

function bindSidebarSearch() {
  const browser = document.querySelector<HTMLElement>('.dshw-workspace-browser');
  const input = document.getElementById('side-search') as HTMLInputElement | null;
  const toggle = document.getElementById('side-search-toggle');
  const clear = document.getElementById('side-search-clear') as HTMLButtonElement | null;
  if (!browser || !input || !toggle || !clear) return;

  const setExpanded = (expanded: boolean) => {
    if (expanded) browser.classList.add('is-searching');
    else browser.classList.remove('is-searching');
    toggle.setAttribute('aria-expanded', String(expanded));
    if (expanded) requestAnimationFrame(() => input.focus());
  };
  const syncClear = () => { clear.hidden = input.value.length === 0; };

  toggle.addEventListener('click', () => setExpanded(true));
  clear.addEventListener('click', () => {
    input.value = '';
    sidebarQuery = '';
    syncClear();
    setExpanded(false);
    void renderSidebar();
  });
  input.addEventListener('input', () => {
    sidebarQuery = input.value;
    syncClear();
    void renderSidebar();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (input.value) {
      input.value = '';
      sidebarQuery = '';
      syncClear();
      void renderSidebar();
    }
    setExpanded(false);
  });
}
bindSidebarSearch();

document.getElementById('workspace-add')?.addEventListener('click', () => startNewChat());
document.getElementById('workspace-filter')?.addEventListener('click', (event) => {
  sidebarRecentOnly = !sidebarRecentOnly;
  const button = event.currentTarget as HTMLButtonElement;
  button.classList.toggle('is-on', sidebarRecentOnly);
  button.setAttribute('aria-pressed', String(sidebarRecentOnly));
  button.title = sidebarRecentOnly ? '只看近 7 天（已启用）' : '筛选工作区';
  void renderSidebar();
});

/* DSH StatsLine：只聚合落盘数据，缺的指标不渲染。 */
function renderStatsLine(turns: MagicPointerTurn[]) {
  const host = document.getElementById('stats-line');
  if (!host) return;
  const steps = turns.reduce((n, t) => n + (t.events || []).length +
    (t.activities || []).filter((activity) => activity.kind === 'model').length, 0);
  const modelTimeMs = turns.reduce((total, turn) => total + (turn.activities || [])
    .filter((activity) => activity.kind === 'model')
    .reduce((sum, activity) => sum + (Number(activity.latencyMs) || 0), 0), 0);
  const toolTimeMs = turns.reduce((total, turn) => total + (turn.events || [])
    .reduce((sum, event) => sum + (Number(event.latencyMs) || 0), 0), 0);
  const firstTokenValues = turns.flatMap((turn) => (turn.activities || [])
    .filter((activity) => activity.kind === 'model' && Number(activity.firstTokenMs) > 0)
    .map((activity) => Number(activity.firstTokenMs)));
  const inputTokens = turns.reduce((total, turn) => total + (Number(turn.modelUsage?.inputTokens) || 0), 0);
  const outputTokens = turns.reduce((total, turn) => total + (Number(turn.modelUsage?.outputTokens) || 0), 0);
  const groups: string[] = [];
  if (turns.length > 0) groups.push(`${turns.length} 轮`);
  if (steps > 0) groups.push(`${steps} 步`);
  if (modelTimeMs > 0) groups.push(`LLM ${(modelTimeMs / 1000).toFixed(2)}s`);
  if (toolTimeMs > 0) groups.push(`工具 ${(toolTimeMs / 1000).toFixed(2)}s`);
  if (firstTokenValues.length) groups.push(`TTFT ${Math.round(firstTokenValues.reduce((a, b) => a + b, 0) / firstTokenValues.length)}ms`);
  if (inputTokens || outputTokens) groups.push(`↑ ${inputTokens} · ↓ ${outputTokens} tokens`);
  if (outputTokens && modelTimeMs) groups.push(`${(outputTokens / (modelTimeMs / 1000)).toFixed(1)} tok/s`);
  host.replaceChildren(...groups.flatMap((group, index) => {
    const item = document.createElement('span');
    item.textContent = group;
    if (!index) return [item];
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '|';
    return [sep, item];
  }));
}

/* ---- 打开一条对话 ---- */
let activeConversationId: string | null = null;
let activeConversationTab: 'chat' | 'trajectory' = 'chat';
/* cardId → DSH 回合节点：后台任务补丁就地换节点，不重建整条流 */
const dshCardNodes = new Map<string, HTMLElement>();

function setConversationTab(tab: 'chat' | 'trajectory') {
  activeConversationTab = tab;
  const stream = document.getElementById('stream');
  const trajectory = document.getElementById('trajectory');
  const scrollbody = document.querySelector<HTMLElement>('.dshw-scrollbody');
  if (stream) stream.hidden = tab !== 'chat';
  if (trajectory) trajectory.hidden = tab !== 'trajectory';
  scrollbody?.classList.toggle('is-trajectory', tab === 'trajectory');
  document.querySelectorAll<HTMLElement>('[data-conversation-tab]').forEach((button) => {
    const selected = button.dataset.conversationTab === tab;
    button.classList.toggle('is-on', selected);
    button.setAttribute('aria-selected', String(selected));
  });
}

async function openConversation(id: string) {
  const c = await Data.conversation(id);
  if (!c) return;
  activeConversationId = c.id;
  // Codex thread semantics: switching threads shows that thread's bound
  // workspace on the chip; a thread without one falls back to the profile
  // default (chip shows unspecified).
  composerWorkspace = String((c as { workspaceRoot?: string }).workspaceRoot || '');
  renderWorkspaceChip();
  show('chat');
  document.querySelectorAll('#side-convos .side-item').forEach((n) =>
    (n as HTMLElement).classList.toggle('is-on', (n as HTMLElement).dataset.open === id));

  const head = document.getElementById('chat-title');
  if (head) head.textContent = String(c.title);
  const preview = document.getElementById('chat-source-preview');
  const sourceThumb = document.getElementById('chat-source-thumb') as HTMLImageElement | null;
  const contextTagLabel = document.getElementById('mp-context-tag-label');
  const peek = document.getElementById('chat-peek');
  const peekImage = document.getElementById('peek-image') as HTMLImageElement | null;
  const peekLabel = document.getElementById('peek-label');
  if (contextTagLabel) contextTagLabel.textContent = String(c.object?.app || 'Magic Pointer');
  if (preview && sourceThumb && peek && peekImage) {
    const imgPath = c.object?.annotatedPath || '';
    if (imgPath) {
      // 划线时标注过的区域截图：主进程把本地路径经 IPC 给出来，渲染层转成
      // file:// 预览。没有这张图就整个藏掉，绝不放一张裂图。
      const src = 'file:///' + String(imgPath).replace(/\\/g, '/');
      const hideBrokenPreview = () => { preview.hidden = true; peek.hidden = true; };
      sourceThumb.onerror = hideBrokenPreview;
      peekImage.onerror = hideBrokenPreview;
      sourceThumb.src = src;
      peekImage.src = src;
      preview.hidden = false;
      peek.hidden = false;
      if (peekLabel) peekLabel.textContent = c.object?.label || '选区预览';
    } else {
      preview.hidden = true;
      peek.hidden = true;
      sourceThumb.removeAttribute('src');
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
    renderStatsLine([]);
    const trajectory = document.getElementById('trajectory');
    if (trajectory) trajectory.replaceChildren(DshTrajectory.render([]));
    setConversationTab(activeConversationTab);
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
      activities: t.activities,
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
  const trajectory = document.getElementById('trajectory');
  if (trajectory) trajectory.replaceChildren(DshTrajectory.render(DshTrajectory.project(turns)));
  setConversationTab(activeConversationTab);
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

  /* 权限预设弹层：点外面收起（芯片/行自己的 click 已 stopPropagation） */
  const permMenu = document.getElementById('composer-permission-menu');
  if (permMenu && !permMenu.hidden && !target.closest('#composer-permission-menu')
      && !target.closest('#composer-permission')) {
    closePermissionMenu();
  }

  /* 模型目录弹层：同上 */
  const modelMenu = document.getElementById('composer-model-menu');
  if (modelMenu && !modelMenu.hidden && !target.closest('#composer-model-menu')
      && !target.closest('#composer-model')) {
    closeModelMenu();
  }

  /* 作曲家 `+`：DSH 斜杠目录（命令 + 本机技能），本地过滤，选中插入 `/name ` */
  const addBtn = target.closest<HTMLElement>('#composer-add');
  const addMenu = document.getElementById('composer-add-menu');
  if (addBtn) {
    if (addMenu) {
      const willShow = addMenu.hidden;
      if (willShow) void openSlashMenu();
      else closeSlashMenu();
      addBtn.setAttribute('aria-expanded', String(willShow));
    }
    return;
  }
  if (addMenu && !addMenu.hidden && !target.closest('#composer-add-menu')) {
    closeSlashMenu();
  }

  const projectToggle = target.closest<HTMLElement>('[data-workspace-toggle]');
  if (projectToggle) {
    const key = projectToggle.dataset.workspaceToggle || '';
    const project = projectToggle.closest<HTMLElement>('.dshw-project');
    const open = project?.dataset.open !== 'false';
    expandedWorkspaces.set(key, !open);
    if (project) project.dataset.open = String(!open);
    projectToggle.setAttribute('aria-expanded', String(!open));
    return;
  }

  const conversationTab = target.closest<HTMLElement>('[data-conversation-tab]');
  if (conversationTab) {
    setConversationTab(conversationTab.dataset.conversationTab === 'trajectory' ? 'trajectory' : 'chat');
    return;
  }

  const surfaceButton = target.closest<HTMLElement>('#mp-context-tag');
  const surfaceMenu = document.getElementById('mp-surface-menu-popover');
  if (surfaceButton && surfaceMenu) {
    const showMenu = surfaceMenu.hidden;
    surfaceMenu.hidden = !showMenu;
    surfaceButton.setAttribute('aria-expanded', String(showMenu));
    return;
  }
  if (surfaceMenu && !surfaceMenu.hidden && !target.closest('#mp-surface-menu')) {
    surfaceMenu.hidden = true;
    document.getElementById('mp-context-tag')?.setAttribute('aria-expanded', 'false');
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
  if (goto) {
    if (surfaceMenu) surfaceMenu.hidden = true;
    document.getElementById('mp-context-tag')?.setAttribute('aria-expanded', 'false');
    show(goto.dataset.goto || '');
    return;
  }

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

/* ---- `+` 斜杠目录（DSH input-trigger 菜单：命令 / 技能 两组 + 本地过滤） ---- */
let slashDirectory: MagicPointerSlashDirectory | null = null;
let slashDirectoryLoaded = false;

function closeSlashMenu() {
  const menu = document.getElementById('composer-add-menu');
  document.getElementById('composer-add')?.setAttribute('aria-expanded', 'false');
  if (menu) menu.hidden = true;
}

function slashRow(entry: MagicPointerSlashEntry, group: 'command' | 'skill'): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'dshw-slash-row';
  row.setAttribute('role', 'menuitem');
  row.dataset.slashName = entry.name;
  row.dataset.slashGroup = group;
  const head = document.createElement('span');
  head.className = 'dshw-slash-name';
  const slash = document.createElement('em');
  slash.textContent = `/${entry.name}`;
  head.appendChild(slash);
  const desc = document.createElement('small');
  desc.textContent = entry.description;
  const body = document.createElement('span');
  body.className = 'dshw-slash-text';
  body.append(head, desc);
  row.appendChild(body);
  return row;
}

function renderSlashRows(filter: string) {
  const host = document.getElementById('composer-slash-rows');
  if (!host || !slashDirectory) return;
  const needle = filter.trim().toLowerCase();
  const nodes: HTMLElement[] = [];
  const commands = (slashDirectory.commands || []).filter(e =>
    !needle || e.name.toLowerCase().includes(needle) || e.description.toLowerCase().includes(needle));
  const skills = (slashDirectory.skills || []).filter(e =>
    !needle || e.name.toLowerCase().includes(needle) || e.description.toLowerCase().includes(needle)
    || (e.whenToUse || '').toLowerCase().includes(needle));
  if (commands.length) {
    const head = document.createElement('div');
    head.className = 'dshw-slash-group';
    head.textContent = '命令';
    nodes.push(head, ...commands.map(e => slashRow(e, 'command')));
  }
  if (skills.length) {
    const head = document.createElement('div');
    head.className = 'dshw-slash-group';
    head.textContent = '技能';
    nodes.push(head, ...skills.map(e => slashRow(e, 'skill')));
  }
  if (!nodes.length) {
    const empty = document.createElement('div');
    empty.className = 'dshw-slash-empty';
    empty.textContent = slashDirectoryLoaded ? '没有匹配的命令或技能。' : '目录不可用（本机未接入桥）。';
    nodes.push(empty);
  }
  host.replaceChildren(...nodes);
}

async function openSlashMenu() {
  const menu = document.getElementById('composer-add-menu');
  if (!menu) return;
  if (!slashDirectoryLoaded) {
    const rows = document.getElementById('composer-slash-rows');
    if (rows) rows.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'dshw-slash-empty';
    loading.textContent = '正在加载目录…';
    if (rows) rows.appendChild(loading);
    slashDirectory = await Data.slashDirectory();
    slashDirectoryLoaded = slashDirectory !== null;
  }
  renderSlashRows('');
  menu.hidden = false;
  const search = document.getElementById('composer-slash-search') as HTMLInputElement | null;
  if (search) {
    search.value = '';
    search.focus();
  }
}

function insertSlashToken(name: string) {
  const ta = document.querySelector<HTMLTextAreaElement>('.dshw-input');
  if (!ta) return;
  const token = `/${name} `;
  const caret = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, caret);
  // 光标前已有 / 前缀（连续挑选）就替换掉旧 token，避免 //stack。
  const trimmed = before.replace(/\/[a-z0-9-]*$/i, '');
  ta.value = trimmed + token + ta.value.slice(caret);
  const nextCaret = (trimmed + token).length;
  ta.setSelectionRange(nextCaret, nextCaret);
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function bindSlashMenu() {
  const search = document.getElementById('composer-slash-search');
  search?.addEventListener('input', () => {
    renderSlashRows((search as HTMLInputElement).value);
  });
  search?.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeSlashMenu(); e.stopPropagation(); }
  });
  document.getElementById('composer-add-menu')?.addEventListener('click', e => {
    const row = (e.target as Element | null)?.closest<HTMLElement>('[data-slash-name]');
    if (!row) return;
    e.stopPropagation();
    insertSlashToken(row.dataset.slashName || '');
    closeSlashMenu();
  });
}
bindSlashMenu();

/* ---- 回复风格芯片（caveman 式语量控制：极简/简洁/正常/古典，自选调节） ---- */
let composerStyle = 'normal';
const REPLY_STYLES = [
  { value: 'ultra', label: '极简', description: '短句直说，能省则省；技术细节不丢' },
  { value: 'compact', label: '简洁', description: '去客套铺垫，保留完整句' },
  { value: 'normal', label: '正常', description: '默认回复风格（不带任何指令）' },
  { value: 'terse', label: '干脆', description: '省略口头语，直说结论' },
  { value: 'wenyan', label: '文言', description: '文言文回答，古雅精简' },
] as const;

function styleOption(value: string) {
  return REPLY_STYLES.find(s => s.value === value) || REPLY_STYLES[2];
}

function renderStyleChip() {
  const btn = document.getElementById('composer-style');
  const glyph = document.getElementById('composer-style-glyph');
  const label = document.getElementById('composer-style-label');
  const option = styleOption(composerStyle);
  if (btn instanceof HTMLButtonElement) btn.title = `回复风格：${option.label} — ${option.description}`;
  if (glyph) glyph.textContent = option.value === 'normal' ? '≡' : option.label[0];
  if (label) label.textContent = option.label;
}

function closeStyleMenu() {
  const menu = document.getElementById('composer-style-menu');
  document.getElementById('composer-style')?.setAttribute('aria-expanded', 'false');
  if (menu) menu.hidden = true;
}

function openStyleMenu() {
  const menu = document.getElementById('composer-style-menu');
  if (!menu) return;
  menu.replaceChildren(...REPLY_STYLES.map(option => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'dshw-perm-row' + (option.value === composerStyle ? ' is-active' : '');
    row.setAttribute('role', 'option');
    row.dataset.styleValue = option.value;
    const text = document.createElement('span');
    text.className = 'dshw-perm-row-text';
    const name = document.createElement('span');
    name.textContent = option.label;
    const desc = document.createElement('small');
    desc.textContent = option.description;
    text.append(name, desc);
    row.append(text);
    if (option.value === composerStyle) {
      const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      check.setAttribute('aria-hidden', 'true');
      check.classList.add('dshw-perm-check');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#ic-dsh-check');
      check.appendChild(use);
      row.appendChild(check);
    }
    return row;
  }));
  menu.hidden = false;
  document.getElementById('composer-style')?.setAttribute('aria-expanded', 'true');
}

function bindStyleChip() {
  renderStyleChip();
  document.getElementById('composer-style')?.addEventListener('click', e => {
    e.stopPropagation();
    const menu = document.getElementById('composer-style-menu');
    closePermissionMenu();
    if (menu?.hidden) openStyleMenu();
    else closeStyleMenu();
  });
  document.getElementById('composer-style-menu')?.addEventListener('click', e => {
    const row = (e.target as Element | null)?.closest<HTMLElement>('[data-style-value]');
    if (!row) return;
    e.stopPropagation();
    composerStyle = row.dataset.styleValue || 'normal';
    closeStyleMenu();
    renderStyleChip();
  });
}

/* ---- 权限预设芯片（DSH PermissionSelect 同款：芯片 + 弹层 + Full access 确认门） ---- */
let composerPreset = 'workspace-write';
let composerWorkspace = ''; // '' = 用上次持久化的默认工作区
interface PermPresetOption {
  value: string; name: string; label: string; description: string; glyph: string;
  confirm?: { title: string; description: string };
}
interface PermPresetsModule {
  PRESETS: PermPresetOption[];
  optionOf(value: string): PermPresetOption | undefined;
  presetSvg(option: PermPresetOption): string;
}
const permPresets = (globalThis as { PermissionPresets?: PermPresetsModule }).PermissionPresets!;

function renderPermissionChip() {
  const btn = document.getElementById('composer-permission');
  const glyph = document.getElementById('composer-permission-glyph');
  const label = document.getElementById('composer-permission-label');
  const option = permPresets.optionOf(composerPreset);
  if (btn instanceof HTMLButtonElement) btn.title = option?.description || '';
  if (glyph) glyph.innerHTML = option ? permPresets.presetSvg(option) : '';
  if (label) label.textContent = option?.label || composerPreset;
}

function closePermissionMenu() {
  const menu = document.getElementById('composer-permission-menu');
  document.getElementById('composer-permission')?.setAttribute('aria-expanded', 'false');
  if (menu) menu.hidden = true;
}

function openPermissionMenu() {
  const menu = document.getElementById('composer-permission-menu');
  if (!menu) return;
  menu.replaceChildren(...permPresets.PRESETS.map(option => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'dshw-perm-row' + (option.value === composerPreset ? ' is-active' : '');
    row.setAttribute('role', 'option');
    row.dataset.permValue = option.value;
    row.title = option.description;
    const glyph = document.createElement('span');
    glyph.className = 'dshw-perm-row-glyph';
    glyph.innerHTML = permPresets.presetSvg(option);
    const text = document.createElement('span');
    text.className = 'dshw-perm-row-text';
    const name = document.createElement('span');
    name.textContent = option.label;
    const desc = document.createElement('small');
    desc.textContent = option.description;
    text.append(name, desc);
    row.append(glyph, text);
    if (option.value === composerPreset) {
      const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      check.setAttribute('aria-hidden', 'true');
      check.classList.add('dshw-perm-check');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#ic-dsh-check');
      check.appendChild(use);
      row.appendChild(check);
    }
    return row;
  }));
  menu.hidden = false;
  document.getElementById('composer-permission')?.setAttribute('aria-expanded', 'true');
}

/* Full access 确认门：勾选“已了解风险”才能启用（DSH RiskConfirmation 同款语义） */
function confirmFullAccess() {
  const option = permPresets.PRESETS.find(p => p.value === 'danger-full-access');
  const confirmSpec = option?.confirm;
  if (!confirmSpec) return;
  const overlay = document.createElement('div');
  overlay.className = 'dshw-perm-confirm';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', confirmSpec.title);
  const card = document.createElement('div');
  card.className = 'dshw-perm-confirm-card';
  const title = document.createElement('b');
  title.textContent = confirmSpec.title;
  const desc = document.createElement('p');
  desc.textContent = confirmSpec.description;
  const ackRow = document.createElement('label');
  ackRow.className = 'dshw-perm-confirm-ack';
  const box = document.createElement('input');
  box.type = 'checkbox';
  const ackText = document.createElement('span');
  ackText.textContent = '我已了解风险，并愿意继续';
  ackRow.append(box, ackText);
  const actions = document.createElement('div');
  actions.className = 'dshw-perm-confirm-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => overlay.remove());
  const enable = document.createElement('button');
  enable.type = 'button';
  enable.className = 'is-primary';
  enable.textContent = '启用 Full access';
  enable.disabled = true;
  box.addEventListener('change', () => { enable.disabled = !box.checked; });
  enable.addEventListener('click', () => {
    composerPreset = 'danger-full-access';
    renderPermissionChip();
    overlay.remove();
  });
  actions.append(cancel, enable);
  card.append(title, desc, ackRow, actions);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

function bindPermissionChip() {
  renderPermissionChip();
  document.getElementById('composer-permission')?.addEventListener('click', e => {
    e.stopPropagation();
    const menu = document.getElementById('composer-permission-menu');
    if (menu?.hidden) openPermissionMenu();
    else closePermissionMenu();
  });
  document.getElementById('composer-permission-menu')?.addEventListener('click', e => {
    const row = (e.target as Element | null)?.closest<HTMLElement>('[data-perm-value]');
    if (!row) return;
    e.stopPropagation();
    const value = row.dataset.permValue || '';
    closePermissionMenu();
    if (value === composerPreset) return;
    if (value === 'danger-full-access') { confirmFullAccess(); return; }
    composerPreset = value;
    renderPermissionChip();
  });
}
function renderWorkspaceChip() {
  const label = document.getElementById('composer-workspace-label');
  if (!label) return;
  if (!composerWorkspace) {
    label.textContent = '工作区';
    label.title = '编码工作区：未指定（用上次持久化的默认值，/cwd 可查）。点击选择文件夹';
    return;
  }
  const segments = composerWorkspace.split(/[/]/).filter(Boolean);
  label.textContent = segments[segments.length - 1] || composerWorkspace;
  label.title = `编码工作区：${composerWorkspace}（点击更换）`;
}

/* Codex update_plan 式计划卡：todo_write 实时推送（answer 同款 b64 blob 通道）
   + 终态 result.plan 双通道 */
let composerPlan: { steps: Array<{ content: string; status: string }> } | null = null;
let planCollapsed = false;

function renderPlanCard() {
  const card = document.getElementById('composer-plan');
  if (!card) return;
  const steps = composerPlan?.steps || [];
  if (!steps.length) { card.hidden = true; return; }
  card.hidden = false;
  card.classList.toggle('is-collapsed', planCollapsed);
  const done = steps.filter(s => s.status === 'completed').length;
  const title = document.getElementById('composer-plan-title');
  if (title) title.textContent = '计划';
  const count = document.getElementById('composer-plan-count');
  if (count) count.textContent = `${done}/${steps.length}`;
  const list = document.getElementById('composer-plan-steps');
  if (!list) return;
  list.replaceChildren(...steps.map(step => {
    const li = document.createElement('li');
    li.className = 'dshw-plan-step'
      + (step.status === 'completed' ? ' is-done' : '')
      + (step.status === 'in_progress' ? ' is-active' : '');
    li.textContent = step.content;
    return li;
  }));
}

document.getElementById('composer-plan-toggle')?.addEventListener('click', () => {
  planCollapsed = !planCollapsed;
  renderPlanCard();
});

/* CC toolPermissionDecision：工具被拒后模型发起的权限提问，三个结构化选项。
   点击 = 授权随下一条消息生效（grant/once/deny），文本同时告诉模型继续。 */
let pendingPermissionAsk: { tool: string } | null = null;
let pendingPermissionChoice: { grant?: string; deny?: string; once?: string } | null = null;

function renderPermissionAsk() {
  const host = document.getElementById('composer-permission-ask');
  if (!host) return;
  if (!pendingPermissionAsk) { host.hidden = true; host.replaceChildren(); return; }
  const tool = pendingPermissionAsk.tool;
  host.hidden = false;
  const label = document.createElement('span');
  label.className = 'dshw-perm-ask-label';
  label.textContent = `是否授权执行 ${tool}？`;
  const make = (text: string, choice: { grant?: string; deny?: string; once?: string }, message: string) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dshw-perm-ask-btn';
    btn.textContent = text;
    btn.addEventListener('click', () => {
      pendingPermissionChoice = choice;
      const ta = document.querySelector<HTMLTextAreaElement>('#composer-form textarea');
      const form = document.getElementById('composer-form') as HTMLFormElement | null;
      if (ta && form) {
        ta.value = message;
        fitComposer(ta);
        form.requestSubmit();
      }
    });
    return btn;
  };
  host.replaceChildren(
    label,
    make('仅这一次允许', { once: tool }, `仅这一次允许 ${tool}，请继续。`),
    make('本会话总是允许', { grant: tool }, `本会话总是允许 ${tool}，请继续。`),
    make('拒绝', { deny: tool }, `拒绝执行 ${tool}，换别的办法。`),
  );
}

function bindWorkspaceChip() {
  renderWorkspaceChip();
  document.getElementById('composer-workspace')?.addEventListener('click', async e => {
    e.stopPropagation();
    try {
      const picked = await Data.pickWorkspace();
      if (picked?.ok && picked.path) {
        composerWorkspace = String(picked.path);
        renderWorkspaceChip();
      }
    } catch { /* 选择器不可用时静默保留当前状态 */ }
  });
}
bindWorkspaceChip();
bindStyleChip();
bindPermissionChip();
/* DSH 输入卡：textarea 随内容长高，14 行封顶（336px，InputBar 同款上限） */
function fitComposer(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(336, ta.scrollHeight)}px`;
}

/* 模型切换器：DSH ModelSelect 同款——真实网关目录（fabric_bridge model.catalog），
   选中即写 secrets/model.txt（全栈消费的同一份配置），下次发送就生效。 */
let modelCatalog: MagicPointerModelCatalog | null = null;

async function refreshComposerModel() {
  const label = document.getElementById('composer-model-label');
  const btn = document.getElementById('composer-model');
  modelCatalog = await Data.models();
  const current = modelCatalog?.current || '';
  if (label) label.textContent = current || '默认模型';
  if (btn instanceof HTMLButtonElement) {
    btn.title = current
      ? (modelCatalog?.visionModel && modelCatalog.visionModel !== current
        ? `文本 ${current} · 视觉 ${modelCatalog.visionModel}` : current)
      : '模型';
  }
}

function closeModelMenu() {
  const menu = document.getElementById('composer-model-menu');
  document.getElementById('composer-model')?.setAttribute('aria-expanded', 'false');
  if (menu) menu.hidden = true;
}

async function openModelMenu() {
  const menu = document.getElementById('composer-model-menu');
  if (!menu) return;
  const btn = document.getElementById('composer-model');
  if (btn instanceof HTMLButtonElement) btn.disabled = true;
  const catalog = await Data.models();
  if (btn instanceof HTMLButtonElement) btn.disabled = false;
  if (!catalog) {
    menu.replaceChildren(modelMenuNote('模型目录不可用（本机未接入 Electron 桥）。'));
    menu.hidden = false;
    return;
  }
  modelCatalog = catalog;
  const rows: HTMLElement[] = [];
  if (catalog.error) rows.push(modelMenuNote(catalog.error));
  for (const group of catalog.groups || []) {
    if ((catalog.groups || []).length > 1) {
      const head = document.createElement('div');
      head.className = 'dshw-model-group';
      head.textContent = group.name || group.id;
      rows.push(head);
    }
    for (const entry of group.models || []) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'dshw-model-row' + (entry.id === catalog.current ? ' is-active' : '');
      row.setAttribute('role', 'option');
      row.dataset.modelId = entry.id;
      const name = document.createElement('span');
      name.className = 'dshw-model-name';
      name.textContent = entry.id;
      if (entry.vision) {
        const tag = document.createElement('em');
        tag.className = 'dshw-model-tag';
        tag.textContent = '视觉';
        name.appendChild(tag);
      }
      row.appendChild(name);
      if (entry.id === catalog.current) {
        const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        check.setAttribute('aria-hidden', 'true');
        check.classList.add('dshw-perm-check');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', '#ic-dsh-check');
        check.appendChild(use);
        row.appendChild(check);
      }
      rows.push(row);
    }
  }
  menu.replaceChildren(...rows);
  menu.hidden = false;
  document.getElementById('composer-model')?.setAttribute('aria-expanded', 'true');
}

function modelMenuNote(text: string): HTMLElement {
  const note = document.createElement('div');
  note.className = 'dshw-model-note';
  note.textContent = text;
  return note;
}

function bindModelSeat() {
  document.getElementById('composer-model')?.addEventListener('click', async e => {
    e.stopPropagation();
    const menu = document.getElementById('composer-model-menu');
    if (menu?.hidden) await openModelMenu();
    else closeModelMenu();
  });
  document.getElementById('composer-model-menu')?.addEventListener('click', async e => {
    const row = (e.target as Element | null)?.closest<HTMLElement>('[data-model-id]');
    if (!row) return;
    e.stopPropagation();
    const modelId = row.dataset.modelId || '';
    if (modelId === modelCatalog?.current) { closeModelMenu(); return; }
    const menu = document.getElementById('composer-model-menu');
    if (menu) menu.replaceChildren(modelMenuNote('正在切换…'));
    const result = await Data.selectModel(modelId);
    if (!result?.ok) {
      if (menu) menu.replaceChildren(modelMenuNote(result?.error || '切换失败。'));
      return;
    }
    closeModelMenu();
    await refreshComposerModel();
  });
}
bindModelSeat();

interface PendingConversation {
  requestId: string;
  body: HTMLElement;
  records: Map<string, Record<string, unknown>>;
  /** 已渲染的活动行，key=progressKey；签名变了才重建，保住用户展开的行。 */
  nodes: Map<string, { sig: string; el: HTMLElement }>;
  agentSessionId: string | null;
  streamText: string;
  streamNode: HTMLElement | null;
}
let pendingConversation: PendingConversation | null = null;

function progressKey(record: Record<string, unknown>): string {
  const phase = String(record.phase || '');
  const fields = record.fields && typeof record.fields === 'object'
    ? record.fields as Record<string, unknown> : {};
  if (phase === 'tool_call' || phase === 'tool_result') return `tool:${String(fields.id || fields.name || '')}`;
  if (['runtime_boot', 'runtime_ready', 'agent_start'].includes(phase)) return 'runtime';
  if (['model_request', 'model_first_chunk', 'model_response'].includes(phase)) return `model:${String(fields.turn || '1')}`;
  return phase || 'progress';
}

function renderConversationProgress(record: Record<string, unknown>) {
  if (!pendingConversation) return;
  /* session_ready：拿到 durable session id —— 停止/插话都指向它。 */
  const sid = ConversationControl.sessionIdFromRecord(record);
  if (sid) {
    pendingConversation.agentSessionId = sid;
    setComposerRunningState(true);
  }
  if (String(record.phase || '') === 'plan') {
    const snapshot = ConversationControl.planStepsFromRecord(record);
    if (snapshot) { composerPlan = snapshot; renderPlanCard(); }
  }
  if (String(record.phase || '') === 'answer_chunk') {
    const fields = record.fields && typeof record.fields === 'object'
      ? record.fields as Record<string, string> : {};
    appendLiveStreamText(ConversationControl.decodeChunkBlob(fields));
    return; // 正文增量不是活动行，不进 records。
  }
  pendingConversation.records.set(progressKey(record), record);
  followIfNearBottom(pendingConversation.body, renderPendingBody);
}

function recordSignature(record: Record<string, unknown>): string {
  const phase = String(record.phase || '');
  const fields = record.fields && typeof record.fields === 'object'
    ? record.fields as Record<string, unknown> : {};
  return `${phase}|${String(fields.state || '')}|${String(fields.turn || '')}|${String(fields.name || '')}`;
}

/* 活动行按 key 增量渲染：签名没变的行绝不重建——否则用户展开的工具行
   在每条进度记录到达时都被拍回折叠态（DSH 的行内局部状态模型）。 */
function renderPendingBody() {
  const pending = pendingConversation;
  if (!pending) return;
  const seen = new Set<string>();
  const els: HTMLElement[] = [];
  for (const [key, item] of pending.records) {
    if (String(item.phase || '') === 'total') continue;
    seen.add(key);
    const sig = recordSignature(item);
    const cached = pending.nodes.get(key);
    if (cached && cached.sig === sig) {
      els.push(cached.el);
      continue;
    }
    const el = DshChat.liveActivityNode(item) as HTMLElement;
    if (cached) cached.el.replaceWith(el);
    pending.nodes.set(key, { sig, el });
    els.push(el);
  }
  for (const [key, cached] of [...pending.nodes]) {
    if (!seen.has(key)) {
      cached.el.remove();
      pending.nodes.delete(key);
    }
  }
  pending.body.replaceChildren(...els, ...renderLiveStreamNode());
}

/* 流式正文：边收边画（纯文本 pre-wrap），回合完成后 openConversation 用
   markdown 重画正式版本。空文本不建节点。 */
function renderLiveStreamNode(): Element[] {
  const pending = pendingConversation;
  if (!pending || !pending.streamText) return [];
  if (!pending.streamNode) {
    const node = document.createElement('div');
    node.className = 'dsh-stream-live';
    node.setAttribute('aria-live', 'polite');
    pending.streamNode = node;
  }
  pending.streamNode.textContent = pending.streamText;
  return [pending.streamNode];
}

const SCROLL_FOLLOW_THRESHOLD_PX = 48;

function isNearBottom(el: HTMLElement, threshold = SCROLL_FOLLOW_THRESHOLD_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function updateScrollPill() {
  const scroller = document.querySelector<HTMLElement>('.dshw-scrollbody');
  const pill = document.getElementById('scroll-pill');
  if (!scroller || !pill) return;
  pill.hidden = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 240;
}

/* 贴底才跟随（DSH FOLLOW_THRESHOLD 同款）：用户往上翻阅历史时，进度记录
   不再把视图拽走；回到距底 48px 内恢复自动跟随。 */
function followIfNearBottom(body: HTMLElement, mutate: () => void): void {
  const scroller = body.closest('.dshw-scrollbody') as HTMLElement | null;
  const near = scroller ? isNearBottom(scroller) : true;
  mutate();
  if (near && scroller) {
    scroller.scrollTo({ top: scroller.scrollHeight });
    updateScrollPill();
  }
}

(function bindScrollPill() {
  const scroller = document.querySelector<HTMLElement>('.dshw-scrollbody');
  const pill = document.getElementById('scroll-pill');
  if (!scroller || !pill || scroller.dataset.pillBound) return;
  scroller.dataset.pillBound = '1';
  scroller.addEventListener('scroll', updateScrollPill, { passive: true });
  pill.addEventListener('click', () => {
    scroller.scrollTo({ top: scroller.scrollHeight });
    updateScrollPill();
  });
})();

function appendLiveStreamText(text: string) {
  const pending = pendingConversation;
  if (!pending || !text) return;
  pending.streamText += text;
  followIfNearBottom(pending.body, renderPendingBody);
}

/* 作曲家忙态：发送钮变停止钮（DSH InputBar 同款形态）。
   isRunning=false 时恢复发送钮并清掉流式残留状态。 */
function setComposerRunningState(running: boolean) {
  const submit = document.querySelector<HTMLButtonElement>('#composer-form button[type="submit"]');
  if (submit) {
    submit.classList.toggle('is-stop', running);
    submit.title = running ? '停止' : '发送';
    submit.setAttribute('aria-label', running ? '停止' : '发送');
  }
}

Data.onConversationProgress((payload) => {
  if (!pendingConversation || payload.requestId !== pendingConversation.requestId || !payload.record) return;
  renderConversationProgress(payload.record);
});

/* 忙态插话：文本写入 durable inbox（next-step），下一轮模型请求即携带。
   界面立即给一条排队的用户气泡，不假装它已经影响本轮。 */
async function steerActiveConversation(question: string, textarea: HTMLTextAreaElement): Promise<void> {
  const pending = pendingConversation;
  const sessionId = pending?.agentSessionId || '';
  if (!sessionId) return; // runtime 还没就绪：保持输入，不打断用户。
  const response = await Data.steerConversation(sessionId, question);
  if (!response?.ok) return; // 桥拒绝时保留输入，让用户重试或改发送。
  textarea.value = '';
  fitComposer(textarea);
  const flow = document.querySelector<HTMLElement>('#stream .dsh-flow');
  if (flow) {
    const node = DshChat.userNode(question);
    node.setAttribute('data-queued', 'true');
    flow.appendChild(node);
    flow.closest('.dshw-scrollbody')?.scrollTo({ top: 1_000_000 });
  }
}

/* 忙态下点发送钮 = 停止本回合：优雅取消优先（Receipt + 部分结果）。
   停止后 openConversation 会用会话里的最终状态重画。 */
document.getElementById('composer-form')?.querySelector('button[type="submit"]')?.addEventListener('click', (e) => {
  if (!studioComposerBusy || !pendingConversation) return;
  e.preventDefault();
  e.stopPropagation();
  void (async () => {
    const requestId = pendingConversation!.requestId;
    const note = document.createElement('div');
    note.className = 'dsh-turn-status';
    note.textContent = '正在停止…';
    pendingConversation!.body.appendChild(note);
    await Data.stopConversation(requestId);
  })();
});

document.getElementById('session-log')?.addEventListener('click', async () => {
  if (!activeConversationId) return;
  const button = document.getElementById('session-log') as HTMLButtonElement | null;
  if (button) button.disabled = true;
  try {
    await Data.exportConversation(activeConversationId);
  } finally {
    if (button) button.disabled = false;
  }
});

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
    const question = textarea?.value.trim() || '';
    if (!textarea || !question) { textarea?.focus(); return; }
    /* 忙态下 Enter = 插话（steer）：写入 durable inbox，下一轮即携带。
       还没拿到 session id 时诚实拒绝，不假装已送达。 */
    if (studioComposerBusy) {
      await steerActiveConversation(question, textarea);
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
    pendingBody.appendChild(DshChat.liveActivityNode({ phase: 'runtime_boot', fields: {} }));
    pending.appendChild(pendingBody);
    flow.appendChild(pending);
    stream.scrollTop = stream.scrollHeight;

    textarea.value = '';
    fitComposer(textarea);
    studioComposerBusy = true;
    form.setAttribute('aria-busy', 'true');
    setComposerRunningState(true);
    const requestId = globalThis.crypto?.randomUUID?.() || `conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingConversation = { requestId, body: pendingBody, records: new Map(), nodes: new Map(), agentSessionId: null, streamText: '', streamNode: null };
    renderConversationProgress({ phase: 'runtime_boot', fields: {} });
    try {
      const response = await Data.sendConversation(
        activeConversationId,
        question,
        composerPreset,
        requestId,
        composerWorkspace || undefined,
        composerStyle,
        pendingPermissionChoice || undefined,
      );
      pendingPermissionChoice = null;
      pendingPermissionAsk = null;
      renderPermissionAsk();
      if (!response?.ok || !response.conversationId) throw new Error(response?.error || '这次没有答完。');
      activeConversationId = String(response.conversationId);
      /* 命令结算的副作用：/permission 落芯片，/model 刷新目录标签 */
      const command = (response as { command?: { type?: string; preset?: string } }).command;
      if (command?.type === 'permission' && command.preset) {
        composerPreset = String(command.preset);
        renderPermissionChip();
      } else if (command?.type === 'model') {
        await refreshComposerModel();
      } else if ((response as { plan?: unknown }).plan && typeof (response as { plan?: unknown }).plan === 'object') {
        composerPlan = (response as { plan: { steps: Array<{ content: string; status: string }> } }).plan;
        renderPlanCard();
      }
      /* 权限提问：模型 ask_user_question(kind=permission) 的结构化回传 */
      const awaiting = response as { awaitingUserInput?: boolean; pendingInput?: { kind?: string; tool?: string } };
      if (awaiting.awaitingUserInput && awaiting.pendingInput?.kind === 'permission' && awaiting.pendingInput.tool) {
        pendingPermissionAsk = { tool: String(awaiting.pendingInput.tool) };
        renderPermissionAsk();
      }
      if ((response as { command?: { type?: string; path?: string } }).command?.type === 'cwd' && typeof (response as { command?: { path?: string } }).command?.path === 'string') {
        composerWorkspace = String((response as { command?: { path?: string } }).command!.path);
        renderWorkspaceChip();
      }
      await openConversation(activeConversationId);
      await renderSidebar();
    } catch (error) {
      pending.replaceChildren(DshChat.turnErrorNode(error instanceof Error ? error.message : String(error)));
      textarea.value = question;
      fitComposer(textarea);
    } finally {
      pendingConversation = null;
      studioComposerBusy = false;
      form.removeAttribute('aria-busy');
      setComposerRunningState(false);
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
  activeConversationTab = 'chat';
  // 新线程不继承上一线程的芯片工作区：未指定 = 跟随默认（Codex 新线程语义）。
  composerWorkspace = '';
  renderWorkspaceChip();
  document.querySelectorAll('#side-convos .side-item').forEach((n) => n.classList.remove('is-on'));
  const title = document.getElementById('chat-title');
  if (title) title.textContent = '新对话';
  const preview = document.getElementById('chat-source-preview');
  if (preview) preview.hidden = true;
  const contextTagLabel = document.getElementById('mp-context-tag-label');
  if (contextTagLabel) contextTagLabel.textContent = 'Magic Pointer';
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
  const trajectory = document.getElementById('trajectory');
  if (trajectory) trajectory.replaceChildren(DshTrajectory.render([]));
  setConversationTab('chat');
  // 「+」的可见回应：即便本来就在空会话上，输入卡也要闪一下并聚焦，
  // 让点击永远有看得见的结果（用户反馈：点了没反应）。
  const card = document.querySelector<HTMLElement>('#composer-form .dshw-card');
  const textarea = document.querySelector<HTMLTextAreaElement>('.dshw-input');
  if (card) {
    card.classList.remove('is-pulsed');
    void card.offsetWidth; // restart the animation
    card.classList.add('is-pulsed');
    window.setTimeout(() => card.classList.remove('is-pulsed'), 700);
  }
  textarea?.focus();
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
