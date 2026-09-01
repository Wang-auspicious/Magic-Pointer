/* Magic Pointer Studio: real data renderers mounted inside the shared Oreo shell. */

/* head 中已经在首帧前解析系统/已保存主题；这里同步旧组件需要的属性。 */
(function bootTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document.body.toggleAttribute('data-ds-dark-theme', dark);
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

function emptyStateMarkup(
  iconId: string,
  title: string,
  description: string,
  action?: { label: string; view: string },
) {
  return `<div class="mp-empty-state">
    <span class="mp-empty-icon" aria-hidden="true">${icon(iconId)}</span>
    <strong>${esc(title)}</strong>
    <p>${esc(description)}</p>
    ${action ? `<button type="button" data-goto="${esc(action.view)}">${esc(action.label)}</button>` : ''}
  </div>`;
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
      ? `<span class="canvas-empty">这个分类里还没有素材。</span>`
      : emptyStateMarkup('ic-stash', '画布还没有素材', '划过屏幕内容、复制图片或保存引用后，它们会在这里形成可整理的视觉上下文。', { label: '回到对话', view: 'chat' });
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

/* ---- 侧栏：文件夹启用项目工具，但普通 Studio 会话可以不绑定文件夹。 ---- */
let sidebarQuery = '';
let sidebarRecentOnly = false;
const expandedWorkspaces = new Map<string, boolean>();
let activeProjectRoot = '';
try { activeProjectRoot = localStorage.getItem('mp:active-project-root') || ''; } catch { /* storage unavailable */ }

function normalizedProjectRoot(root: unknown): string {
  return String(root || '').trim().replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
}

function setActiveProject(root: unknown) {
  activeProjectRoot = String(root || '').trim();
  projectEnvironment = null;
  activeTerminalRelativeDirectory = '';
  try {
    if (activeProjectRoot) localStorage.setItem('mp:active-project-root', activeProjectRoot);
    else localStorage.removeItem('mp:active-project-root');
  } catch { /* storage unavailable */ }
  renderProjectContext();
  renderTerminalPrompt();
  if (document.getElementById('project-inspector') && shell?.dataset.inspector === 'open') {
    void refreshProjectInspector();
  }
}

function renderProjectContext() {
  const headerLabel = document.getElementById('chat-project-label');
  const locationLabel = document.getElementById('header-location-label');
  const workspaceLabel = document.getElementById('composer-workspace-label');
  const hasProject = Boolean(activeProjectRoot);
  const designStatus = document.querySelector<HTMLElement>('.mp-design-live');
  if (designStatus) {
    designStatus.classList.toggle('is-offline', !hasProject);
    const text = designStatus.lastChild;
    if (text?.nodeType === Node.TEXT_NODE) text.textContent = hasProject ? '已连接项目' : '等待打开项目';
  }
  if (!headerLabel) return;
  if (!hasProject) {
    headerLabel.textContent = '本机会话';
    headerLabel.removeAttribute('title');
    if (locationLabel) locationLabel.textContent = '本机';
    if (workspaceLabel) workspaceLabel.textContent = '选择文件夹…';
    return;
  }
  const parts = activeProjectRoot.replace(/\\/g, '/').split('/').filter(Boolean);
  const projectName = parts[parts.length - 1] || activeProjectRoot;
  headerLabel.textContent = projectName;
  headerLabel.title = activeProjectRoot;
  if (locationLabel) locationLabel.textContent = projectName;
  if (workspaceLabel) workspaceLabel.textContent = projectName;
}
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
interface StudioHomeModule {
  render(options: {
    stats: MagicPointerHomeStats | null;
    conversations: ReadonlyArray<{
      id: string;
      title?: string;
      state?: string;
      updatedAt?: number;
      hasPendingWork?: boolean;
    }>;
    onOpenConversation?: (id: string) => void;
  }): void;
}
const studioHomeGlobals = (globalThis as { StudioHome?: StudioHomeModule }).StudioHome!;
interface StudioSearchItem {
  kind: 'conversation' | 'project' | 'command' | 'skill' | 'route';
  key: string;
  label: string;
  detail: string;
  target: Record<string, unknown>;
}
interface StudioSearchModule {
  buildStudioSearchIndex(sources: {
    conversations?: readonly MagicPointerConversation[];
    projects?: readonly MagicPointerProject[];
    commands?: readonly MagicPointerSlashEntry[];
    skills?: readonly MagicPointerSlashEntry[];
    routes?: ReadonlyArray<{ id: string; label: string; keywords: readonly string[] }>;
  }): StudioSearchItem[];
  searchStudioIndex(index: readonly StudioSearchItem[], query: unknown, limit?: number): StudioSearchItem[];
}
const studioSearchGlobals = (globalThis as { StudioSearch?: StudioSearchModule }).StudioSearch!;

const STUDIO_SEARCH_ROUTES = [
  { id: 'chat', label: '新建对话', keywords: ['首页', '会话', 'new'] },
  { id: 'design', label: 'Design', keywords: ['设计', '素材', '画布'] },
  { id: 'settings', label: '自定义', keywords: ['设置', '插件', '模型', '权限', 'Skills', 'MCP'] },
  { id: 'changes', label: '工作树变更', keywords: ['Git', 'Review', '拉取请求'] },
  { id: 'browser', label: '项目浏览器', keywords: ['站点', '网页', 'localhost'] },
  { id: 'tasks', label: '任务', keywords: ['已安排', '后台', '运行中'] },
] as const;
let studioSearchIndex: StudioSearchItem[] = [];
let visibleSearchResults: StudioSearchItem[] = [];
let globalSearchActiveIndex = 0;

/* sv_motion:sv-animations 组件的弹簧/勾线常量(经典脚本全局,见 renderer/sv_motion.ts)。
   局部名必须小写:全局已有 const SvMotion(sv_motion.js),同名会撞经典脚本词法作用域。 */
interface SvMotionModule {
  PLAN_CHECK: { path: string; transform: string; strokeWidth: number; drawEase: string; drawDurationMs: number };
}
const svMotionGlobals = (globalThis as { SvMotion?: SvMotionModule }).SvMotion!;

function conversationNode(c: { id?: string; title?: string; updatedAt?: number; hasPendingWork?: boolean }, active?: string): HTMLElement {
  const row = document.createElement('button');
  row.className = 'side-item' + (c.id === active ? ' is-on' : '');
  row.dataset.open = String(c.id || '');
  row.type = 'button';
  // 会话行保持安静：标题是主体，待续状态与操作只在需要时出现。
  const dot = document.createElement('span');
  dot.className = 'side-dot';
  dot.classList.toggle('is-pending', c.hasPendingWork === true);
  if (c.hasPendingWork) {
    dot.title = '有未完成工作，可继续此会话';
    row.dataset.pendingWork = 'true';
    row.setAttribute('aria-label', `${String(c.title || '未命名对话')}，有待续工作`);
  }
  dot.setAttribute('aria-hidden', 'true');
  const title = document.createElement('span');
  title.className = 'side-title';
  title.textContent = String(c.title || '未命名对话');
  const actions = document.createElement('span');
  actions.className = 'side-actions';
  // DSH Rows 的会话动作菜单：重命名 / 删除。行本身是 button，动作槽用
  // role=button 的 span（按钮不能嵌按钮）。
  const ellipsis = document.createElement('span');
  ellipsis.className = 'side-ellipsis';
  ellipsis.setAttribute('role', 'button');
  ellipsis.setAttribute('tabindex', '0');
  ellipsis.setAttribute('aria-label', '会话操作');
  ellipsis.dataset.sessionMenu = String(c.id || '');
  ellipsis.innerHTML = icon('ic-ellipsis');
  actions.appendChild(ellipsis);
  actions.appendChild(buildSessionMenu(c));
  row.append(dot, title, actions);
  return row;
}

/* 会话动作菜单：挂在行内，打开时才可见；点击外部由全局委托收起。 */
function buildSessionMenu(c: { id?: string; title?: string }): HTMLElement {
  const menu = document.createElement('span');
  menu.className = 'side-session-menu';
  menu.hidden = true;
  menu.dataset.forSession = String(c.id || '');
  const makeItem = (label: string, danger: boolean, action: () => void) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'side-session-menu-item' + (danger ? ' is-danger' : '');
    item.textContent = label;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = true;
      action();
    });
    return item;
  };
  menu.append(
    makeItem('重命名', false, () => openRenameDialog(String(c.id || ''), String(c.title || ''))),
    makeItem('删除对话', true, () => {
      if (String(c.id || '') === activeConversationId) startNewChat();
      void Data.deleteConversation(String(c.id || '')).then(() => renderSidebar());
    }),
  );
  return menu;
}

/* 重命名对话框：Electron 不支持 window.prompt，用内联覆盖层。 */
function openRenameDialog(id: string, currentTitle: string) {
  if (!id) return;
  const overlay = document.createElement('div');
  overlay.className = 'dshw-perm-confirm';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '重命名对话');
  const card = document.createElement('div');
  card.className = 'dshw-perm-confirm-card';
  const titleEl = document.createElement('b');
  titleEl.textContent = '重命名对话';
  const input = document.createElement('input');
  input.className = 'dshw-rename-input';
  input.value = currentTitle;
  input.maxLength = 60;
  const err = document.createElement('p');
  err.className = 'dshw-rename-error';
  err.hidden = true;
  const actionsEl = document.createElement('div');
  actionsEl.className = 'dshw-perm-confirm-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => overlay.remove());
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'is-primary';
  save.textContent = '保存';
  const submit = async () => {
    const value = input.value.trim();
    if (!value) {
      err.textContent = '标题不能为空。';
      err.hidden = false;
      return;
    }
    const response = await Data.renameConversation(id, value);
    if (!response?.ok) {
      err.textContent = response?.error === 'invalid_id_or_title' ? '标题无效。' : '重命名失败，请重试。';
      err.hidden = false;
      return;
    }
    overlay.remove();
    await renderSidebar();
    const head = document.getElementById('chat-title');
    if (head && activeConversationId === id) head.textContent = value;
  };
  save.addEventListener('click', () => void submit());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void submit();
    }
  });
  actionsEl.append(cancel, save);
  card.append(titleEl, input, err, actionsEl);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  input.focus();
  input.select();
}

(function bindSessionMenuDismiss() {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const trigger = target.closest<HTMLElement>('[data-session-menu]');
    if (trigger) {
      e.stopPropagation();
      const host = trigger.parentElement?.querySelector<HTMLElement>('.side-session-menu');
      if (host) {
        document.querySelectorAll('.side-session-menu:not([hidden])').forEach((m) => {
          if (m !== host) (m as HTMLElement).hidden = true;
        });
        host.hidden = !host.hidden;
      }
      return;
    }
    document.querySelectorAll('.side-session-menu:not([hidden])').forEach((m) => {
      if (!target.closest('.side-session-menu')) (m as HTMLElement).hidden = true;
    });
  });
})();

let sidebarListSignature = '';

async function renderSidebar() {
  const host = document.getElementById('side-convos');
  if (!host) return;
  const [list, projects] = await Promise.all([Data.conversations(), Data.projects()]);
  const registeredRoots = new Set(projects.map((project) => normalizedProjectRoot(project.root)));
  if (activeProjectRoot && !registeredRoots.has(normalizedProjectRoot(activeProjectRoot))) {
    setActiveProject('');
  } else {
    renderProjectContext();
  }
  const active = host.querySelector('.is-on')?.getAttribute('data-open')
    ?? activeConversationId
    ?? undefined;
  const nodes: HTMLElement[] = [];
  let filtered = sidebarGroups.filterConversations(list, sidebarQuery);
  if (sidebarRecentOnly) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    filtered = filtered.filter((conversation) => Number(conversation.updatedAt) >= cutoff);
  }
  // 项目独立持久化；即使还没有第一条对话，打开过的文件夹也必须留在左栏。
  const wsGroups = sidebarGroups.groupByWorkspace(filtered as Array<MagicPointerConversation & { workspaceRoot?: string }>);
  const conversationsByRoot = new Map(wsGroups.map((group) => [normalizedProjectRoot(group.workspaceRoot), group.items]));
  const projectGroups = projects.map((project) => ({
    key: project.root,
    label: project.name,
    items: (conversationsByRoot.get(normalizedProjectRoot(project.root)) || []) as MagicPointerConversation[],
  })).filter((project) => {
    if (!sidebarQuery.trim()) return true;
    return project.label.toLocaleLowerCase().includes(sidebarQuery.trim().toLocaleLowerCase()) || project.items.length > 0;
  });
  const localGroup = wsGroups.find((group) => group.key === '__local__');
  const groups = [
    ...projectGroups,
    ...(localGroup ? [{ key: '', label: localGroup.label, items: localGroup.items as MagicPointerConversation[] }] : []),
  ];
  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'side-empty';
    empty.textContent = projects.length ? '没有匹配的会话。' : '从新建开始';
    nodes.push(empty);
  }
  const listSignature = groups
    .map((group) => `${group.key}:${group.items.map((c) => String(c.id || '')).join(',')}`)
    .join('|');
  const animateRows = listSignature !== sidebarListSignature;
  sidebarListSignature = listSignature;
  let rowIndex = 0;
  for (const group of groups) {
    const project = document.createElement('section');
    project.className = 'dshw-project';
    const open = expandedWorkspaces.get(group.key) !== false;
    project.classList.toggle('is-active', normalizedProjectRoot(group.key) === normalizedProjectRoot(activeProjectRoot));
    project.dataset.open = String(open);
    project.dataset.workspace = group.key;
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'dshw-project-row';
    head.dataset.workspaceToggle = group.key;
    head.dataset.projectSelect = group.key;
    head.setAttribute('aria-expanded', String(open));
    head.innerHTML = `<span class="dshw-project-slot dshw-project-chevron">${icon('ic-triangle-right', open ? 'is-open' : '')}</span><span class="dshw-project-slot dshw-project-folder">${icon('ic-folder')}</span><span class="dshw-project-name"></span>`;
    head.querySelector<HTMLElement>('.dshw-project-name')!.textContent = group.label;
    const sessions = document.createElement('div');
    sessions.className = 'dshw-project-sessions';
    for (const c of group.items) {
      const node = conversationNode(c, active);
      if (animateRows) {
        node.classList.add('sv-row-in');
        node.style.setProperty('--sv-i', String(rowIndex));
      }
      rowIndex += 1;
      sessions.appendChild(node);
    }
    if (!group.items.length) {
      const empty = document.createElement('span');
      empty.className = 'dshw-project-empty';
      empty.textContent = '新项目';
      sessions.appendChild(empty);
    }
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
    event.stopPropagation();
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

async function openProjectFromPicker() {
  const picked = await Data.openProject();
  if (!picked?.ok || !picked.project?.root) return;
  setActiveProject(picked.project.root);
  startNewChat();
  await renderSidebar();
}

document.getElementById('workspace-add')?.addEventListener('click', () => { void openProjectFromPicker(); });
document.getElementById('composer-workspace')?.addEventListener('click', () => { void openProjectFromPicker(); });
document.getElementById('workspace-filter')?.addEventListener('click', (event) => {
  sidebarRecentOnly = !sidebarRecentOnly;
  const button = event.currentTarget as HTMLButtonElement;
  button.classList.toggle('is-on', sidebarRecentOnly);
  button.setAttribute('aria-pressed', String(sidebarRecentOnly));
  button.title = sidebarRecentOnly ? '只看近 7 天（已启用）' : '只看最近项目';
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
  renderUsageMeter(turns);
}

function compactTokenCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}

function renderUsageMeter(turns: MagicPointerTurn[]) {
  const button = document.getElementById('composer-context') as HTMLButtonElement | null;
  const label = document.getElementById('composer-usage-label');
  const popover = document.getElementById('composer-usage-popover');
  if (!button || !label || !popover) return;
  const inputTokens = turns.reduce((total, turn) => total + (Number(turn.modelUsage?.inputTokens) || 0), 0);
  const outputTokens = turns.reduce((total, turn) => total + (Number(turn.modelUsage?.outputTokens) || 0), 0);
  const totalTokens = inputTokens + outputTokens;
  button.hidden = totalTokens <= 0;
  if (totalTokens <= 0) {
    label.textContent = '';
    popover.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    return;
  }
  label.textContent = compactTokenCount(totalTokens);
  button.title = `本会话模型用量：${totalTokens.toLocaleString()} tokens`;
  popover.replaceChildren();
  const eyebrow = document.createElement('span');
  eyebrow.className = 'mp-usage-eyebrow';
  eyebrow.textContent = 'SESSION USAGE';
  const title = document.createElement('strong');
  title.textContent = `${totalTokens.toLocaleString()} tokens`;
  const rows = document.createElement('dl');
  for (const [term, value] of [['输入', inputTokens], ['输出', outputTokens], ['已记录回合', turns.length]] as const) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = Number(value).toLocaleString();
    rows.append(dt, dd);
  }
  const note = document.createElement('p');
  note.textContent = '这是落盘的实际模型用量，不把它冒充为上下文窗口占比。';
  popover.append(eyebrow, title, rows, note);
}

document.getElementById('composer-context')?.addEventListener('click', (event) => {
  event.stopPropagation();
  const button = event.currentTarget as HTMLButtonElement;
  const popover = document.getElementById('composer-usage-popover');
  if (!popover) return;
  const open = popover.hidden;
  popover.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
});

/* ---- 打开一条对话 ---- */
let activeConversationId: string | null = null;
let activeConversationTab: 'chat' | 'trajectory' = 'chat';
let activeConversationTurnCount = 0;
/* cardId → DSH 回合节点：后台任务补丁就地换节点，不重建整条流 */
const dshCardNodes = new Map<string, HTMLElement>();

function setStudioHomeVisible(visible: boolean) {
  const home = document.getElementById('studio-home');
  const header = document.querySelector<HTMLElement>('#view-chat > .dshw-header');
  const stream = document.getElementById('stream');
  const trajectory = document.getElementById('trajectory');
  if (home) home.hidden = !visible;
  if (header) header.hidden = visible;
  if (stream) stream.hidden = visible || activeConversationTab !== 'chat';
  if (trajectory) trajectory.hidden = visible || activeConversationTab !== 'trajectory';
  document.querySelector<HTMLElement>('.dshw-scrollbody')?.classList.toggle('is-home', visible);
}

async function renderStudioHome() {
  const [stats, conversations] = await Promise.all([
    Data.conversationStats(),
    Data.conversations(),
  ]);
  studioHomeGlobals.render({
    stats,
    conversations: conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
      hasPendingWork: conversation.hasPendingWork,
      state: conversation.hasPendingWork ? 'resumable' : '',
    })),
    onOpenConversation: (id) => { void openConversation(id); },
  });
  const note = document.getElementById('studio-home-stats-note');
  if (note) note.textContent = stats ? '只统计本机已有的真实会话与模型用量。' : '统计暂不可用；对话仍可正常开始。';
}

async function refreshGlobalSearchIndex() {
  const [conversations, projects, directory] = await Promise.all([
    Data.conversations(),
    Data.projects(),
    Data.slashDirectory(),
  ]);
  studioSearchIndex = studioSearchGlobals.buildStudioSearchIndex({
    conversations,
    projects,
    commands: directory?.commands ?? [],
    skills: directory?.skills ?? [],
    routes: [...STUDIO_SEARCH_ROUTES],
  });
}

function globalSearchKindLabel(kind: StudioSearchItem['kind']): string {
  switch (kind) {
    case 'conversation': return '会';
    case 'project': return '项';
    case 'command': return '/';
    case 'skill': return '技';
    case 'route': return '→';
  }
}

function renderGlobalSearchResults(query: string) {
  const host = document.getElementById('global-search-results');
  if (!host) return;
  visibleSearchResults = studioSearchGlobals.searchStudioIndex(studioSearchIndex, query, 20);
  globalSearchActiveIndex = Math.min(globalSearchActiveIndex, Math.max(0, visibleSearchResults.length - 1));
  if (!query.trim()) {
    host.innerHTML = '<p class="mp-global-search-empty">输入内容以搜索会话、项目、命令、Skills 和设置。</p>';
    return;
  }
  if (!visibleSearchResults.length) {
    host.innerHTML = '<p class="mp-global-search-empty">没有匹配结果。</p>';
    return;
  }
  const rows = visibleSearchResults.map((item, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'mp-global-search-row';
    row.classList.toggle('is-active', index === globalSearchActiveIndex);
    row.dataset.searchIndex = String(index);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === globalSearchActiveIndex));
    const kind = document.createElement('span');
    kind.className = 'mp-global-search-kind';
    kind.textContent = globalSearchKindLabel(item.kind);
    const copy = document.createElement('span');
    copy.className = 'mp-global-search-copy';
    const title = document.createElement('strong');
    title.textContent = item.label;
    const detail = document.createElement('small');
    detail.textContent = item.detail;
    copy.append(title, detail);
    row.append(kind, copy);
    row.addEventListener('click', () => selectGlobalSearchResult(item));
    return row;
  });
  host.replaceChildren(...rows);
}

function selectGlobalSearchResult(item: StudioSearchItem) {
  closeGlobalSearch();
  const kind = item.kind;
  if (kind === 'conversation') {
    void openConversation(String(item.target.conversationId || ''));
    return;
  }
  if (kind === 'project') {
    setActiveProject(String(item.target.workspaceRoot || ''));
    startNewChat();
    void renderSidebar();
    return;
  }
  if (kind === 'route') {
    const view = String(item.target.view || 'chat');
    if (view === 'changes' || view === 'browser' || view === 'tasks') {
      show('chat');
      setInspector(true, view);
    } else {
      show(view);
    }
    return;
  }
  const name = String(item.target.command || item.target.skill || '');
  const textarea = document.querySelector<HTMLTextAreaElement>('.dshw-input');
  if (!textarea || !name) return;
  textarea.value = `/${name} `;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
}

async function openGlobalSearch() {
  const overlay = document.getElementById('global-search');
  const toggle = document.getElementById('global-search-toggle');
  const input = document.getElementById('global-search-input') as HTMLInputElement | null;
  if (!overlay || !input) return;
  overlay.hidden = false;
  toggle?.setAttribute('aria-expanded', 'true');
  globalSearchActiveIndex = 0;
  input.value = '';
  renderGlobalSearchResults('');
  await refreshGlobalSearchIndex();
  renderGlobalSearchResults(input.value);
  input.focus();
}

function closeGlobalSearch() {
  const overlay = document.getElementById('global-search');
  if (overlay) overlay.hidden = true;
  document.getElementById('global-search-toggle')?.setAttribute('aria-expanded', 'false');
  visibleSearchResults = [];
  globalSearchActiveIndex = 0;
}

document.getElementById('global-search-toggle')?.addEventListener('click', () => {
  if (document.getElementById('global-search')?.hidden === false) closeGlobalSearch();
  else void openGlobalSearch();
});
document.querySelectorAll<HTMLElement>('[data-global-search-close]').forEach((element) => {
  element.addEventListener('click', closeGlobalSearch);
});
document.getElementById('global-search-input')?.addEventListener('input', (event) => {
  globalSearchActiveIndex = 0;
  renderGlobalSearchResults((event.currentTarget as HTMLInputElement).value);
});
document.getElementById('global-search-input')?.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!visibleSearchResults.length) return;
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    globalSearchActiveIndex = (globalSearchActiveIndex + direction + visibleSearchResults.length) % visibleSearchResults.length;
    renderGlobalSearchResults((event.currentTarget as HTMLInputElement).value);
    return;
  }
  if (event.key === 'Enter' && !event.isComposing) {
    const item = visibleSearchResults[globalSearchActiveIndex];
    if (item) {
      event.preventDefault();
      selectGlobalSearchResult(item);
    }
  }
});

function setConversationTab(tab: 'chat' | 'trajectory') {
  activeConversationTab = tab;
  const stream = document.getElementById('stream');
  const trajectory = document.getElementById('trajectory');
  const scrollbody = document.querySelector<HTMLElement>('.dshw-scrollbody');
  const homeVisible = document.getElementById('studio-home')?.hidden === false;
  if (stream) stream.hidden = homeVisible || tab !== 'chat';
  if (trajectory) trajectory.hidden = homeVisible || tab !== 'trajectory';
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
  activeConversationTurnCount = Array.isArray(c.turns) ? c.turns.length : 0;
  const projectRoot = String((c as { workspaceRoot?: string }).workspaceRoot || '');
  setActiveProject(projectRoot);
  show('chat');
  setStudioHomeVisible(false);
  document.querySelectorAll('#side-convos .side-item').forEach((n) =>
    (n as HTMLElement).classList.toggle('is-on', (n as HTMLElement).dataset.open === id));

  const head = document.getElementById('chat-title');
  if (head) head.textContent = String(c.title);
  renderProjectContext();
  const preview = document.getElementById('chat-source-preview');
  const sourceThumb = document.getElementById('chat-source-thumb') as HTMLImageElement | null;
  const peek = document.getElementById('chat-peek');
  const peekImage = document.getElementById('peek-image') as HTMLImageElement | null;
  const peekLabel = document.getElementById('peek-label');
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
    stream.innerHTML = emptyStateMarkup('ic-message-plus', '这条对话还没有内容', '继续输入任务，或从屏幕上划过一个对象作为上下文。');
    renderStatsLine([]);
    const trajectory = document.getElementById('trajectory');
    if (trajectory) trajectory.replaceChildren(DshTrajectory.render([]));
    setConversationTab(activeConversationTab);
    return;
  }
  // 每轮使用稳定的工具/思考结构；消息本身保持克制，操作在悬停时出现。
  const flow = document.createElement('div');
  flow.className = 'dsh-flow';
  for (const [turnIndex, t] of turns.entries()) {
    const branchTarget = { conversationId: c.id, turnIndex };
    if (t.question) flow.appendChild(DshChat.userNode(String(t.question), undefined, branchTarget));
    const host = document.createElement('div');
    host.className = 'dsh-flow-item';
    for (const node of DshChat.assistantTurnNode({
      answer: t.answer,
      thinking: t.thinking,
      trace: t.trace,
      events: t.events,
      activities: t.activities,
      trajectory: t.trajectory,
      modelUsage: t.modelUsage,
      failed: t.failed,
      at: t.at,
      conversationId: c.id,
      turnIndex,
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
  /* 会话重开后审批卡要能 reconstruct：最后一条 turn 若带着未消化的
     pendingInput（等待输入被打断/重启），卡重新长在 composer 上沿。
     已被回答过的旧提问不复活——只有最后一轮还在等才亮。 */
  const lastTurn = turns[turns.length - 1] as {
    pendingInput?: {
      question?: unknown;
      options?: unknown;
      kind?: unknown;
      tool?: unknown;
      prefix?: unknown;
    } | null;
    failed?: boolean;
  } | undefined;
  const lastPending = lastTurn && !lastTurn.failed && lastTurn.pendingInput && typeof lastTurn.pendingInput === 'object'
    ? lastTurn.pendingInput
    : null;
  const lastOptions = lastPending && Array.isArray(lastPending.options)
    ? (lastPending.options as unknown[]).map((o) => String(o)).filter(Boolean)
    : [];
  if (
    lastPending?.kind === 'permission'
    && String(lastPending.tool || '').trim()
  ) {
    pendingPermissionAsk = {
      tool: String(lastPending.tool),
      prefix: String(lastPending.prefix || '').trim() || undefined,
    };
    pendingAskInput = null;
    renderPermissionAsk();
  } else if (lastOptions.length >= 2) {
    pendingAskInput = {
      question: String(lastPending?.question || '需要你的决定'),
      options: lastOptions,
    };
    pendingPermissionAsk = null;
    renderPermissionAsk();
  }
  const trajectory = document.getElementById('trajectory');
  if (trajectory) trajectory.replaceChildren(DshTrajectory.render(DshTrajectory.project(turns)));
  setConversationTab(activeConversationTab);
}

/* 代理卡 → DSH 节点：后台任务补丁（进度/步骤/终态）就地换掉那一轮。 */
function renderDshCardNode(card: MagicPointerCard): HTMLElement {
  const host = document.createElement('div');
  host.className = 'dsh-assistant';
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
    host.innerHTML = emptyStateMarkup('ic-docs', '还没有产物', 'Agent 生成并落盘的文档、代码、表格与可编辑草稿会集中出现在这里。', { label: '去对话创建', view: 'chat' });
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
const SIDEBAR_COLLAPSE_KEY = 'mp:studio-sidebar-collapsed';
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
    const element = document.getElementById(id);
    if (element) element.hidden = (k !== view);
  });
  document.querySelectorAll<HTMLElement>('[data-goto]').forEach((item) => {
    item.classList.toggle('is-on', item.dataset.goto === view);
  });
  if (view === 'stash') { renderStash(true); bindCanvas(); }
  if (view === 'artifacts') renderArtifacts();
  if (view === 'settings') renderSettings();
  if (view !== 'chat') {
    closeAux();
    if (shell.dataset.inspector === 'open') setInspector(false);
    if (shell.dataset.bottomPanel === 'open') setBottomPanel(false);
  }
  recordWindowNavigation(view);
}

const windowViewHistory = ['chat'];
let windowViewHistoryIndex = 0;
let replayingWindowNavigation = false;

function syncWindowNavigation() {
  const back = document.getElementById('window-back') as HTMLButtonElement | null;
  const forward = document.getElementById('window-forward') as HTMLButtonElement | null;
  if (back) back.disabled = windowViewHistoryIndex <= 0;
  if (forward) forward.disabled = windowViewHistoryIndex >= windowViewHistory.length - 1;
}

function recordWindowNavigation(view: string) {
  if (replayingWindowNavigation || windowViewHistory[windowViewHistoryIndex] === view) {
    syncWindowNavigation();
    return;
  }
  windowViewHistory.splice(windowViewHistoryIndex + 1);
  windowViewHistory.push(view);
  windowViewHistoryIndex = windowViewHistory.length - 1;
  syncWindowNavigation();
}

function moveWindowNavigation(delta: number) {
  const next = windowViewHistoryIndex + delta;
  if (next < 0 || next >= windowViewHistory.length) return;
  windowViewHistoryIndex = next;
  replayingWindowNavigation = true;
  show(windowViewHistory[next]);
  replayingWindowNavigation = false;
  syncWindowNavigation();
}

document.getElementById('window-back')?.addEventListener('click', () => moveWindowNavigation(-1));
document.getElementById('window-forward')?.addEventListener('click', () => moveWindowNavigation(1));
syncWindowNavigation();

type ProductMode = 'walker' | 'design';
let productMode: ProductMode = 'walker';

function setProductMode(mode: ProductMode, navigate = true) {
  productMode = mode;
  shell.dataset.productMode = mode;
  document.querySelectorAll<HTMLElement>('[data-product-mode]').forEach((button) => {
    const selected = button.dataset.productMode === mode;
    button.classList.toggle('is-on', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  try { localStorage.setItem('mp:product-mode', mode); } catch { /* renderer storage unavailable */ }
  if (navigate) {
    show(mode === 'design' ? 'design' : 'chat');
    if (mode === 'design') {
      document.querySelectorAll<HTMLElement>('.mp-design-nav button').forEach((button) => button.classList.toggle('is-on', button.dataset.goto === 'design'));
    }
  }
}

(function bindProductMode() {
  try { productMode = localStorage.getItem('mp:product-mode') === 'design' ? 'design' : 'walker'; } catch { productMode = 'walker'; }
  setProductMode(productMode, false);
  document.getElementById('mode-work')?.addEventListener('click', () => setProductMode('walker'));
  document.getElementById('mode-design')?.addEventListener('click', () => setProductMode('design'));
})();

(function bindDesignHome() {
  document.querySelectorAll<HTMLElement>('[data-design-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.designAction;
      if (action === 'canvas' || action === 'list') {
        show('stash');
        requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(`#stash-mode [data-mode="${action}"]`)?.click();
        });
        return;
      }
      if (action === 'files') {
        show('design');
        setInspector(true, 'files');
        return;
      }
      if (action === 'artifacts') show('artifacts');
    });
  });
})();

function closeWindowMenu() {
  const popover = document.getElementById('window-menu-popover');
  if (popover) popover.hidden = true;
  document.querySelectorAll<HTMLElement>('[data-window-menu]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
  document.getElementById('app-menu')?.setAttribute('aria-expanded', 'false');
}

function openWindowMenu(button: HTMLElement, menuName: string) {
  const popover = document.getElementById('window-menu-popover');
  if (!popover) return;
  const wasOpen = !popover.hidden && button.getAttribute('aria-expanded') === 'true';
  closeWindowMenu();
  if (wasOpen) return;
  document.querySelectorAll<HTMLElement>('[data-window-menu-panel]').forEach((panel) => {
    panel.hidden = menuName !== 'all' && panel.dataset.windowMenuPanel !== menuName;
  });
  const rect = button.getBoundingClientRect();
  popover.style.left = `${Math.max(4, rect.left)}px`;
  popover.hidden = false;
  button.setAttribute('aria-expanded', 'true');
}

document.querySelectorAll<HTMLElement>('.mp-window-menu-bar [data-window-menu]').forEach((button) => {
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    openWindowMenu(button, button.dataset.windowMenu || 'file');
  });
  button.addEventListener('pointerenter', () => {
    if (document.getElementById('window-menu-popover')?.hidden === false) openWindowMenu(button, button.dataset.windowMenu || 'file');
  });
});

document.getElementById('app-menu')?.addEventListener('click', (event) => {
  event.stopPropagation();
  openWindowMenu(event.currentTarget as HTMLElement, 'all');
});

function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark');
  try { localStorage.setItem('mp:theme', theme); } catch { /* renderer storage unavailable */ }
  window.magicPointerDashboard?.setTheme?.(theme);
  const use = document.getElementById('theme-toggle-icon');
  use?.setAttribute('href', theme === 'dark' ? '#ic-sun' : '#ic-moon');
  const toggle = document.getElementById('theme-toggle');
  if (toggle) toggle.setAttribute('aria-label', theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
}

function toggleAnimatedTheme(origin?: { x: number; y: number }) {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  const documentWithTransition = document as Document & {
    startViewTransition?: (callback: () => void) => { ready: Promise<void> };
  };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!documentWithTransition.startViewTransition || reduceMotion) { applyTheme(next); return; }
  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? 22;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const transition = documentWithTransition.startViewTransition(() => applyTheme(next));
  void transition.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 400, easing: 'cubic-bezier(.2,.8,.2,1)', pseudoElement: '::view-transition-new(root)' } as KeyframeAnimationOptions,
    );
  }).catch(() => {});
}

(function bindVisibleThemeToggle() {
  const button = document.getElementById('theme-toggle');
  const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  document.body.toggleAttribute('data-ds-dark-theme', current === 'dark');
  const use = document.getElementById('theme-toggle-icon');
  use?.setAttribute('href', current === 'dark' ? '#ic-sun' : '#ic-moon');
  button?.setAttribute('aria-label', current === 'dark' ? '切换到浅色主题' : '切换到深色主题');
  button?.addEventListener('click', () => {
    const rect = button.getBoundingClientRect();
    toggleAnimatedTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  });
})();

function openInformationDialog(title: string, detail: string) {
  const overlay = document.createElement('div');
  overlay.className = 'dshw-perm-confirm';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const card = document.createElement('div');
  card.className = 'dshw-perm-confirm-card';
  const heading = document.createElement('b');
  heading.textContent = title;
  const body = document.createElement('p');
  body.style.whiteSpace = 'pre-line';
  body.textContent = detail;
  const actions = document.createElement('div');
  actions.className = 'dshw-perm-confirm-actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'is-primary';
  close.textContent = '完成';
  close.addEventListener('click', () => overlay.remove());
  actions.appendChild(close);
  card.append(heading, body, actions);
  overlay.appendChild(card);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  close.focus();
}

async function executeWindowMenuCommand(command: string, origin?: HTMLElement) {
  closeWindowMenu();
  if (command === 'new-chat') { setProductMode('walker'); startNewChat(); return; }
  if (command === 'open-project') { await openProjectFromPicker(); return; }
  if (command === 'add-files') {
    if (!activeProjectRoot) { renderProjectContext(); return; }
    const picked = await Data.pickProjectFiles(activeProjectRoot);
    if (picked?.ok && Array.isArray(picked.paths)) {
      composerAttachments = [...new Set([...composerAttachments, ...picked.paths.map(String)])];
      renderComposerAttachments();
      setProductMode('walker');
    }
    return;
  }
  if (command === 'open-project-folder') { if (activeProjectRoot) await Data.openProjectPath(activeProjectRoot, ''); return; }
  if (command === 'toggle-sidebar') { setSidebarCollapsed(shell.dataset.sidebar !== 'collapsed'); return; }
  if (command === 'toggle-inspector') { setInspector(shell.dataset.inspector !== 'open', activeInspectorTab); return; }
  if (command === 'toggle-bottom-panel') { setBottomPanel(shell.dataset.bottomPanel !== 'open'); return; }
  if (command === 'toggle-theme') {
    const rect = origin?.getBoundingClientRect();
    toggleAnimatedTheme(rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : undefined);
    return;
  }
  if (command === 'settings') { show('settings'); return; }
  if (command === 'shortcuts') {
    openInformationDialog('键盘快捷键', 'Ctrl+N  新建对话\nCtrl+O  打开项目\nCtrl+B  切换侧栏\nCtrl+Shift+B  切换项目面板\nCtrl+J  切换底部面板\nCtrl+,  设置\nCtrl+/  快捷键');
    return;
  }
  if (command === 'about') {
    const result = await Data.windowCommand('about');
    openInformationDialog('关于', `Magic Pointer ${result.version || ''}\nElectron ${result.electron || ''}\nChromium ${result.chrome || ''}`);
    return;
  }
  await Data.windowCommand(command);
}

document.getElementById('window-menu-popover')?.addEventListener('click', (event) => {
  const command = (event.target as Element | null)?.closest<HTMLElement>('[data-window-command]');
  if (command) void executeWindowMenuCommand(command.dataset.windowCommand || '', command);
});

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey
      && event.key.toLocaleLowerCase() === 'k') {
    event.preventDefault();
    void openGlobalSearch();
    return;
  }
  if (event.key === 'Escape') {
    const globalSearchOpen = document.getElementById('global-search')?.hidden === false;
    if (globalSearchOpen) {
      event.preventDefault();
      closeGlobalSearch();
      return;
    }
    const menuWasOpen = [
      'window-menu-popover',
      'magic-brain-popover',
      'composer-add-menu',
      'composer-style-menu',
      'composer-permission-menu',
      'composer-model-menu',
      'composer-options-menu',
      'composer-usage-popover',
    ].some((id) => document.getElementById(id)?.hidden === false)
      || Boolean(document.getElementById('thread-menu'))
      || Boolean(document.querySelector('.side-session-menu:not([hidden])'));
    closeWindowMenu();
    closeThreadMenu();
    closeSlashMenu();
    closeStyleMenu();
    closePermissionMenu();
    closeModelMenu();
    const brain = document.getElementById('magic-brain-popover');
    if (brain) brain.hidden = true;
    document.getElementById('magic-brain-toggle')?.setAttribute('aria-expanded', 'false');
    const optionsMenu = document.getElementById('composer-options-menu');
    if (optionsMenu) optionsMenu.hidden = true;
    document.getElementById('composer-options')?.setAttribute('aria-expanded', 'false');
    const usagePopover = document.getElementById('composer-usage-popover');
    if (usagePopover) usagePopover.hidden = true;
    document.getElementById('composer-context')?.setAttribute('aria-expanded', 'false');
    document.querySelectorAll<HTMLElement>('.side-session-menu:not([hidden])')
      .forEach((menu) => { menu.hidden = true; });
    if (!menuWasOpen && studioComposerBusy && pendingConversation) {
      void stopActiveConversation();
    }
    return;
  }
  if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); moveWindowNavigation(-1); return; }
  if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); moveWindowNavigation(1); return; }
  if (!event.ctrlKey || event.altKey) return;
  const key = event.key.toLocaleLowerCase();
  const command = key === 'n' ? 'new-chat'
    : key === 'o' ? 'open-project'
      : key === 'b' && event.shiftKey ? 'toggle-inspector'
        : key === 'b' ? 'toggle-sidebar'
          : key === 'j' ? 'toggle-bottom-panel'
            : key === ',' ? 'settings'
              : key === '/' ? 'shortcuts'
                : '';
  if (!command) return;
  event.preventDefault();
  void executeWindowMenuCommand(command);
});

document.addEventListener('mp:branch-conversation', (event: Event) => {
  const detail = (event as CustomEvent<{ conversationId?: string; turnIndex?: number }>).detail;
  const conversationId = String(detail?.conversationId || '');
  const turnIndex = Number(detail?.turnIndex);
  if (!conversationId || !Number.isInteger(turnIndex)) return;
  void Data.branchConversation(conversationId, turnIndex).then(async (result) => {
    if (!result?.ok || !result.conversation?.id) return;
    await renderSidebar();
    await openConversation(result.conversation.id);
  });
});

function setSidebarCollapsed(collapsed: boolean, persist = true) {
  shell.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
  const button = document.getElementById('sidebar-toggle');
  button?.setAttribute('aria-pressed', String(collapsed));
  button?.setAttribute('aria-label', collapsed ? '展开侧栏' : '折叠侧栏');
  if (button instanceof HTMLElement) button.title = collapsed ? '展开侧栏' : '折叠侧栏';
  if (persist) {
    try { localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* renderer storage unavailable */ }
  }
}

(function bindSidebarCollapse() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === '1'; } catch { /* use expanded */ }
  setSidebarCollapsed(collapsed, false);
  document.getElementById('sidebar-toggle')?.addEventListener('click', (event) => {
    event.stopPropagation();
    setSidebarCollapsed(shell.dataset.sidebar !== 'collapsed');
  });
})();

function openAux() { aux.hidden = false; shell.classList.add('has-aux'); }
function closeAux() { shell.classList.remove('has-aux'); setTimeout(() => { aux.hidden = true; }, 240); }

function closeThreadMenu() {
  document.getElementById('thread-menu')?.remove();
  document.getElementById('thread-more')?.setAttribute('aria-expanded', 'false');
}

function openThreadMenu(button: HTMLElement) {
  closeThreadMenu();
  const menu = document.createElement('div');
  menu.id = 'thread-menu';
  menu.className = 'mp-thread-menu';
  menu.setAttribute('role', 'menu');
  const make = (label: string, run: () => void, options: { danger?: boolean; disabled?: boolean } = {}) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.disabled = options.disabled === true;
    item.classList.toggle('is-danger', options.danger === true);
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      closeThreadMenu();
      run();
    });
    return item;
  };
  const unavailable = !activeConversationId;
  menu.append(
    make('重命名', () => {
      if (activeConversationId) openRenameDialog(activeConversationId, document.getElementById('chat-title')?.textContent || '');
    }, { disabled: unavailable }),
    make('从当前结果分支', () => {
      if (!activeConversationId || activeConversationTurnCount < 1) return;
      void Data.branchConversation(activeConversationId, activeConversationTurnCount - 1).then(async (result) => {
        if (!result?.ok || !result.conversation?.id) return;
        await renderSidebar();
        await openConversation(result.conversation.id);
      });
    }, { disabled: unavailable || activeConversationTurnCount < 1 }),
    make('导出 Session log', () => {
      if (activeConversationId) void Data.exportConversation(activeConversationId);
    }, { disabled: unavailable }),
    make('删除对话', () => {
      if (!activeConversationId) return;
      const id = activeConversationId;
      startNewChat();
      void Data.deleteConversation(id).then(() => renderSidebar());
    }, { danger: true, disabled: unavailable }),
  );
  document.body.appendChild(menu);
  const rect = button.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  button.setAttribute('aria-expanded', 'true');
}

document.getElementById('thread-more')?.addEventListener('click', (event) => {
  event.stopPropagation();
  const button = event.currentTarget as HTMLElement;
  if (document.getElementById('thread-menu')) closeThreadMenu();
  else openThreadMenu(button);
});

type ProjectTreeEntry = { name: string; path: string; kind: 'directory' | 'file' };
const projectTreeCache = new Map<string, ProjectTreeEntry[]>();
const expandedProjectDirectories = new Set<string>(['']);
let selectedProjectFile = '';
let activeInspectorTab = 'files';
interface InspectorState {
  open: boolean;
  maximized: boolean;
  width: number;
  previousWidth: number;
  tab: string;
}
interface InspectorStateModule {
  clampInspectorWidth(desired: unknown, availableWidth: unknown): number;
  reduceInspectorState(state: InspectorState, action: Record<string, unknown>): InspectorState;
}
const inspectorStatePolicy = (globalThis as { StudioInspectorState?: InspectorStateModule }).StudioInspectorState!;
const INSPECTOR_WIDTH_KEY = 'mp:inspector-width';
let initialInspectorWidth = 560;
try {
  const stored = Number(localStorage.getItem(INSPECTOR_WIDTH_KEY));
  if (Number.isFinite(stored)) initialInspectorWidth = stored;
} catch { /* storage unavailable */ }
let inspectorState: InspectorState = {
  open: false,
  maximized: false,
  width: inspectorStatePolicy.clampInspectorWidth(initialInspectorWidth, window.innerWidth),
  previousWidth: inspectorStatePolicy.clampInspectorWidth(initialInspectorWidth, window.innerWidth),
  tab: 'files',
};
let inspectorMaximized = false;
/* sv 文件树动效:刚展开的目录(下一帧翻开入场)/ 收起退场动画的落盘定时器。 */
let lastExpandedTreeDirectory = '';
let pendingTreeCollapseTimer: ReturnType<typeof setTimeout> | null = null;

function inspectorError(message: string) {
  const host = document.getElementById('project-file-tree');
  if (host) host.innerHTML = `<p class="mp-inspector-empty">${esc(message)}</p>`;
}

function renderProjectFileTree() {
  const host = document.getElementById('project-file-tree');
  if (!host) return;
  const query = (document.getElementById('file-tree-filter') as HTMLInputElement | null)?.value.trim().toLocaleLowerCase() || '';
  /* file-tree(sv-animations,MIT):目录子树包进 .sv-tree-branch,
     展开 = grid-template-rows 0fr→1fr + opacity(200ms easeInOut),
     刚展开的分支先以收起态入 DOM,下一帧再翻开,入场动画才会跑。 */
  const freshDirectory = lastExpandedTreeDirectory;
  lastExpandedTreeDirectory = '';
  const buildLevel = (directory: string, depth: number): Node[] => {
    const nodes: Node[] = [];
    for (const entry of projectTreeCache.get(directory) || []) {
      if (query && !entry.name.toLocaleLowerCase().includes(query) && entry.kind !== 'directory') continue;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'mp-file-tree-row' + (entry.path === selectedProjectFile ? ' is-on' : '');
      row.dataset.projectPath = entry.path;
      row.dataset.projectKind = entry.kind;
      row.dataset.depth = String(depth);
      row.style.setProperty('--item-index', String(nodes.length));
      row.style.setProperty('--tree-depth', String(depth));
      row.style.setProperty('--tree-guide-left', `${14 + Math.max(0, depth - 1) * 20}px`);
      row.style.paddingLeft = `${depth * 20}px`;
      const expanded = entry.kind === 'directory' && expandedProjectDirectories.has(entry.path);
      if (entry.kind === 'directory') row.setAttribute('aria-expanded', String(expanded));
      /* file-tree(sv-animations,MIT) 逐字：展开行只有图标本身翻转 open/closed，
         没有额外 chevron——参考源码 folder.svelte 默认图标就是唯一的展开指示。 */
      row.innerHTML = `${entry.kind === 'directory'
        ? icon(expanded ? 'ic-tree-folder-open' : 'ic-tree-folder')
        : icon('ic-tree-file')}<span>${esc(entry.name)}</span>`;
      nodes.push(row);
      if (!expanded) continue;
      const branch = document.createElement('div');
      branch.className = 'sv-tree-branch';
      branch.style.setProperty('--sv-guide-left', `${13 + depth * 20}px`);
      const inner = document.createElement('div');
      inner.className = 'sv-tree-branch-inner';
      for (const child of buildLevel(entry.path, depth + 1)) inner.appendChild(child);
      branch.appendChild(inner);
      if (entry.path !== freshDirectory) branch.classList.add('is-open');
      else requestAnimationFrame(() => { branch.classList.add('is-open'); });
      nodes.push(branch);
    }
    return nodes;
  };
  const roots = buildLevel('', 0);
  if (!roots.length) {
    const empty = document.createElement('p');
    empty.className = 'mp-inspector-empty';
    empty.textContent = query ? '没有匹配文件。' : '项目中没有可显示的文件。';
    roots.push(empty);
  }
  host.replaceChildren(...roots);
}

async function loadProjectDirectory(relativePath = '') {
  if (!activeProjectRoot) { inspectorError('请先打开项目。'); return; }
  const response = await Data.projectTree(activeProjectRoot, relativePath);
  if (!response?.ok) { inspectorError(response?.error || '文件树读取失败。'); return; }
  projectTreeCache.set(relativePath, response.entries || []);
  renderProjectFileTree();
}

async function refreshProjectInspector() {
  projectTreeCache.clear();
  expandedProjectDirectories.clear();
  expandedProjectDirectories.add('');
  selectedProjectFile = '';
  const preview = document.getElementById('project-file-preview');
  if (preview) preview.hidden = true;
  if (activeProjectRoot) await loadProjectDirectory('');
  else inspectorError('请先打开项目。');
  if (activeInspectorTab === 'changes') await renderProjectChanges();
}

async function selectProjectFile(relativePath: string) {
  const response = await Data.readProjectFile(activeProjectRoot, relativePath);
  const preview = document.getElementById('project-file-preview');
  if (!preview) return;
  preview.hidden = false;
  selectedProjectFile = relativePath;
  const name = document.getElementById('project-file-name');
  const content = document.getElementById('project-file-content');
  if (name) name.textContent = relativePath + (response?.truncated ? ' · 已截断' : '');
  if (content) content.textContent = response?.ok ? String(response.text || '') : String(response?.error || '文件读取失败。');
  renderProjectFileTree();
}

let projectEnvironment: MagicPointerProjectEnvironment | null = null;

async function renderMagicBrain(force = false) {
  const popover = document.getElementById('magic-brain-popover');
  if (!popover) return;
  const projectName = activeProjectRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '当前项目';
  const project = document.getElementById('magic-brain-project');
  if (project) project.textContent = projectName;
  if (!activeProjectRoot) {
    projectEnvironment = null;
    document.getElementById('magic-brain-changes-detail')!.textContent = '请先打开项目';
    document.getElementById('magic-brain-branch-name')!.textContent = 'Git 分支';
    document.getElementById('magic-brain-branch-detail')!.textContent = '没有项目环境';
    document.getElementById('magic-brain-source-list')!.innerHTML = '<p>打开项目并开始任务后显示来源。</p>';
    return;
  }
  if (!force && projectEnvironment?.root === activeProjectRoot) return;
  document.getElementById('magic-brain-changes-detail')!.textContent = '正在读取…';
  document.getElementById('magic-brain-branch-detail')!.textContent = '正在读取…';
  const response = await Data.projectEnvironment(activeProjectRoot, activeConversationId);
  projectEnvironment = response;
  const changes = Number(response.changedFiles || 0);
  const added = Number(response.addedLines || 0);
  const deleted = Number(response.deletedLines || 0);
  document.getElementById('magic-brain-changes-detail')!.textContent = response.ok
    ? (changes ? `${changes} 个文件 · +${added} −${deleted}` : '工作树干净')
    : String(response.error || '读取失败');
  document.getElementById('magic-brain-branch-name')!.textContent = response.branch || (response.isGit ? 'Git 仓库' : '未初始化 Git');
  const sync: string[] = [];
  if (response.upstream) sync.push(response.upstream);
  if (response.ahead) sync.push(`领先 ${response.ahead}`);
  if (response.behind) sync.push(`落后 ${response.behind}`);
  document.getElementById('magic-brain-branch-detail')!.textContent = sync.join(' · ') || (response.remoteUrl ? '已连接远程仓库' : '仅本地项目');
  const sourceHost = document.getElementById('magic-brain-source-list');
  if (!sourceHost) return;
  const sources = Array.isArray(response.sources) ? response.sources : [];
  sourceHost.replaceChildren(...sources.map((url, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mp-brain-source';
    button.dataset.sourceUrl = url;
    button.style.setProperty('--item-index', String(index));
    let label = url;
    try { const parsed = new URL(url); label = `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`; } catch { /* show raw URL */ }
    button.innerHTML = `${icon('ic-globe', 'codex-icon')}<span>${esc(label)}</span>`;
    button.title = url;
    return button;
  }));
  if (!sources.length) sourceHost.innerHTML = '<p>当前任务尚无网页来源。</p>';
}

document.getElementById('header-open-location')?.addEventListener('click', () => {
  if (activeProjectRoot) void Data.openProjectPath(activeProjectRoot, '');
  else void openProjectFromPicker();
});
document.getElementById('magic-brain-toggle')?.addEventListener('click', (event) => {
  event.stopPropagation();
  const popover = document.getElementById('magic-brain-popover');
  const button = event.currentTarget as HTMLElement;
  if (!popover) return;
  popover.hidden = !popover.hidden;
  button.setAttribute('aria-expanded', String(!popover.hidden));
  if (!popover.hidden) void renderMagicBrain(true);
});
document.getElementById('magic-brain-changes')?.addEventListener('click', () => {
  document.getElementById('magic-brain-popover')!.hidden = true;
  document.getElementById('magic-brain-toggle')?.setAttribute('aria-expanded', 'false');
  setInspector(true, 'changes');
});
document.getElementById('magic-brain-branch')?.addEventListener('click', () => {
  const url = projectEnvironment?.pullRequestUrl || projectEnvironment?.remoteUrl || '';
  if (url) void Data.openProjectUrl(url);
  else setInspector(true, 'changes');
});
document.getElementById('magic-brain-sources')?.addEventListener('click', (event) => {
  const source = (event.target as Element | null)?.closest<HTMLElement>('[data-source-url]');
  if (!source?.dataset.sourceUrl) return;
  setInspector(true, 'browser');
  const input = document.getElementById('project-browser-url') as HTMLInputElement | null;
  if (input) input.value = source.dataset.sourceUrl;
  void openProjectBrowser(source.dataset.sourceUrl);
});

async function renderProjectChanges() {
  const host = document.getElementById('project-changes');
  if (!host) return;
  if (!activeProjectRoot) { host.innerHTML = '<p class="mp-inspector-empty">请先打开项目。</p>'; return; }
  host.innerHTML = '<p class="mp-inspector-empty">正在读取 Git 工作树…</p>';
  const response = await Data.projectEnvironment(activeProjectRoot, activeConversationId);
  projectEnvironment = response;
  if (!response.ok) { host.innerHTML = `<p class="mp-inspector-empty">${esc(response.error || 'Git 环境读取失败。')}</p>`; return; }
  const header = document.createElement('header');
  header.className = 'mp-changes-header';
  const branch = document.createElement('span');
  branch.innerHTML = `${icon('ic-branch', 'codex-icon')}<strong>${esc(response.branch || '本地项目')}</strong>`;
  const count = document.createElement('small');
  count.textContent = `${Number(response.changedFiles || 0)} 个变更 · +${Number(response.addedLines || 0)} −${Number(response.deletedLines || 0)}`;
  header.append(branch, count);
  const list = document.createElement('div');
  list.className = 'mp-change-list';
  for (const [index, change] of (response.fileChanges || []).entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mp-change-row';
    button.dataset.changePath = change.path;
    button.style.setProperty('--item-index', String(index));
    button.innerHTML = `<span class="mp-change-status">${esc(change.status || 'M')}</span><span>${esc(change.path)}</span>${change.staged ? '<small>已暂存</small>' : ''}`;
    list.appendChild(button);
  }
  if (!list.childElementCount) list.innerHTML = '<p class="mp-inspector-empty">工作树干净。</p>';
  host.replaceChildren(header, list);
}

document.getElementById('project-changes')?.addEventListener('click', (event) => {
  const row = (event.target as Element | null)?.closest<HTMLElement>('[data-change-path]');
  if (!row?.dataset.changePath) return;
  setInspector(true, 'files');
  void selectProjectFile(row.dataset.changePath);
});

let browserViewVisible = false;
let latestBrowserViewState: MagicPointerBrowserViewState = {};

function projectBrowserBounds() {
  const host = document.getElementById('project-browser-host');
  if (!host) return null;
  const rect = host.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

function renderBrowserViewState(state: MagicPointerBrowserViewState) {
  latestBrowserViewState = { ...latestBrowserViewState, ...state };
  const input = document.getElementById('project-browser-url') as HTMLInputElement | null;
  if (input && state.url && document.activeElement !== input) input.value = state.url;
  const back = document.getElementById('project-browser-back') as HTMLButtonElement | null;
  const forward = document.getElementById('project-browser-forward') as HTMLButtonElement | null;
  const reload = document.getElementById('project-browser-reload');
  if (back) back.disabled = !state.canGoBack;
  if (forward) forward.disabled = !state.canGoForward;
  if (reload) {
    reload.setAttribute('aria-label', state.loading ? '停止加载' : '重新加载');
    reload.setAttribute('title', state.loading ? '停止加载' : '重新加载');
  }
  if (state.title) document.getElementById('inspector-browser')?.setAttribute('aria-label', state.title);
}

async function openProjectBrowser(rawUrl: string) {
  const bounds = projectBrowserBounds();
  if (!bounds) return;
  const empty = document.getElementById('project-browser-empty');
  const response = await Data.openBrowserView(rawUrl, bounds);
  browserViewVisible = response?.ok === true;
  if (empty) empty.hidden = browserViewVisible;
  if (response?.state) renderBrowserViewState(response.state);
  if (!response?.ok && empty) {
    empty.hidden = false;
    const message = empty.querySelector('p');
    if (message) message.textContent = String(response?.error || '网页打开失败。');
  }
}

function resizeProjectBrowser() {
  if (!browserViewVisible || activeInspectorTab !== 'browser' || shell.dataset.inspector !== 'open') return;
  const bounds = projectBrowserBounds();
  if (bounds) void Data.resizeBrowserView(bounds);
}

let projectBrowserResizeFrame: number | null = null;

function scheduleProjectBrowserResize() {
  if (projectBrowserResizeFrame !== null) return;
  projectBrowserResizeFrame = requestAnimationFrame(() => {
    projectBrowserResizeFrame = null;
    resizeProjectBrowser();
  });
}

function closeProjectBrowserView() {
  if (!browserViewVisible) return;
  browserViewVisible = false;
  void Data.browserViewCommand('close');
}

Data.onBrowserViewState((state) => renderBrowserViewState(state));
const projectBrowserHost = document.getElementById('project-browser-host');
if (projectBrowserHost && typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => scheduleProjectBrowserResize()).observe(projectBrowserHost);
}
window.addEventListener('resize', scheduleProjectBrowserResize);

function inspectorAvailableWidth(): number {
  const sidebarWidth = shell.dataset.sidebar === 'collapsed' ? 44 : 288;
  return Math.max(0, shell.clientWidth - sidebarWidth);
}

function syncInspectorGeometry() {
  const inspector = document.getElementById('project-inspector');
  const maximize = document.getElementById('inspector-maximize');
  if (!inspector) return;
  inspectorMaximized = inspectorState.maximized;
  inspector.hidden = !inspectorState.open;
  inspector.style.width = inspectorState.maximized ? '' : `${inspectorState.width}px`;
  if (inspectorState.open) shell.dataset.inspector = 'open';
  else delete shell.dataset.inspector;
  if (inspectorState.maximized) shell.dataset.inspectorMaximized = 'true';
  else delete shell.dataset.inspectorMaximized;
  maximize?.setAttribute('aria-pressed', String(inspectorState.maximized));
  maximize?.setAttribute('aria-label', inspectorState.maximized ? '还原项目面板' : '展开项目面板');
  try { localStorage.setItem(INSPECTOR_WIDTH_KEY, String(inspectorState.width)); } catch { /* storage unavailable */ }
  document.getElementById('inspector-toggle')?.setAttribute('aria-expanded', String(inspectorState.open));
  scheduleProjectBrowserResize();
}

function setInspector(open: boolean, tab = activeInspectorTab) {
  const inspector = document.getElementById('project-inspector');
  if (!inspector) return;
  inspectorState = inspectorStatePolicy.reduceInspectorState(
    inspectorState,
    open ? { type: 'open', tab } : { type: 'close' },
  );
  activeInspectorTab = inspectorState.tab;
  syncInspectorGeometry();
  document.querySelectorAll<HTMLElement>('[data-inspector-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.inspectorPanel !== activeInspectorTab;
  });
  document.querySelectorAll<HTMLElement>('.mp-inspector-tabs [data-inspector-tab]').forEach((button) => {
    const active = button.dataset.inspectorTab === activeInspectorTab;
    button.classList.toggle('is-on', active);
    button.setAttribute('aria-selected', String(active));
  });
  const inspectorTitle = document.getElementById('inspector-title');
  if (inspectorTitle) {
    inspectorTitle.textContent = ({ files: '文件', browser: '浏览器', terminal: '终端', changes: '更改', tasks: '任务' } as Record<string, string>)[activeInspectorTab] || '项目';
  }
  if (!open) { closeProjectBrowserView(); return; }
  if (activeInspectorTab !== 'browser') closeProjectBrowserView();
  if (activeInspectorTab === 'files' && !projectTreeCache.has('')) void refreshProjectInspector();
  if (activeInspectorTab === 'changes') void renderProjectChanges();
  if (activeInspectorTab === 'browser') scheduleProjectBrowserResize();
}

document.getElementById('inspector-toggle')?.addEventListener('click', () => {
  setInspector(shell.dataset.inspector !== 'open', 'files');
});
document.getElementById('inspector-close')?.addEventListener('click', () => setInspector(false));
document.getElementById('inspector-maximize')?.addEventListener('click', () => {
  inspectorState = inspectorStatePolicy.reduceInspectorState(
    inspectorState,
    { type: inspectorState.maximized ? 'restore' : 'maximize' },
  );
  syncInspectorGeometry();
});

document.getElementById('inspector-resize-handle')?.addEventListener('pointerdown', (event) => {
  if (inspectorState.maximized) return;
  const handle = event.currentTarget as HTMLElement;
  const startX = event.clientX;
  const startWidth = inspectorState.width;
  handle.dataset.dragging = 'true';
  handle.setPointerCapture(event.pointerId);
  const move = (moveEvent: PointerEvent) => {
    inspectorState = inspectorStatePolicy.reduceInspectorState(inspectorState, {
      type: 'resize',
      width: startWidth + startX - moveEvent.clientX,
      availableWidth: inspectorAvailableWidth(),
    });
    syncInspectorGeometry();
  };
  const finish = () => {
    delete handle.dataset.dragging;
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', finish);
    handle.removeEventListener('pointercancel', finish);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
});
document.getElementById('project-file-tree')?.addEventListener('click', (event) => {
  const row = (event.target as Element | null)?.closest<HTMLElement>('[data-project-path]');
  if (!row) return;
  const relativePath = row.dataset.projectPath || '';
  if (row.dataset.projectKind === 'directory') {
    if (expandedProjectDirectories.has(relativePath)) {
      expandedProjectDirectories.delete(relativePath);
      /* 收起时先播 200ms 退场(folder.svelte AnimatePresence),再落盘重渲。 */
      const branch = row.nextElementSibling;
      if (pendingTreeCollapseTimer !== null) clearTimeout(pendingTreeCollapseTimer);
      if (branch?.classList.contains('sv-tree-branch')) {
        branch.classList.remove('is-open');
        pendingTreeCollapseTimer = setTimeout(() => { pendingTreeCollapseTimer = null; renderProjectFileTree(); }, 220);
      } else {
        renderProjectFileTree();
      }
    } else {
      expandedProjectDirectories.add(relativePath);
      lastExpandedTreeDirectory = relativePath;
      if (projectTreeCache.has(relativePath)) renderProjectFileTree();
      else void loadProjectDirectory(relativePath);
    }
    return;
  }
  void selectProjectFile(relativePath);
});
document.getElementById('project-file-tree')?.addEventListener('contextmenu', (event) => {
  const row = (event.target as Element | null)?.closest<HTMLElement>('[data-project-path]');
  if (!row || !activeProjectRoot) return;
  event.preventDefault();
  const relativePath = row.dataset.projectPath || '';
  const kind = row.dataset.projectKind === 'directory' ? 'directory' : 'file';
  void Data.showProjectContextMenu(activeProjectRoot, relativePath, kind).then((result) => {
    if (!result?.ok) return;
    if (result.action === 'preview' && kind === 'file') void selectProjectFile(relativePath);
    if (result.action === 'terminal-here') {
      activeTerminalRelativeDirectory = relativePath;
      setBottomPanel(true);
      renderTerminalPrompt();
    }
  });
});
document.getElementById('file-tree-filter')?.addEventListener('input', renderProjectFileTree);
document.getElementById('project-file-open')?.addEventListener('click', () => {
  if (selectedProjectFile) void Data.openProjectPath(activeProjectRoot, selectedProjectFile);
});
document.getElementById('project-browser-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('project-browser-url') as HTMLInputElement | null;
  if (input?.value.trim()) void openProjectBrowser(input.value.trim());
});
document.getElementById('project-browser-back')?.addEventListener('click', () => { void Data.browserViewCommand('back'); });
document.getElementById('project-browser-forward')?.addEventListener('click', () => { void Data.browserViewCommand('forward'); });
document.getElementById('project-browser-reload')?.addEventListener('click', () => {
  void Data.browserViewCommand(latestBrowserViewState.loading ? 'stop' : 'reload');
});
document.getElementById('project-browser-external')?.addEventListener('click', () => {
  if (browserViewVisible) void Data.browserViewCommand('external');
  else {
    const url = (document.getElementById('project-browser-url') as HTMLInputElement | null)?.value.trim();
    if (url) void Data.openProjectUrl(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  }
});

let activeTerminalRelativeDirectory = '';

function renderTerminalPrompt() {
  const suffix = activeTerminalRelativeDirectory ? `\\${activeTerminalRelativeDirectory.replace(/\//g, '\\')}` : '';
  for (const id of ['project-terminal-output', 'bottom-terminal-output']) {
    const output = document.getElementById(id);
    const label = output?.querySelector('span');
    if (label) label.textContent = `PowerShell · 当前项目${suffix}`;
  }
}

async function runTerminalCommand(command: string, output: HTMLElement) {
  if (!command || !activeProjectRoot) return;
  output.textContent += `\n> ${command}\n`;
  const result = await Data.runProjectCommand(activeProjectRoot, command, activeTerminalRelativeDirectory);
  output.textContent += `${String(result.output || result.error || '')}\n`;
  output.scrollTop = output.scrollHeight;
}

for (const pair of [
  ['project-terminal-form', 'project-terminal-input', 'project-terminal-output'],
  ['bottom-terminal-form', 'bottom-terminal-input', 'bottom-terminal-output'],
] as const) {
  document.getElementById(pair[0])?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById(pair[1]) as HTMLInputElement | null;
    const output = document.getElementById(pair[2]);
    const command = input?.value.trim() || '';
    if (!command || !output) return;
    input!.value = '';
    void runTerminalCommand(command, output);
  });
}

function setBottomPanel(open: boolean) {
  const panel = document.getElementById('bottom-panel');
  if (!panel) return;
  panel.hidden = !open;
  if (open) shell.dataset.bottomPanel = 'open';
  else delete shell.dataset.bottomPanel;
  document.getElementById('bottom-panel-toggle')?.setAttribute('aria-expanded', String(open));
  if (open) {
    renderTerminalPrompt();
    requestAnimationFrame(() => (document.getElementById('bottom-terminal-input') as HTMLInputElement | null)?.focus());
  }
}

document.getElementById('bottom-panel-toggle')?.addEventListener('click', () => setBottomPanel(shell.dataset.bottomPanel !== 'open'));
document.getElementById('bottom-panel-close')?.addEventListener('click', () => setBottomPanel(false));

let dictationPrefix = '';
let studioDictating = false;
document.getElementById('composer-voice')?.addEventListener('click', () => {
  const api = window.magicPointerDashboard;
  const button = document.getElementById('composer-voice');
  if (studioDictating) {
    api?.stopDictation?.({ graceful: true });
    studioDictating = false;
    button?.classList.remove('is-recording');
    return;
  }
  const textarea = document.querySelector<HTMLTextAreaElement>('#composer-form textarea');
  dictationPrefix = textarea?.value || '';
  studioDictating = true;
  button?.classList.add('is-recording');
  button?.setAttribute('title', '停止语音输入');
  api?.startDictation?.();
});
window.magicPointerDashboard?.onDictationResult?.((payload) => {
  if (payload.surface !== 'dashboard') return;
  const textarea = document.querySelector<HTMLTextAreaElement>('#composer-form textarea');
  const button = document.getElementById('composer-voice');
  if (payload.transcript && textarea) {
    textarea.value = `${dictationPrefix}${dictationPrefix && !/\s$/.test(dictationPrefix) ? ' ' : ''}${payload.transcript}`;
    fitComposer(textarea);
  }
  if (payload.final || payload.ok === false) {
    studioDictating = false;
    button?.classList.remove('is-recording');
    button?.setAttribute('title', payload.ok === false ? String(payload.error || '语音输入失败') : '语音输入');
    textarea?.focus();
  }
});

let pluginDirectoryCatalog: MagicPointerSlashDirectory | null = null;
let pluginDirectoryKind: 'skills' | 'commands' = 'skills';

function closePluginDirectory() {
  const overlay = document.getElementById('plugin-directory');
  if (overlay) overlay.hidden = true;
  document.getElementById('nav-plugins')?.classList.remove('is-on');
}

function renderPluginDirectory() {
  const host = document.getElementById('plugin-directory-list');
  if (!host) return;
  const query = (document.getElementById('plugin-directory-search') as HTMLInputElement | null)?.value.trim().toLocaleLowerCase() || '';
  const entries = (pluginDirectoryKind === 'skills' ? pluginDirectoryCatalog?.skills : pluginDirectoryCatalog?.commands) || [];
  const filtered = entries.filter((entry) => [entry.name, entry.description, entry.whenToUse, entry.source]
    .filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
  document.getElementById('plugin-directory-kind-label')!.textContent = pluginDirectoryKind === 'skills' ? '已安装技能' : '可用命令';
  document.getElementById('plugin-directory-count')!.textContent = `${filtered.length} 项`;
  host.replaceChildren(...filtered.map((entry) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'mp-directory-card';
    card.innerHTML = `<strong>/${esc(entry.name)}</strong><p>${esc(entry.description || entry.whenToUse || '可在 Composer 中调用。')}</p><small>${esc(entry.source || entry.path || 'Magic Pointer')}</small>`;
    card.addEventListener('click', () => {
      insertSlashToken(entry.name);
      closePluginDirectory();
      show('chat');
    });
    return card;
  }));
  if (!filtered.length) host.innerHTML = '<p class="mp-inspector-empty">没有匹配项目。</p>';
}

async function openPluginDirectory() {
  const overlay = document.getElementById('plugin-directory');
  if (!overlay) return;
  overlay.hidden = false;
  document.getElementById('nav-plugins')?.classList.add('is-on');
  const host = document.getElementById('plugin-directory-list');
  if (host) host.innerHTML = '<p class="mp-inspector-empty">正在读取目录…</p>';
  pluginDirectoryCatalog = await Data.slashDirectory();
  renderPluginDirectory();
  requestAnimationFrame(() => (document.getElementById('plugin-directory-search') as HTMLInputElement | null)?.focus());
}

document.getElementById('plugin-directory-search')?.addEventListener('input', renderPluginDirectory);
document.querySelectorAll<HTMLElement>('[data-directory-kind]').forEach((button) => {
  button.addEventListener('click', () => {
    pluginDirectoryKind = button.dataset.directoryKind === 'commands' ? 'commands' : 'skills';
    document.querySelectorAll<HTMLElement>('[data-directory-kind]').forEach((item) => item.classList.toggle('is-on', item === button));
    renderPluginDirectory();
  });
});

document.addEventListener('click', e => {
  const target = e.target as Element | null;
  if (!target) return;
  if (!target.closest('#window-menu-popover') && !target.closest('#app-menu')) closeWindowMenu();
  if (!target.closest('#magic-brain-popover') && !target.closest('#magic-brain-toggle')) {
    const brain = document.getElementById('magic-brain-popover');
    if (brain) brain.hidden = true;
    document.getElementById('magic-brain-toggle')?.setAttribute('aria-expanded', 'false');
  }
  if (target.closest('[data-directory-close]')) { closePluginDirectory(); return; }
  if (target.closest('[data-directory-open]')) { void openPluginDirectory(); return; }
  if (!target.closest('#thread-menu') && !target.closest('#thread-more')) closeThreadMenu();
  if (target.closest('[data-settings-close]')) { show(lastNonSettingsView); return; }

  const inspectorTarget = target.closest<HTMLElement>('[data-inspector-tab]');
  if (inspectorTarget) {
    show('chat');
    setInspector(true, inspectorTarget.dataset.inspectorTab || 'files');
    return;
  }

  const settingsTarget = target.closest<HTMLElement>('[data-settings-section]');
  if (settingsTarget) {
    show('settings');
    requestAnimationFrame(() => {
      const requested = settingsTarget.dataset.settingsSection || 'models-agents';
      (document.querySelector(`[data-settings-page="${requested}"]`)
        || document.querySelector('[data-settings-page="models-agents"]'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    return;
  }

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

  /* 纸夹是真附件；斜杠目录由输入 `/` 唤起。 */
  const addBtn = target.closest<HTMLElement>('#composer-add');
  const addMenu = document.getElementById('composer-add-menu');
  if (addBtn) {
    if (!activeProjectRoot) { renderProjectContext(); return; }
    void Data.pickProjectFiles(activeProjectRoot).then((picked) => {
      if (!picked?.ok || !Array.isArray(picked.paths)) return;
      composerAttachments = [...new Set([...composerAttachments, ...picked.paths.map(String)])];
      renderComposerAttachments();
    });
    return;
  }
  if (addMenu && !addMenu.hidden && !target.closest('#composer-add-menu')) {
    closeSlashMenu();
  }

  const mention = target.closest<HTMLElement>('#composer-mention');
  if (mention) {
    const textarea = document.querySelector<HTMLTextAreaElement>('#composer-form textarea');
    if (textarea) {
      const start = textarea.selectionStart;
      textarea.setRangeText('@', start, textarea.selectionEnd, 'end');
      textarea.focus();
      fitComposer(textarea);
    }
    return;
  }

  const optionsButton = target.closest<HTMLElement>('#composer-options');
  const optionsMenu = document.getElementById('composer-options-menu');
  if (optionsButton && optionsMenu) {
    const open = optionsMenu.hidden;
    optionsMenu.hidden = !open;
    optionsButton.setAttribute('aria-expanded', String(open));
    return;
  }
  if (optionsMenu && !optionsMenu.hidden && !target.closest('#composer-options-menu')) {
    optionsMenu.hidden = true;
    document.getElementById('composer-options')?.setAttribute('aria-expanded', 'false');
  }

  const projectToggle = target.closest<HTMLElement>('[data-workspace-toggle]');
  if (projectToggle) {
    const key = projectToggle.dataset.workspaceToggle || '';
    const project = projectToggle.closest<HTMLElement>('.dshw-project');
    const alreadyActive = normalizedProjectRoot(key) === normalizedProjectRoot(activeProjectRoot);
    const open = project?.dataset.open !== 'false';
    setActiveProject(key);
    expandedWorkspaces.set(key, alreadyActive ? !open : true);
    if (project) project.dataset.open = String(alreadyActive ? !open : true);
    projectToggle.setAttribute('aria-expanded', String(alreadyActive ? !open : true));
    void (async () => {
      const list = await Data.conversations();
      const recent = list.find((conversation) =>
        normalizedProjectRoot((conversation as { workspaceRoot?: string }).workspaceRoot) === normalizedProjectRoot(key));
      if (recent) await openConversation(recent.id);
      else startNewChat();
      await renderSidebar();
    })();
    return;
  }

  const conversationTab = target.closest<HTMLElement>('[data-conversation-tab]');
  if (conversationTab) {
    setConversationTab(conversationTab.dataset.conversationTab === 'trajectory' ? 'trajectory' : 'chat');
    return;
  }

  const usagePopover = document.getElementById('composer-usage-popover');
  if (usagePopover && !usagePopover.hidden && !target.closest('#composer-context')
      && !target.closest('#composer-usage-popover')) {
    usagePopover.hidden = true;
    document.getElementById('composer-context')?.setAttribute('aria-expanded', 'false');
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
    show(goto.dataset.goto || '');
    const designLayout = goto.dataset.designLayout;
    if (designLayout) {
      document.querySelectorAll<HTMLElement>('.mp-design-nav [data-design-layout]').forEach((button) => button.classList.toggle('is-on', button === goto));
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`#stash-mode [data-mode="${designLayout}"]`)?.click();
      });
    }
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
  setActiveSlashRow(slashRows()[0] || null);
}

/* 键盘导航：高亮行在可见行之间循环移动，Enter/Tab 选中。 */
function slashRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('#composer-slash-rows [data-slash-name]')];
}

function activeSlashRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#composer-slash-rows [data-slash-name].is-active');
}

function setActiveSlashRow(row: HTMLElement | null) {
  slashRows().forEach((r) => {
    r.classList.toggle('is-active', r === row);
    if (r === row) r.setAttribute('aria-selected', 'true');
    else r.removeAttribute('aria-selected');
  });
  row?.scrollIntoView({ block: 'nearest' });
}

function moveSlashSelection(delta: number): boolean {
  const rows = slashRows();
  if (!rows.length) return false;
  const current = activeSlashRow();
  const index = current ? rows.indexOf(current) : -1;
  const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))]
    || (delta < 0 ? rows[rows.length - 1] : rows[0]);
  setActiveSlashRow(next);
  return true;
}

async function openSlashMenu(inlineFilter?: string) {
  const menu = document.getElementById('composer-add-menu');
  if (!menu) return;
  const inline = typeof inlineFilter === 'string';
  if (!slashDirectoryLoaded && !inline) {
    const rows = document.getElementById('composer-slash-rows');
    if (rows) rows.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'dshw-slash-empty';
    loading.textContent = '正在加载目录…';
    if (rows) rows.appendChild(loading);
  }
  if (!slashDirectoryLoaded) {
    slashDirectory = await Data.slashDirectory();
    slashDirectoryLoaded = slashDirectory !== null;
  }
  renderSlashRows(inline ? inlineFilter : '');
  menu.hidden = false;
  const search = document.getElementById('composer-slash-search') as HTMLInputElement | null;
  if (search && !inline) {
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
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveSlashSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSlashSelection(-1); }
    else if (e.key === 'Enter') {
      const active = activeSlashRow();
      if (active) {
        e.preventDefault();
        insertSlashToken(active.dataset.slashName || '');
        closeSlashMenu();
      }
    }
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
      use.setAttribute('href', '#ic-check');
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
let composerAttachments: string[] = [];

function renderComposerAttachments() {
  const host = document.getElementById('composer-attachments');
  if (!host) return;
  host.hidden = composerAttachments.length === 0;
  host.replaceChildren(...composerAttachments.map((filePath) => {
    const chip = document.createElement('span');
    chip.className = 'mp-composer-attachment';
    chip.title = filePath;
    const name = document.createElement('span');
    name.textContent = filePath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || filePath;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `移除 ${name.textContent}`);
    remove.innerHTML = '<svg aria-hidden="true"><use href="#ic-x" /></svg>';
    remove.addEventListener('click', () => {
      composerAttachments = composerAttachments.filter((path) => path !== filePath);
      renderComposerAttachments();
    });
    chip.append(name, remove);
    return chip;
  }));
}
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
      use.setAttribute('href', '#ic-check');
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
    /* animated-checkbox(sv-animations,MIT):盒子 + pathLength 划入勾线 + 弹簧删除线。
       参数取自源码,见 _sv_sources/sv-animations/animated-checkbox。 */
    const check = document.createElement('span');
    check.className = 'sv-checkbox';
    check.setAttribute('aria-hidden', 'true');
    check.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true"><path class="sv-checkbox-mark" `
      + `pathLength="1" d="${svMotionGlobals.PLAN_CHECK.path}" transform="${svMotionGlobals.PLAN_CHECK.transform}" fill="none" `
      + `stroke="currentColor" stroke-width="${svMotionGlobals.PLAN_CHECK.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const content = document.createElement('span');
    content.className = 'sv-plan-step-label';
    content.textContent = step.content;
    const strike = document.createElement('span');
    strike.className = 'sv-plan-step-strike';
    strike.setAttribute('aria-hidden', 'true');
    content.appendChild(strike);
    li.append(check, content);
    return li;
  }));
}

document.getElementById('composer-plan-toggle')?.addEventListener('click', () => {
  planCollapsed = !planCollapsed;
  renderPlanCard();
});

/* 审批卡：贴着 composer 上沿长出的那张卡。两类决定走同一个卡：
   - permission：CC toolPermissionDecision 语义，三个结构化选项（grant/once/deny），
     点击 = 授权随下一条消息生效，文本同时告诉模型继续；
   - ask：ask_user_question 的 options，点哪个就把哪个作为回答发出去。
   审批而已，用户不该需要打字。 */
let pendingPermissionAsk: { tool: string; prefix?: string } | null = null;
let pendingPermissionChoice: { grant?: string; deny?: string; once?: string } | null = null;
let pendingAskInput: { question: string; options: string[] } | null = null;

function renderPermissionAsk() {
  const host = document.getElementById('composer-permission-ask');
  if (!host) return;
  if (!pendingPermissionAsk && !pendingAskInput) { host.hidden = true; host.replaceChildren(); return; }
  host.hidden = false;
  host.dataset.mode = pendingPermissionAsk ? 'permission' : 'ask';
  const question = document.createElement('p');
  question.className = 'dshw-perm-ask-question';
  const make = (text: string, onClick: () => void, variant?: string) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = variant ? `dshw-perm-ask-btn is-${variant}` : 'dshw-perm-ask-btn';
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  };
  const submitText = (message: string, choice: { grant?: string; deny?: string; once?: string } | null) => {
    pendingPermissionChoice = choice;
    const ta = document.querySelector<HTMLTextAreaElement>('#composer-form textarea');
    const form = document.getElementById('composer-form') as HTMLFormElement | null;
    if (ta && form) {
      ta.value = message;
      fitComposer(ta);
      form.requestSubmit();
    }
  };
  if (pendingPermissionAsk) {
    const tool = pendingPermissionAsk.tool;
    const prefix = pendingPermissionAsk.prefix || '';
    const grantRule = ConversationControl.permissionGrantRule(tool, prefix);
    const grantTarget = prefix || tool;
    question.textContent = `是否授权执行 ${grantTarget}？`;
    const grantButtons = grantRule ? [
      make('仅这一次允许', () => submitText(
        `仅这一次允许 ${grantTarget}，请继续。`,
        { once: grantRule },
      )),
      make(`总是允许 ${prefix || tool}`, () => submitText(
        `本会话总是允许 ${grantTarget}，请继续。`,
        { grant: grantRule },
      )),
    ] : [];
    host.replaceChildren(
      question,
      ...grantButtons,
      make('拒绝', () => submitText(`拒绝执行 ${tool}，换别的办法。`, { deny: tool }), 'danger'),
    );
    return;
  }
  const options = pendingAskInput?.options || [];
  question.textContent = pendingAskInput?.question || '需要你的决定';
  host.replaceChildren(
    question,
    ...options.map((option) => make(option, () => {
      pendingAskInput = null;
      submitText(option, null);
    })),
  );
}

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
  try {
    modelCatalog = await Data.models();
  } catch {
    modelCatalog = null;
  }
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
  // 先把浮层画出来，再刷新目录。模型目录是 I/O，不能挟持一次点击的
  // 可见反馈；否则网关慢半秒，用户就会连续点击并在返回瞬间把菜单关掉。
  menu.replaceChildren(...modelMenuRows(modelCatalog));
  menu.hidden = false;
  document.getElementById('composer-model')?.setAttribute('aria-expanded', 'true');
  let catalog: MagicPointerModelCatalog | null = null;
  try {
    catalog = await Data.models();
  } catch {
    catalog = null;
  }
  // 用户可能在请求期间主动关掉菜单；只更新缓存，不把它强行弹回来。
  if (menu.hidden) {
    modelCatalog = catalog;
    return;
  }
  if (!catalog) {
    menu.replaceChildren(modelMenuNote('模型目录不可用（本机未接入 Electron 桥）。'));
    return;
  }
  modelCatalog = catalog;
  menu.replaceChildren(...modelMenuRows(catalog));
}

function modelMenuRows(catalog: MagicPointerModelCatalog | null): HTMLElement[] {
  if (!catalog) return [modelMenuNote('正在读取模型…')];
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
      use.setAttribute('href', '#ic-check');
        check.appendChild(use);
        row.appendChild(check);
      }
      rows.push(row);
    }
  }
  return rows.length ? rows : [modelMenuNote('没有可用模型。')];
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
  reasoningText: string;
  reasoningNode: HTMLElement | null;
}
let pendingConversation: PendingConversation | null = null;

function progressKey(record: Record<string, unknown>): string {
  const phase = String(record.phase || '');
  const fields = record.fields && typeof record.fields === 'object'
    ? record.fields as Record<string, unknown> : {};
  if (phase === 'tool_call' || phase === 'tool_result') return `tool:${String(fields.id || fields.name || '')}`;
  /* 非工具阶段全部并入单一 status 桶:运行中只有一行状态,原地更新(CC/DSH 金标准),
     内部阶段不再逐条堆成 Think 行。 */
  return 'status';
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
  if (String(record.phase || '') === 'reasoning_chunk') {
    const fields = record.fields && typeof record.fields === 'object'
      ? record.fields as Record<string, string> : {};
    appendLiveReasoningText(ConversationControl.decodeChunkBlob(fields));
    return; // 思考流增量同样不进 records，画成 Think 行。
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
  pending.body.replaceChildren(...els, ...renderLiveReasoningNode(), ...renderLiveStreamNode());
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

/* 思考流：DSH Think 行边想边画（running 态摘要跟随最后一行）。模型不吐
   reasoning 时整个节点不出现，与没有思考流的行为完全一致。 */
function renderLiveReasoningNode(): Element[] {
  const pending = pendingConversation;
  if (!pending || !pending.reasoningText) return [];
  const node = DshChat.thinkNode(pending.reasoningText, true) as HTMLElement;
  pending.reasoningNode = node;
  return [node];
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
/* 运行中耗时：DSH TurnStatus 同款，超过 15 秒才出现，避免短回合闪数字。 */
const PENDING_CLOCK_VISIBLE_MS = 15_000;
let pendingClockTimer: number | null = null;

function startPendingClock(body: HTMLElement) {
  stopPendingClock();
  const startedAt = Date.now();
  const clock = document.createElement('div');
  clock.className = 'dsh-stream-clock';
  const tick = () => {
    const elapsed = Date.now() - startedAt;
    if (elapsed < PENDING_CLOCK_VISIBLE_MS) return;
    clock.textContent = `已运行 ${Math.floor(elapsed / 1000)} 秒`;
    if (!clock.isConnected) body.appendChild(clock);
  };
  tick();
  pendingClockTimer = window.setInterval(tick, 1000);
}

function stopPendingClock() {
  if (pendingClockTimer !== null) {
    window.clearInterval(pendingClockTimer);
    pendingClockTimer = null;
  }
  document.querySelector('.dsh-stream-clock')?.remove();
}

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

function appendLiveReasoningText(text: string) {
  const pending = pendingConversation;
  if (!pending || !text) return;
  pending.reasoningText += text;
  followIfNearBottom(pending.body, renderPendingBody);
}

/* 作曲家忙态：发送钮变停止钮（DSH InputBar 同款形态）。
   isRunning=false 时恢复发送钮并清掉流式残留状态。 */
function focusComposerWhenIdle() {
  const textarea = document.querySelector<HTMLTextAreaElement>('#composer-form textarea');
  if (!textarea) return;
  const active = document.activeElement;
  const tagName = String((active as HTMLElement | null)?.tagName || '').toLowerCase();
  const anotherTypingTarget = active !== textarea && (tagName === 'input' || tagName === 'textarea');
  if (!anotherTypingTarget) textarea.focus();
}

let composerSettledTimer: number | null = null;

function setComposerSettledState(state: 'idle' | 'error' | 'success') {
  const form = document.getElementById('composer-form');
  if (!form) return;
  if (composerSettledTimer !== null) window.clearTimeout(composerSettledTimer);
  composerSettledTimer = null;
  form.setAttribute('data-state', state);
  if (state === 'idle') return;
  composerSettledTimer = window.setTimeout(() => {
    if (form.dataset.state === state) form.setAttribute('data-state', 'idle');
    composerSettledTimer = null;
  }, 1200);
}

function setComposerRunningState(running: boolean) {
  const form = document.getElementById('composer-form');
  const submit = document.querySelector<HTMLButtonElement>('#composer-form button[type="submit"]');
  if (running || form?.dataset.state === 'running') {
    form?.setAttribute('data-state', running ? 'running' : 'idle');
  }
  if (submit) {
    submit.classList.toggle('is-stop', running);
    submit.title = running ? '停止' : '发送';
    submit.setAttribute('aria-label', running ? '停止' : '发送');
    const use = submit.querySelector('use');
    use?.setAttribute('href', running ? '#ic-stop' : '#ic-send');
  }
  if (!running) focusComposerWhenIdle();
}

async function stopActiveConversation() {
  const pending = pendingConversation;
  if (!studioComposerBusy || !pending || pending.body.dataset.stopRequested === 'true') return;
  pending.body.dataset.stopRequested = 'true';
  const note = document.createElement('div');
  note.className = 'dsh-turn-status';
  note.textContent = '正在停止…';
  pending.body.appendChild(note);
  const result = await ConversationControl.callConversationAction(
    () => Data.stopConversation(pending.requestId),
  );
  if (!result.ok && pendingConversation === pending) {
    delete pending.body.dataset.stopRequested;
    note.textContent = result.error;
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
  void stopActiveConversation();
});

document.querySelectorAll('form.dshw-input-form').forEach(form => {
  const ta = form.querySelector<HTMLTextAreaElement>('textarea');
  if (ta) {
    fitComposer(ta);
    ta.addEventListener('input', () => fitComposer(ta));
    /* DSH input-trigger：光标前是未提交的 /token 时内联开目录并随输入过滤。 */
    ta.addEventListener('input', () => {
      const caret = ta.selectionStart ?? ta.value.length;
      const token = SlashTrigger.detectSlashToken(ta.value.slice(0, caret));
      if (token !== null) void openSlashMenu(token);
      else closeSlashMenu();
    });
    /* 目录打开时方向键移动高亮、Enter/Tab 选中、Escape 关闭；
       未打开时 Enter 走发送分派（下方 keydown）。 */
    ta.addEventListener('keydown', e => {
      const menu = document.getElementById('composer-add-menu');
      if (menu && !menu.hidden) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSlashSelection(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveSlashSelection(-1); return; }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSlashMenu(); return; }
        if ((e.key === 'Enter' && !e.isComposing) || e.key === 'Tab') {
          const active = activeSlashRow();
          if (active) {
            e.preventDefault();
            insertSlashToken(active.dataset.slashName || '');
            closeSlashMenu();
            return;
          }
        }
      }
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

    const attachmentPaths = [...composerAttachments];
    const requestQuestion = attachmentPaths.length
      ? `${question}\n\n附件：\n${attachmentPaths.map((filePath) => `- ${filePath}`).join('\n')}`
      : question;

    const stream = document.getElementById('stream');
    if (!stream) return;
    let flow = stream.querySelector<HTMLElement>('.dsh-flow');
    if (!flow) {
      flow = document.createElement('div');
      flow.className = 'dsh-flow';
      stream.replaceChildren(...(stream.querySelector('.dshw-blank, .view-empty') ? [] : [...stream.children]), flow);
    }
    flow.appendChild(DshChat.userNode(requestQuestion));
    const pending = document.createElement('div');
    pending.className = 'dsh-assistant';
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
    startPendingClock(pendingBody);
    const requestId = globalThis.crypto?.randomUUID?.() || `conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingConversation = { requestId, body: pendingBody, records: new Map(), nodes: new Map(), agentSessionId: null, streamText: '', streamNode: null, reasoningText: '', reasoningNode: null };
    renderConversationProgress({ phase: 'runtime_boot', fields: {} });
    try {
      const response = await Data.sendConversation(
        activeConversationId,
        requestQuestion,
        composerPreset,
        requestId,
        activeProjectRoot,
        composerStyle,
        pendingPermissionChoice || undefined,
      );
      pendingPermissionChoice = null;
      pendingPermissionAsk = null;
      pendingAskInput = null;
      renderPermissionAsk();
      if (!response?.ok || !response.conversationId) throw new Error(response?.error || '这次没有答完。');
      composerAttachments = [];
      renderComposerAttachments();
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
      /* 结构化提问回传：权限门（kind=permission）走三键授权语义；
         ask_user_question 的 options 走逐选项按钮。都长在 composer 上沿，
         点按钮即答，不需要打字。 */
      const awaiting = response as {
        awaitingUserInput?: boolean;
        pendingInput?: { kind?: string; tool?: string; prefix?: string; question?: string; options?: unknown };
      };
      if (awaiting.awaitingUserInput && awaiting.pendingInput?.kind === 'permission' && awaiting.pendingInput.tool) {
        pendingPermissionAsk = {
          tool: String(awaiting.pendingInput.tool),
          prefix: String(awaiting.pendingInput.prefix || '').trim() || undefined,
        };
        renderPermissionAsk();
      } else if (awaiting.awaitingUserInput && Array.isArray(awaiting.pendingInput?.options)
        && (awaiting.pendingInput.options as unknown[]).length >= 2) {
        pendingAskInput = {
          question: String(awaiting.pendingInput.question || '需要你的决定'),
          options: (awaiting.pendingInput.options as unknown[]).map((o) => String(o)).filter(Boolean),
        };
        renderPermissionAsk();
      }
      await openConversation(activeConversationId);
      await renderSidebar();
      setComposerSettledState('success');
    } catch (error) {
      pending.replaceChildren(DshChat.turnErrorNode(error instanceof Error ? error.message : String(error)));
      textarea.value = ConversationControl.failedDraftValue(textarea.value, question);
      fitComposer(textarea);
      setComposerSettledState('error');
    } finally {
      pendingConversation = null;
      studioComposerBusy = false;
      stopPendingClock();
      form.removeAttribute('aria-busy');
      setComposerRunningState(false);
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
  if (shell.dataset.view !== 'chat') return;
  startNewChat();
}

/* 新对话：清空当前这一屏，把焦点交回输入框。
   不新建记录——记录在第一次真的问出去之后才产生。 */
function startNewChat() {
  activeConversationId = null;
  activeConversationTurnCount = 0;
  activeConversationTab = 'chat';
  renderProjectContext();
  setStudioHomeVisible(true);
  document.querySelectorAll('#side-convos .side-item').forEach((n) => n.classList.remove('is-on'));
  const title = document.getElementById('chat-title');
  if (title) title.textContent = '新对话';
  projectEnvironment = null;
  renderProjectContext();
  const preview = document.getElementById('chat-source-preview');
  if (preview) preview.hidden = true;
  const peek = document.getElementById('chat-peek');
  if (peek) { peek.hidden = true; }
  const stream = document.getElementById('stream');
  if (stream) {
    stream.innerHTML = '<div class="dshw-blank" aria-hidden="true"></div>';
  }
  renderStatsLine([]);
  const trajectory = document.getElementById('trajectory');
  if (trajectory) trajectory.replaceChildren(DshTrajectory.render([]));
  setConversationTab('chat');
  void renderStudioHome();
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

document.getElementById('nav-new-chat')?.addEventListener('click', () => {
  setProductMode('walker');
  startNewChat();
});

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
void boot(initialView === 'chat' && productMode === 'design' ? 'design' : initialView);

// 新的一轮问答落库之后，项目树与产物跟着刷新。
Data.onChange(() => {
  renderSidebar();
  if (document.getElementById('studio-home')?.hidden === false) void renderStudioHome();
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
