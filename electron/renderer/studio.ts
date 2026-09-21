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
let stashQuery = '';

// 画布上摆过的收藏节点：Data.stash() 的条目加上布局坐标。
interface StashBurstNode {
  t: string; w?: number; h?: number; desc?: string; src?: string; text?: string; media?: string; summary?: string;
  id?: string; capturedAt?: number; originalArtifactPath?: string; sourceId?: string; sourceTimeMs?: number; userCategory?: string;
  locator?: Record<string, unknown> | null;
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
    // Caption + description + border; reserve summary space only when present.
    const ih = (it.t === 'shot' ? imageH + 58 + summaryHeight : 104);
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

  const all = stashQuery || stashKindFilter
    ? await Data.searchStash(stashQuery, stashKindFilter)
    : await Data.stash();
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
      return `<span class="node" data-stash-id="${esc(n.id || '')}" data-src="${esc(n.src || '')}" data-text="${esc(n.text || '')}" data-summary="${esc(n.summary || '')}" style="left:${(b.cx as number) + n.x}px;top:${(b.cy as number) + n.y}px;width:${n.w}px;height:${n.h}px">
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
    bs.map(b => b.items.map(it => `<div class="stash-row" data-stash-id="${esc(it.id || '')}" data-src="${esc(it.src || '')}" data-text="${esc(it.text || '')}">
        <span class="sq" style="${it.src && /\.(png|jpe?g|gif|webp|bmp)$/i.test(it.src) ? `background-image:url('file:///${cssUrl(it.src)}');background-size:cover;background-position:center` : `background-image:${it.t === 'shot' ? makeShot(it.desc) : 'none'}`}"></span>
        <span class="txt">${esc(it.desc || it.text)}</span>
        <span class="src">${esc(b.app)}</span>
        <span class="kind ${KIND_TAG[b.kind] || ''}">${esc(b.kind)}</span>
        <span class="t">${esc(b.time)}</span>
        <span class="stash-row-actions">
          <button type="button" data-stash-open="${esc(it.id || '')}">打开来源</button>
          <button type="button" data-stash-category="${esc(it.id || '')}" data-category="${esc(it.userCategory || b.kind)}">分类</button>
          <button type="button" data-stash-remove="${esc(it.id || '')}">删除</button>
        </span>
      </div>`).join('')).join('')
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
let projectEnvironment: MagicPointerProjectEnvironment | null = null;
let repositoryContextDismissedFor = '';
let repositoryContextRequest = 0;
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

/* ---- 会话级 git worktree ----
   打开后工作目录切到一棵独立的 checkout，agent 的改动落在自己的分支上。
   `base` 记住切出去之前是哪个项目，关掉开关要切回去。 */
interface ComposerWorktree { path: string; branch: string; base: string }
let composerWorktree: ComposerWorktree | null = null;
let composerWorktreeEnabled = false;
try {
  const stored = JSON.parse(localStorage.getItem('mp:composer-worktree') || 'null') as ComposerWorktree | null;
  if (stored?.path && stored?.base) composerWorktree = stored;
  composerWorktreeEnabled = localStorage.getItem('mp:composer-worktree-enabled') === 'true'
    || (localStorage.getItem('mp:composer-worktree-enabled') === null && Boolean(composerWorktree));
} catch { /* storage unavailable */ }

function persistComposerWorktree() {
  try {
    localStorage.setItem('mp:composer-worktree-enabled', String(composerWorktreeEnabled));
    if (composerWorktree) localStorage.setItem('mp:composer-worktree', JSON.stringify(composerWorktree));
    else localStorage.removeItem('mp:composer-worktree');
  } catch { /* storage unavailable */ }
}

function renderComposerWorktree() {
  const button = document.getElementById('composer-worktree') as HTMLButtonElement | null;
  if (!button) return;
  button.hidden = !activeProjectRoot;
  button.setAttribute('aria-checked', String(composerWorktreeEnabled));
  button.disabled = false;
  button.title = composerWorktreeEnabled
    ? 'Work in an isolated copy of your repository so you can keep working without conflicts.'
    : 'Work in an isolated copy of your repository to work on multiple tasks at the same time.';
}

/* 失败必须说出来：git 拒绝（不是仓库、有未提交改动、分支占用了）时开关弹回
   原状并带上 git 自己的话，而不是静默地什么都不发生。 */
function failComposerWorktree(button: HTMLElement | null, message: string) {
  button?.setAttribute('data-error', 'true');
  if (button) button.title = message;
}

document.getElementById('composer-worktree')?.addEventListener('click', (event) => {
  if (!activeProjectRoot) return;
  composerWorktreeEnabled = !composerWorktreeEnabled;
  (event.currentTarget as HTMLElement).removeAttribute('data-error');
  if (!composerWorktreeEnabled && composerWorktree
      && normalizedProjectRoot(activeProjectRoot) === normalizedProjectRoot(composerWorktree.path)) {
    setActiveProject(composerWorktree.base);
  }
  persistComposerWorktree();
  renderComposerWorktree();
});

// Like Claude's checkbox, choosing a worktree is immediate. Git only runs when
// sending a task; deselecting never deletes a checkout or its uncommitted work.
async function prepareComposerWorktree(): Promise<string> {
  const base = activeProjectRoot;
  if (!composerWorktreeEnabled || !base) return base;
  if (composerWorktree && [composerWorktree.base, composerWorktree.path]
    .some(root => normalizedProjectRoot(root) === normalizedProjectRoot(base))) {
    setActiveProject(composerWorktree.path);
    return composerWorktree.path;
  }
  const result = await Data.projectWorktree({ action: 'create', projectRoot: base, conversationId: activeConversationId || '' });
  if (!result?.ok || !result.path) {
    const message = String(result?.error || '无法创建 worktree。');
    failComposerWorktree(document.getElementById('composer-worktree'), message);
    throw new Error(message);
  }
  composerWorktree = { path: result.path, branch: result.branch || 'worktree', base };
  persistComposerWorktree();
  // A user may cancel the checkbox while Git is running. Keep the created
  // checkout for reuse, and run the task in the originally selected folder.
  if (!composerWorktreeEnabled) return base;
  setActiveProject(result.path);
  return result.path;
}

function renderProjectContext() {
  renderComposerWorktree();
  const headerLabel = document.getElementById('chat-project-label');
  const locationLabel = document.getElementById('header-location-label');
  const workspaceLabel = document.getElementById('composer-workspace-label');
  const contextRow = document.querySelector<HTMLElement>('.mp-composer-context-row');
  const repositoryRow = document.getElementById('composer-repository-context');
  const hasProject = Boolean(activeProjectRoot);
  const homeVisible = !document.getElementById('studio-home')?.hidden;
  if (contextRow) contextRow.hidden = hasProject && !homeVisible;
  if (repositoryRow && (!hasProject || homeVisible || !activeConversationId)) repositoryRow.hidden = true;
  const designStatus = document.querySelector<HTMLElement>('.mp-design-live');
  if (designStatus) {
    designStatus.classList.toggle('is-offline', !hasProject);
    const text = designStatus.lastChild;
    if (text?.nodeType === Node.TEXT_NODE) text.textContent = hasProject ? '已连接项目' : '等待打开项目';
  }
  if (!headerLabel) return;
  if (!hasProject) {
    headerLabel.textContent = 'Local';
    headerLabel.removeAttribute('title');
    if (locationLabel) locationLabel.textContent = 'Local';
    if (workspaceLabel) workspaceLabel.textContent = 'Select folder…';
    return;
  }
  const parts = activeProjectRoot.replace(/\\/g, '/').split('/').filter(Boolean);
  const projectName = parts[parts.length - 1] || activeProjectRoot;
  headerLabel.textContent = projectName;
  headerLabel.title = activeProjectRoot;
  if (locationLabel) locationLabel.textContent = projectName;
  if (workspaceLabel) workspaceLabel.textContent = projectName;
}

function repositoryContextKey() {
  return `${activeConversationId || ''}\u0000${normalizedProjectRoot(activeProjectRoot)}`;
}

function applyRepositoryContextBar(response: MagicPointerProjectEnvironment | null) {
  const row = document.getElementById('composer-repository-context');
  const inspectorButton = document.getElementById('inspector-toggle');
  if (!row) return;
  const homeVisible = !document.getElementById('studio-home')?.hidden;
  const changes = Number(response?.changedFiles || 0);
  const visible = Boolean(
    activeConversationId
    && activeProjectRoot
    && !homeVisible
    && response?.ok
    && response?.isGit
    && repositoryContextDismissedFor !== repositoryContextKey()
  );
  row.hidden = !visible;
  inspectorButton?.toggleAttribute('data-has-changes', visible && changes > 0);
  if (!visible || !response) return;

  const projectName = activeProjectRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Project';
  const displayName = String(response.name || projectName);
  const repositoryName = document.getElementById('composer-repository-name');
  const branchName = document.getElementById('composer-branch-name');
  const added = document.getElementById('composer-diff-added');
  const deleted = document.getElementById('composer-diff-deleted');
  const createPr = document.getElementById('composer-create-pr') as HTMLButtonElement | null;
  if (repositoryName) repositoryName.textContent = displayName;
  const headerProject = document.getElementById('chat-project-label');
  if (headerProject) headerProject.textContent = displayName;
  if (branchName) branchName.textContent = String(response.branch || 'main');
  if (added) added.textContent = `+${Number(response.addedLines || 0).toLocaleString('en-US')}`;
  if (deleted) deleted.textContent = `−${Number(response.deletedLines || 0).toLocaleString('en-US')}`;
  if (createPr) {
    createPr.disabled = changes <= 0 && !response.pullRequestUrl;
    createPr.title = response.pullRequestUrl ? 'Open pull request comparison' : 'Review changes before creating a pull request';
  }
}

async function renderRepositoryContextBar(force = false) {
  const request = ++repositoryContextRequest;
  if (!activeConversationId || !activeProjectRoot || !document.getElementById('studio-home')?.hidden) {
    applyRepositoryContextBar(null);
    return;
  }
  if (!force && projectEnvironment?.root === activeProjectRoot) {
    applyRepositoryContextBar(projectEnvironment);
    return;
  }
  const response = await Data.projectEnvironment(activeProjectRoot, activeConversationId);
  if (request !== repositoryContextRequest) return;
  projectEnvironment = response;
  applyRepositoryContextBar(response);
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
const studioLibraries = (globalThis as any).StudioLibraries;
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
interface EffortOption {
  value: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  label: string;
  description: string;
}
interface EffortLevelsModule {
  EFFORT_LEVELS: readonly EffortOption[];
  normalizeEffort(value: unknown): EffortOption['value'];
  effortOption(value: unknown): EffortOption;
}
interface PopoverPositionModule {
  placePopover(
    trigger: { left: number; right: number; top: number; bottom: number },
    popup: { width: number; height: number },
    viewport: { width: number; height: number },
  ): { left: number; top: number };
}
const effortLevels = (globalThis as { EffortLevels?: EffortLevelsModule }).EffortLevels!;
const popoverPosition = (globalThis as { PopoverPosition?: PopoverPositionModule }).PopoverPosition!;
let effortParticleController: { setMax(value: boolean): void; dispose(): void } | null = null;

const STUDIO_POPOVERS = [
  ['composer-permission-menu', 'composer-permission'],
  ['composer-model-menu', 'composer-model'],
  ['composer-effort-menu', 'composer-effort'],
  ['composer-attach-menu', 'composer-add'],
  ['composer-usage-popover', 'composer-context'],
  ['account-menu', 'account-footer'],
] as const;

function closeAnchoredPopover(popupId: string, triggerId: string) {
  if (popupId === 'composer-effort-menu') {
    effortParticleController?.dispose();
    effortParticleController = null;
  }
  if (popupId === 'account-menu') {
    const submenu = document.getElementById('account-submenu');
    if (submenu) submenu.hidden = true;
    document.querySelectorAll('[data-account-command][aria-haspopup]').forEach(row => row.setAttribute('aria-expanded', 'false'));
  }
  if (popupId === 'composer-usage-popover') setUsageDetailsOpen(false);
  const popup = document.getElementById(popupId);
  if (popup) {
    popup.hidden = true;
    popup.style.removeProperty('left');
    popup.style.removeProperty('top');
    popup.style.removeProperty('width');
    popup.style.removeProperty('visibility');
  }
  document.getElementById(triggerId)?.setAttribute('aria-expanded', 'false');
}

function closeStudioPopovers(exceptPopupId = '') {
  for (const [popupId, triggerId] of STUDIO_POPOVERS) {
    if (popupId !== exceptPopupId) closeAnchoredPopover(popupId, triggerId);
  }
}

function positionAnchoredPopover(popupId: string, triggerId: string): HTMLElement | null {
  const popup = document.getElementById(popupId);
  const trigger = document.getElementById(triggerId);
  if (!popup || !trigger || !popoverPosition) return null;
  closeStudioPopovers(popupId);
  popup.style.visibility = 'hidden';
  popup.hidden = false;
  const triggerRect = trigger.getBoundingClientRect();
  const point = popoverPosition.placePopover(
    triggerRect,
    { width: popup.offsetWidth, height: popup.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight },
  );
  popup.style.left = `${point.left}px`;
  popup.style.top = `${point.top}px`;
  popup.style.removeProperty('visibility');
  if (popupId === 'composer-permission-menu') {
    popup.style.left = `${Math.max(12, Math.min(trigger.getBoundingClientRect().left, innerWidth - popup.offsetWidth - 12))}px`;
  }
  trigger.setAttribute('aria-expanded', 'true');
  return popup;
}
interface StudioSubagentStep {
  index: number;
  tool: string;
  status: string;
  usedBackend?: string;
  latencyMs?: number;
  callId?: string;
  input?: string;
  output?: string;
}
interface StudioSubagentTask {
  id: string;
  parentCallId: string;
  description: string;
  status: string;
  stepCount: number;
  currentTool: string;
  summary: string;
  readonly: boolean;
  steps: StudioSubagentStep[];
  startedAt: number;
  completedAt: number;
  reasoning?: string;
  answer?: string;
  phase?: string;
  elapsedMs?: number;
  turn?: number;
  pendingInput?: MagicPointerDecisionRequest & { requestId: string };
}
interface StudioSubagentsModule {
  activeSubagentParentCallId(records: ReadonlyArray<Record<string, unknown>>): string;
  projectSubagentTasks(
    turns: ReadonlyArray<Record<string, unknown>>,
    live?: ReadonlyArray<Partial<StudioSubagentTask>>,
  ): StudioSubagentTask[];
}
const studioSubagentGlobals = (globalThis as { StudioSubagents?: StudioSubagentsModule }).StudioSubagents!;

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

function conversationNode(c: {
  id?: string;
  title?: string;
  updatedAt?: number;
  hasPendingWork?: boolean;
  failed?: boolean;
  turns?: MagicPointerTurn[];
}, active?: string): HTMLElement {
  const row = document.createElement('button');
  row.className = 'side-item' + (c.id === active ? ' is-on' : '');
  row.dataset.open = String(c.id || '');
  row.type = 'button';
  // 会话行保持安静：标题是主体，待续状态与操作只在需要时出现。
  const dot = document.createElement('span');
  dot.className = 'side-dot';
  const lastTurn = Array.isArray(c.turns) ? c.turns[c.turns.length - 1] : undefined;
  const hasError = c.failed === true || lastTurn?.failed === true;
  dot.classList.toggle('is-pending', c.hasPendingWork === true);
  dot.classList.toggle('is-error', hasError);
  if (hasError) dot.innerHTML = icon('ic-warning');
  if (c.hasPendingWork) {
    dot.title = '有未完成工作，可继续此会话';
    row.dataset.pendingWork = 'true';
    row.setAttribute('aria-label', `${String(c.title || '未命名对话')}，有待续工作`);
  }
  if (hasError) {
    dot.title = '上一轮没有完成';
    row.dataset.error = 'true';
    row.setAttribute('aria-label', `${String(c.title || '未命名对话')}，上一轮没有完成`);
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

/* 会话动作菜单：挂在行内，打开时才可见；点击外部由全局委托收起。
   结构照参考：图标 + 文案 +（P/R/D 快捷键），子菜单带右尖角，置顶后换成
   「取消固定 / 移除出项目 / 上移 / 下移」——固定过的项靠手动顺序排，不再按分组。 */
function buildSessionMenu(c: { id?: string; title?: string; workspaceRoot?: string }): HTMLElement {
  const id = String(c.id || '');
  const menu = document.createElement('span');
  menu.className = 'side-session-menu';
  menu.hidden = true;
  menu.dataset.forSession = id;
  const glyph = (globalThis as unknown as { CdsIcons: { html: (name: string, size?: string) => string } }).CdsIcons.html;
  type MenuItem = { icon: string; key?: string; danger?: boolean; submenu?: boolean };
  const item = (name: string, label: string, options: MenuItem) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'side-session-menu-item' + (options.danger ? ' is-danger' : '');
    row.dataset.sessionAction = name;
    row.innerHTML = `<span class="side-menu-icon" aria-hidden="true">${glyph(options.icon)}</span><span class="side-menu-label">${esc(label)}</span>`
      + (options.key ? `<kbd>${options.key}</kbd>` : options.submenu ? '<span class="side-menu-chevron" aria-hidden="true">›</span>' : '');
    return row;
  };
  const divider = () => { const line = document.createElement('hr'); return line; };
  const local = studioLibraries.sessionPreference(id);
  const inProject = Boolean(String(c.workspaceRoot || '').trim());
  const close = (event: Event) => { event.stopPropagation(); menu.hidden = true; };
  const run = (name: string) => (event: Event) => {
    close(event);
    if (name === 'pin') {
      studioLibraries.setSessionPreference(id, { pinned: !local.pinned, order: Date.now() });
      void renderSidebar();
      return;
    }
    if (name === 'rename') { openRenameDialog(id, String(c.title || '')); return; }
    if (name === 'archive') {
      studioLibraries.setSessionPreference(id, { archived: !local.archived });
      void renderSidebar();
      return;
    }
    if (name === 'remove-project') { void Data.setConversationProject(id, '').then(() => renderSidebar()); return; }
    if (name === 'up') { studioLibraries.movePinned(id, -1); void renderSidebar(); return; }
    if (name === 'down') { studioLibraries.movePinned(id, 1); void renderSidebar(); return; }
    if (name === 'delete') {
      if (id === activeConversationId) startNewChat();
      void Data.deleteConversation(id).then(() => renderSidebar());
    }
  };
  const pin = item('pin', local.pinned ? 'Unpin' : 'Pin', { icon: local.pinned ? 'unpin' : 'pinned-star', key: 'P' });
  pin.dataset.sessionPinned = String(local.pinned);
  pin.addEventListener('click', run('pin'));
  menu.append(pin);
  const rename = item('rename', 'Rename', { icon: 'mode-write', key: 'R' });
  rename.addEventListener('click', run('rename'));
  menu.append(rename);
  const project = item('project', inProject ? 'Change project' : 'Add to project', { icon: 'box', submenu: true });
  // 不能先藏菜单再传 anchor：元素一 hidden，getBoundingClientRect() 全归零，
  // 项目选择器会被摆到窗口左上角。菜单留着，选择器自己按外部点击收起。
  project.addEventListener('click', (event) => { event.stopPropagation(); void openProjectAssignment(id, project); });
  menu.append(project);
  if (inProject) {
    const removeProject = item('remove-project', 'Remove from project', { icon: 'arrow-out' });
    removeProject.addEventListener('click', run('remove-project'));
    menu.append(removeProject);
  }
  if (!local.pinned) {
    // 「移至分组」是个真子菜单：列出现有分组名，加一条新建。
    const parent = item('group', 'Move to group', { icon: 'folder', submenu: true });
    const apply = (group: string | null) => {
      if (group === null) {
        void requestStudioText('分组名称', local.group || '', 60).then(name => {
          if (name === null) return;
          studioLibraries.setSessionGroup(id, name);
          studioLibraries.setFilter('group', 'custom');
          void renderSidebar();
        });
        return;
      }
      studioLibraries.setSessionGroup(id, group);
      studioLibraries.setFilter('group', 'custom');
      void renderSidebar();
    };
    const show = () => openGroupSubmenu(parent, studioLibraries.sessionGroups(), local.group || '', apply);
    parent.addEventListener('mouseenter', () => { closeGroupSubmenu?.(); show(); });
    parent.addEventListener('focusin', show);
    parent.addEventListener('click', (event) => { event.stopPropagation(); show(); });
    menu.append(parent);
  }
  const archive = item('archive', local.archived ? 'Unarchive' : 'Archive', { icon: 'archive' });
  archive.addEventListener('click', run('archive'));
  menu.append(archive);
  menu.append(divider());
  if (local.pinned) {
    const up = item('up', 'Move up', { icon: 'send' });
    up.addEventListener('click', run('up'));
    const down = item('down', 'Move down', { icon: 'arrow-down' });
    down.addEventListener('click', run('down'));
    menu.append(up, down, divider());
  }
  const remove = item('delete', 'Delete', { icon: 'trash', key: 'D', danger: true });
  remove.addEventListener('click', run('delete'));
  menu.append(remove);
  return menu;
}

/* 「移至分组」的子菜单必须挂到 body 上：侧栏列表是 overflow:auto 的滚动容器，
   留在行内的绝对定位子菜单会被它整块裁掉，右侧只剩一个白角。
   位置按父行算，右边界放不下就翻到左侧；鼠标移开父行进到面板里不算离开。 */
let closeGroupSubmenu: (() => void) | null = null;
function openGroupSubmenu(anchor: HTMLElement, groups: readonly string[], current: string, pick: (group: string | null) => void): void {
  closeGroupSubmenu?.();
  const glyph = (globalThis as unknown as { CdsIcons: { html: (name: string, size?: string) => string } }).CdsIcons.html;
  const panel = document.createElement('div');
  panel.className = 'side-session-submenu is-floating';
  panel.setAttribute('role', 'menu');
  panel.setAttribute('aria-label', 'Move to group');
  panel.innerHTML = groups.map((group: string) => `<button type="button" role="menuitemradio" aria-checked="${current === group}" data-session-group="${esc(group)}"><span>${esc(group)}</span>${current === group ? glyph('check') : ''}</button>`).join('')
    + `<button type="button" data-session-group-new><span>New group…</span></button>`;
  document.body.append(panel);
  const rect = anchor.getBoundingClientRect();
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const left = rect.right + 4 + width <= window.innerWidth - 8 ? rect.right + 4 : Math.max(8, rect.left - width - 4);
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(Math.max(8, Math.min(rect.top - 4, window.innerHeight - height - 8)))}px`;
  let hideTimer: number | undefined;
  const close = () => {
    if (hideTimer !== undefined) window.clearTimeout(hideTimer);
    panel.remove();
    if (closeGroupSubmenu === close) closeGroupSubmenu = null;
  };
  const scheduleClose = () => { hideTimer = window.setTimeout(close, 180); };
  const cancelClose = () => { if (hideTimer !== undefined) window.clearTimeout(hideTimer); };
  anchor.addEventListener('mouseleave', scheduleClose);
  anchor.addEventListener('focusout', scheduleClose);
  panel.addEventListener('mouseenter', cancelClose);
  panel.addEventListener('mouseleave', scheduleClose);
  panel.addEventListener('click', (event) => {
    event.stopPropagation();
    const target = (event.target as Element).closest<HTMLElement>('[data-session-group], [data-session-group-new]');
    if (!target) return;
    const value = target.dataset.sessionGroup;
    close();
    pick(value === undefined ? null : String(value));
  });
  closeGroupSubmenu = close;
}

/* 菜单打开时按 P / R / D 直接执行对应行——参考里写在行右端的字母要是按不动，
   就只是装饰。和模型菜单的 1..9 一样：菜单关掉就解绑。 */
function bindSessionMenuKeys(menu: HTMLElement): void {
  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLocaleLowerCase();
    const name = key === 'p' ? 'pin' : key === 'r' ? 'rename' : key === 'd' ? 'delete' : '';
    if (!name) return;
    const row = menu.querySelector<HTMLElement>(`[data-session-action="${name}"]`);
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    row.click();
  };
  const observer = new MutationObserver(() => {
    if (menu.hidden) { document.removeEventListener('keydown', onKey, true); observer.disconnect(); }
  });
  observer.observe(menu, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('keydown', onKey, true);
}

let projectAssignmentRequest = 0;
let closeProjectAssignment: (() => void) | null = null;
async function openProjectAssignment(id: string, anchor: HTMLElement) {
  const request = ++projectAssignmentRequest;
  closeProjectAssignment?.();
  const parentMenu = anchor.closest<HTMLElement>('.side-session-menu, .mp-library-popover');
  const bounds = (parentMenu || anchor).getBoundingClientRect();
  const anchorBounds = anchor.getBoundingClientRect();
  const [projects, conversation] = await Promise.all([Data.projects(), Data.conversation(id)]);
  if (!conversation || request !== projectAssignmentRequest) return;
  const popover = document.createElement('div'); popover.className = 'mp-library-popover mp-project-assignment';
  popover.setAttribute('role', 'menu'); popover.setAttribute('aria-label', 'Change project');
  const glyph = (globalThis as any).CdsIcons.html;
  popover.innerHTML = `<label class="mp-library-search">${glyph('search')}<input type="search" data-project-search placeholder="Search projects" aria-label="Search projects" /></label><div class="mp-project-options">${studioLibraries.projectOptionsMarkup(projects, conversation.workspaceRoot || '')}</div><button type="button" data-project-picker>${glyph('attach')}<span>Start new project…</span></button><p class="mp-library-error" role="status"></p>`;
  const left = bounds.right + 240 <= window.innerWidth - 8 ? bounds.right - 3 : bounds.left - 237;
  popover.style.left = `${Math.max(8, Math.min(left, window.innerWidth - 248))}px`;
  document.body.append(popover);
  popover.style.top = `${Math.max(8, Math.min(anchorBounds.top - 4, window.innerHeight - popover.offsetHeight - 8))}px`;
  anchor.setAttribute('aria-expanded', 'true');
  const listeners = new AbortController();
  const close = () => { popover.remove(); anchor.setAttribute('aria-expanded', 'false'); listeners.abort(); if (closeProjectAssignment === close) closeProjectAssignment = null; };
  closeProjectAssignment = close;
  document.addEventListener('pointerdown', event => { if (!popover.contains(event.target as Node) && !parentMenu?.contains(event.target as Node)) close(); }, {signal:listeners.signal});
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { close(); anchor.focus(); } }, {signal:listeners.signal});
  const report = (reason: unknown) => { popover.querySelector('.mp-library-error')!.textContent = reason instanceof Error ? reason.message : String(reason); };
  let busy = false;
  async function move(root: string) {
    if (busy) return; busy = true;
    popover.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; });
    try {
      const result = await Data.setConversationProject(id, root);
      if (!result.ok) throw new Error(result.error || '项目没有更改。');
      if (activeConversationId === id) setActiveProject(root);
      close(); if (parentMenu) parentMenu.hidden = true; await renderSidebar();
    } catch (reason) { report(reason); busy = false; popover.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = false; }); }
  }
  popover.addEventListener('input', event => {
    const input = event.target as HTMLInputElement;
    if (input.matches('[data-project-search]')) popover.querySelector('.mp-project-options')!.innerHTML = studioLibraries.projectOptionsMarkup(projects, conversation.workspaceRoot || '', input.value);
  });
  popover.addEventListener('click', event => {
    event.stopPropagation();
    const button = (event.target as Element).closest<HTMLElement>('button');
    if (button?.hasAttribute('data-project-root')) void move(String(button.dataset.projectRoot || ''));
    if (button?.hasAttribute('data-project-picker')) void Data.openProject().then(result => {
      if (result.ok && result.project) return move(result.project.root);
      if (!result.ok && !result.canceled) report(result.error || '项目没有创建。');
    }).catch(report);
  });
  popover.querySelector<HTMLInputElement>('input')?.focus();
}

/* 重命名对话框：Electron 不支持 window.prompt，用内联覆盖层。 */
function requestStudioText(title: string, initial = '', maxLength = 32000): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'dshw-perm-confirm';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    const card = document.createElement('div');
    card.className = 'dshw-perm-confirm-card';
    const label = document.createElement('b');
    label.textContent = title;
    const input = document.createElement('textarea');
    input.className = 'dshw-rename-input';
    input.value = initial;
    input.maxLength = maxLength;
    input.rows = maxLength > 200 ? 4 : 1;
    input.setAttribute('aria-label', title);
    const actions = document.createElement('div');
    actions.className = 'dshw-perm-confirm-actions';
    const finish = (value: string | null) => { overlay.remove(); resolve(value); };
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => finish(null));
    const save = document.createElement('button');
    save.className = 'is-primary';
    save.textContent = '确定';
    save.addEventListener('click', () => { if (input.value.trim()) finish(input.value.trim()); });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(null); }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault(); event.stopPropagation(); save.click();
      }
    });
    actions.append(cancel, save);
    card.append(label, input, actions);
    overlay.append(card);
    document.body.append(overlay);
    input.focus();
  });
}

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
        if (!host.hidden) bindSessionMenuKeys(host);
      }
      return;
    }
    document.querySelectorAll('.side-session-menu:not([hidden])').forEach((m) => {
      if (!target.closest('.side-session-menu, .mp-project-assignment')) (m as HTMLElement).hidden = true;
    });
    if (!target.closest('.side-session-menu, .side-session-submenu.is-floating, .mp-project-assignment')) closeGroupSubmenu?.();
  });
})();

const EMPTY_SESSION_SOLIDS: ReadonlyArray<readonly [number, number, number, number]> = [
  [90, 0, 20, 20],
  [90, 40, 20, 20],
  [70, 20, 20, 20],
  [110, 20, 20, 20],
];
const EMPTY_SESSION_CHECKERS: ReadonlyArray<readonly [number, number, number, number]> = [
  [20, 40, 20, 20],
  [20, 80, 20, 20],
  [0, 60, 20, 20],
  [40, 60, 20, 20],
  [90, 20, 20, 20],
  [140, 40, 10, 20],
  [110, 60, 10, 20],
  [130, 60, 20, 20],
  [120, 80, 20, 20],
  [110, 100, 10, 20],
  [100, 120, 10, 20],
];
const EMPTY_SESSION_SPARSE: ReadonlyArray<readonly [number, number, number, number]> = [
  [20, 60, 20, 20],
  [40, 100, 10, 20],
  [50, 120, 10, 20],
];
let cachedEmptySessionsPictogramPath = '';

function pixelRegionPath(
  regions: ReadonlyArray<readonly [number, number, number, number]>,
  include: (row: number, column: number) => boolean,
) {
  let path = '';
  for (const [left, top, width, height] of regions) {
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        if (include(row, column)) path += `M${left + column} ${top + row}h1v1h-1z`;
      }
    }
  }
  return path;
}

function emptySessionsPictogramPath() {
  if (cachedEmptySessionsPictogramPath) return cachedEmptySessionsPictogramPath;
  cachedEmptySessionsPictogramPath = EMPTY_SESSION_SOLIDS
    .map(([left, top, width, height]) => `M${left} ${top}h${width}v${height}h${-width}z`)
    .join('')
    + pixelRegionPath(EMPTY_SESSION_CHECKERS, (row, column) => (row + column) % 2 === 0)
    + pixelRegionPath(EMPTY_SESSION_SPARSE, (row, column) => row % 2 === 0 && column % 2 === 0);
  return cachedEmptySessionsPictogramPath;
}

function emptySessionsPictogram() {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.classList.add('side-empty-pictogram');
  svg.setAttribute('width', '82.5');
  svg.setAttribute('height', '77');
  svg.setAttribute('viewBox', '0 0 150 140');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(namespace, 'path');
  path.setAttribute('d', emptySessionsPictogramPath());
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

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
  let filtered = studioLibraries.filterRows(sidebarGroups.filterConversations(list, sidebarQuery)) as MagicPointerConversation[];
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
  const displayGroups = studioLibraries.sections(filtered, groups) as Array<{ key: string; label: string; items: MagicPointerConversation[]; virtual?: boolean }>;
  const browser = host.closest<HTMLElement>('.dshw-workspace-browser');
  browser?.classList.toggle('is-empty', displayGroups.length === 0);
  if (!displayGroups.length) {
    const empty = document.createElement('div');
    empty.className = 'side-empty';
    const label = document.createElement('span');
    label.className = 'side-empty-label';
    label.textContent = projects.length ? 'No matching sessions' : 'Sessions you start will show up here';
    empty.append(label);
    if (!projects.length) empty.append(emptySessionsPictogram());
    nodes.push(empty);
  }
  for (const group of displayGroups) {
    const project = document.createElement('section');
    project.className = 'dshw-project';
    const open = expandedWorkspaces.get(group.key) !== false;
    project.classList.toggle('is-active', normalizedProjectRoot(group.key) === normalizedProjectRoot(activeProjectRoot));
    project.dataset.open = String(open);
    project.dataset.workspace = group.key;
    const head = document.createElement('div');
    head.className = 'dshw-project-row';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'dshw-project-toggle';
    toggle.dataset.workspaceToggle = group.key;
    if (group.virtual) toggle.dataset.virtualGroup = 'true';
    toggle.dataset.projectSelect = group.key;
    toggle.setAttribute('aria-expanded', String(open));
    const projectName = document.createElement('span');
    projectName.className = 'dshw-project-name';
    projectName.textContent = group.label;
    toggle.appendChild(projectName);
    const actions = document.createElement('span');
    actions.className = 'dshw-project-actions';
    if (group.key && !group.virtual) {
      const add = document.createElement('button');
      add.type = 'button';
      add.dataset.projectNew = group.key;
      add.setAttribute('aria-label', 'New session');
      add.innerHTML = icon('ic-plus');
      const tools = document.createElement('button');
      tools.type = 'button';
      tools.dataset.projectTools = group.key;
      tools.setAttribute('aria-label', 'Project tools');
      tools.innerHTML = icon('ic-sliders');
      actions.append(add, tools);
    }
    head.append(toggle, actions);
    const sessions = document.createElement('div');
    sessions.className = 'dshw-project-sessions';
    for (const c of group.items) {
      const node = conversationNode(c, active);
      sessions.appendChild(node);
    }
    project.append(head, sessions);
    nodes.push(project);
  }
  host.replaceChildren(...nodes);
}

function renderUpdateCard(update: MagicPointerUpdateState) {
  const card = document.getElementById('update-card') as HTMLButtonElement | null;
  const title = document.getElementById('update-card-title');
  const detail = document.getElementById('update-card-detail');
  if (!card || !title || !detail) return;
  const state = String(update?.state || 'unsupported');
  let heading = '';
  let note = '';
  let actionable = false;
  switch (state) {
    case 'available':
      heading = `${update.version || 'Update'} available`;
      note = 'Click to download';
      actionable = true;
      break;
    case 'downloading':
      heading = 'Downloading update…';
      note = '';
      break;
    case 'downloaded':
      heading = 'Relaunch to update';
      note = update.version ? `v${String(update.version).replace(/^v/, '')}` : '';
      break;
    default:
      card.hidden = true;
      delete card.dataset.state;
      return;
  }
  card.hidden = false;
  card.dataset.state = state;
  card.disabled = !actionable;
  title.textContent = heading;
  detail.textContent = note;
  detail.hidden = !note;
}

document.getElementById('update-card')?.addEventListener('click', () => {
  void Data.checkForUpdates();
});
Data.onUpdateStatus(renderUpdateCard);
void Data.updateStatus().then(renderUpdateCard);

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

/* 点工作目录芯片先开一张小卡（参考里就是这个），而不是直接弹系统对话框：
   系统对话框里没有「最近打开过哪个项目」这件事，而用户十次里有九次是切回
   刚才那个。最后一行才是「打开文件夹…」。 */
function workspaceMenuRow(
  className: string,
  label: string,
  onClick: () => void,
  options: { role?: string; selected?: boolean; title?: string } = {},
): HTMLButtonElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = className;
  row.setAttribute('role', options.role || 'menuitem');
  if (options.selected) row.setAttribute('aria-checked', 'true');
  if (options.title) row.title = options.title;
  const text = document.createElement('span');
  text.className = 'mp-workspace-menu-label';
  text.textContent = label;
  row.appendChild(text);
  if (options.selected) {
    const check = checkGlyph();
    check.classList.add('mp-workspace-menu-check');
    row.appendChild(check);
  }
  row.addEventListener('click', onClick);
  return row;
}

async function openWorkspaceMenu() {
  const menu = document.getElementById('composer-workspace-menu');
  if (!menu) return;
  const projects = await Data.projects().catch(() => [] as MagicPointerProject[]);
  const rows: HTMLElement[] = [];
  const close = () => {
    closeAnchoredPopover('composer-workspace-menu', 'composer-workspace');
  };
  rows.push(workspaceMenuRow('mp-workspace-menu-row', 'No folder', () => {
    close();
    setActiveProject('');
  }, { selected: !activeProjectRoot }));
  if (projects.length) {
    const label = document.createElement('div');
    label.className = 'mp-workspace-menu-section';
    label.textContent = 'Recent';
    rows.push(label);
    for (const project of projects.slice(0, 6)) {
      const root = String(project.root || '');
      if (!root) continue;
      const name = String(project.name || root);
      rows.push(workspaceMenuRow('mp-workspace-menu-row', name || root, () => {
        close();
        setActiveProject(root);
        void startNewChat();
        void renderSidebar();
      }, {
        selected: normalizedProjectRoot(root) === normalizedProjectRoot(activeProjectRoot),
        title: root,
      }));
    }
  }
  const divider = document.createElement('div');
  divider.className = 'mp-workspace-menu-divider';
  rows.push(divider);
  rows.push(workspaceMenuRow('mp-workspace-menu-row', 'Open folder…', () => {
    close();
    void openProjectFromPicker();
  }));
  menu.replaceChildren(...rows);
  positionAnchoredPopover('composer-workspace-menu', 'composer-workspace');
}

document.getElementById('composer-workspace')?.addEventListener('click', (event) => {
  event.stopPropagation();
  const button = event.currentTarget as HTMLButtonElement;
  const menu = document.getElementById('composer-workspace-menu');
  if (!menu) return;
  if (!menu.hidden) { closeAnchoredPopover('composer-workspace-menu', 'composer-workspace'); return; }
  button.setAttribute('aria-expanded', 'true');
  void openWorkspaceMenu();
});
document.getElementById('workspace-filter')?.addEventListener('click', (event) => {
  sidebarRecentOnly = !sidebarRecentOnly;
  const button = event.currentTarget as HTMLButtonElement;
  button.classList.toggle('is-on', sidebarRecentOnly);
  button.setAttribute('aria-pressed', String(sidebarRecentOnly));
  button.title = sidebarRecentOnly ? '只看近 7 天（已启用）' : '只看最近项目';
  void renderSidebar();
});

function compactTokenCount(value: number): string {
  if (value < 1000) return String(value);
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`;
  return `${Number((value / 1000).toFixed(1))}k`;
}

/* ---- 左上角的跳转条 ----
   参考里它不是一条贯穿整屏的轨道，而是钉在正文左上角的一小撮短横：每一条
   我发出去的消息一枚，叠在一起。鼠标移上去才展开成带标签的列表（`— Session
   start` / `— 核验完成，构建档案页`），点一行滚过去。
   以前做成「按全文比例摊在整条左槽上」是错的——那是滚动条的位置，不是
   参考的形状。 */
const RAIL_START_LABEL = 'Session start';

function railEntries(): Array<{ label: string; target: HTMLElement | null }> {
  const stream = document.getElementById('stream');
  if (!stream) return [];
  const entries: Array<{ label: string; target: HTMLElement | null }> = [
    { label: RAIL_START_LABEL, target: null },
  ];
  for (const message of Array.from(stream.querySelectorAll<HTMLElement>('.dsh-user'))) {
    const text = (message.querySelector('.dsh-bubble')?.textContent || '').trim();
    entries.push({ label: text.split('\n')[0].slice(0, 60) || '未命名', target: message });
  }
  /* 只有 Session start 一条时整个控件没有意义——一个没有目的地的跳转条。 */
  return entries.length > 1 ? entries : [];
}
/* 高亮的是「当前视口顶部那一条」。参考里两枚短横一深一浅，深的那枚就是
   你正看着的那一段。 */
function syncStreamRailActive() {
  const rail = document.getElementById('stream-rail');
  const stream = document.getElementById('stream');
  if (!rail || !stream) return;
  const anchors = Array.from(rail.querySelectorAll<HTMLElement>('.dshw-rail-mark'));
  if (!anchors.length) return;
  const streamTop = stream.getBoundingClientRect().top;
  const cursor = stream.scrollTop + 24;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  anchors.forEach((mark, index) => {
    const target = mark.dataset.railIndex === '0' ? null : stream.querySelectorAll<HTMLElement>('.dsh-user')[index - 1];
    const offset = target
      ? target.getBoundingClientRect().top - streamTop + stream.scrollTop
      : 0;
    const distance = Math.abs(offset - cursor);
    if (distance < bestDistance) { bestDistance = distance; best = index; }
  });
  anchors.forEach((mark, index) => {
    mark.setAttribute('data-active', index === best ? 'true' : 'false');
  });
}

function railScrollTo(index: number): void {
  const stream = document.getElementById('stream');
  if (!stream) return;
  const reduceMotion = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const behavior: ScrollBehavior = reduceMotion ? 'auto' : 'smooth';
  if (index === 0) {
    stream.scrollTo({ top: 0, behavior });
    return;
  }
  const message = stream.querySelectorAll<HTMLElement>('.dsh-user')[index - 1];
  message?.scrollIntoView({ block: 'start', behavior });
}

function renderStreamRail() {
  const rail = document.getElementById('stream-rail');
  const marks = document.getElementById('stream-rail-marks');
  const menu = document.getElementById('stream-rail-menu');
  if (!rail || !marks || !menu) return;
  const entries = railEntries();
  if (!entries.length) {
    rail.hidden = true;
    marks.replaceChildren();
    menu.replaceChildren();
    return;
  }
  rail.hidden = false;
  marks.replaceChildren();
  menu.replaceChildren();
  entries.forEach((entry, index) => {
    const mark = document.createElement('span');
    mark.className = 'dshw-rail-mark';
    mark.dataset.railIndex = String(index);
    marks.appendChild(mark);

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'dshw-rail-row';
    row.dataset.railIndex = String(index);
    const dash = document.createElement('span');
    dash.className = 'dshw-rail-dash';
    dash.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'dshw-rail-label';
    label.textContent = entry.label;
    row.append(dash, label);
    row.setAttribute('aria-label', `跳到：${entry.label}`);
    row.addEventListener('click', () => railScrollTo(index));
    menu.appendChild(row);
  });
  syncStreamRailActive();
}

/* 流是一轮一轮长出来的，每轮都会改消息的条数，所以重新数要等这一轮画完再做。
   用 debounce 而不是 rAF：一轮里可能连改好几次 DOM。 */
let streamRailTimer = 0;
function scheduleStreamRail(delay = 80) {
  if (streamRailTimer) window.clearTimeout(streamRailTimer);
  streamRailTimer = window.setTimeout(() => {
    streamRailTimer = 0;
    renderStreamRail();
  }, delay);
}

/* ---- 选中文字 → Start a side chat / Reply ----
   在消息里选中一段文字，旁边浮出这两个动作。它们回答的是同一件事的两个方向：
   「就着这段说一句」（把选中的话引到输入框里）和「拿这段另起一个对话」。
   引用用的是 markdown 引用块——它进的是输入框，用户还能改，而不是偷偷发出去。 */
function quotedSelection(text: string): string {
  const lines = text.split('\n').map((line) => `> ${line}`).join('\n');
  return `${lines}\n\n`;
}

(function bindSelectionActions() {
  const stream = document.getElementById('stream');
  if (!stream) return;
  const pill = document.createElement('div');
  pill.className = 'dshw-select-pill';
  pill.hidden = true;
  pill.setAttribute('role', 'toolbar');
  pill.setAttribute('aria-label', '选中内容的操作');
  const side = document.createElement('button');
  side.type = 'button';
  side.textContent = 'Start a side chat';
  const reply = document.createElement('button');
  reply.type = 'button';
  reply.textContent = 'Reply';
  pill.append(side, reply);
  document.body.appendChild(pill);

  let selected = '';
  let selectionTurn: { conversationId: string; turnIndex: number } | null = null;

  const hide = () => { pill.hidden = true; };

  const update = () => {
    const selection = window.getSelection();
    const text = selection ? String(selection).trim() : '';
    if (!selection || selection.isCollapsed || !text || selection.rangeCount === 0) {
      hide();
      return;
    }
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    const message = element?.closest<HTMLElement>('.dsh-user, .dsh-assistant');
    if (!message || !stream.contains(message)) { hide(); return; }
    /* 引用要连回它出自哪一轮，所以从消息上取分支目标（用户气泡带着它）。 */
    const fork = message.querySelector<HTMLElement>('[data-dsh-branch-conversation]');
    const turnIndex = Number(fork?.getAttribute('data-dsh-branch-turn'));
    selectionTurn = fork && Number.isInteger(turnIndex)
      ? { conversationId: fork.getAttribute('data-dsh-branch-conversation') || '', turnIndex }
      : null;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) { hide(); return; }
    selected = text.slice(0, 4000);
    pill.hidden = false;
    const width = pill.offsetWidth;
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left));
    /* 选中的是最后一行时，浮层放到选区上方——放到下方会压在输入框上。 */
    const below = rect.bottom + 10;
    const top = below + pill.offsetHeight < window.innerHeight - 12 ? below : rect.top - pill.offsetHeight - 10;
    pill.style.left = `${Math.round(left)}px`;
    pill.style.top = `${Math.round(Math.max(12, top))}px`;
  };

  side.addEventListener('mousedown', (event) => event.preventDefault());
  reply.addEventListener('mousedown', (event) => event.preventDefault());
  side.addEventListener('click', () => {
    const target = selectionTurn;
    hide();
    window.getSelection()?.removeAllRanges();
    const textarea = document.querySelector<HTMLTextAreaElement>('#composer-form textarea');
    if (textarea) {
      textarea.value = quotedSelection(selected);
      fitComposer(textarea);
      syncComposerSubmitState();
      textarea.focus();
    }
    if (target?.conversationId) {
      document.dispatchEvent(new CustomEvent('mp:branch-conversation', { detail: target }));
    }
  });
  reply.addEventListener('click', () => {
    hide();
    window.getSelection()?.removeAllRanges();
    const textarea = document.querySelector<HTMLTextAreaElement>('#composer-form textarea');
    if (!textarea) return;
    const quoted = quotedSelection(selected);
    textarea.value = `${quoted}${textarea.value}`;
    fitComposer(textarea);
    syncComposerSubmitState();
    textarea.focus();
    textarea.setSelectionRange(quoted.length, quoted.length);
  });

  /* selectionchange 在拖选过程中会连续触发，等手停下来再定位。 */
  let timer = 0;
  document.addEventListener('selectionchange', () => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => { timer = 0; update(); }, 90);
  });
  stream.addEventListener('scroll', hide, { passive: true });
  document.addEventListener('mousedown', (event) => {
    if (!pill.contains(event.target as Node)) hide();
  });
}());

(function bindStreamRail() {
  const stream = document.getElementById('stream');
  if (!stream) return;
  /* 滚动只改高亮，不重新测量：位置是按全文比例定的，不随滚动漂移。
     用 rAF 合并同一帧里的多次 scroll 事件。 */
  let ticking = false;
  stream.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(() => {
      ticking = false;
      syncStreamRailActive();
    });
  }, { passive: true });
}());

/* 账户配额只问一次：这张卡是「点开看一眼」，不是仪表盘。主进程那边还有
   60 秒缓存，所以即使这里被重建也不会重复打接口。 */
let composerQuota: MagicPointerQuotaReport | null = null;
let composerQuotaPending = false;
let usageMeterTurns: MagicPointerTurn[] = [];
let usageDetailsOpen = false;
let composerQuotaKey = '';

function ensureComposerQuota(force = false) {
  const key = `${modelCatalog?.provider || ''}:${modelCatalog?.source || ''}:${modelCatalog?.current || ''}`;
  if (composerQuotaKey !== key) { composerQuota = null; composerQuotaKey = key; }
  if (composerQuotaPending || (!force && composerQuota && Date.now() - composerQuota.fetchedAt < 60_000)) return;
  composerQuotaPending = true;
  void Data.modelQuota({ force }).then((report) => {
    composerQuotaPending = false;
    if (!report) return;
    if (key !== `${modelCatalog?.provider || ''}:${modelCatalog?.source || ''}:${modelCatalog?.current || ''}`) return;
    composerQuota = report;
    renderUsageMeter(usageMeterTurns);
  });
}

/* 上下文卡里的类别，顺序固定：缓存命中 → 缓存写入 → 新输入 → 输出。
   顺序就是「上下文花在哪」的顺序：缓存里的最便宜，也最该先看见。 */
const USAGE_CATEGORIES = [
  { kind: 'cache-read', label: '缓存命中' },
  { kind: 'cache-write', label: '缓存写入' },
  { kind: 'input', label: '新输入' },
  { kind: 'output', label: '输出' },
] as const;

interface UsageCategoryRow {
  kind: string;
  label: string;
  value: number;
}

/* 一轮 usage 拆成类别行，只留「真到过且不为零」的。缺键整项不出现——「这家
   provider 不报」和「报了零」是两回事，前者画出来就是编数据；值为零的也不
   画，一段零宽的彩色只会让人以为那儿有东西。 */
function usageCategoryRows(usage: MagicPointerModelUsage | undefined): UsageCategoryRow[] {
  if (!usage || typeof usage !== 'object') return [];
  const read = (key: string): number | undefined => {
    const value = usage[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  const cacheRead = read('cacheReadTokens');
  const cacheWrite = read('cacheWriteTokens');
  const input = read('inputTokens');
  const output = read('outputTokens');
  /* 新输入 = 输入总量 − 命中 − 写入，负数按 0。OpenAI 系（含 DeepSeek）的
     prompt_tokens 已经把缓存那段算在内，减出来就是这次真被重新读进去的部分。 */
  const fresh = input === undefined
    ? undefined
    : Math.max(0, input - (cacheRead || 0) - (cacheWrite || 0));
  const values: Record<string, number | undefined> = {
    'cache-read': cacheRead,
    'cache-write': cacheWrite,
    input: fresh,
    output,
  };
  const rows: UsageCategoryRow[] = [];
  for (const category of USAGE_CATEGORIES) {
    const value = values[category.kind];
    if (typeof value === 'number' && value > 0) {
      rows.push({ kind: category.kind, label: category.label, value });
    }
  }
  return rows;
}

/* 一段占窗口多少，换算成百分比宽度。夹在 0..100：一段画不出比整条还长。
   零和负数在这里也返回 0%，虽然它们在 usageCategoryRows 就已经被滤掉——
   零宽的彩色段看着像「这里有东西」，两头都不放它进来。 */
function usageSegmentShare(value: number, contextWindow: number): string {
  if (!(contextWindow > 0) || !(value > 0)) return '0%';
  return `${Math.max(0, Math.min(100, value / contextWindow * 100))}%`;
}

function contextCategoryRows(usage: MagicPointerModelUsage | undefined): Array<{kind: string; label: string; value: number}> {
  if (!usage?.contextTokens) return [];
  const estimates = [
    { kind: 'system', label: '系统提示词', value: usage.systemTokensEstimate || 0 },
    { kind: 'tools', label: '工具定义', value: usage.toolSchemaTokensEstimate || 0 },
    { kind: 'messages', label: '对话消息', value: usage.messageTokensEstimate || 0 },
    { kind: 'results', label: '工具结果', value: usage.toolResultTokensEstimate || 0 },
  ].filter(row => row.value > 0);
  const sum = estimates.reduce((total, row) => total + row.value, 0);
  if (sum === 0) return [{ kind: 'input', label: '请求输入', value: usage.contextTokens }];
  return estimates.map(row => ({ ...row, value: row.value / sum * usage.contextTokens! }));
}

function latestContextUsage(turns: MagicPointerTurn[]): MagicPointerModelUsage | undefined {
  for (const turn of [...turns].reverse()) {
    const records = turn.liveProgress?.trajectory || turn.trajectory || [];
    const current = [...records].reverse().find(record => record.kind === 'message'
      && typeof (record.modelUsage as MagicPointerModelUsage)?.contextTokens === 'number')?.modelUsage as MagicPointerModelUsage | undefined;
    if (current) return current;
    if (typeof turn.modelUsage?.contextTokens === 'number') return turn.modelUsage;
    // Older saved turns contain only the sum of their model calls.
    if (turn.modelUsage) return undefined;
  }
  return undefined;
}

function positionUsageBreakdown() {
  const main = document.getElementById('composer-usage-popover');
  const detail = document.getElementById('composer-usage-breakdown');
  if (!main || main.hidden || !detail || detail.hidden) return;
  const rect = main.getBoundingClientRect();
  const gap = 8;
  detail.style.width = `${Math.min(320, Math.max(120, rect.left - gap - 12))}px`;
  detail.style.left = `${Math.max(12, rect.left - detail.offsetWidth - gap)}px`;
  detail.style.top = `${Math.max(12, Math.min(rect.top, window.innerHeight - detail.offsetHeight - 12))}px`;
}

function setUsageDetailsOpen(open: boolean) {
  usageDetailsOpen = open;
  const detail = document.getElementById('composer-usage-breakdown');
  if (detail) detail.hidden = !open;
  document.querySelectorAll('#composer-usage-popover [aria-controls="composer-usage-breakdown"]')
    .forEach(node => node.setAttribute('aria-expanded', String(open)));
  if (open) positionUsageBreakdown();
}

function renderUsageMeter(turns: MagicPointerTurn[]) {
  usageMeterTurns = turns;
  const button = document.getElementById('composer-context') as HTMLButtonElement | null;
  const label = document.getElementById('composer-usage-label');
  const popover = document.getElementById('composer-usage-popover');
  if (!button || !label || !popover) return;
  const inputTokens = turns.reduce((total, turn) => total + (Number((latestContextUsage([turn]) || turn.modelUsage)?.inputTokens) || 0), 0);
  const outputTokens = turns.reduce((total, turn) => total + (Number((latestContextUsage([turn]) || turn.modelUsage)?.outputTokens) || 0), 0);
  const totalTokens = inputTokens + outputTokens;
  const currentModel = modelCatalog?.groups?.flatMap((group) => group.models || [])
    .find((entry) => entry.id === modelCatalog?.current
      && (!modelCatalog?.currentProfileId || entry.profileId === modelCatalog.currentProfileId));
  const latestUsage = latestContextUsage(turns);
  const contextWindow = Number(latestUsage?.contextWindow) || Number(currentModel?.contextWindow) || 0;
  /* 「上下文占了多少」问的是**这一次请求送进去多少**，所以只数输入。
     以前把输出也加了进来：输出还没被送回去，把它算进窗口占用既说不通，
     又会把百分比顶到 100%，看上去像一条越界的实心色块。
     比例本身不夹：真超过窗口就该看得见超过，夹掉的数字是在替数据圆谎。
     夹的只有进度条的宽度——那条画不出超过 100%。 */
  const contextTokens = Number(latestUsage?.contextTokens) || 0;
  const measured = latestUsage?.contextEstimated === 0 || turns.length === 0;
  const known = typeof latestUsage?.contextTokens === 'number' || turns.length === 0;
  const contextRatio = contextWindow > 0 ? contextTokens / contextWindow * 100 : 0;
  const contextProgress = Math.max(0, Math.min(100, Math.round(contextRatio)));
  button.hidden = false;
  button.style.setProperty('--mp-context-progress', String(contextProgress));
  label.textContent = known && contextWindow > 0
    ? `${measured ? '' : '≈'}${Math.round(contextRatio)}% context used`
    : 'Context usage unavailable';
  button.title = contextWindow > 0
    ? `Context ${contextTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens`
    : `Session usage: ${totalTokens.toLocaleString()} tokens`;
  /* Context is the latest request. Account windows come from the provider;
     cumulative billing counters are available in the expanded details. */
  popover.replaceChildren();
  const el = (tag: string, className: string, text?: string) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const head = el('button', 'mp-usage-head') as HTMLButtonElement;
  head.type = 'button';
  head.setAttribute('aria-expanded', String(usageDetailsOpen));
  const toggleDetails = (event: Event) => {
    event.stopPropagation();
    setUsageDetailsOpen(!usageDetailsOpen);
  };
  head.setAttribute('aria-controls', 'composer-usage-breakdown');
  head.addEventListener('click', toggleDetails);
  head.append(el('span', 'mp-usage-head-label', 'Context window'));
  const headValue = el('span', 'mp-usage-head-value',
    known && contextWindow > 0
      ? `${measured ? '' : '≈'}${compactTokenCount(contextTokens)} / ${compactTokenCount(contextWindow)} (${Math.round(contextRatio)}%)`
      : `${known ? compactTokenCount(contextTokens) : '—'} / ${contextWindow > 0 ? compactTokenCount(contextWindow) : '—'}`);
  const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chev.setAttribute('aria-hidden', 'true');
  chev.classList.add('mp-usage-chev');
  const chevUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  chevUse.setAttribute('href', '#ic-chev');
  chev.appendChild(chevUse);
  head.append(headValue, chev);
  popover.append(head);

  /* The composition is provider-independent. Component proportions are local
     estimates; their sum is calibrated to the measured request input. */
  const latestRows = contextCategoryRows(latestUsage);
  const bar = el('div', 'mp-usage-bar');
  if (contextWindow > 0) {
    for (const row of latestRows) {
      const segment = el('span', `mp-usage-seg is-${row.kind}`);
      segment.setAttribute('data-kind', row.kind);
      segment.title = `${row.label}：约 ${Math.round(row.value).toLocaleString()} tokens`;
      segment.style.width = usageSegmentShare(row.value, contextWindow);
      bar.append(segment);
    }
  }
  popover.append(bar);

  const details = document.getElementById('composer-usage-breakdown') || el('div', 'mp-usage-breakdown');
  details.replaceChildren();
  details.hidden = !usageDetailsOpen;
  const detailHead = el('div', 'mp-usage-head');
  detailHead.append(el('span', '', 'Context window'));
  detailHead.append(el('span', 'mp-usage-head-value', headValue.textContent || ''));
  details.append(detailHead);
  const contextRows = [...latestRows, ...(contextWindow > 0 ? [{
    kind: 'available', label: '剩余空间', value: Math.max(0, contextWindow - contextTokens),
  }] : [])];
  for (const row of contextRows) {
    const node = el('div', 'mp-usage-row mp-usage-context-row');
    node.dataset.kind = row.kind;
    const rowLabel = el('span', 'mp-usage-row-label');
    const swatch = el('span', 'mp-usage-swatch');
    swatch.dataset.kind = row.kind;
    rowLabel.append(swatch, document.createTextNode(row.label));
    node.append(rowLabel, el('span', 'mp-usage-row-value', `${row.kind === 'available' ? '' : '≈'}${Math.round(row.value).toLocaleString()}`));
    const track = el('div', 'mp-usage-row-track');
    const fill = el('div', 'mp-usage-row-fill');
    fill.dataset.kind = row.kind;
    fill.style.width = usageSegmentShare(row.value, contextWindow);
    track.append(fill);
    node.append(track);
    details.append(node);
  }
  if (latestRows.length) details.append(el('div', 'mp-usage-note', measured
    ? '总量为服务端计量；各项占比为本地估算。' : '本地估算 · 收到服务端用量后更新。'));
  details.append(el('div', 'mp-usage-divider'));
  const section = el('div', 'mp-usage-section');
  section.append(el('span', 'mp-usage-section-label', `本会话累计 · ${totalTokens.toLocaleString()} tokens`));
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arrow.setAttribute('viewBox', '0 0 20 20');
  arrow.setAttribute('aria-hidden', 'true');
  arrow.classList.add('mp-usage-arrow');
  const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrowPath.setAttribute('d', 'M4 10h12m0 0-5-5m5 5-5 5');
  arrowPath.setAttribute('fill', 'none');
  arrowPath.setAttribute('stroke', 'currentColor');
  arrowPath.setAttribute('stroke-width', '1.5');
  arrowPath.setAttribute('stroke-linecap', 'round');
  arrowPath.setAttribute('stroke-linejoin', 'round');
  arrow.appendChild(arrowPath);
  details.append(section);

  /* 本会话的类别合计。一行一个类别，每行的条用这一类别自己的颜色——四行四个
     色，不是四行一个色。这一段的尺度和上面那条不一样：上面问的是「这一轮占
     了窗口多少」，这里问的是「整个会话花在哪」，所以各算各的，不硬凑成一个数。 */
  const sessionTotals: Record<string, number> = {};
  for (const turn of turns) {
    for (const row of usageCategoryRows(latestContextUsage([turn]) || turn.modelUsage)) {
      sessionTotals[row.kind] = (sessionTotals[row.kind] || 0) + row.value;
    }
  }
  const sessionRows = USAGE_CATEGORIES
    .map((category) => ({
      kind: category.kind,
      label: category.label,
      value: sessionTotals[category.kind] || 0,
    }))
    .filter((row) => row.value > 0);
  for (const row of sessionRows) {
    const node = el('div', 'mp-usage-row');
    node.append(el('span', 'mp-usage-row-label', row.label));
    node.append(el('span', 'mp-usage-row-value', compactTokenCount(row.value)));
    details.append(node);
  }

  /* 账户配额。数字来自 provider 自己的接口（见 electron/quota_probe.ts），
     这里只负责画。没有适配器就整段不出现——「少一行」和「编一个数」的区别，
     用户是看不出来的，所以宁可少一行。适配器认出来了但请求失败时会留一行
     灰色的原因，那是真信息，不是装饰。 */
  if (composerQuota && (composerQuota.rows.length > 0 || composerQuota.error)) {
    popover.append(el('div', 'mp-usage-divider'));
    const quotaSection = el('button', 'mp-usage-section mp-usage-quota-head');
    quotaSection.setAttribute('aria-expanded', String(usageDetailsOpen));
    quotaSection.setAttribute('aria-controls', 'composer-usage-breakdown');
    const quotaTitle = composerQuota.rows.some(row => row.percent !== null) ? 'Plan usage limits' : 'Usage';
    quotaSection.append(el('span', 'mp-usage-section-label',
      composerQuota.label ? `${quotaTitle} · ${composerQuota.label}` : quotaTitle));
    const quotaArrow = arrow.cloneNode(true);
    quotaSection.append(quotaArrow);
    quotaSection.addEventListener('click', toggleDetails);
    popover.append(quotaSection);
    const quotaRows = el('div', 'mp-usage-quota-rows');
    for (const row of composerQuota.rows) {
      const node = el('div', 'mp-usage-row');
      node.append(el('span', 'mp-usage-row-label', row.label));
      const value = el('span', 'mp-usage-row-value');
      if (row.detail) value.append(el('span', 'mp-usage-row-detail', row.detail));
      value.append(el('span', '', row.value));
      node.append(value);
      if (row.percent !== null && row.percent !== undefined) {
        const track = el('div', 'mp-usage-row-track');
        const fill = el('div', 'mp-usage-row-fill');
        fill.style.width = `${Math.max(0, Math.min(100, Number(row.percent)))}%`;
        track.append(fill);
        node.append(track);
      }
      quotaRows.append(node);
    }
    popover.append(quotaRows);
    if (composerQuota.adapter === 'deepseek') {
      let cost = 0;
      let priced = 0;
      let reported = 0;
      for (const turn of turns) {
        const usage = latestContextUsage([turn]) || turn.modelUsage;
        cost += usage?.estimatedCostUsd || 0;
        priced += usage?.pricedRequests || 0;
        reported += usage?.turnsReported || 0;
      }
      const row = el('div', 'mp-usage-row');
      row.append(el('span', 'mp-usage-row-label', '本会话费用 (USD)'));
      row.append(el('span', 'mp-usage-row-value', priced > 0 ? `≈$${cost.toFixed(6)}` : '—'));
      quotaRows.append(row);
      details.append(el('div', 'mp-usage-note', `已计价 ${priced}/${reported} 次请求。按 DeepSeek 官方 2026-09-19 价格、缓存与峰谷时段估算；以厂家账单为准。`));
    }
    if (composerQuota.error) popover.append(el('div', 'mp-usage-note', composerQuota.error));
    details.append(el('div', 'mp-usage-note', `额度更新于 ${new Date(composerQuota.fetchedAt).toLocaleTimeString()} · ${composerQuota.source}`));
  } else {
    popover.append(el('div', 'mp-usage-divider'));
    popover.append(el('div', 'mp-usage-section', composerQuotaPending ? 'Loading usage…' : 'Usage · 当前服务未提供额度接口'));
  }

  popover.append(el('div', 'mp-usage-divider'));
  const foot = document.createElement('button');
  foot.type = 'button';
  foot.className = 'mp-usage-foot';
  foot.textContent = 'See detailed breakdown';
  foot.setAttribute('aria-controls', 'composer-usage-breakdown');
  foot.setAttribute('aria-expanded', String(usageDetailsOpen));
  foot.addEventListener('click', toggleDetails);
  popover.append(foot);
  if (!popover.hidden) positionAnchoredPopover('composer-usage-popover', 'composer-context');
  positionUsageBreakdown();
}

document.getElementById('composer-context')?.addEventListener('click', (event) => {
  event.stopPropagation();
  const button = event.currentTarget as HTMLButtonElement;
  const popover = document.getElementById('composer-usage-popover');
  if (!popover) return;
  const open = popover.hidden;
  if (open) {
    positionAnchoredPopover('composer-usage-popover', 'composer-context');
    // 配额不是每个回合都会变，但也不该在启动时就打一次接口——等这张卡被
    // 真正打开再问，然后原地补上那几行。
    ensureComposerQuota(true);
  } else closeAnchoredPopover('composer-usage-popover', 'composer-context');
  button.setAttribute('aria-expanded', String(open));
});

window.setInterval(() => {
  if (!document.hidden && !document.getElementById('composer-usage-popover')?.hidden) ensureComposerQuota();
}, 15_000);

/* ---- 打开一条对话 ---- */
let activeConversationId: string | null = null;
let activeConversationTab: 'chat' | 'trajectory' = 'chat';
let activeConversationTurnCount = 0;
let activeConversationTurns: Record<string, unknown>[] = [];
let activeConversationView: ReturnType<typeof DshChat.createConversationView> | null = null;
let activeConversationRecord: MagicPointerConversation | null = null;
let conversationOpenGeneration = 0;
let conversationRefreshSequence = 0;
let conversationNotificationSequence = 0;
let externalConversationRun: { requestId: string; agentSessionId: string; body: HTMLElement } | null = null;
/* 这条对话挂着的屏幕对象：联想词要读它，否则模型只看到半截上下文。 */
let activeConversationObject: Record<string, unknown> = {};
let activeTaskContext: MagicPointerTaskContext | null = null;
const composerSelectedSourceIds = new Set<string>();
let figmaStatusTimer: number | null = null;
let figmaPairExpiresAt = 0;

function stopFigmaStatusPolling() {
  if (figmaStatusTimer !== null) window.clearTimeout(figmaStatusTimer);
  figmaStatusTimer = null;
}

function figmaConnectionElements() {
  return {
    status: document.getElementById('figma-connection-status'),
    code: document.getElementById('figma-pair-code'),
    button: document.getElementById('figma-connect') as HTMLButtonElement | null,
  };
}

async function refreshFigmaConnection(poll = false) {
  const conversationId = activeConversationId;
  const { status, code, button } = figmaConnectionElements();
  if (!status || !code || !button) return;
  if (!conversationId) {
    stopFigmaStatusPolling();
    button.disabled = true;
    button.textContent = '连接';
    delete button.dataset.documentSessionId;
    code.hidden = true;
    status.textContent = '先打开并运行一个任务，再连接当前 Figma 文档。';
    return;
  }
  button.disabled = true;
  const result = await Data.figmaStatus(conversationId);
  if (conversationId !== activeConversationId) return;
  const connections = Array.isArray(result.connections) ? result.connections : [];
  const connection = connections[0] as Record<string, unknown> | undefined;
  if (result.ok && connection) {
    stopFigmaStatusPolling();
    figmaPairExpiresAt = 0;
    code.hidden = true;
    button.disabled = false;
    button.textContent = '断开';
    button.dataset.documentSessionId = String(connection.documentSessionId || '');
    status.textContent = [
      String(connection.documentName || '当前文档'),
      String(connection.pageName || ''),
      `${Array.isArray(connection.selectionIds) ? connection.selectionIds.length : 0} 个选中节点`,
    ].filter(Boolean).join(' · ');
    return;
  }
  delete button.dataset.documentSessionId;
  button.textContent = '连接';
  button.disabled = false;
  if (!result.ok) {
    status.textContent = result.error === 'figma_connection_requires_started_task'
      ? '这条对话尚未产生运行时任务；先发送一次任务。'
      : String(result.error || '暂时无法读取 Figma 连接状态。');
    code.hidden = true;
    stopFigmaStatusPolling();
    return;
  }
  if (!figmaPairExpiresAt || Date.now() >= figmaPairExpiresAt) {
    status.textContent = '尚未连接当前 Figma 文档。';
    code.hidden = true;
    stopFigmaStatusPolling();
    return;
  }
  if (poll) {
    stopFigmaStatusPolling();
    figmaStatusTimer = window.setTimeout(() => { void refreshFigmaConnection(true); }, 1000);
  }
}

async function toggleFigmaConnection() {
  const conversationId = activeConversationId;
  const { status, code, button } = figmaConnectionElements();
  if (!conversationId || !status || !code || !button) return;
  button.disabled = true;
  const documentSessionId = button.dataset.documentSessionId;
  if (documentSessionId) {
    const result = await Data.disconnectFigma(conversationId, documentSessionId);
    if (!result.ok) status.textContent = String(result.error || 'Figma 断开失败。');
    await refreshFigmaConnection();
    return;
  }
  const result = await Data.pairFigma(conversationId);
  if (!result.ok) {
    status.textContent = String(result.error || '无法启动 Figma 配对。');
    button.disabled = false;
    return;
  }
  figmaPairExpiresAt = Number(result.expiresAt) || 0;
  code.textContent = `${String(result.pairCode || '')} · ${String(result.baseUrl || '')}`;
  code.hidden = false;
  status.textContent = result.installableManifestBuilt
    ? '在 Magic Pointer Figma 插件中输入这组一次性配对码。'
    : '插件代码已构建，但本机没有 Figma 分配的真实插件 ID；请先用 Create New Plugin 建立 ID，再生成可导入 manifest。';
  button.disabled = false;
  stopFigmaStatusPolling();
  figmaStatusTimer = window.setTimeout(() => { void refreshFigmaConnection(true); }, 1000);
}

document.getElementById('figma-connect')?.addEventListener('click', () => {
  void toggleFigmaConnection();
});
/* cardId → DSH 回合节点：后台任务补丁就地换节点，不重建整条流 */
const dshCardNodes = new Map<string, HTMLElement>();

function setStudioHomeVisible(visible: boolean) {
  const home = document.getElementById('studio-home');
  const header = document.querySelector<HTMLElement>('#view-chat > .dshw-header');
  const stream = document.getElementById('stream');
  const trajectory = document.getElementById('trajectory');
  const contextRow = document.querySelector<HTMLElement>('.mp-composer-context-row');
  const textarea = document.querySelector<HTMLTextAreaElement>('#composer-form textarea');
  if (home) home.hidden = !visible;
  if (header) header.hidden = visible;
  if (stream) stream.hidden = visible || activeConversationTab !== 'chat';
  if (trajectory) trajectory.hidden = visible || activeConversationTab !== 'trajectory';
  if (contextRow) contextRow.hidden = !visible && Boolean(activeProjectRoot);
  if (textarea) applyComposerPlaceholder(textarea);
  document.getElementById('nav-new-chat')?.classList.toggle('is-on', visible);
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
  const generation = ++conversationOpenGeneration;
  const notificationSequence = conversationNotificationSequence;
  const c = await Data.conversation(id);
  if (!c || generation !== conversationOpenGeneration) return;
  const switchedTask = activeConversationId !== c.id;
  if (switchedTask) {
    detachPendingConversation();
    pendingPermissionChoice = null;
    composerPlan = null;
    renderPlanCard();
  }
  if (artifactEditor.state().conversationId && artifactEditor.state().conversationId !== c.id) {
    artifactEditor.clear();
    renderArtifactEditor();
    if (activeInspectorTab === 'artifact') setInspector(false);
  }
  if (activeConversationId !== c.id) repositoryContextDismissedFor = '';
  activeConversationId = c.id;
  void refreshBackgroundAgentTasks(c.id);
  activeConversationRecord = c;
  void renderConversationRecovery(c.id);
  activeConversationView = null;
  conversationRefreshSequence += 1;
  if (externalConversationRun) {
    externalConversationRun = null;
    studioComposerBusy = Boolean(pendingConversation);
    setComposerRunningState(studioComposerBusy);
  }
  setActiveTaskContext(c.taskContext, switchedTask);
  void refreshFigmaConnection();
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
  await renderRepositoryContextBar(true);
  if (generation !== conversationOpenGeneration) return;
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
  activeConversationTurns = turns as Record<string, unknown>[];
  composerPlan = PlanList.project(turns);
  renderPlanCard();
  activeConversationObject = (c as { object?: Record<string, unknown> }).object || {};
  /* 换了对话，上一条的建议就不再是关于「这里」的了。 */
  clearComposerSuggestion();
  renderProjectTasks();
  if (!turns.length) {
    stream.innerHTML = emptyStateMarkup('ic-message-plus', '这条对话还没有内容', '继续输入任务，或从屏幕上划过一个对象作为上下文。');
    syncConversationPendingInput(turns);
    renderUsageMeter([]);
    const trajectory = document.getElementById('trajectory');
    if (trajectory) trajectory.replaceChildren(DshTrajectory.render([]));
    setConversationTab(activeConversationTab);
    return;
  }
  // 每轮使用稳定的工具/思考结构；消息本身保持克制，操作在悬停时出现。
  const flow = document.createElement('div');
  flow.className = 'dsh-flow';
  activeConversationView = DshChat.createConversationView(flow);
  activeConversationView.update(c);
  for (const [turnIndex, t] of turns.entries()) {
    const host = flow.querySelector<HTMLElement>(`.dsh-flow-item[data-turn-index="${turnIndex}"]`)!;
    // 后台任务补丁按舞台同款 cardId 就地落到这个节点：登记代理卡，
    // 补丁来了 replaceWith 重画，不重建整条流。
    const proxy = LiveCards.track(CardModel.normalizeCard({
      id: `${t.at || 0}-a`,
      kind: 'prose',
      state: t.failed ? 'failed' : 'done',
      answer: t.answer || '',
      error: t.failed ? String(t.error || '这次没能完成。') : '',
      steps: (t.trace || []).map((x) => (typeof x === 'string'
        ? { label: x, state: 'done' }
        : { label: x.label, note: x.note || '', state: 'done' })),
    }));
    dshCardNodes.set(proxy.id, host);
  }
  stream.replaceChildren(flow);
  syncConversationPendingInput(turns);
  stream.scrollTop = stream.scrollHeight;
  DshChat.bindDelegation(stream);
  syncExternalConversationRun(c);
  scheduleStreamRail();
  renderUsageMeter(turns);
  const trajectory = document.getElementById('trajectory');
  if (trajectory) trajectory.replaceChildren(DshTrajectory.render(DshTrajectory.project(turns)));
  setConversationTab(activeConversationTab);
  if (notificationSequence !== conversationNotificationSequence) void refreshOpenConversation({ id: c.id });
}

/* The last turn owns the composer question for both reopening and external
   task updates. Replacing that turn must also clear any previous question. */
function syncConversationPendingInput(turns: MagicPointerTurn[]) {
  const last = turns.at(-1);
  const pending = last && !last.liveProgress ? last.pendingInput : null;
  const options = Array.isArray(pending?.options) ? pending.options.map(String).filter(Boolean) : [];
  pendingPermissionAsk = null;
  pendingAskInput = null;
  if (pending?.kind === 'permission' && String(pending.tool || '').trim()) {
    pendingPermissionAsk = {
      requestId: pending.requestId || pendingToolRequestId(last),
      tool: String(pending.tool),
      prefix: String(pending.prefix || '').trim() || undefined,
      actionPreview: pending.actionPreview,
      question: String(pending.question || '').trim() || undefined,
      options: options.length ? options : undefined,
    };
  } else if (pending && (pending.questions?.length || pending.question)) {
    pendingAskInput = { ...pending, requestId: pending.requestId || pendingToolRequestId(last),
      question: String(pending.question || '需要你的决定'), options };
  }
  renderPermissionAsk();
}

function syncExternalConversationRun(conversation: MagicPointerConversation) {
  if (pendingConversation) return;
  const turns = conversation.turns || [];
  const live = turns.at(-1)?.liveProgress;
  const body = document.querySelector<HTMLElement>(`.dsh-flow-item[data-turn-index="${turns.length - 1}"]`);
  const wasRunning = Boolean(externalConversationRun);
  const next = live?.requestId && body ? {
    requestId: live.requestId,
    agentSessionId: live.agentSessionId || conversation.agentSessionId || conversation.taskContext?.taskId || '',
    body,
  } : null;
  if (next && externalConversationRun?.requestId === next.requestId) Object.assign(externalConversationRun, next);
  else externalConversationRun = next;
  studioComposerBusy = Boolean(externalConversationRun);
  if (wasRunning !== studioComposerBusy) setComposerRunningState(studioComposerBusy);
}

async function refreshOpenConversation(change?: MagicPointerConversationChange) {
  const id = activeConversationId;
  if (!id || !change?.id || change.id !== id || !activeConversationView || pendingConversation) return;
  const sequence = ++conversationRefreshSequence;
  let conversation: MagicPointerConversation | null;
  const index = change.turnIndex;
  if (change.liveProgress && Number.isInteger(index) && activeConversationTurns[Number(index)] && activeConversationRecord) {
    const turns = activeConversationTurns.slice() as MagicPointerTurn[];
    turns[Number(index)] = { ...turns[Number(index)], outcome: '进行中', liveProgress: change.liveProgress };
    conversation = { ...activeConversationRecord, turns };
  } else conversation = (await Data.conversation(id)) || null;
  if (!conversation || activeConversationId !== id || sequence !== conversationRefreshSequence || !activeConversationView) return;
  activeConversationRecord = conversation;
  activeConversationTurns = conversation.turns || [];
  activeConversationTurnCount = activeConversationTurns.length;
  composerPlan = PlanList.project(activeConversationTurns);
  renderPlanCard();
  if (conversation.taskContext) setActiveTaskContext(conversation.taskContext);
  const stream = document.getElementById('stream');
  if (stream) followIfNearBottom(stream, () => activeConversationView?.update(conversation!));
  syncExternalConversationRun(conversation);
  if (change.liveProgress && inspectorState.open && activeInspectorTab === 'tasks') renderProjectTasks();
  if (!change.liveProgress) {
    void renderConversationRecovery(conversation.id);
    syncConversationPendingInput(conversation.turns || []);
    renderUsageMeter(conversation.turns || []);
    renderProjectTasks();
    const trajectory = document.getElementById('trajectory');
    if (trajectory) trajectory.replaceChildren(DshTrajectory.render(DshTrajectory.project(conversation.turns || [])));
  }
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
  artifactId?: string;
  revision?: number;
  kind?: string;
  summary?: string;
  name?: string;
  from?: string;
  at?: number;
  conversationId?: string;
}
/* 产物页的筛选状态。写在模块级：切走再切回来时 renderArtifacts 会因为
   host 已有内容而早退，状态必须活得比一次渲染长。 */
let artifactCache: ArtifactEntry[] = [];
let artifactScope: 'all' | 'mine' = 'all';
let artifactKind = '';
let artifactQuery = '';
let artifactLayout: 'list' | 'grid' = 'list';
let artifactViewBound = false;
const artifactPreviews = new Map<string, string>();
const artifactPreviewPending = new Set<string>();

function artifactGlyph(name: string, size = 'small') {
  return (globalThis as unknown as { CdsIcons: { html(name: string, size: string): string } }).CdsIcons.html(name, size);
}

/* kind 是桥端透传的自由字符串（现网见过 file / text / document_patch）。
   只给认得的 kind 配中文名和图标，认不得的原样显示——不编类型。 */
const ARTIFACT_KIND_LABELS: Record<string, string> = {
  file: '文件',
  text: '文本',
  document_patch: '文档补丁',
  code: '代码',
  image: '图片',
};

function artifactKindLabel(kind: string) {
  return ARTIFACT_KIND_LABELS[kind] || kind;
}

function artifactKindIcon(kind: string) {
  if (kind === 'code') return 'code';
  if (kind === 'image') return 'image';
  return 'document';
}

/* 产物名是落盘内容的第一行，模型经常写成 `**验证结果：已通过。**`。列表里一行
   标题不能留 Markdown 记号，所以渲染前剥成纯文本：这里不解析结构，只去掉
   标记符号、保留文字。 */
function artifactPlainLine(value: unknown, limit = 120) {
  const text = String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^[-+*]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__)([\s\S]*?)\1/g, '$2')
    .replace(/(\*|_)([^*_\n]+)\1/g, '$2')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/* 分组标题要的是参考里的「今天 / 昨天 / 9月13日」。data.ts 的 dayLabel 回的是
   「9 月 13 日」（带空格），formatTime 当天只回时刻，都对不上，所以单独一个。 */
function artifactDayKey(at: number) {
  const date = new Date(at);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return '今天';
  if (date.toDateString() === new Date(today.getTime() - 86400000).toDateString()) return '昨天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function artifactMatches(entry: ArtifactEntry) {
  if (artifactScope === 'mine' && !String(entry.artifactId || '').trim()) return false;
  if (artifactKind && String(entry.kind || '') !== artifactKind) return false;
  if (artifactQuery) {
    const haystack = `${entry.name || ''} ${entry.summary || ''} ${entry.from || ''}`.toLowerCase();
    if (!haystack.includes(artifactQuery)) return false;
  }
  return true;
}

function artifactRowMarkup(entry: ArtifactEntry) {
  const kind = String(entry.kind || '');
  const name = artifactPlainLine(entry.name) || artifactPlainLine(entry.summary) || '未命名产物';
  const meta = [
    formatTime(entry.at),
  ].filter(Boolean).join(' · ');
  const openAttrs = entry.artifactId
    ? `data-artifact-id="${esc(entry.artifactId)}" data-artifact-conversation="${esc(entry.conversationId)}"`
    : `data-open="${esc(entry.conversationId)}"`;
  const excerpt = artifactPreviews.get(`${entry.artifactId}:${entry.revision || 0}`) || entry.summary || name;
  return `<div class="mp-artifact-item"><button type="button" class="mp-artifact-row" ${openAttrs} title="${esc(entry.from ? `${name} · ${entry.from}` : name)}">
      <span class="mp-artifact-preview" aria-hidden="true">${studioLibraries.artifactPreviewMarkup({ ...entry, name }, excerpt)}</span>
      <span class="mp-artifact-tile" data-kind="${esc(kind)}" aria-hidden="true">${artifactGlyph(artifactKindIcon(kind))}</span>
      <span class="mp-artifact-name">${esc(name)}</span>
      <span class="mp-artifact-meta">${esc(meta)}</span>
    </button><details class="mp-artifact-actions"><summary aria-label="产物操作">${artifactGlyph('more-horizontal')}</summary>
      <div class="mp-artifact-action-menu"><button type="button" ${openAttrs}>${artifactGlyph('external')}打开产物</button>
      ${entry.conversationId ? `<button type="button" data-open="${esc(entry.conversationId)}">${artifactGlyph('composer-aux1')}查看来源对话</button>` : ''}</div>
    </details></div>`;
}

/* 空态照参考的克制写法：只有一行灰字，没有插画、没有那颗撑满页面的图标。 */
function artifactEmptyMarkup(message: string) {
  return `<div class="mp-artifact-empty-state">${studioLibraries.pictogram('HandShapes')}<p class="mp-artifact-empty">${esc(message)}</p></div>`;
}

function closeArtifactKindMenu() {
  const menu = document.getElementById('artifact-kind-menu');
  if (menu) menu.hidden = true;
  document.getElementById('artifact-kind-trigger')?.setAttribute('aria-expanded', 'false');
}

function paintArtifactToolbar(list: ArtifactEntry[]) {
  const kinds = Array.from(new Set(list.map((entry) => String(entry.kind || '')).filter(Boolean))).sort();
  if (artifactKind && !kinds.includes(artifactKind)) artifactKind = '';
  const menu = document.getElementById('artifact-kind-menu');
  if (menu) {
    menu.innerHTML = [''].concat(kinds).map((kind) => {
      const label = kind ? artifactKindLabel(kind) : '全部类型';
      const count = kind ? list.filter((entry) => String(entry.kind || '') === kind).length : list.length;
      return `<button type="button" role="menuitemradio" aria-checked="${kind === artifactKind ? 'true' : 'false'}"
        data-artifact-kind="${esc(kind || '__all__')}"><span class="mp-kind-label">${kind ? `<span class="mp-artifact-kind-icon" data-kind="${esc(kind)}">${artifactGlyph(artifactKindIcon(kind))}</span>` : ''}${esc(label)}</span><span class="mp-kind-tail">${kind === artifactKind ? artifactGlyph('check') : `<em>${count}</em>`}</span></button>`;
    }).join('');
  }
  const kindLabel = document.getElementById('artifact-kind-label');
  if (kindLabel) kindLabel.textContent = artifactKind ? artifactKindLabel(artifactKind) : '全部类型';
  for (const tab of document.querySelectorAll<HTMLElement>('[data-artifact-scope]')) {
    const on = tab.dataset.artifactScope === artifactScope;
    tab.classList.toggle('is-on', on);
    tab.setAttribute('aria-pressed', String(on));
  }
  const layout = document.getElementById('artifact-layout-toggle');
  if (layout) {
    const grid = artifactLayout === 'grid';
    const text = grid ? '切换为列表布局' : '切换为网格布局';
    layout.setAttribute('aria-pressed', String(grid));
    layout.setAttribute('aria-label', text);
    layout.setAttribute('title', text);
    layout.innerHTML = artifactGlyph(grid ? 'layout-list' : 'layout-grid');
  }
  const host = document.getElementById('art-list');
  if (host) host.dataset.layout = artifactLayout;
}

function paintArtifacts() {
  const host = document.getElementById('art-list');
  if (!host) return;
  paintArtifactToolbar(artifactCache);
  if (!artifactCache.length) {
    host.innerHTML = artifactEmptyMarkup('还没有产物。Agent 生成并落盘的文档、代码与草稿会出现在这里。');
    return;
  }
  const filtered = artifactCache.filter(artifactMatches);
  if (!filtered.length) {
    host.innerHTML = artifactEmptyMarkup('没有匹配的产物。');
    return;
  }
  // 分组按「第一次出现的日期」排序，缓存本身已按 at 从新到旧，所以组序和组内
  // 顺序都不需要再排一次。
  const groups: Array<{ label: string; items: ArtifactEntry[] }> = [];
  const byLabel = new Map<string, ArtifactEntry[]>();
  for (const entry of filtered) {
    const at = Number(entry.at);
    const label = Number.isFinite(at) && at > 0 ? artifactDayKey(at) : '更早';
    let bucket = byLabel.get(label);
    if (!bucket) {
      bucket = [];
      byLabel.set(label, bucket);
      groups.push({ label, items: bucket });
    }
    bucket.push(entry);
  }
  host.innerHTML = groups.map((group) => `<div class="mp-artifact-group">
    <div class="mp-artifact-group-label">${esc(group.label)}</div>
    ${group.items.map((entry) => artifactRowMarkup(entry)).join('')}
  </div>`).join('');
  if (artifactLayout === 'grid') void loadArtifactPreviews(filtered);
}

async function loadArtifactPreviews(entries: ArtifactEntry[]) {
  const pending = entries.slice(0, 24).filter((entry) => {
    const key = `${entry.artifactId}:${entry.revision || 0}`;
    return entry.artifactId && entry.conversationId && !artifactPreviews.has(key) && !artifactPreviewPending.has(key);
  });
  if (!pending.length) return;
  await Promise.all(pending.map(async (entry) => {
    const key = `${entry.artifactId}:${entry.revision || 0}`;
    artifactPreviewPending.add(key);
    try {
      const response = await Data.readArtifact(entry.conversationId!, entry.artifactId!);
      artifactPreviews.set(key, response.ok ? String(response.artifact?.content || '') : '');
    } catch { artifactPreviews.set(key, ''); }
    finally { artifactPreviewPending.delete(key); }
  }));
  if (artifactLayout === 'grid') paintArtifacts();
}

/* 工具条是真的在筛东西：tab / 类型 / 搜索 / 布局四种状态都落到同一份缓存上。
   行本身的打开动作仍由 studio.ts 既有的 document 委托处理（[data-artifact-id]
   与 [data-open]）。 */
function bindArtifactView() {
  if (artifactViewBound) return;
  const view = document.getElementById('view-artifacts');
  const trigger = document.getElementById('artifact-kind-trigger');
  const menu = document.getElementById('artifact-kind-menu');
  const searchToggle = document.getElementById('artifact-search-toggle');
  const searchField = document.getElementById('artifact-search-field');
  const searchInput = document.getElementById('artifact-search-input') as HTMLInputElement | null;
  const layoutToggle = document.getElementById('artifact-layout-toggle');
  if (!view || !trigger || !menu || !searchToggle || !searchField || !searchInput || !layoutToggle) return;
  artifactViewBound = true;

  const setSearchOpen = (open: boolean) => {
    searchField.hidden = !open;
    searchToggle.setAttribute('aria-expanded', String(open));
    if (open) searchInput.focus();
    else if (artifactQuery) {
      artifactQuery = '';
      searchInput.value = '';
      paintArtifacts();
    }
  };

  view.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const create = target?.closest<HTMLElement>('[data-artifact-create]');
    if (create) {
      document.getElementById('nav-new-chat')?.click();
      const input = document.querySelector<HTMLTextAreaElement>('#composer-form textarea');
      if (input) { input.value = String(create.dataset.artifactCreate || ''); fitComposer(input); input.focus(); }
      return;
    }
    const scope = target?.closest<HTMLElement>('[data-artifact-scope]');
    if (scope) {
      artifactScope = scope.dataset.artifactScope === 'mine' ? 'mine' : 'all';
      closeArtifactKindMenu();
      paintArtifacts();
      return;
    }
    if (target?.closest('#artifact-layout-toggle')) {
      artifactLayout = artifactLayout === 'grid' ? 'list' : 'grid';
      paintArtifacts();
      return;
    }
    if (target?.closest('#artifact-search-toggle')) {
      setSearchOpen(Boolean(searchField.hidden));
      return;
    }
    const option = target?.closest<HTMLElement>('[data-artifact-kind]');
    if (option) {
      const value = String(option.dataset.artifactKind || '');
      artifactKind = value === '__all__' ? '' : value;
      closeArtifactKindMenu();
      paintArtifacts();
      return;
    }
    if (target?.closest('#artifact-kind-trigger')) {
      const open = menu.hidden;
      closeArtifactKindMenu();
      if (open) {
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
      }
      return;
    }
    closeArtifactKindMenu();
  });

  searchInput.addEventListener('input', () => {
    artifactQuery = searchInput.value.trim().toLowerCase();
    paintArtifacts();
  });

  document.addEventListener('click', (event) => {
    if (!view.contains(event.target as Node)) closeArtifactKindMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeArtifactKindMenu();
    if (!searchField.hidden) setSearchOpen(false);
  });
}

async function renderArtifacts(_force = false) {
  bindArtifactView();
  const host = document.getElementById('art-list');
  if (!host) return;
  const [list] = await Promise.all([Data.artifacts() as Promise<ArtifactEntry[]>, studioLibraries.loadPictograms()]);
  studioLibraries.mountPreviews(document.getElementById('v-artifacts') || document);
  artifactCache = list.slice().sort((left, right) => (Number(right.at) || 0) - (Number(left.at) || 0));
  paintArtifacts();
}

const artifactEditor = ArtifactEditor.createArtifactEditor({
  read: (payload) => Data.readArtifact(
    String(payload.conversationId || ''),
    String(payload.artifactId || ''),
  ),
  edit: (payload) => Data.editArtifact({
    conversationId: String(payload.conversationId || ''),
    artifactId: String(payload.artifactId || ''),
    expectedRevision: Number(payload.expectedRevision),
    content: String(payload.content ?? ''),
    patchPayload: payload.patchPayload && typeof payload.patchPayload === 'object'
      ? payload.patchPayload as Record<string, unknown>
      : null,
  }),
  accept: (payload) => Data.acceptArtifact(
    String(payload.conversationId || ''),
    String(payload.artifactId || ''),
    Number(payload.revision),
  ),
  apply: (payload) => Data.applyArtifact(
    String(payload.conversationId || ''),
    String(payload.artifactId || ''),
    Number(payload.revision),
  ),
  undo: (payload) => Data.undoArtifact(String(payload.conversationId || ''), String(payload.artifactId || ''), Number(payload.revision), payload.confirmed === true),
});

type FigmaArtifactPreview = {
  status: 'loading' | 'ready' | 'error';
  dataUrl?: string;
  error?: string;
};
const figmaArtifactPreviews = new Map<string, FigmaArtifactPreview>();

function figmaPatchCoordinates(
  state: MagicPointerArtifactEditorState,
  operation: Record<string, unknown>,
  index: number,
): { key: string; documentSessionId: string; nodeId: string } | null {
  const locator = operation.locator && typeof operation.locator === 'object'
    ? operation.locator as Record<string, unknown>
    : null;
  const value = locator?.value && typeof locator.value === 'object'
    ? locator.value as Record<string, unknown>
    : null;
  if (locator?.kind !== 'figma-node' || !value) return null;
  const documentSessionId = String(value.documentSessionId || '').trim();
  const nodeId = String(value.nodeId || '').trim();
  if (!documentSessionId || !nodeId) return null;
  return {
    key: `${state.artifactId}:${state.revision}:${index}:${documentSessionId}:${nodeId}`,
    documentSessionId,
    nodeId,
  };
}

async function loadFigmaArtifactPreview(index: number, force = false): Promise<void> {
  const state = artifactEditor.state();
  const operations = Array.isArray(state.patchPayload?.operations)
    ? state.patchPayload.operations as Record<string, unknown>[]
    : [];
  const operation = operations[index];
  const coordinates = operation ? figmaPatchCoordinates(state, operation, index) : null;
  if (!coordinates || !state.conversationId) return;
  if (!force && figmaArtifactPreviews.has(coordinates.key)) return;
  figmaArtifactPreviews.set(coordinates.key, { status: 'loading' });
  renderArtifactPatchPreview(state);
  const result = await Data.exportFigmaPreview(
    state.conversationId,
    coordinates.documentSessionId,
    coordinates.nodeId,
  );
  const latest = artifactEditor.state();
  const latestOperations = Array.isArray(latest.patchPayload?.operations)
    ? latest.patchPayload.operations as Record<string, unknown>[]
    : [];
  const latestCoordinates = latestOperations[index]
    ? figmaPatchCoordinates(latest, latestOperations[index], index)
    : null;
  if (latestCoordinates?.key !== coordinates.key) return;
  const payload = result.result && typeof result.result === 'object'
    ? result.result as Record<string, unknown>
    : {};
  const mimeType = String(payload.mimeType || '');
  const base64 = String(payload.base64 || '');
  if (result.ok && mimeType === 'image/png' && /^[A-Za-z0-9+/=]+$/.test(base64)) {
    figmaArtifactPreviews.set(coordinates.key, {
      status: 'ready',
      dataUrl: `data:image/png;base64,${base64}`,
    });
  } else {
    figmaArtifactPreviews.set(coordinates.key, {
      status: 'error',
      error: String(result.error || 'Figma 节点预览不可用。'),
    });
  }
  renderArtifactPatchPreview(latest);
}

async function refreshFigmaArtifactPreviews(force = false): Promise<void> {
  const state = artifactEditor.state();
  const operations = Array.isArray(state.patchPayload?.operations)
    ? state.patchPayload.operations as Record<string, unknown>[]
    : [];
  await Promise.all(operations.map(async (operation, index) => {
    if (figmaPatchCoordinates(state, operation, index)) {
      await loadFigmaArtifactPreview(index, force);
    }
  }));
}

async function retargetFigmaArtifact(index: number): Promise<void> {
  const state = artifactEditor.state();
  const operations = Array.isArray(state.patchPayload?.operations)
    ? state.patchPayload.operations as Record<string, unknown>[]
    : [];
  const operation = operations[index];
  const coordinates = operation ? figmaPatchCoordinates(state, operation, index) : null;
  if (!coordinates || !state.patchPayload) return;
  figmaArtifactPreviews.set(coordinates.key, { status: 'loading' });
  renderArtifactPatchPreview(state);
  const response = await Data.inspectFigmaSelection(
    state.conversationId,
    coordinates.documentSessionId,
  );
  const current = artifactEditor.state();
  if (current.selectionGeneration !== state.selectionGeneration
    || current.revision !== state.revision || current.patchPayload !== state.patchPayload) return;
  const result = response.result && typeof response.result === 'object'
    ? response.result as Record<string, unknown>
    : {};
  const selectionIds = Array.isArray(result.selectionIds)
    ? result.selectionIds.map((value) => String(value || ''))
    : [];
  const nodes = Array.isArray(result.nodes)
    ? result.nodes.filter((value): value is Record<string, unknown> => (
      Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ))
    : [];
  const selected = nodes.find((node) => selectionIds.includes(String(node.id || '')));
  if (!response.ok || !selected) {
    figmaArtifactPreviews.set(coordinates.key, {
      status: 'error',
      error: String(response.error || '请先在当前 Figma 文档中选择一个可写节点。'),
    });
    renderArtifactPatchPreview(artifactEditor.state());
    return;
  }
  try {
    const nextPayload = ArtifactEditor.retargetFigmaPatch(
      state.patchPayload,
      index,
      { ...selected, pageId: result.pageId },
    );
    artifactEditor.updatePatchPayload(nextPayload);
    for (const key of [...figmaArtifactPreviews.keys()]) {
      if (key.startsWith(`${state.artifactId}:`)) figmaArtifactPreviews.delete(key);
    }
    renderArtifactEditor();
    void refreshFigmaArtifactPreviews();
  } catch (error) {
    figmaArtifactPreviews.set(coordinates.key, {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    renderArtifactPatchPreview(artifactEditor.state());
  }
}

function artifactValueText(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value ?? ''); }
}

function renderArtifactPatchPreview(state: MagicPointerArtifactEditorState) {
  const host = document.getElementById('artifact-patch-changes');
  if (!host) return;
  const operations = Array.isArray(state.patchPayload?.operations)
    ? state.patchPayload.operations as Record<string, unknown>[]
    : [];
  if (!operations.length) {
    host.innerHTML = '<p class="mp-inspector-empty">普通文本草稿没有外部文件修改。</p>';
    return;
  }
  const busy = ['loading', 'saving', 'accepting', 'applying'].includes(state.status);
  host.innerHTML = operations.map((operation, index) => {
    const locator = operation.locator && typeof operation.locator === 'object'
      ? operation.locator as Record<string, unknown>
      : {};
    const figmaCoordinates = figmaPatchCoordinates(state, operation, index);
    const preview = figmaCoordinates ? figmaArtifactPreviews.get(figmaCoordinates.key) : null;
    const figmaPreview = !figmaCoordinates ? '' : `<div class="mp-figma-artifact-preview">
      ${preview?.dataUrl
        ? `<img src="${esc(preview.dataUrl)}" alt="当前 Figma 节点 ${esc(figmaCoordinates.nodeId)} 的导出预览" />`
        : `<p>${esc(preview?.status === 'loading' ? '正在从当前文档导出节点预览…' : preview?.error || '节点预览尚未加载。')}</p>`}
      <div>
        <button type="button" data-figma-preview-index="${index}" ${busy ? 'disabled' : ''}>刷新预览</button>
        <button type="button" data-figma-retarget-index="${index}" ${busy ? 'disabled' : ''}>改用当前选中节点</button>
      </div>
    </div>`;
    return `<article class="mp-artifact-change">
      <header><strong>${esc(operation.operation || 'change')}</strong><code>${esc(operation.sourceId || '')}</code></header>
      <small>${esc(locator.kind || 'locator')} · ${esc(artifactValueText(locator.value || {}))}</small>
      ${figmaPreview}
      <pre>之前：${esc(artifactValueText(operation.before))}</pre>
      <label>之后（实际写入值）
        <textarea class="mp-artifact-after-value" data-artifact-operation-index="${index}"
          aria-label="编辑第 ${index + 1} 项实际写入值" ${busy ? 'disabled' : ''}>${esc(artifactValueText(operation.after))}</textarea>
      </label>
    </article>`;
  }).join('');
}

function renderArtifactEditor() {
  const state = artifactEditor.state();
  const content = document.getElementById('artifact-editor-content') as HTMLTextAreaElement | null;
  const kind = document.getElementById('artifact-editor-kind');
  const revision = document.getElementById('artifact-editor-revision');
  const status = document.getElementById('artifact-editor-status');
  const save = document.getElementById('artifact-editor-save') as HTMLButtonElement | null;
  const accept = document.getElementById('artifact-editor-accept') as HTMLButtonElement | null;
  const apply = document.getElementById('artifact-editor-apply') as HTMLButtonElement | null;
  const undo = document.getElementById('artifact-editor-undo') as HTMLButtonElement | null;
  if (content && document.activeElement !== content) content.value = state.content;
  if (kind) kind.textContent = state.kind === 'document_patch' ? 'Document patch' : 'Draft';
  if (revision) revision.textContent = state.revision ? `revision ${state.revision}` : 'revision —';
  const busy = ['loading', 'saving', 'accepting', 'applying'].includes(state.status);
  if (undo) { undo.hidden = !state.undoAvailable; undo.disabled = busy || state.dirty; }
  if (content) content.disabled = busy || !state.artifactId;
  if (save) save.disabled = busy || !state.dirty;
  if (accept) {
    accept.disabled = busy || state.dirty || !state.artifactId
      || state.acceptedRevision === state.revision;
  }
  if (apply) {
    apply.disabled = busy || state.dirty || state.kind !== 'document_patch'
      || state.acceptedRevision !== state.revision;
  }
  if (status) {
    const resultStatus = String(state.applyResult?.status || '');
    status.textContent = state.error
      || (state.status === 'loading' ? '正在读取当前版本…'
        : state.status === 'saving' ? '正在保存新版本…'
          : state.status === 'accepting' ? '正在绑定批准版本…'
            : state.status === 'applying' ? '正在写入并读回验证…'
              : resultStatus === 'succeeded' ? (state.applyResult?.undone ? '已撤销并通过读回验证。' : '已写入并通过读回验证。')
                : state.acceptedRevision === state.revision && state.revision > 0
                  ? '当前版本已接受，可以应用。'
                  : state.dirty ? '有尚未保存的编辑。' : '');
    status.dataset.tone = state.error ? 'error' : 'neutral';
  }
  renderArtifactPatchPreview(state);
}

async function openArtifactEditor(conversationId: string, artifactId: string) {
  if (!conversationId || !artifactId) return;
  if (activeConversationId !== conversationId) await openConversation(conversationId);
  inspectorState = inspectorStatePolicy.reduceInspectorState(inspectorState, {
    type: 'select-content',
    contentKind: 'artifact',
    contentId: artifactId,
  });
  setInspector(true, 'artifact');
  renderArtifactEditor();
  await artifactEditor.select(conversationId, artifactId);
  renderArtifactEditor();
  void refreshFigmaArtifactPreviews();
}

document.getElementById('artifact-editor-content')?.addEventListener('input', (event) => {
  artifactEditor.updateContent((event.currentTarget as HTMLTextAreaElement).value);
  renderArtifactEditor();
});
document.getElementById('artifact-patch-changes')?.addEventListener('change', (event) => {
  const field = (event.target as Element | null)?.closest<HTMLTextAreaElement>(
    '[data-artifact-operation-index]',
  );
  if (!field) return;
  const state = artifactEditor.state();
  const operations = Array.isArray(state.patchPayload?.operations)
    ? state.patchPayload.operations as Record<string, unknown>[]
    : [];
  const index = Number(field.dataset.artifactOperationIndex);
  if (!Number.isInteger(index) || index < 0 || index >= operations.length) return;
  try {
    const after = typeof operations[index].after === 'string'
      ? field.value : JSON.parse(field.value) as unknown;
    field.setCustomValidity('');
    artifactEditor.updatePatchPayload({
      ...state.patchPayload,
      operations: operations.map((operation, operationIndex) => (
        operationIndex === index ? { ...operation, after } : operation
      )),
    });
    renderArtifactEditor();
  } catch {
    field.setCustomValidity('请输入有效的 JSON 值；无效内容不会保存。');
    field.reportValidity();
  }
});
document.getElementById('artifact-patch-changes')?.addEventListener('click', (event) => {
  const target = event.target as Element | null;
  const preview = target?.closest<HTMLButtonElement>('[data-figma-preview-index]');
  if (preview) {
    void loadFigmaArtifactPreview(Number(preview.dataset.figmaPreviewIndex), true);
    return;
  }
  const retarget = target?.closest<HTMLButtonElement>('[data-figma-retarget-index]');
  if (retarget) void retargetFigmaArtifact(Number(retarget.dataset.figmaRetargetIndex));
});
document.getElementById('artifact-editor-save')?.addEventListener('click', async () => {
  const pending = artifactEditor.save();
  renderArtifactEditor();
  await pending;
  renderArtifactEditor();
  void refreshFigmaArtifactPreviews();
});
document.getElementById('artifact-editor-accept')?.addEventListener('click', async () => {
  const pending = artifactEditor.accept();
  renderArtifactEditor();
  await pending;
  renderArtifactEditor();
});
document.getElementById('artifact-editor-apply')?.addEventListener('click', async () => {
  const pending = artifactEditor.apply();
  renderArtifactEditor();
  await pending;
  const state = artifactEditor.state();
  for (const key of [...figmaArtifactPreviews.keys()]) {
    if (key.startsWith(`${state.artifactId}:`)) figmaArtifactPreviews.delete(key);
  }
  renderArtifactEditor();
  void refreshFigmaArtifactPreviews();
});

document.getElementById('artifact-editor-undo')?.addEventListener('click', async () => {
  if (!window.confirm('撤销本次应用？只有当前内容仍与应用结果匹配的部分会恢复，创建的文件会保留。')) return;
  const pending = artifactEditor.undo(true);
  renderArtifactEditor();
  await pending;
  renderArtifactEditor();
  void refreshFigmaArtifactPreviews(true);
});

let recoveryRenderGeneration = 0;
async function renderConversationRecovery(conversationId: string): Promise<void> {
  const generation = ++recoveryRenderGeneration;
  const host = document.getElementById('conversation-recovery');
  if (!host) return;
  host.replaceChildren(); host.hidden = true;
  const response: Record<string, any> = await Data.recovery({ conversationId }).catch((error: unknown) => ({
    ok: false, error: error instanceof Error ? error.message : String(error),
  }));
  if (activeConversationId !== conversationId || generation !== recoveryRenderGeneration) return;
  if (response.ok === false) {
    const message = document.createElement('p');
    message.textContent = response.error === 'session_not_found'
      ? '找不到此任务的运行记录，暂时无法核对执行恢复状态。已保存的对话仍可查看。'
      : `无法读取执行恢复状态：${String(response.error || '未知错误')}`;
    host.appendChild(message);
    host.hidden = false;
    return;
  }
  const operations = Array.isArray(response.pendingRecovery) ? response.pendingRecovery : [];
  for (const operation of operations) {
    const section = document.createElement('section');
    const title = document.createElement('strong');
    title.textContent = `需要核对执行结果：${String(operation.tool || '')}`;
    const details = document.createElement('pre');
    details.textContent = JSON.stringify(operation.arguments, null, 2);
    const candidates = Array.isArray(operation.verificationCandidates) ? operation.verificationCandidates : [];
    const select = document.createElement('select');
    select.setAttribute('aria-label', '选择用于核对的读取记录');
    candidates.forEach((candidate: any, index: number) => {
      const option = document.createElement('option'); option.value = String(index);
      option.textContent = `${String(candidate.tool)} · ${String(candidate.callId)}`; select.appendChild(option);
    });
    const readback = document.createElement('pre');
    const showReadback = () => { const candidate = candidates[Number(select.value) || 0];
      readback.textContent = candidate ? JSON.stringify({ arguments: candidate.arguments, result: candidate.result }, null, 2)
        : '请先让 Agent 读取目标并核对现场，再允许重新执行。'; };
    select.addEventListener('change', showReadback); showReadback();
    const allow = document.createElement('button'); allow.textContent = '核对后允许重新执行'; allow.disabled = !candidates.length;
    allow.addEventListener('click', async () => {
      const candidate = candidates[Number(select.value) || 0];
      if (!candidate || !window.confirm('确认已核对显示的读回内容，并允许重新执行这项操作？')) return;
      allow.disabled = true;
      const result = await Data.recovery({ conversationId, action: 'resolve', operationId: operation.operationId, verificationCallId: candidate.callId, confirmed: true });
      if (result.ok) { await renderConversationRecovery(conversationId); }
      else { readback.textContent = String(result.error || '恢复失败'); allow.disabled = false; }
    });
    section.append(title, details, select, readback, allow); host.appendChild(section);
  }
  host.hidden = operations.length === 0;
}

function pendingToolRequestId(turn?: MagicPointerTurn): string {
  const calls = turn?.trajectory || [];
  return String([...calls].reverse().find(record => record.kind === 'tool'
    && ['AskUser', 'AskUserQuestion', 'ask_user_question'].includes(String(record.name)))?.callId || '');
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
const libraryUi = studioLibraries.createController({
  data: Data,
  show,
  compose: (prompt: string) => {
    startNewChat(); show('chat');
    const input = document.querySelector<HTMLTextAreaElement>('#composer-form textarea');
    if (input) { input.value = prompt; fitComposer(input); input.focus(); }
  },
  openProject: openProjectFromPicker,
  selectProject: setActiveProject,
  renameConversation: openRenameDialog,
  changeProject: (id: string, anchor: HTMLElement) => { void openProjectAssignment(id, anchor); },
  refreshSidebar: renderSidebar,
  requestText: requestStudioText,
  connectFigma: () => { show('chat'); setInspector(true, 'files'); void refreshFigmaConnection(true); },
  conversationId: () => activeConversationId,
});

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
    const layout = document.querySelector<HTMLElement>('#stash-mode .is-on')?.dataset.mode;
    item.classList.toggle('is-on', item.dataset.goto === view
      && (!item.dataset.designLayout || item.dataset.designLayout === layout));
  });
  if (view === 'stash') { renderStash(true); bindCanvas(); }
  if (view === 'artifacts') renderArtifacts();
  if (view === 'settings') renderSettings();
  void libraryUi.render(view);
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
  const designNav = document.querySelector<HTMLElement>('.mp-design-nav');
  const workNav = document.querySelector<HTMLElement>('.mp-main-navigation');
  if (designNav) designNav.hidden = mode !== 'design';
  if (workNav) workNav.hidden = mode !== 'walker';
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

function closeAccountMenu() {
  const submenu = document.getElementById('account-submenu');
  if (submenu) submenu.hidden = true;
  closeAnchoredPopover('account-menu', 'account-footer');
}

/* 参考里的账户浮层不是贴着触发按钮的窄菜单：它左右各留 8px、铺满整个侧栏宽度，
   底边压在账户行上方，所以宽度跟着侧栏走，不跟按钮走。 */
function openAccountMenu() {
  const menu = document.getElementById('account-menu');
  const sidebar = document.querySelector<HTMLElement>('.dshw-sidebar-col');
  const footer = document.getElementById('account-footer');
  if (!menu || !sidebar || !footer) return;
  closeStudioPopovers('account-menu');
  menu.style.visibility = 'hidden';
  menu.hidden = false;
  const sidebarRect = sidebar.getBoundingClientRect();
  const footerRect = footer.getBoundingClientRect();
  const left = sidebarRect.left + 8;
  const width = Math.min(272, window.innerWidth - 16);
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.max(36, Math.round(footerRect.top - 8 - menu.offsetHeight))}px`;
  menu.style.removeProperty('visibility');
  footer.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => menu.querySelector<HTMLButtonElement>('button')?.focus());
}

async function executeAccountCommand(command: string) {
  if (command === 'learn-more' || command === 'language') {
    openAccountSubmenu(command);
    return;
  }
  closeAccountMenu();
  if (command === 'settings') { show('settings'); return; }
  if (command === 'models') {
    show('settings');
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-settings-page="models-agents"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    return;
  }
  if (command === 'updates') { await Data.checkForUpdates(); return; }
  if (command === 'usage') { setProductMode('walker'); setStudioHomeVisible(true); return; }
  if (command === 'help') { await Data.openProjectUrl('https://github.com/Wang-auspicious/Magic-Pointer#readme'); return; }
  if (command === 'changelog') { await Data.windowCommand('changelog'); return; }
  if (command === 'shortcuts' || command === 'about') {
    await executeWindowMenuCommand(command);
  }
}

document.getElementById('account-footer')?.addEventListener('click', (event) => {
  event.stopPropagation();
  const menu = document.getElementById('account-menu');
  if (menu?.hidden) openAccountMenu();
  else closeAccountMenu();
});

document.getElementById('account-menu')?.addEventListener('click', (event) => {
  const row = (event.target as Element | null)?.closest<HTMLElement>('[data-account-command]');
  if (!row) return;
  event.stopPropagation();
  void executeAccountCommand(row.dataset.accountCommand || '');
});

document.getElementById('account-menu')?.addEventListener('pointerover', (event) => {
  const row = (event.target as Element)?.closest<HTMLElement>('[data-account-command]');
  if (row?.dataset.accountCommand === 'learn-more') openAccountSubmenu('learn-more');
  else if (row) {
    const submenu = document.getElementById('account-submenu');
    if (submenu) submenu.hidden = true;
  }
});

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'u'
      && document.getElementById('composer-form')?.getClientRects().length) {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeStudioPopovers();
    void executeWindowMenuCommand('add-files');
    return;
  }
  const target = event.target as HTMLElement;
  const menu = target?.closest<HTMLElement>('.mp-compact-menu, #account-menu');
  if (!menu || menu.hidden) return;
  const rows = [...menu.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)')];
  const index = rows.indexOf(target.closest('button') as HTMLButtonElement);
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows[next]?.focus();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeStudioPopovers();
    (menu.id.startsWith('account') ? document.getElementById('account-footer') : document.getElementById('composer-add'))?.focus();
  }
});

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
      'composer-permission-menu',
      'composer-model-menu',
      'composer-effort-menu',
      'composer-usage-popover',
      'account-menu',
    ].some((id) => document.getElementById(id)?.hidden === false)
      || Boolean(document.getElementById('thread-menu'))
      || Boolean(document.querySelector('.side-session-menu:not([hidden])'));
    closeWindowMenu();
    closeThreadMenu();
    closeSlashMenu();
    closePermissionMenu();
    closeModelMenu();
    closeEffortMenu();
    closeAccountMenu();
    const brain = document.getElementById('magic-brain-popover');
    if (brain) brain.hidden = true;
    document.getElementById('magic-brain-toggle')?.setAttribute('aria-expanded', 'false');
    closeAnchoredPopover('composer-usage-popover', 'composer-context');
    document.querySelectorAll<HTMLElement>('.side-session-menu:not([hidden])')
      .forEach((menu) => { menu.hidden = true; });
    if (!menuWasOpen && studioComposerBusy && (pendingConversation || externalConversationRun)) {
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

/* 重新发送一条已经发过的消息：把它放回输入框并提交。不新建对话——重发是
   「这一条再走一遍」，不是「另起一轮」。 */
document.addEventListener('mp:retry-question', (event: Event) => {
  const detail = (event as CustomEvent<{ question?: string }>).detail;
  const question = String(detail?.question || '').trim();
  if (!question || studioComposerBusy) return;
  const textarea = document.querySelector<HTMLTextAreaElement>('#composer-form textarea');
  const form = document.getElementById('composer-form') as HTMLFormElement | null;
  if (!textarea || !form) return;
  textarea.value = question;
  fitComposer(textarea);
  syncComposerSubmitState();
  form.requestSubmit();
});

/* 产物卡上的 Open 和箭头都走这里：打开右侧的产物编辑器，落在那一份上。 */
document.addEventListener('mp:open-artifact', (event: Event) => {
  const detail = (event as CustomEvent<{ artifactId?: string; conversationId?: string }>).detail;
  const artifactId = String(detail?.artifactId || '');
  const conversationId = String(detail?.conversationId || '') || String(activeConversationId || '');
  if (!artifactId) return;
  void openArtifactEditor(conversationId, artifactId);
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
    make('Conversation', () => setConversationTab('chat')),
    make('Trajectory', () => setConversationTab('trajectory')),
    make('Open project folder', () => {
      if (activeProjectRoot) void Data.openProjectPath(activeProjectRoot, '');
      else void openProjectFromPicker();
    }),
    make('Task materials & Figma', () => {
      const popover = document.getElementById('magic-brain-popover');
      if (!popover) return;
      popover.hidden = false;
      void renderMagicBrain(true);
      void refreshFigmaConnection();
    }, { disabled: unavailable }),
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
let selectedProjectFileText = '';
let selectedProjectFileMarkdown = false;
let projectFileCodeView = false;
let activeInspectorTab = 'files';
let focusedSubagentId = '';
interface InspectorState {
  open: boolean;
  maximized: boolean;
  width: number;
  previousWidth: number;
  tab: string;
  contentSelection?: { kind: 'material' | 'artifact'; id: string } | null;
}
interface InspectorStateModule {
  sessionRailGeometry(availableWidth: number): { width: number; overlay: boolean };
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
const preferredInspectorWidth = inspectorStatePolicy.clampInspectorWidth(initialInspectorWidth, 1320);
let inspectorState: InspectorState = {
  open: false,
  maximized: false,
  width: inspectorStatePolicy.clampInspectorWidth(preferredInspectorWidth, window.innerWidth - 288),
  previousWidth: preferredInspectorWidth,
  tab: 'files',
};
function inspectorError(message: string) {
  const host = document.getElementById('project-file-tree');
  if (host) host.innerHTML = `<p class="mp-inspector-empty">${esc(message)}</p>`;
}

function renderProjectFileTree() {
  const host = document.getElementById('project-file-tree');
  if (!host) return;
  const query = (document.getElementById('file-tree-filter') as HTMLInputElement | null)?.value.trim().toLocaleLowerCase() || '';
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
      // 官方树行：data-tree-row + role=treeitem + aria-level=depth+1，缩进是
      // 内联 paddingLeft = 8 + depth * 8（不是每层 20px、也不再画引导线）。
      row.dataset.treeRow = 'true';
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(depth + 1));
      row.tabIndex = -1;
      row.style.paddingLeft = `${8 + depth * 8}px`;
      const expanded = entry.kind === 'directory' && expandedProjectDirectories.has(entry.path);
      if (entry.kind === 'directory') row.setAttribute('aria-expanded', String(expanded));
      row.innerHTML = `${entry.kind === 'directory'
        ? icon(expanded ? 'ic-tree-folder-open' : 'ic-tree-folder')
        : icon('ic-tree-file')}<span>${esc(entry.name)}</span>`;
      nodes.push(row);
      if (!expanded) continue;
      nodes.push(...buildLevel(entry.path, depth + 1));
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
  selectedProjectFileText = '';
  selectedProjectFileMarkdown = false;
  projectFileCodeView = false;
  const preview = document.getElementById('project-file-preview');
  if (preview) preview.hidden = true;
  preview?.closest('.mp-inspector-panel')?.classList.remove('is-previewing');
  if (activeProjectRoot) await loadProjectDirectory('');
  else inspectorError('请先打开项目。');
  if (activeInspectorTab === 'changes') await renderProjectChanges();
}

function renderSelectedProjectFile() {
  const preview = document.getElementById('project-file-preview');
  const content = document.getElementById('project-file-content');
  const code = document.getElementById('project-file-code');
  if (!preview || !content) return;
  const renderMarkdown = selectedProjectFileMarkdown && !projectFileCodeView;
  preview.classList.toggle('is-markdown', renderMarkdown);
  code?.setAttribute('aria-pressed', String(projectFileCodeView));
  if (renderMarkdown) content.replaceChildren(DshMarkdown.render(selectedProjectFileText));
  else {
    const pre = document.createElement('pre');
    pre.textContent = selectedProjectFileText;
    content.replaceChildren(pre);
  }
}

async function selectProjectFile(relativePath: string) {
  const response = await Data.readProjectFile(activeProjectRoot, relativePath);
  const preview = document.getElementById('project-file-preview');
  if (!preview) return;
  preview.hidden = false;
  const panel = preview.closest<HTMLElement>('.mp-inspector-panel');
  panel?.classList.add('is-previewing');
  selectedProjectFile = relativePath;
  selectedProjectFileText = response?.ok ? String(response.text || '') : String(response?.error || '文件读取失败。');
  selectedProjectFileMarkdown = /\.(?:md|mdx|markdown)$/i.test(relativePath) && Boolean(response?.ok);
  projectFileCodeView = false;
  const name = document.getElementById('project-file-name');
  const inspectorTitle = document.getElementById('inspector-title');
  if (inspectorTitle) inspectorTitle.textContent = 'File';
  if (name) name.textContent = relativePath + (response?.truncated ? ' · 已截断' : '');
  renderSelectedProjectFile();
  renderProjectFileTree();
}

function magicBrainMaterialNodes(startIndex = 0): HTMLButtonElement[] {
  return (activeTaskContext?.sources || []).map((source, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mp-brain-source';
    button.dataset.materialSourceId = source.sourceId;
    button.style.setProperty('--item-index', String(startIndex + index));
    button.innerHTML = `${icon(source.kind === 'web' ? 'ic-globe' : source.kind === 'figma' ? 'ic-pen' : 'ic-file', 'codex-icon')}<span>${esc(source.title)}</span>`;
    button.title = source.sourceId;
    return button;
  });
}

async function renderMagicBrain(force = false) {
  const popover = document.getElementById('magic-brain-popover');
  if (!popover) return;
  const projectName = activeProjectRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '当前项目';
  const project = document.getElementById('magic-brain-project');
  if (project) project.textContent = projectName;
  const projectRows = [
    document.getElementById('magic-brain-changes'),
    document.getElementById('magic-brain-branch'),
  ];
  projectRows.forEach((row) => { if (row) row.hidden = !activeProjectRoot; });
  if (!activeProjectRoot) {
    projectEnvironment = null;
    document.getElementById('magic-brain-changes-detail')!.textContent = '请先打开项目';
    document.getElementById('magic-brain-branch-name')!.textContent = 'Git 分支';
    document.getElementById('magic-brain-branch-detail')!.textContent = '没有项目环境';
    const sourceHost = document.getElementById('magic-brain-source-list')!;
    const materialNodes = magicBrainMaterialNodes();
    if (materialNodes.length) sourceHost.replaceChildren(...materialNodes);
    else sourceHost.innerHTML = activeConversationId
      ? '<p>当前任务还没有材料；可连接 Figma 或添加本机文件。</p>'
      : '<p>启动任务后可连接 Figma 或添加本机材料。</p>';
    void refreshFigmaConnection();
    return;
  }
  if (!force && projectEnvironment?.root === activeProjectRoot) return;
  document.getElementById('magic-brain-changes-detail')!.textContent = '正在读取…';
  document.getElementById('magic-brain-branch-detail')!.textContent = '正在读取…';
  const response = await Data.projectEnvironment(activeProjectRoot, activeConversationId);
  projectEnvironment = response;
  applyRepositoryContextBar(response);
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
  const materialNodes = magicBrainMaterialNodes();
  sourceHost.replaceChildren(...materialNodes, ...sources.map((url, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mp-brain-source';
    button.dataset.sourceUrl = url;
    button.style.setProperty('--item-index', String(materialNodes.length + index));
    let label = url;
    try { const parsed = new URL(url); label = `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`; } catch { /* show raw URL */ }
    button.innerHTML = `${icon('ic-globe', 'codex-icon')}<span>${esc(label)}</span>`;
    button.title = url;
    return button;
  }));
  if (!sources.length && !materialNodes.length) sourceHost.innerHTML = '<p>当前任务尚无材料或网页来源。</p>';
}

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
  const material = (event.target as Element | null)?.closest<HTMLElement>('[data-material-source-id]');
  if (material?.dataset.materialSourceId) {
    setInspector(true, 'materials');
    inspectorState = inspectorStatePolicy.reduceInspectorState(inspectorState, {
      type: 'select-content',
      contentKind: 'material',
      contentId: material.dataset.materialSourceId,
    });
    renderTaskMaterials();
    return;
  }
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

document.getElementById('composer-repository-location')?.addEventListener('click', () => setInspector(true, 'changes'));
document.getElementById('composer-repository-diff')?.addEventListener('click', () => setInspector(true, 'changes'));
document.getElementById('composer-create-pr')?.addEventListener('click', () => {
  const url = projectEnvironment?.pullRequestUrl || '';
  if (url) void Data.openProjectUrl(url);
  else setInspector(true, 'changes');
});
document.getElementById('composer-pr-menu')?.addEventListener('click', () => setInspector(true, 'changes'));
document.getElementById('composer-repository-dismiss')?.addEventListener('click', () => {
  repositoryContextDismissedFor = repositoryContextKey();
  applyRepositoryContextBar(projectEnvironment);
});

function subagentStatusLabel(status: string): string {
  if (status === 'running') return 'Running';
  if (status === 'awaiting_user') return 'Needs approval';
  if (status === 'failed') return 'Failed';
  if (status === 'stopped') return 'Stopped';
  return 'Completed';
}

function currentSubagentTasks() {
  return studioSubagentGlobals.projectSubagentTasks(pendingConversation
    ? [...activeConversationTurns, { trajectory: pendingConversation.transcript.trajectory }]
    : activeConversationTurns, backgroundAgentSnapshots.get(activeConversationId || '') || []);
}

const backgroundAgentSnapshots = new Map<string, StudioSubagentTask[]>();
const acceptedChildInputs = new Set<string>();
let backgroundAgentRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let backgroundAgentRefreshInFlight = '';

function childActive(status: string): boolean { return status === 'running' || status === 'awaiting_user'; }

async function refreshBackgroundAgentTasks(conversationId: string): Promise<void> {
  if (!conversationId || backgroundAgentRefreshInFlight === conversationId) return;
  backgroundAgentRefreshInFlight = conversationId;
  try {
    const result = await Data.subagents({ conversationId });
    if (!result.ok) throw new Error(result.error || 'Could not refresh background tasks.');
    backgroundAgentSnapshots.set(conversationId, (result.tasks || []) as StudioSubagentTask[]);
    if (activeConversationId === conversationId) renderProjectTasks();
  } catch (error) {
    if (activeConversationId === conversationId) {
      const host = document.getElementById('project-tasks');
      let notice = host?.querySelector<HTMLElement>('.mp-background-error');
      if (host && !notice) { notice = document.createElement('p'); notice.className = 'mp-background-error'; notice.setAttribute('role', 'status'); host.prepend(notice); }
      if (notice) notice.textContent = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (backgroundAgentRefreshInFlight === conversationId) backgroundAgentRefreshInFlight = '';
    scheduleBackgroundAgentRefresh();
  }
}

function scheduleBackgroundAgentRefresh(): void {
  if (backgroundAgentRefreshTimer || !activeConversationId || backgroundAgentRefreshInFlight) return;
  if (!currentSubagentTasks().some(task => childActive(task.status))) return;
  backgroundAgentRefreshTimer = setTimeout(() => {
    backgroundAgentRefreshTimer = null;
    if (activeConversationId) void refreshBackgroundAgentTasks(activeConversationId);
  }, document.hidden ? 5000 : 1200);
}

async function respondToChildInput(host: HTMLElement, task: StudioSubagentTask,
  conversationId: string, response: MagicPointerDecisionResponse): Promise<void> {
  const requestId = task.pendingInput?.requestId;
  if (!requestId) return;
  try {
    const result = await Data.respondSubagent({ conversationId, subagentId: task.id, requestId, response });
    if (!result.ok) throw new Error(result.error || 'Could not answer the child task. Try again.');
    acceptedChildInputs.add(`${conversationId}:${task.id}:${requestId}`);
    DecisionCard.clear(host, true);
    await refreshBackgroundAgentTasks(conversationId);
  } catch (error) { DecisionCard.pending(host, false, error instanceof Error ? error.message : String(error)); }
}

const backgroundTaskViews = new Map<string, { scope: string; finishedOpen: boolean; cleared: Set<string> }>();

function backgroundTaskView() {
  const scope = activeConversationId || pendingConversation?.agentSessionId || pendingConversation?.requestId || 'draft';
  let view = backgroundTaskViews.get(scope);
  if (!view) {
    view = { scope, finishedOpen: false, cleared: new Set() };
    backgroundTaskViews.set(scope, view);
  }
  return view;
}

async function stopSubagentTask(row: HTMLElement) {
  const conversationId = row.dataset.conversationId || '';
  const subagentId = row.dataset.taskId || '';
  const button = row.querySelector<HTMLButtonElement>('.mp-subagent-stop')!;
  const error = row.querySelector<HTMLElement>('.mp-subagent-stop-error')!;
  if (!conversationId || !subagentId || button.disabled) return;
  row.dataset.stopState = 'pending';
  row.querySelector<HTMLElement>('.mp-subagent-state')!.textContent = 'Stopping';
  button.disabled = true;
  button.title = 'Stopping task…';
  button.setAttribute('aria-label', 'Stopping task');
  error.hidden = true;
  try {
    const result = await Data.stopSubagent({ conversationId, subagentId });
    if (!childActive(row.dataset.status || '')) return;
    if (!result.ok) throw new Error(result.error || 'Could not stop this task. Try again.');
    row.dataset.stopState = 'requested';
  } catch (failure) {
    if (!childActive(row.dataset.status || '')) return;
    delete row.dataset.stopState;
    row.querySelector<HTMLElement>('.mp-subagent-state')!.textContent = '';
    button.disabled = false;
    button.title = 'Stop task';
    button.setAttribute('aria-label', 'Stop task');
    error.textContent = failure instanceof Error ? failure.message : String(failure);
    error.hidden = false;
  }
}

function renderProjectTasks() {
  renderPlanCard();
  scheduleBackgroundAgentRefresh();
  const host = document.getElementById('project-tasks');
  if (!host) return;
  const allTasks = currentSubagentTasks();
  const inspector = document.getElementById('project-inspector');
  const layout = allTasks.length ? 'background' : 'plan';
  if (inspector && inspector.dataset.taskLayout !== layout) {
    inspector.dataset.taskLayout = layout;
    syncInspectorGeometry();
  }
  const view = backgroundTaskView();
  if (host.dataset.taskScope !== view.scope) {
    host.replaceChildren();
    host.dataset.taskScope = view.scope;
  }
  const tasks = allTasks.filter(task => task.status === 'running' || !view.cleared.has(task.id));
  if (!tasks.length) {
    const empty = document.createElement('p');
    empty.className = 'mp-inspector-empty';
    empty.textContent = composerPlan?.steps.length ? '' : 'No tasks yet.';
    empty.hidden = Boolean(composerPlan?.steps.length);
    host.replaceChildren(empty);
    return;
  }
  const rows = new Map(Array.from(host.querySelectorAll<HTMLElement>('.mp-subagent-task')).map(row => [row.dataset.taskId, row]));
  const setText = (node: Element, text: string) => { if (node.textContent !== text) node.textContent = text; };
  host.querySelector('.mp-inspector-empty')?.remove();
  const makeSection = (label: string, items: StudioSubagentTask[]) => {
    let section = host.querySelector<HTMLElement>(`[data-task-section="${label}"]`);
    if (!section) {
      section = document.createElement('section');
      section.className = 'mp-subagent-section';
      section.dataset.taskSection = label;
      const heading = document.createElement('div');
      heading.className = 'mp-subagent-section-header';
      if (label === 'Finished') {
        heading.innerHTML = '<button type="button" class="mp-subagent-finished-toggle"><span></span><svg aria-hidden="true"><use href="#ic-chev" /></svg></button>'
          + '<button type="button" class="mp-subagent-clear">Clear</button>';
        heading.querySelector('button')!.addEventListener('click', () => {
          view.finishedOpen = !view.finishedOpen;
          renderProjectTasks();
        });
        heading.querySelector('.mp-subagent-clear')!.addEventListener('click', () => {
          for (const task of currentSubagentTasks()) if (!childActive(task.status)) view.cleared.add(task.id);
          renderProjectTasks();
        });
      } else {
        const title = document.createElement('h3');
        title.textContent = label;
        heading.appendChild(title);
      }
      section.appendChild(heading);
      const list = document.createElement('div');
      list.className = 'mp-subagent-list';
      section.appendChild(list);
    }
    const list = section.querySelector<HTMLElement>('.mp-subagent-list')!;
    list.hidden = label === 'Finished' && !view.finishedOpen;
    if (label === 'Finished') {
      const toggle = section.querySelector<HTMLElement>('.mp-subagent-finished-toggle')!;
      toggle.setAttribute('aria-expanded', String(view.finishedOpen));
      setText(toggle.querySelector('span')!, `Finished ${items.length}`);
    }
    for (const task of items) {
      let row = rows.get(task.id) || rows.get(`parent:${task.parentCallId}`);
      if (!row) {
        row = document.createElement('article');
        row.className = 'mp-subagent-task';
        row.innerHTML = '<div class="mp-subagent-heading"><strong></strong><button type="button" class="mp-subagent-stop" title="Stop task" aria-label="Stop task"><svg aria-hidden="true"><use href="#ic-stop" /></svg></button></div>'
          + '<div class="mp-subagent-meta"><span>Agent</span><span class="mp-subagent-time"></span><span class="mp-subagent-state"></span></div>'
          + '<div class="mp-subagent-stats"><span class="mp-subagent-tool-uses"></span><span class="mp-subagent-current-tool"></span>'
          + '<button type="button" class="mp-subagent-transcript" aria-expanded="false">View transcript</button></div>'
          + '<p class="mp-subagent-stop-error" role="status" hidden></p>'
          + '<div class="mp-subagent-permission" hidden></div>'
          + '<div class="mp-subagent-body" hidden><details class="mp-subagent-thinking"><summary>Thinking</summary><pre></pre></details>'
          + '<div class="mp-subagent-answer"></div><div class="mp-subagent-steps"></div><p class="mp-subagent-result"></p></div>';
        const taskRow = row;
        row.querySelector('.mp-subagent-stop')!.addEventListener('click', () => { void stopSubagentTask(taskRow); });
        row.querySelector('.mp-subagent-transcript')!.addEventListener('click', () => {
          const body = taskRow.querySelector<HTMLElement>('.mp-subagent-body')!;
          body.hidden = !body.hidden;
          const button = taskRow.querySelector<HTMLButtonElement>('.mp-subagent-transcript')!;
          button.textContent = body.hidden ? 'View transcript' : 'Hide transcript';
          button.setAttribute('aria-expanded', String(!body.hidden));
        });
      }
      row.dataset.taskId = task.id;
      row.dataset.parentCallId = task.parentCallId;
      row.dataset.conversationId = activeConversationId || pendingConversation?.conversationId || '';
      row.dataset.status = task.status;
      setText(row.querySelector('strong')!, task.description);
      setText(row.querySelector('.mp-subagent-time')!, task.elapsedMs ? DshChat.formatRunMeta(task.elapsedMs, null) : '');
      setText(row.querySelector('.mp-subagent-state')!, task.status === 'running' ? row.dataset.stopState ? 'Stopping' : '' : subagentStatusLabel(task.status));
      setText(row.querySelector('.mp-subagent-tool-uses')!, `${task.stepCount} tool ${task.stepCount === 1 ? 'use' : 'uses'}`);
      setText(row.querySelector('.mp-subagent-current-tool')!, task.currentTool || (task.status === 'running' ? task.phase === 'writing' ? 'Writing' : 'Thinking' : ''));
      const stop = row.querySelector<HTMLButtonElement>('.mp-subagent-stop')!;
      stop.hidden = !childActive(task.status) || task.id.startsWith('parent:') || !row.dataset.conversationId;
      if (!childActive(task.status)) {
        delete row.dataset.stopState;
        row.querySelector<HTMLElement>('.mp-subagent-stop-error')!.hidden = true;
      }
      stop.disabled = Boolean(row.dataset.stopState);
      const permission = row.querySelector<HTMLElement>('.mp-subagent-permission')!;
      const input = task.pendingInput;
      const inputKey = `${row.dataset.conversationId}:${task.id}:${input?.requestId}`;
      if (input && task.status === 'awaiting_user' && !acceptedChildInputs.has(inputKey)) {
        const conversationId = row.dataset.conversationId!;
        DecisionCard.render(permission, { ...input, key: inputKey }, response => {
          void respondToChildInput(permission, task, conversationId, response);
        });
      } else DecisionCard.clear(permission);
      const thinking = row.querySelector<HTMLDetailsElement>('.mp-subagent-thinking')!;
      thinking.hidden = !task.reasoning;
      setText(thinking.querySelector('summary')!, task.status === 'running' && task.phase === 'thinking' ? 'Thinking…' : 'Thought');
      setText(thinking.querySelector('pre')!, task.reasoning || '');
      const answer = row.querySelector<HTMLElement>('.mp-subagent-answer')!;
      answer.hidden = !task.answer;
      setText(answer, task.answer || '');
      const stepsHost = row.querySelector<HTMLElement>('.mp-subagent-steps')!;
      const stepRows = new Map(Array.from(stepsHost.children).map(item => [(item as HTMLElement).dataset.stepId, item as HTMLElement]));
      const wantedSteps: HTMLElement[] = [];
      for (const step of task.steps) {
        const stepId = step.callId || String(step.index);
        let item = stepRows.get(stepId);
        if (!item) {
          item = document.createElement('details');
          item.className = 'mp-subagent-step-evidence';
          item.dataset.stepId = stepId;
          item.innerHTML = '<summary class="mp-subagent-step"><span class="mp-subagent-step-marker"></span><span class="mp-subagent-step-name"></span><small></small></summary><pre class="mp-subagent-step-input"></pre><pre class="mp-subagent-step-output"></pre>';
        }
        item.dataset.status = step.status;
        item.querySelector<HTMLElement>('summary')!.dataset.status = step.status;
        setText(item.querySelector('.mp-subagent-step-marker')!, step.status === 'completed' ? '✓' : step.status === 'failed' ? '!' : '·');
        setText(item.querySelector('.mp-subagent-step-name')!, step.tool || `Step ${step.index}`);
        setText(item.querySelector('small')!, [step.usedBackend, step.latencyMs ? `${Math.round(step.latencyMs)}ms` : ''].filter(Boolean).join(' · '));
        setText(item.querySelector('.mp-subagent-step-input')!, step.input || '');
        setText(item.querySelector('.mp-subagent-step-output')!, step.output || '');
        wantedSteps.push(item);
      }
      for (const child of Array.from(stepsHost.children)) if (!wantedSteps.includes(child as HTMLElement)) child.remove();
      wantedSteps.forEach((item, i) => { if (stepsHost.children[i] !== item) stepsHost.insertBefore(item, stepsHost.children[i] || null); });
      setText(row.querySelector('.mp-subagent-result')!, task.summary);
      const index = items.indexOf(task);
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    }
    return section;
  };
  const running = tasks.filter((task) => childActive(task.status));
  const finished = tasks.filter((task) => !childActive(task.status));
  const sections: HTMLElement[] = [];
  if (running.length) sections.push(makeSection('Running', running));
  if (finished.length) sections.push(makeSection('Finished', finished));
  for (const row of rows.values()) if (!tasks.some(task => task.id === row.dataset.taskId)) row.remove();
  for (const section of Array.from(host.children)) if (!sections.includes(section as HTMLElement)) section.remove();
  sections.forEach((section, index) => { if (host.children[index] !== section) host.insertBefore(section, host.children[index] || null); });
}

document.addEventListener('mp:open-subagent', (event) => {
  const detail = (event as CustomEvent<{ id?: string; parentCallId?: string }>).detail;
  const requestedId = String(detail?.id || '');
  const parentCallId = String(detail?.parentCallId || '');
  const tasks = currentSubagentTasks();
  const matchingTask = tasks.find((task) => task.id === requestedId || task.parentCallId === parentCallId);
  focusedSubagentId = matchingTask?.id || requestedId;
  if (matchingTask) {
    const view = backgroundTaskView();
    view.cleared.delete(matchingTask.id);
    if (matchingTask.status !== 'running') view.finishedOpen = true;
  }
  setInspector(true, 'tasks');
  renderProjectTasks();
  if (focusedSubagentId) {
    requestAnimationFrame(() => {
      const taskRow = document.querySelector<HTMLElement>(`.mp-subagent-task[data-task-id="${CSS.escape(focusedSubagentId)}"]`);
      taskRow?.scrollIntoView({ block: 'nearest' });
      taskRow?.querySelector<HTMLElement>('.mp-subagent-transcript')?.focus({ preventScroll: true });
    });
  }
});

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
window.addEventListener('resize', () => {
  /* 跳转条的位置按全文高度算，换尺寸之后整张图都变了，要重新测。 */
  scheduleStreamRail();
  if (inspectorState.open && !inspectorState.maximized) {
    inspectorState = inspectorStatePolicy.reduceInspectorState(
      inspectorState,
      { type: 'viewport', availableWidth: inspectorAvailableWidth() },
    );
    syncInspectorGeometry();
    return;
  }
  scheduleProjectBrowserResize();
});

function inspectorAvailableWidth(): number {
  const sidebarWidth = document.querySelector('.dshw-sidebar-col')?.getBoundingClientRect().width
    ?? (shell.dataset.sidebar === 'collapsed' ? 44 : 288);
  return Math.max(0, shell.clientWidth - sidebarWidth);
}

function syncInspectorGeometry() {
  const inspector = document.getElementById('project-inspector');
  const maximize = document.getElementById('inspector-maximize');
  if (!inspector) return;
  inspector.hidden = !inspectorState.open;
  const taskRail = inspectorState.tab === 'tasks';
  const backgroundTasks = taskRail && inspector.dataset.taskLayout === 'background';
  const rail = inspectorStatePolicy.sessionRailGeometry(inspectorAvailableWidth());
  inspector.dataset.taskRail = String(taskRail && !backgroundTasks);
  inspector.dataset.backgroundTasks = String(backgroundTasks);
  inspector.dataset.railOverlay = String(taskRail && !backgroundTasks && rail.overlay);
  shell.dataset.taskSurface = !inspectorState.open ? '' : backgroundTasks ? 'background' : taskRail ? 'plan' : 'document';
  inspector.style.width = taskRail && !backgroundTasks ? `${rail.width}px`
    : inspectorState.maximized ? '' : backgroundTasks ? '416px' : `${inspectorState.width}px`;
  if (taskRail) {
    const title = document.getElementById('inspector-title');
    if (title) title.textContent = backgroundTasks ? 'Background tasks' : 'Tasks';
  }
  if (maximize) maximize.hidden = taskRail && !backgroundTasks;
  const resizeHandle = document.getElementById('inspector-resize-handle');
  if (resizeHandle) resizeHandle.hidden = taskRail;
  if (inspectorState.open) shell.dataset.inspector = 'open';
  else delete shell.dataset.inspector;
  if (inspectorState.maximized && (!taskRail || backgroundTasks)) shell.dataset.inspectorMaximized = 'true';
  else delete shell.dataset.inspectorMaximized;
  maximize?.setAttribute('aria-pressed', String(inspectorState.maximized));
  maximize?.setAttribute('aria-label', inspectorState.maximized ? '还原任务面板' : '展开任务面板');
  try { localStorage.setItem(INSPECTOR_WIDTH_KEY, String(inspectorState.previousWidth)); } catch { /* storage unavailable */ }
  document.getElementById('inspector-toggle')?.setAttribute('aria-expanded', String(inspectorState.open));
  scheduleProjectBrowserResize();
}

function setInspector(open: boolean, tab = activeInspectorTab) {
  const inspector = document.getElementById('project-inspector');
  if (!inspector) return;
  inspectorState = inspectorStatePolicy.reduceInspectorState(
    inspectorState,
    open ? { type: 'open', tab, availableWidth: inspectorAvailableWidth() } : { type: 'close' },
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
    inspectorTitle.textContent = ({ materials: 'Materials', files: 'Files', browser: 'Browser', terminal: 'Terminal', changes: 'Changes', tasks: inspector.dataset.taskLayout === 'background' ? 'Background tasks' : 'Tasks', artifact: 'Artifact' } as Record<string, string>)[activeInspectorTab] || 'Task';
  }
  if (!open) { closeProjectBrowserView(); return; }
  if (activeInspectorTab !== 'browser') closeProjectBrowserView();
  if (activeInspectorTab === 'files' && !projectTreeCache.has('')) void refreshProjectInspector();
  if (activeInspectorTab === 'materials') renderTaskMaterials();
  if (activeInspectorTab === 'changes') void renderProjectChanges();
  if (activeInspectorTab === 'tasks') renderProjectTasks();
  if (activeInspectorTab === 'artifact') renderArtifactEditor();
  if (activeInspectorTab === 'browser') scheduleProjectBrowserResize();
}

document.getElementById('inspector-toggle')?.addEventListener('click', () => {
  setInspector(shell.dataset.inspector !== 'open', activeProjectRoot ? 'files' : 'materials');
});
document.getElementById('header-preview-toggle')?.addEventListener('click', () => setInspector(true, 'browser'));
document.getElementById('inspector-close')?.addEventListener('click', () => setInspector(false));
document.getElementById('inspector-maximize')?.addEventListener('click', () => {
  inspectorState = inspectorStatePolicy.reduceInspectorState(
    inspectorState,
    inspectorState.maximized
      ? { type: 'restore', availableWidth: inspectorAvailableWidth() }
      : { type: 'maximize' },
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
      renderProjectFileTree();
    } else {
      expandedProjectDirectories.add(relativePath);
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
/* 文件树的键盘导航：官方树行是 tabIndex=-1（键盘只从树容器进来），靠 ←/→/↑/↓
   Home/End 在行之间移动焦点。行本身是 button，Enter/Space 走原生 click。
   ↑ 在第一行时回到过滤框——官方也是这么收回去的。 */
(function bindFileTreeKeyboard() {
  const host = document.getElementById('project-file-tree');
  if (!host) return;
  const rows = () => [...host.querySelectorAll<HTMLElement>('[data-tree-row]')];
  const visible = (row: HTMLElement) => {
    const box = host.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    return rect.bottom > box.top && rect.top < box.bottom;
  };
  const focusRow = (row: HTMLElement | undefined | null) => { row?.focus(); row?.scrollIntoView({ block: 'nearest' }); };
  const currentRow = () => {
    const active = document.activeElement as HTMLElement | null;
    const all = rows();
    return active && all.includes(active) ? active : all.find(row => row.classList.contains('is-on') && visible(row)) || all.find(visible) || all[0];
  };
  host.addEventListener('focus', (event) => {
    if (event.target !== host) return;
    focusRow(currentRow());
  });
  host.addEventListener('keydown', (event) => {
    const all = rows();
    if (!all.length) return;
    const row = currentRow();
    const index = row ? all.indexOf(row) : -1;
    const go = (next: number) => {
      event.preventDefault();
      focusRow(all[Math.max(0, Math.min(all.length - 1, next))]);
    };
    if (event.key === 'ArrowDown') { go(index < 0 ? 0 : index + 1); return; }
    if (event.key === 'ArrowUp') {
      if (index <= 0) { event.preventDefault(); document.getElementById('file-tree-filter')?.focus(); return; }
      go(index - 1);
      return;
    }
    if (event.key === 'Home') { go(0); return; }
    if (event.key === 'End') { go(all.length - 1); return; }
    if (!row) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (row.dataset.projectKind === 'directory' && row.getAttribute('aria-expanded') === 'false') row.click();
      else go(index + 1);
      return;
    }
    if (event.key === 'ArrowLeft') {
      if (row.getAttribute('aria-expanded') === 'true') { event.preventDefault(); row.click(); return; }
      const depth = Number(row.dataset.depth || '0');
      if (depth <= 0) return;
      event.preventDefault();
      for (let i = index - 1; i >= 0; i -= 1) {
        if (Number(all[i].dataset.depth || '0') < depth) { focusRow(all[i]); return; }
      }
    }
  });
})();
document.getElementById('file-tree-filter')?.addEventListener('input', renderProjectFileTree);
document.getElementById('project-file-back')?.addEventListener('click', () => {
  const preview = document.getElementById('project-file-preview');
  if (preview) preview.hidden = true;
  preview?.closest('.mp-inspector-panel')?.classList.remove('is-previewing');
  selectedProjectFile = '';
  selectedProjectFileText = '';
  selectedProjectFileMarkdown = false;
  projectFileCodeView = false;
  const inspectorTitle = document.getElementById('inspector-title');
  if (inspectorTitle) inspectorTitle.textContent = 'Files';
  renderProjectFileTree();
});
document.getElementById('project-file-code')?.addEventListener('click', () => {
  projectFileCodeView = !projectFileCodeView;
  renderSelectedProjectFile();
});
document.getElementById('project-file-copy')?.addEventListener('click', () => {
  if (selectedProjectFileText) void navigator.clipboard.writeText(selectedProjectFileText);
});
document.getElementById('project-file-search')?.addEventListener('click', () => {
  const input = document.getElementById('project-file-search-input') as HTMLInputElement | null;
  if (!input) return;
  input.hidden = !input.hidden;
  if (!input.hidden) input.focus();
});
document.getElementById('project-file-search-input')?.addEventListener('input', (event) => {
  const query = (event.currentTarget as HTMLInputElement).value;
  const find = (window as Window & { find?: (...args: unknown[]) => boolean }).find;
  if (query && find) find.call(window, query, false, false, true, false, true, false);
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
  if (!target.closest('#account-menu') && !target.closest('#account-footer')) closeAccountMenu();
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

  const effortMenu = document.getElementById('composer-effort-menu');
  if (effortMenu && !effortMenu.hidden && !target.closest('#composer-effort-menu')
      && !target.closest('#composer-effort')) {
    closeEffortMenu();
  }

  /* + opens Claude's attachment menu; / keeps the command directory. */
  const addBtn = target.closest<HTMLElement>('#composer-add');
  const addMenu = document.getElementById('composer-add-menu');
  if (addBtn) {
    const attach = document.getElementById('composer-attach-menu');
    if (attach?.hidden) openAttachMenu();
    else closeAnchoredPopover('composer-attach-menu', 'composer-add');
    return;
  }
  if (!target.closest('#composer-attach-menu')) closeAnchoredPopover('composer-attach-menu', 'composer-add');
  if (addMenu && !addMenu.hidden && !target.closest('#composer-add-menu')) {
    closeSlashMenu();
  }

  const mention = target.closest<HTMLElement>('#composer-mention');
  if (mention) {
    if (activeTaskContext?.sources.length) {
      setInspector(true, 'materials');
      return;
    }
    const textarea = document.querySelector<HTMLTextAreaElement>('#composer-form textarea');
    if (textarea) {
      const start = textarea.selectionStart;
      textarea.setRangeText('@', start, textarea.selectionEnd, 'end');
      textarea.focus();
      fitComposer(textarea);
    }
    return;
  }

  const projectNew = target.closest<HTMLElement>('[data-project-new]');
  if (projectNew) {
    setActiveProject(projectNew.dataset.projectNew || '');
    startNewChat();
    return;
  }
  const projectTools = target.closest<HTMLElement>('[data-project-tools]');
  if (projectTools) {
    setActiveProject(projectTools.dataset.projectTools || '');
    setInspector(true, 'files');
    return;
  }
  const projectToggle = target.closest<HTMLElement>('[data-workspace-toggle]');
  if (projectToggle) {
    const key = projectToggle.dataset.workspaceToggle || '';
    const project = projectToggle.closest<HTMLElement>('.dshw-project');
    const alreadyActive = normalizedProjectRoot(key) === normalizedProjectRoot(activeProjectRoot);
    const open = project?.dataset.open !== 'false';
    if (projectToggle.dataset.virtualGroup === 'true') {
      expandedWorkspaces.set(key, !open);
      if (project) project.dataset.open = String(!open);
      projectToggle.setAttribute('aria-expanded', String(!open));
      return;
    }
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
      && !target.closest('#composer-usage-popover, #composer-usage-breakdown')) {
    closeAnchoredPopover('composer-usage-popover', 'composer-context');
  }

  const open = target.closest<HTMLElement>('[data-open]');
  if (open && open.dataset.open) {
    studioLibraries.setSessionPreference(open.dataset.open, { seenAt: Date.now() });
    openConversation(open.dataset.open); return;
  }

  const artifact = target.closest<HTMLElement>('[data-artifact-id]');
  if (artifact?.dataset.artifactId && artifact.dataset.artifactConversation) {
    void openArtifactEditor(
      artifact.dataset.artifactConversation,
      artifact.dataset.artifactId,
    );
    return;
  }

  if (target.closest('#stash-add-file')) {
    void (async () => {
      const result = await Data.addStashFiles();
      if (result.ok) await renderStash(true);
      else if (!result.canceled) window.alert(String(result.error || '文件没有加入收藏。'));
    })();
    return;
  }

  if (target.closest('#stash-add-note')) {
    void (async () => {
      const text = await requestStudioText('写下要收藏的笔记');
      if (!text?.trim()) return;
      const category = await requestStudioText('分类', '笔记', 100);
      if (category === null) return;
      const result = await Data.addStashNote(text, category);
      if (result.ok) await renderStash(true);
      else window.alert(String(result.error || '笔记没有加入收藏。'));
    })();
    return;
  }

  const stashOpen = target.closest<HTMLElement>('[data-stash-open]');
  if (stashOpen?.dataset.stashOpen) {
    void (async () => {
      const result = await Data.openStashEntry(stashOpen.dataset.stashOpen || '');
      if (!result.ok) {
        const at = Number(result.sourceTimeMs);
        const when = Number.isFinite(at) && at > 0 ? `（来源时间：${new Date(at).toLocaleString()}）` : '';
        window.alert(`原应用或文件当前不可达${when}。${result.error ? `\n${result.error}` : ''}`);
      }
    })();
    return;
  }

  const stashCategory = target.closest<HTMLElement>('[data-stash-category]');
  if (stashCategory?.dataset.stashCategory) {
    void (async () => {
      const category = await requestStudioText('修改分类', stashCategory.dataset.category || '', 100);
      if (!category) return;
      const result = await Data.updateStashCategory(stashCategory.dataset.stashCategory || '', category);
      if (result.ok) await renderStash(true);
      else window.alert(String(result.error || '分类没有更新。'));
    })();
    return;
  }

  const stashRemove = target.closest<HTMLElement>('[data-stash-remove]');
  if (stashRemove?.dataset.stashRemove) {
    if (!window.confirm('删除这条收藏？原始文件不会被删除。')) return;
    void (async () => {
      const result = await Data.removeStashEntry(stashRemove.dataset.stashRemove || '');
      if (result.ok) await renderStash(true);
      else window.alert(String(result.error || '收藏没有删除。'));
    })();
    return;
  }

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
    document.querySelectorAll<HTMLElement>('.mp-design-nav [data-design-layout]').forEach(button => {
      button.classList.toggle('is-on', button.dataset.designLayout === mode.dataset.mode);
    });
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

document.getElementById('stash-search')?.addEventListener('input', (event) => {
  stashQuery = String((event.target as HTMLInputElement | null)?.value || '').trim();
  void renderStash(true);
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

/* ---- Claude effort：模型工作深度，不是回复文风。 ---- */
const EFFORT_STORAGE_KEY = 'mp:composer-effort';
let composerEffort = (() => {
  try {
    const stored = localStorage.getItem(EFFORT_STORAGE_KEY);
    return stored ? String(stored) : 'xhigh';
  } catch { return 'xhigh'; }
})();

/* 档位随会话存下来：它不是一次性选择，是用户对这个助手的长期偏好。 */
function persistEffort() {
  try { localStorage.setItem(EFFORT_STORAGE_KEY, composerEffort); } catch { /* storage unavailable */ }
}

function renderEffortChip() {
  const button = document.getElementById('composer-effort');
  const label = document.getElementById('composer-effort-label');
  const option = effortLevels.effortOption(composerEffort);
  if (label) label.textContent = option.label;
  if (button instanceof HTMLButtonElement) {
    button.title = `Reasoning effort: ${option.label} — ${option.description}`;
    button.setAttribute('aria-label', `Reasoning effort: ${option.label}`);
  }
}

function closeEffortMenu() {
  closeAnchoredPopover('composer-effort-menu', 'composer-effort');
}

/* 菜单里的选中勾现在是 Claude 自己的字形（`check` U+E03B，20px 那档），
   不再是一枚自绘的描边勾——参考里菜单内的勾和别处的图标是同一套字形，
   自绘的那个笔画粗细跟旁边的字体图标对不上。
   取不到字体模块时退回原来的 svg：少一个勾比少一整个菜单严重。 */
function checkGlyph(): Element {
  const api = globalThis as unknown as { CdsIcons?: { html?: (name: string, size?: string) => string } };
  const markup = typeof api.CdsIcons?.html === 'function' ? api.CdsIcons.html('check') : '';
  if (markup) {
    const host = document.createElement('span');
    host.setAttribute('aria-hidden', 'true');
    host.innerHTML = markup;
    return host;
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#ic-check');
  svg.appendChild(use);
  return svg;
}

function selectedCheck(): Element {
  const check = checkGlyph();
  check.classList.add('dshw-perm-check');
  return check;
}

/* 参考里的 effort 不是一列选项，是一根滑块：左边 Faster、右边 Smarter，
   一条槽上五个刻度点，方形白滑块停在当前档。选档因此是一个「往左还是往右」
   的动作，而不是在五个词里读哪一个——这两件事对用户是不同的负担。
   槽是连续的，档是离散的：点击/拖动都吸附到最近的那一档。 */
function openEffortMenu() {
  const menu = document.getElementById('composer-effort-menu');
  if (!menu) return;
  const levels = effortLevels.EFFORT_LEVELS;
  const currentIndex = Math.max(0, levels.findIndex((option) => option.value === composerEffort));

  const head = document.createElement('div');
  head.className = 'mp-effort-head';
  const headLabel = document.createElement('span');
  headLabel.className = 'mp-effort-head-label';
  headLabel.textContent = 'Effort';
  const headValue = document.createElement('strong');
  headValue.className = 'mp-effort-head-value';
  headValue.textContent = levels[currentIndex].label;
  const help = document.createElement('button');
  help.type = 'button';
  help.className = 'mp-effort-help';
  help.setAttribute('aria-label', 'About effort');
  help.setAttribute('title', levels[currentIndex].description);
  help.innerHTML = menuGlyph('help');
  head.append(headLabel, headValue, help);

  const scale = document.createElement('div');
  scale.className = 'mp-effort-scale';
  const faster = document.createElement('span');
  faster.textContent = 'Faster';
  const smarter = document.createElement('span');
  smarter.textContent = 'Smarter';
  scale.append(faster, smarter);

  const track = document.createElement('div');
  track.className = 'mp-effort-track';
  track.setAttribute('role', 'slider');
  track.setAttribute('tabindex', '0');
  track.setAttribute('aria-label', 'Reasoning effort');
  track.setAttribute('aria-valuemin', '1');
  track.setAttribute('aria-valuemax', String(levels.length));
  track.setAttribute('aria-valuenow', String(currentIndex + 1));
  track.setAttribute('aria-valuetext', levels[currentIndex].label);
  const fill = document.createElement('div');
  fill.className = 'mp-effort-fill';
  const thumb = document.createElement('div');
  thumb.className = 'mp-effort-thumb';
  const particles = document.createElement('canvas');
  particles.className = 'mp-effort-particles';
  particles.setAttribute('aria-hidden', 'true');
  fill.append(particles);
  track.append(fill, thumb);
  /* 位置一律内缩半个滑块宽：不内缩的话第一档和最后一档的方块各有一半悬在
     槽外，参考里两端都是完整落在槽里的。 */
  const position = (ratio: number) => `calc(var(--mp-effort-inset) + ${ratio} * (100% - 2 * var(--mp-effort-inset)))`;
  for (let index = 0; index < levels.length; index += 1) {
    const tick = document.createElement('i');
    tick.className = 'mp-effort-tick';
    tick.style.left = `calc(10px + ${index / (levels.length - 1)} * (100% - 20px))`;
    track.append(tick);
  }

  const paint = (index: number) => {
    const ratio = index / (levels.length - 1);
    fill.style.width = `calc(var(--mp-effort-inset) + ${ratio} * (100% - 2 * var(--mp-effort-inset)))`;
    thumb.style.left = position(ratio);
    track.dataset.max = String(index === levels.length - 1);
    effortParticleController?.setMax(index === levels.length - 1);
  };
  paint(currentIndex);

  let activeIndex = currentIndex;
  const select = (index: number) => {
    activeIndex = Math.max(0, Math.min(levels.length - 1, index));
    composerEffort = levels[activeIndex].value;
    paint(activeIndex);
    headValue.textContent = levels[activeIndex].label;
    help.setAttribute('title', levels[activeIndex].description);
    track.setAttribute('aria-valuenow', String(activeIndex + 1));
    track.setAttribute('aria-valuetext', levels[activeIndex].label);
    renderEffortChip();
    persistEffort();
  };
  const indexFromPointer = (clientX: number) => {
    const rect = track.getBoundingClientRect();
    const inset = 8; // Claude compact control: (24 - 8) / 2
    const usable = rect.width - inset * 2;
    if (usable <= 0) return activeIndex;
    const ratio = (clientX - rect.left - inset) / usable;
    return Math.round(ratio * (levels.length - 1));
  };
  track.addEventListener('pointerdown', (event) => {
    track.dataset.dragging = 'true';
    /* 先选档再捕获：捕获对合成事件（探针的 sendInputEvent）会抛 NotFoundError，
       放在前面会让整个处理器在那一次点击里直接中止——档位看着像点不动。 */
    select(indexFromPointer(event.clientX));
    try { track.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
  });
  track.addEventListener('pointermove', (event) => {
    if (track.hasPointerCapture(event.pointerId)) select(indexFromPointer(event.clientX));
  });
  const endDrag = () => { delete track.dataset.dragging; };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
  track.addEventListener('lostpointercapture', endDrag);
  track.addEventListener('keydown', (event) => {
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); select(event.key === 'Home' ? 0 : levels.length - 1); return;
    }
    const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (!delta) return;
    event.preventDefault();
    select(activeIndex + delta);
  });

  const body = document.createElement('div');
  body.className = 'mp-effort-body';
  body.append(scale, track);
  effortParticleController?.dispose();
  menu.replaceChildren(head, body);
  const opened = positionAnchoredPopover('composer-effort-menu', 'composer-effort');
  const particleApi = (globalThis as { EffortParticles?: { mount(canvas: HTMLCanvasElement): NonNullable<typeof effortParticleController> } }).EffortParticles;
  effortParticleController = particleApi?.mount(particles) || null;
  effortParticleController?.setMax(currentIndex === levels.length - 1);
  requestAnimationFrame(() => opened?.querySelector<HTMLElement>('.mp-effort-track')?.focus());
}


function bindEffortChip() {
  renderEffortChip();
  document.getElementById('composer-effort')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = document.getElementById('composer-effort-menu');
    if (menu?.hidden) openEffortMenu();
    else closeEffortMenu();
  });
}

/* ---- 权限预设芯片（DSH PermissionSelect 同款：芯片 + 弹层 + Full access 确认门） ---- */
let composerPreset = 'workspace-write';
let composerAttachments: string[] = [];

function normalizedTaskContext(value: unknown): MagicPointerTaskContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const taskId = String(raw.taskId || '').trim();
  if (!taskId) return null;
  try {
    const sources = (Array.isArray(raw.sources) ? raw.sources : [])
      .map((source) => TaskSources.normalizeSourceRef(source)) as MagicPointerTaskSource[];
    const referenceValues = Array.isArray(raw.references)
      ? raw.references
      : raw.references && typeof raw.references === 'object'
        ? Object.values(raw.references as Record<string, unknown>)
        : [];
    const references = referenceValues
      .map((reference) => TaskSources.normalizeReferenceBinding(reference)) as MagicPointerTaskReference[];
    return {
      taskId,
      sources: sources.filter((source) => source.taskId === taskId),
      references,
      referenceRevision: Math.max(0, Number(raw.referenceRevision) || 0),
      permissionMode: typeof raw.permissionMode === 'string' ? raw.permissionMode : undefined,
      effort: typeof raw.effort === 'string' ? raw.effort : undefined,
    };
  } catch {
    return null;
  }
}

function setActiveTaskContext(value: unknown, resetSelection = false) {
  const next = normalizedTaskContext(value);
  if (next?.permissionMode && (resetSelection || next.permissionMode !== activeTaskContext?.permissionMode)) {
    const preset = ({ plan: 'plan', safe: 'read-only', default: 'workspace-write',
      accept_reversible: 'auto', bypass: 'danger-full-access' } as Record<string, string>)[next.permissionMode];
    if (preset) { composerPreset = preset; renderPermissionChip(); }
  }
  if (next?.effort && (resetSelection || next.effort !== activeTaskContext?.effort)) {
    composerEffort = effortLevels.normalizeEffort(next.effort); renderEffortChip();
  }
  if (resetSelection || (activeTaskContext?.taskId && activeTaskContext.taskId !== next?.taskId)) {
    composerSelectedSourceIds.clear();
    inspectorState = inspectorStatePolicy.reduceInspectorState(inspectorState, { type: 'clear-content' });
  }
  activeTaskContext = next;
  const known = new Set(next?.sources.map((source) => source.sourceId) || []);
  for (const sourceId of [...composerSelectedSourceIds]) {
    if (!known.has(sourceId)) composerSelectedSourceIds.delete(sourceId);
  }
  renderTaskMaterials();
  renderComposerMaterials();
}

function referencesForSource(sourceId: string): MagicPointerTaskReference[] {
  return (activeTaskContext?.references || [])
    .filter((reference) => reference.active && reference.sourceId === sourceId)
    .sort((left, right) => left.ordinal - right.ordinal);
}

function taskSourceLabel(source: MagicPointerTaskSource): string {
  const role = referencesForSource(source.sourceId)
    .map((reference) => `${reference.label} · ${reference.role}`)
    .join('，');
  return [source.kind, source.origin, role].filter(Boolean).join(' · ');
}

function selectTaskMaterial(sourceId: string) {
  if (!activeTaskContext?.sources.some((source) => source.sourceId === sourceId)) return;
  if (composerSelectedSourceIds.has(sourceId)) composerSelectedSourceIds.delete(sourceId);
  else composerSelectedSourceIds.add(sourceId);
  inspectorState = inspectorStatePolicy.reduceInspectorState(inspectorState, {
    type: 'select-content',
    contentKind: 'material',
    contentId: sourceId,
  });
  renderTaskMaterials();
  renderComposerMaterials();
}

function renderTaskMaterials() {
  const host = document.getElementById('task-material-list');
  const detail = document.getElementById('task-material-detail');
  if (!host || !detail) return;
  const sources = activeTaskContext?.sources || [];
  if (!sources.length) {
    host.innerHTML = '<p class="mp-inspector-empty">当前任务还没有材料。用 + 加入文件，或在屏幕上指向内容。</p>';
    detail.hidden = true;
    detail.replaceChildren();
    return;
  }
  host.replaceChildren(...sources.map((source) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'mp-task-material';
    row.dataset.materialSourceId = source.sourceId;
    row.classList.toggle('is-selected', composerSelectedSourceIds.has(source.sourceId));
    row.setAttribute('aria-pressed', String(composerSelectedSourceIds.has(source.sourceId)));
    row.title = source.sourceId;
    const iconHost = document.createElement('span');
    iconHost.className = 'mp-task-material-icon';
    iconHost.innerHTML = icon(source.kind === 'web' ? 'ic-globe' : source.kind === 'figma' ? 'ic-pen' : 'ic-file');
    const copy = document.createElement('span');
    copy.className = 'mp-task-material-copy';
    const title = document.createElement('strong');
    title.textContent = source.title;
    const meta = document.createElement('small');
    meta.textContent = taskSourceLabel(source);
    copy.append(title, meta);
    row.append(iconHost, copy);
    row.addEventListener('click', () => selectTaskMaterial(source.sourceId));
    return row;
  }));
  const selectedId = inspectorState.contentSelection?.kind === 'material'
    ? inspectorState.contentSelection.id : '';
  const selected = sources.find((source) => source.sourceId === selectedId);
  if (!selected) {
    detail.hidden = true;
    detail.replaceChildren();
    return;
  }
  const references = referencesForSource(selected.sourceId);
  const title = document.createElement('strong');
  title.textContent = selected.title;
  const sourceId = document.createElement('code');
  sourceId.textContent = selected.sourceId;
  const scope = document.createElement('p');
  scope.textContent = `可用能力：${selected.capabilities.join('、') || '无'}`;
  const provenance = document.createElement('pre');
  provenance.textContent = JSON.stringify(selected.identity, null, 2);
  const referenceSummary = document.createElement('p');
  referenceSummary.textContent = references.length
    ? `引用：${references.map((reference) => `${reference.label}（${reference.role}）`).join('，')}`
    : '当前没有局部引用。';
  detail.replaceChildren(title, sourceId, scope, referenceSummary, provenance);
  if (selected.identity.absolutePath && activeConversationId) {
    const conversationId = activeConversationId;
    const controls = document.createElement('div');
    controls.className = 'mp-material-watch';
    const task = document.createElement('input');
    task.className = 'dshw-rename-input';
    task.value = '核对材料变化，生成更新草稿。';
    task.maxLength = 4000;
    task.setAttribute('aria-label', '材料关注任务');
    const cadence = document.createElement('select');
    cadence.setAttribute('aria-label', '关注时机');
    cadence.innerHTML = '<option value="filesystem">材料变化时</option><option value="daily">每天此时</option>';
    const follow = document.createElement('button');
    follow.type = 'button';
    follow.textContent = '关注此材料';
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.textContent = '停止关注';
    stop.hidden = true;
    const status = document.createElement('p');
    status.textContent = '应用运行时核对所选材料，结果出现在普通任务中。';
    const update = async (action: string) => {
      follow.disabled = stop.disabled = true;
      try {
        const result = await Data.trackMaterial({
          conversationId, sourceId: selected.sourceId, action,
          task: task.value, cadence: cadence.value,
        });
        if (!controls.isConnected) return;
        if (!result.ok) { status.textContent = String(result.error || '关注设置未保存。'); return; }
        const tracker = result.tracker;
        stop.hidden = tracker?.enabled !== true;
        follow.textContent = tracker?.enabled ? '更新关注' : '关注此材料';
        if (tracker) {
          task.value = tracker.task;
          cadence.value = tracker.trigger.kind === 'schedule' ? 'daily' : 'filesystem';
          status.textContent = tracker.enabled ? '正在关注此材料；结果出现在普通任务中。' : '已停止关注。';
          if (tracker.lastRun) status.textContent += tracker.lastRun.ok
            ? ' 上次已生成草稿。' : ` 上次未完成：${tracker.lastRun.error || '请查看任务结果'}`;
        }
      } catch (error) {
        status.textContent = `关注设置未保存：${String(error)}`;
      } finally { follow.disabled = stop.disabled = false; }
    };
    follow.addEventListener('click', () => void update('follow'));
    stop.addEventListener('click', () => void update('stop'));
    controls.append(task, cadence, follow, stop, status);
    detail.append(controls);
    void update('get');
  }
  detail.hidden = false;
}

function renderComposerMaterials() {
  const host = document.getElementById('composer-materials');
  if (!host) return;
  const sourceById = new Map((activeTaskContext?.sources || []).map((source) => [source.sourceId, source]));
  const selected = [...composerSelectedSourceIds]
    .map((sourceId) => sourceById.get(sourceId))
    .filter((source): source is MagicPointerTaskSource => Boolean(source));
  host.hidden = selected.length === 0;
  host.replaceChildren(...selected.map((source) => {
    const chip = document.createElement('span');
    chip.className = 'mp-composer-attachment mp-composer-material';
    chip.title = source.sourceId;
    const name = document.createElement('span');
    name.textContent = source.title;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `不在下一步使用 ${source.title}`);
    remove.innerHTML = '<svg aria-hidden="true"><use href="#ic-x" /></svg>';
    remove.addEventListener('click', () => selectTaskMaterial(source.sourceId));
    chip.append(name, remove);
    return chip;
  }));
}

function buildStudioTaskInput(
  instruction: string,
  inputId: string,
  taskId: string,
  attachments: string[] = [],
): MagicPointerTaskInput {
  const capturedAtMs = Date.now();
  return TaskSources.bindConversationTaskInput({
    inputId,
    taskId: taskId || 'studio-pending',
    target: 'next-step',
    instruction,
    referenceUpdates: [],
    sourceIds: [...composerSelectedSourceIds],
    timeline: [],
    capturedAtMs,
  }, {
    taskId: taskId || 'studio-pending',
    instruction,
    attachments,
    capturedAtMs,
  }) as MagicPointerTaskInput;
}

function attachmentSourcesForTask(paths: string[], taskId: string): Record<string, unknown>[] {
  return paths.map((filePath) => TaskSources.attachmentSourceRef(filePath, taskId));
}

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
  badge?: string;
  action?: string;
  shortcut?: string;
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
  closeAnchoredPopover('composer-permission-menu', 'composer-permission');
}

function openPermissionMenu() {
  const menu = document.getElementById('composer-permission-menu');
  if (!menu) return;
  /* 参考里这枚菜单的第一行是分组标题 `Mode`，行首不放图标，行尾是数字快捷键，
     当前档在编号前面打一个勾；Bypass 那一行没有编号，右侧改放一个 Enable。
     以前的版本是「行首图标 + 行尾只打勾」，形状对不上。 */
  const heading = document.createElement('div');
  heading.className = 'dshw-perm-heading';
  heading.textContent = 'Mode';
  const rows = permPresets.PRESETS.map(option => {
    const row = document.createElement('button');
    row.type = 'button';
    const selected = option.value === composerPreset;
    row.className = 'dshw-perm-row' + (selected ? ' is-active' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(selected));
    row.dataset.permValue = option.value;
    if (option.shortcut) row.dataset.permKey = option.shortcut;
    row.title = option.description;
    const text = document.createElement('span');
    text.className = 'dshw-perm-row-text';
    const name = document.createElement('span');
    name.className = 'dshw-perm-row-name';
    name.textContent = option.label;
    if (option.badge) {
      const badge = document.createElement('span');
      badge.className = 'dshw-perm-badge';
      badge.textContent = option.badge;
      name.appendChild(badge);
    }
    const desc = document.createElement('small');
    desc.textContent = option.description;
    text.append(name, desc);
    row.append(text);
    const trail = document.createElement('span');
    trail.className = 'dshw-perm-trail';
    if (option.action) {
      /* 有 action 的行没有编号：它不是「切过去」，是一次要确认的开启。 */
      const action = document.createElement('span');
      action.className = 'dshw-perm-action';
      action.textContent = option.action;
      trail.appendChild(action);
    } else {
      if (selected) trail.appendChild(selectedCheck());
      if (option.shortcut) {
        const key = document.createElement('span');
        key.className = 'dshw-perm-key';
        key.textContent = option.shortcut;
        trail.appendChild(key);
      }
    }
    row.appendChild(trail);
    return row;
  });
  menu.replaceChildren(heading, ...rows);
  const opened = positionAnchoredPopover('composer-permission-menu', 'composer-permission');
  bindDigitShortcuts(menu, 'permKey');
  requestAnimationFrame(() => opened?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus());
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
/* The task rail projects the latest durable plan; it does not occupy the composer. */
let composerPlan: ReturnType<typeof PlanList.project> = null;

function renderPlanCard() {
  const host = document.getElementById('project-plan');
  if (!host) return;
  PlanList.render(host, composerPlan, {
    sessionKey: activeConversationId || pendingConversation?.requestId || '',
  });
}

/* Decisions respond to the suspended tool call. They never submit the composer. */
let pendingPermissionAsk: { requestId?: string; tool: string; prefix?: string; actionPreview?: string; question?: string; options?: string[] } | null = null;
let pendingPermissionChoice: { grant?: string; deny?: string; once?: string } | null = null;
let pendingAskInput: NonNullable<MagicPointerTurn['pendingInput']> | null = null;
const pendingInputHost = document.getElementById('composer-permission-ask');

function renderPermissionAsk() {
  const host = document.getElementById('composer-permission-ask') || pendingInputHost;
  if (!host) return;
  const input = pendingPermissionAsk || pendingAskInput;
  if (!input) { DecisionCard.clear(host); return; }
  const conversationId = activeConversationId || '';
  const requestId = input.requestId || '';
  const stream = document.getElementById('stream');
  const follow = stream && stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120;
  if (stream && host.parentElement !== stream) stream.append(host);
  host.dataset.mode = pendingPermissionAsk ? 'permission' : 'ask';
  DecisionCard.render(host, {
    ...input, key: `${conversationId}:${requestId}`,
    presentation: 'inline',
    kind: pendingPermissionAsk ? 'permission' : pendingAskInput?.kind || 'ask',
    questions: pendingAskInput?.questions || (pendingAskInput ? [{
      question: pendingAskInput.question || '需要你的决定',
      options: (pendingAskInput.options || []).map(label => ({ label })),
    }] : undefined),
  }, response => { void respondToPendingInput(conversationId, requestId, response); });
  if (stream && follow) stream.scrollTop = stream.scrollHeight;
}

async function respondToPendingInput(conversationId: string, requestId: string, response: MagicPointerDecisionResponse) {
  if (studioComposerBusy || pendingConversation || externalConversationRun) return;
  const host = document.getElementById('composer-permission-ask');
  if (!host || conversationId !== activeConversationId) return;
  if (!requestId || !conversationId) {
    DecisionCard.pending(host, false, '无法找到这条请求的执行记录。请重新打开任务后重试。');
    return;
  }
  const turnIndex = activeConversationTurnCount - 1;
  const body = document.querySelector<HTMLElement>(`.dsh-flow-item[data-turn-index="${turnIndex}"]`);
  if (!body) { DecisionCard.pending(host, false, '无法找到当前任务。请重新打开后重试。'); return; }
  const requestToken = `response-${Date.now()}-${++studioTaskInputSequence}`;
  const scope = `${conversationId}#${turnIndex}`;
  const transcript = ConversationControl.createTranscript();
  const previous = activeConversationTurns[turnIndex] as MagicPointerTurn | undefined;
  transcript.trajectory = (previous?.trajectory || []).map(record => ({ ...record }));
  const submitted: PendingConversation = { requestId: requestToken, scope, body,
    records: new Map(), renderer: DshChat.createLiveTurn(body, scope, { taskPanel: true }),
    agentSessionId: activeConversationRecord?.agentSessionId || null,
    streamText: '', reasoningText: '', transcript, liveTokens: null };
  pendingConversation = submitted;
  studioComposerBusy = true;
  setComposerRunningState(true);
  startPendingClock(body);
  let accepted = false;
  try {
    const result = await Data.respondConversation({ conversationId, requestId, response,
      requestToken, permissionPreset: composerPreset, effort: composerEffort });
    accepted = result.accepted === true || submitted.inputAccepted === true;
    if (pendingConversation !== submitted || activeConversationId !== conversationId) return;
    if (!accepted) {
      DecisionCard.pending(host, false, String(result.error || '未能保存这次回答，请重试。'));
      return;
    }
    pendingPermissionAsk = null; pendingAskInput = null;
    DecisionCard.clear(host, true);
    await openConversation(conversationId);
    if (pendingConversation !== submitted || activeConversationId !== conversationId) return;
    setComposerSettledState(result.ok ? 'success' : 'error');
    await renderSidebar();
  } catch (error) {
    if (pendingConversation === submitted && activeConversationId === conversationId) {
      accepted = submitted.inputAccepted === true;
      if (accepted) {
        await openConversation(conversationId);
        setComposerSettledState('error');
      } else DecisionCard.pending(host, false, error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (pendingConversation === submitted) {
      detachPendingConversation();
      if (accepted) void refreshOpenConversation({ id: conversationId });
    }
  }
}

bindEffortChip();
bindPermissionChip();
/* textarea 随内容长高，上限由当前 composer 的 CSS 决定。 */
let composerFitRaf: number | null = null;
let composerFitTarget: HTMLTextAreaElement | null = null;

/*
 * 自动长高原来是「写 height:auto → 读 scrollHeight（强制同步布局）→ 写 height」
 * 每个按键跑一次，整个 studio 文档（长会话下极大）被同步 reflow。改成把测量
 * 合并到下一帧：一次 input 突发只量一次，且测量发生在同一帧内所有样式写入
 * 之后，读到的布局是最终的那一份。
 *
 * 所有调用点都只把 fitComposer 当成「下一帧变高」的视觉副作用（没有调用方在
 * 它之后立刻读 textarea 的高度），所以延后一帧不改变任何可观察行为。
 */
function fitComposer(ta: HTMLTextAreaElement) {
  composerFitTarget = ta;
  if (composerFitRaf !== null) return;
  composerFitRaf = window.requestAnimationFrame(() => {
    composerFitRaf = null;
    const target = composerFitTarget;
    composerFitTarget = null;
    if (!target) return;
    target.style.height = 'auto';
    const maxHeight = Number.parseFloat(getComputedStyle(target).maxHeight);
    target.style.height = `${Math.min(Number.isFinite(maxHeight) ? maxHeight : 384, target.scrollHeight)}px`;
  });
}

/* ---- 输入框联想词 ----
   回合结束后问一次「用户下一步最可能说什么」，空草稿以 placeholder 显示，
   Tab 接受为可编辑草稿，再由用户提交。拉取失败或模型没给建议时退回静态提示语，
   不写任何错误提示——输入框不是一个报告错误的地方。 */
let composerSuggestion = '';
let composerSuggestionRequest = 0;

const COMPOSER_PLACEHOLDER_HOME = 'Describe a task or ask a question';
const COMPOSER_PLACEHOLDER_THREAD = 'Type / for commands';

function applyComposerPlaceholder(ta?: HTMLTextAreaElement | null) {
  const textarea = ta || document.querySelector<HTMLTextAreaElement>('#composer-form textarea');
  if (!textarea) return;
  /* 联想词只在会话里出现：首页那句问的是「要做什么」，没有「下一步」。 */
  const home = !document.getElementById('studio-home')?.hidden;
  const base = home ? COMPOSER_PLACEHOLDER_HOME : COMPOSER_PLACEHOLDER_THREAD;
  textarea.placeholder = !home && composerSuggestion ? composerSuggestion : base;
  if (!home && composerSuggestion) textarea.setAttribute('aria-description', 'Press Tab to use the suggested follow-up. Edit it before sending.');
  else textarea.removeAttribute('aria-description');
}

function clearComposerSuggestion() {
  composerSuggestion = '';
  composerSuggestionRequest += 1;
  applyComposerPlaceholder();
}

/* 请求不阻塞任何东西：它在回合结束之后自己跑，回来时如果用户已经换了会话
   或又发了一轮，就整条丢掉。 */
async function refreshComposerSuggestion(turns: unknown, object: unknown) {
  const request = ++composerSuggestionRequest;
  const suggestion = await Data.suggestNextPrompt(turns, object);
  if (request !== composerSuggestionRequest) return;
  composerSuggestion = suggestion;
  applyComposerPlaceholder();
}

function syncComposerSubmitState() {
  const textarea = document.querySelector<HTMLTextAreaElement>('#composer-form textarea');
  const submit = document.querySelector<HTMLButtonElement>('#composer-form button[type="submit"]');
  if (!textarea || !submit) return;
  submit.disabled = !studioComposerBusy && !textarea.value.trim();
}

/* 模型切换器：DSH ModelSelect 同款——真实网关目录（fabric_bridge model.catalog），
   选中即更新当前模型档案（没有档案时才写 legacy secrets/model.txt），下次发送就生效。 */
let modelCatalog: MagicPointerModelCatalog | null = null;
let modelCatalogRequest = 0;

async function refreshComposerModel() {
  const request = ++modelCatalogRequest;
  let catalog: MagicPointerModelCatalog | null = null;
  try {
    catalog = await Data.models();
  } catch {
    catalog = null;
  }
  if (request !== modelCatalogRequest) return;
  if (catalog) modelCatalog = catalog;
  renderComposerModel();
}

function renderComposerModel() {
  const label = document.getElementById('composer-model-label');
  const btn = document.getElementById('composer-model');
  const current = modelCatalog?.current || '';
  composerQuota = null;
  if (!document.getElementById('composer-usage-popover')?.hidden) ensureComposerQuota();
  if (label) label.textContent = current || '默认模型';
  btn?.removeAttribute('title');
  renderUsageMeter(activeConversationTurns as MagicPointerTurn[]);
}

function closeModelMenu() {
  closeAnchoredPopover('composer-model-menu', 'composer-model');
}

async function openModelMenu() {
  const menu = document.getElementById('composer-model-menu');
  if (!menu) return;
  modelMoreOpen = false;
  // 先把浮层画出来，再刷新目录。模型目录是 I/O，不能挟持一次点击的
  // 可见反馈；否则网关慢半秒，用户就会连续点击并在返回瞬间把菜单关掉。
  menu.replaceChildren(...modelMenuRows(modelCatalog));
  positionAnchoredPopover('composer-model-menu', 'composer-model');
  bindDigitShortcuts(menu, 'modelKey');
  const request = ++modelCatalogRequest;
  let catalog: MagicPointerModelCatalog | null = null;
  try {
    catalog = await Data.models(true);
  } catch {
    catalog = null;
  }
  if (request !== modelCatalogRequest) return;
  if (!catalog) {
    if (menu.hidden || modelCatalog) return;
    menu.replaceChildren(modelMenuNote('模型目录不可用（本机未接入 Electron 桥）。'));
    return;
  }
  modelCatalog = catalog;
  renderComposerModel();
  // 更新同一个模型状态，但不重新打开用户已关闭的菜单。
  if (menu.hidden) return;
  renderModelMenu();
}

/* 菜单打开时按 1..9 直接选中对应模型——行右端写着的那个数字要是按不动，
   就只是一个装饰。监挂在 document 上、菜单一关就摘掉，避免和输入框抢键。 */
/* 菜单打开时按数字直接选。模型菜单和 Mode 菜单共用这一份——两者的区别只在
   属性名，复制一遍的话「菜单关掉要解绑」这个容易漏的收尾就会漏第二次。 */
function bindDigitShortcuts(menu: HTMLElement, attribute: 'modelKey' | 'permKey'): void {
  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!/^[1-9]$/.test(event.key)) return;
    const row = Array.from(menu.querySelectorAll<HTMLElement>('button'))
      .find(item => item.dataset[attribute] === event.key);
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    row.click();
  };
  const observer = new MutationObserver(() => {
    if (menu.hidden) {
      document.removeEventListener('keydown', onKey, true);
      observer.disconnect();
    }
  });
  observer.observe(menu, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('keydown', onKey, true);
}

/* 参考里的模型菜单只露固定几个：外面一排是「已固定」的席位（行尾写数字快捷键，
   当前那个写勾），其余全部收进 More models 子菜单，在子菜单里勾选决定谁占席位。
   勾满 MODEL_PIN_LIMIT 个以后要先取消一个才能勾下一个——席位是有上限的，
   否则子菜单里的每一行都会同时说「已勾选」和「不显示」，那是自相矛盾的状态。 */
const MODEL_PIN_LIMIT = 4;
const MODEL_PIN_STORAGE = 'mp:model-pins';
let modelMoreOpen = false;

type ModelMenuEntry = MagicPointerModelEntry & { key: string; provider: string };

function modelEntries(catalog: MagicPointerModelCatalog | null): ModelMenuEntry[] {
  const entries: ModelMenuEntry[] = [];
  for (const group of catalog?.groups || []) {
    for (const entry of group.models || []) {
      const profileId = entry.profileId || group.profileId;
      entries.push({ ...entry, profileId, provider: group.provider || group.name,
        key: profileId ? JSON.stringify([profileId, entry.id]) : entry.id });
    }
  }
  return entries;
}

let modelPinsCache: string[] | null = null;

function readModelPins(): string[] | null {
  try {
    const saved = localStorage.getItem(MODEL_PIN_STORAGE);
    if (saved === null) return modelPinsCache;
    const raw: unknown = JSON.parse(saved);
    return Array.isArray(raw) ? raw.map(id => typeof id === 'string' ? id : '') : null;
  } catch {
    return modelPinsCache;
  }
}

function writeModelPins(ids: string[]): void {
  modelPinsCache = [...ids];
  try {
    localStorage.setItem(MODEL_PIN_STORAGE, JSON.stringify(ids));
  } catch { /* 浏览器存储只读时，本次会话内仍然生效 */ }
}

/* 只在首次使用时给出四个默认项。空字符串保留用户腾出的席位，下一次
   勾选填回原位置；取消当前模型的固定不会改变 Runtime 的活动模型。 */
function resolveModelPins(catalog: MagicPointerModelCatalog | null): string[] {
  const entries = modelEntries(catalog);
  const known = new Set(entries.map(entry => entry.key));
  const saved = readModelPins();
  if (saved !== null) {
    const seen = new Set<string>();
    return Array.from({ length: MODEL_PIN_LIMIT }, (_, index) => {
      const raw = saved[index] || '';
      // Preferences written before provider-qualified catalogs used the id.
      const id = known.has(raw) ? raw : entries.find(entry => entry.id === raw
        && entry.profileId === catalog?.currentProfileId)?.key
        || entries.find(entry => entry.id === raw)?.key || '';
      if (!known.has(id) || seen.has(id)) return '';
      seen.add(id);
      return id;
    });
  }
  const pins: string[] = [];
  const current = entries.find(entry => entry.id === catalog?.current
    && (!catalog.currentProfileId || entry.profileId === catalog.currentProfileId))?.key || '';
  if (current && known.has(current) && !pins.includes(current)) {
    pins.unshift(current);
    pins.length = Math.min(pins.length, MODEL_PIN_LIMIT);
  }
  for (const entry of entries) {
    if (pins.length >= MODEL_PIN_LIMIT) break;
    if (!pins.includes(entry.key)) pins.push(entry.key);
  }
  if (entries.length) writeModelPins(pins);
  return pins;
}

function modelMenuDivider(): HTMLElement {
  const line = document.createElement('hr');
  line.className = 'dshw-model-divider';
  return line;
}

function modelMenuRow(id: string, _vision: boolean, index: number, selected: boolean): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'dshw-model-row' + (selected ? ' is-active' : '');
  row.setAttribute('role', 'option');
  row.dataset.modelId = id;
  const name = document.createElement('span');
  name.className = 'dshw-model-name';
  name.textContent = id;
  row.appendChild(name);
  row.setAttribute('aria-selected', String(selected));
  /* 参考里每行右端有一个数字，是**真的快捷键**（按 1 直接选中第一个）。
     只画数字不接键盘就成了骗人的提示，所以两边一起给：编号写进
     data-model-key，打开菜单时挂一次按键监听。
     当前那一行右端画勾、不画数字——勾和数字同时出现会挤成第三列。 */
  row.dataset.modelKey = String(index + 1);
  if (selected) row.appendChild(selectedCheck());
  else {
    const key = document.createElement('kbd');
    key.className = 'dshw-model-key';
    key.textContent = String(index + 1);
    row.appendChild(key);
  }
  return row;
}

function modelMoreRow(open: boolean): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'dshw-model-row dshw-model-more';
  row.dataset.modelMore = 'true';
  row.setAttribute('aria-expanded', String(open));
  const label = document.createElement('span');
  label.className = 'dshw-model-name';
  label.textContent = 'More models';
  row.appendChild(label);
  const chevron = document.createElement('span');
  chevron.className = 'dshw-model-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = (globalThis as unknown as { CdsIcons: { html(name: string, size: string): string } }).CdsIcons.html('chevron-section', 'small');
  row.appendChild(chevron);
  return row;
}

function modelSourceBadge(provider: string): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'dshw-model-source';
  badge.textContent = provider;
  badge.title = provider;
  return badge;
}

function modelMorePanel(entries: ModelMenuEntry[], pins: string[]): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'dshw-model-more-panel';
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', 'More models');
  for (const entry of entries) {
    const pinned = pins.includes(entry.key);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'dshw-model-pin-row';
    row.setAttribute('role', 'menuitemcheckbox');
    row.setAttribute('aria-checked', String(pinned));
    row.dataset.modelPin = entry.key;
    row.title = `${entry.id}${entry.provider ? ` · ${entry.provider}` : ''}${entry.contextWindow ? ` · ${entry.contextWindow.toLocaleString()} tokens` : ''}`;
    if (!pinned && pins.filter(Boolean).length >= MODEL_PIN_LIMIT) {
      row.setAttribute('aria-disabled', 'true');
    }
    const box = document.createElement('span');
    box.className = 'dshw-model-pin-box';
    box.setAttribute('aria-hidden', 'true');
    if (pinned) box.appendChild(checkGlyph());
    const name = document.createElement('span');
    name.className = 'dshw-model-name';
    const label = document.createElement('span');
    label.className = 'dshw-model-label';
    label.textContent = entry.id;
    name.append(label, modelSourceBadge(entry.provider));
    row.append(box, name);
    panel.appendChild(row);
  }
  return panel;
}

function modelMenuRows(catalog: MagicPointerModelCatalog | null): HTMLElement[] {
  if (!catalog) return [modelMenuNote('正在读取模型…')];
  const rows: HTMLElement[] = [];
  if (catalog.error) rows.push(modelMenuNote(catalog.error));
  const entries = modelEntries(catalog);
  if (!entries.length) return rows.length ? rows : [modelMenuNote('没有可用模型。')];
  const byKey = new Map(entries.map(entry => [entry.key, entry]));
  const pins = resolveModelPins(catalog);
  pins.forEach((key, index) => {
    const entry = byKey.get(key);
    if (!entry) return;
    const row = modelMenuRow(entry.id, Boolean(entry.vision), index, entry.id === catalog.current
      && (!catalog.currentProfileId || entry.profileId === catalog.currentProfileId));
    const name = row.querySelector('.dshw-model-name');
    const label = document.createElement('span');
    label.className = 'dshw-model-label';
    label.textContent = entry.id;
    name?.replaceChildren(label, modelSourceBadge(entry.provider));
    if (entry.profileId) row.dataset.modelProfileId = entry.profileId;
    row.title = `${entry.id}${entry.provider ? ` · ${entry.provider}` : ''}${entry.contextWindow ? ` · ${entry.contextWindow.toLocaleString()} tokens` : ''}`;
    rows.push(row);
  });
  rows.push(modelMenuDivider());
  rows.push(modelMoreRow(modelMoreOpen));
  if (modelMoreOpen) rows.push(modelMorePanel(entries, pins));
  if (modelMoreOpen) {
    const panel = rows[rows.length - 1];
    for (const group of catalog.groups || []) {
      if (group.error) panel.appendChild(modelMenuNote(`${group.name}：${group.error}`));
    }
  }
  return rows;
}

/* 子菜单默认开在菜单右侧；模型菜单贴着输入框右下角，右边往往不够，
   所以量一次视口再决定翻到左侧——开在屏幕外的菜单等于没开。 */
function renderModelMenu(): void {
  const menu = document.getElementById('composer-model-menu');
  if (!menu) return;
  const scrollTop = menu.querySelector('.dshw-model-more-panel')?.scrollTop || 0;
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.modelPin : undefined;
  menu.replaceChildren(...modelMenuRows(modelCatalog));
  positionAnchoredPopover('composer-model-menu', 'composer-model');
  positionModelMorePanel();
  const panel = menu.querySelector<HTMLElement>('.dshw-model-more-panel');
  if (panel) {
    panel.scrollTop = scrollTop;
    if (focused) Array.from(panel.querySelectorAll<HTMLElement>('[data-model-pin]'))
      .find(row => row.dataset.modelPin === focused)?.focus({ preventScroll: true });
  }
}

function positionModelMorePanel(): void {
  const menu = document.getElementById('composer-model-menu');
  const panel = menu?.querySelector<HTMLElement>('.dshw-model-more-panel');
  if (!menu || menu.hidden || !panel) return;
  const rect = menu.getBoundingClientRect();
  const margin = 8;
  const top = Math.max(margin, (document.getElementById('window-titlebar')?.getBoundingClientRect().bottom || 0) + margin);
  panel.style.maxHeight = `${Math.max(24, Math.min(216, window.innerHeight - top - margin))}px`;
  const right = rect.right + 4;
  const left = right + panel.offsetWidth <= window.innerWidth - margin
    ? right : rect.left - 4 - panel.offsetWidth;
  panel.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - margin - panel.offsetWidth))}px`;
  panel.style.top = `${Math.max(top, Math.min(rect.bottom - panel.offsetHeight, window.innerHeight - margin - panel.offsetHeight))}px`;
}

window.addEventListener('resize', () => {
  const menu = document.getElementById('composer-model-menu');
  if (menu && !menu.hidden) {
    positionAnchoredPopover('composer-model-menu', 'composer-model');
    positionModelMorePanel();
  }
});

function menuGlyph(name: string, size = 'small'): string {
  return (globalThis as { CdsIcons?: { html(name: string, size: string): string } }).CdsIcons?.html(name, size) || '';
}

function compactMenuItem(label: string, icon: string, action: () => void, trailing = ''): HTMLButtonElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'mp-compact-menu-row';
  row.setAttribute('role', 'menuitem');
  if (icon) {
    const glyph = document.createElement('span');
    glyph.className = 'mp-menu-icon';
    glyph.innerHTML = menuGlyph(icon);
    row.append(glyph);
  }
  const text = document.createElement('span');
  text.className = 'mp-compact-menu-label';
  text.textContent = label;
  row.append(text);
  if (trailing) {
    const key = document.createElement('kbd'); key.textContent = trailing; row.append(key);
  }
  row.addEventListener('click', (event) => { event.stopPropagation(); action(); });
  return row;
}

function openAccountSubmenu(kind: string) {
  const menu = document.getElementById('account-submenu');
  const trigger = document.querySelector<HTMLElement>(`[data-account-command="${kind}"]`);
  if (!menu || !trigger) return;
  const run = (command: string) => () => { void executeAccountCommand(command); };
  const rows = kind === 'language'
    ? [compactMenuItem('English', '', () => { document.documentElement.lang = 'en'; closeAccountMenu(); }, '✓')]
    : [compactMenuItem('About Magic Pointer', '', run('about')),
      compactMenuItem('Documentation', '', run('help')),
      compactMenuItem('Check for updates', '', run('updates')),
      compactMenuItem('Keyboard shortcuts', '', run('shortcuts'), 'Ctrl+/')];
  menu.replaceChildren(...rows);
  menu.hidden = false;
  const rect = trigger.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.right + 4, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(36, Math.min(rect.top, innerHeight - menu.offsetHeight - 8))}px`;
  document.querySelectorAll('[data-account-command][aria-haspopup]').forEach(row => row.setAttribute('aria-expanded', String(row === trigger)));
  rows[0].focus();
}

function openSettingsPage(page: string) {
  show('settings');
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-settings-page="${page}"]`)?.click());
}

function openAttachMenu() {
  closeSlashMenu();
  const menu = document.getElementById('composer-attach-menu');
  if (!menu) return;
  const action = (run: () => void) => () => { closeAnchoredPopover('composer-attach-menu', 'composer-add'); run(); };
  const entries = [
    { id: 'files', label: 'Add files or photos', icon: 'attach-file', key: 'Ctrl+U', run: () => { void executeWindowMenuCommand('add-files'); } },
    { id: 'folder', label: 'Add folder', icon: 'folder', run: () => { void openProjectFromPicker(); } },
    { id: 'slash', label: 'Slash commands', icon: 'attach-skills', run: () => { void openSlashMenu(); } },
    { id: 'connectors', label: 'Add connectors', icon: 'attach-connector', run: () => openSettingsPage('connectors') },
    { id: 'plugins', label: 'Add plugins', icon: 'attach-plugins', run: () => openSettingsPage('plugins') },
  ];
  menu.replaceChildren(...entries.map(entry => {
    const row = compactMenuItem(entry.label, entry.icon, action(entry.run), entry.key);
    row.dataset.attachCommand = entry.id;
    return row;
  }));
  positionAnchoredPopover('composer-attach-menu', 'composer-add');
  const trigger = document.getElementById('composer-add')!.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(trigger.left, innerWidth - menu.offsetWidth - 8))}px`;
  menu.querySelector<HTMLButtonElement>('button')?.focus();
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
    const target = e.target as Element | null;
    const menu = document.getElementById('composer-model-menu');
    const more = target?.closest<HTMLElement>('[data-model-more]');
    if (more) {
      e.stopPropagation();
      modelMoreOpen = !modelMoreOpen;
      renderModelMenu();
      return;
    }
    const pin = target?.closest<HTMLElement>('[data-model-pin]');
    if (pin) {
      e.stopPropagation();
      const id = pin.dataset.modelPin || '';
      const pins = resolveModelPins(modelCatalog);
      const index = pins.includes(id) ? pins.indexOf(id) : pins.indexOf('');
      if (index < 0) return;
      pins[index] = pins[index] === id ? '' : id;
      writeModelPins(pins);
      renderModelMenu();
      return;
    }
    const row = target?.closest<HTMLElement>('[data-model-id]');
    if (!row) return;
    e.stopPropagation();
    const modelId = row.dataset.modelId || '';
    const profileId = row.dataset.modelProfileId;
    if (modelId === modelCatalog?.current && profileId === modelCatalog?.currentProfileId) { closeModelMenu(); return; }
    ++modelCatalogRequest;
    closeModelMenu();
    const result = await Data.selectModel(modelId, profileId);
    if (!result?.ok) {
      if (menu) menu.replaceChildren(modelMenuNote(result?.error || '切换失败。'));
      positionAnchoredPopover('composer-model-menu', 'composer-model');
      return;
    }
    modelCatalog = { ...modelCatalog, current: modelId, currentProfileId: profileId };
    renderComposerModel();
  });
}
bindModelSeat();

interface PendingConversation {
  conversationId?: string;
  requestId: string;
  scope?: string;
  inputAccepted?: boolean;
  body: HTMLElement;
  records: Map<string, Record<string, unknown>>;
  renderer: MagicPointerLiveTurn;
  agentSessionId: string | null;
  streamText: string;
  reasoningText: string;
  transcript: ReturnType<typeof ConversationControl.createTranscript>;
  /** 运行中已产出的 token 数——只有进度记录真的带了才填，否则时间行只报时长。 */
  liveTokens: number | null;
}
let pendingConversation: PendingConversation | null = null;
let studioTaskInputSequence = 0;

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
  ConversationControl.appendTranscript(pendingConversation.transcript, record);
  /* session_ready：拿到 durable session id —— 停止/插话都指向它。 */
  const sid = ConversationControl.sessionIdFromRecord(record);
  if (sid) {
    pendingConversation.agentSessionId = sid;
    setComposerRunningState(true);
  }
  /* 进度记录带了 token 数就采纳，运行态那行因此能写成
     `1m 12s · 3.6k tokens · 第 2 轮推理中`；没带就只报时长，不编数字。 */
  const tokenFields = record.fields && typeof record.fields === 'object'
    ? record.fields as Record<string, unknown> : {};
  const reportedTokens = Number(tokenFields.total_tokens ?? tokenFields.tokens ?? tokenFields.output_tokens);
  if (Number.isFinite(reportedTokens) && reportedTokens > 0) {
    pendingConversation.liveTokens = reportedTokens;
  }
  if (String(record.phase || '') === 'model_usage') {
    const usage = latestContextUsage([{ liveProgress: pendingConversation.transcript }]);
    if (usage?.totalTokens !== undefined) pendingConversation.liveTokens = usage.totalTokens;
    return;
  }
  if (String(record.phase || '') === 'plan') {
    const snapshot = ConversationControl.planStepsFromRecord(record);
    if (snapshot) { composerPlan = PlanList.project([{ plan: snapshot }]); renderPlanCard(); }
  }
  if (String(record.phase || '') === 'subagent') {
    schedulePendingRender();
    return;
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
  schedulePendingRender();
}

let pendingRenderTimer: number | null = null;
function schedulePendingRender() {
  if (pendingRenderTimer !== null || !pendingConversation) return;
  const scheduled = pendingConversation;
  pendingRenderTimer = window.setTimeout(() => {
    pendingRenderTimer = null;
    if (pendingConversation !== scheduled) return;
    followIfNearBottom(scheduled.body, renderPendingBody);
    if (inspectorState.open && activeInspectorTab === 'tasks') renderProjectTasks();
  }, document.hidden ? 200 : 33);
}

function renderPendingBody() {
  const pending = pendingConversation;
  if (!pending) return;
  pending.renderer.update({ ...pending.transcript, records: [...pending.records.values()] });
  const plan = PlanList.project([{ liveProgress: pending.transcript }]);
  if (plan) { composerPlan = plan; renderPlanCard(); }
  pendingClockWrite?.();
}

function acceptComposerSuggestion(textarea: HTMLTextAreaElement): boolean {
  if (textarea.value || !composerSuggestion || studioComposerBusy
      || !document.getElementById('studio-home')?.hidden) return false;
  textarea.value = composerSuggestion;
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  clearComposerSuggestion();
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
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
/* 运行中计时：参考把「已经跑了多久」并进那一行状态里，而不是另起一行——
   星芒 + `12m 59s · 第 2 轮推理中`。计时槽是状态行里预留的空 span，这里按秒
   就地写文本；不重建节点，星芒的旋转动画因此不会每秒被打断一次。 */
let pendingClockTimer: number | null = null;
/** 当前计时器的写槽函数：状态行重建后由渲染循环立刻补一次，避免新行空一拍。 */
let pendingClockWrite: (() => void) | null = null;

function startPendingClock(body: HTMLElement) {
  stopPendingClock();
  const startedAt = Date.now();
  const tick = () => {
    const slot = body.querySelector<HTMLElement>('[data-turn-meta]');
    if (!slot) return;
    const elapsed = Date.now() - startedAt;
    const text = DshChat.formatRunMeta(elapsed, pendingConversation?.liveTokens ?? null);
    if (slot.textContent !== text) slot.textContent = text;
  };
  pendingClockWrite = tick;
  tick();
  pendingClockTimer = window.setInterval(tick, 1000);
}

function stopPendingClock() {
  if (pendingClockTimer !== null) {
    window.clearInterval(pendingClockTimer);
    pendingClockTimer = null;
  }
  pendingClockWrite = null;
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
  schedulePendingRender();
}

function appendLiveReasoningText(text: string) {
  const pending = pendingConversation;
  if (!pending || !text) return;
  pending.reasoningText += text;
  schedulePendingRender();
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
  if (running) form?.setAttribute('aria-busy', 'true');
  else form?.removeAttribute('aria-busy');
  if (running || form?.dataset.state === 'running') {
    form?.setAttribute('data-state', running ? 'running' : 'idle');
  }
  if (submit) {
    submit.classList.toggle('is-stop', running);
    submit.title = running ? 'Stop' : 'Send';
    submit.setAttribute('aria-label', running ? 'Stop' : 'Send');
    /* 空闲时是 Claude 自己的 send 字形（字体图标）。跑起来要换成方块停止键，
       而字体里没有对应的码位，所以只有运行态走自绘的 svg——两态外形差别够大，
       值得为它留一个例外。 */
    const hasStop = Boolean(submit.querySelector('use[href="#ic-stop"]'));
    if (running !== hasStop) {
      submit.replaceChildren();
      if (running) {
        const stop = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        stop.setAttribute('width', '20');
        stop.setAttribute('height', '20');
        stop.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', '#ic-stop');
        stop.appendChild(use);
        submit.appendChild(stop);
      } else {
        const api = globalThis as unknown as { CdsIcons?: { html?: (name: string, size?: string) => string } };
        const markup = typeof api.CdsIcons?.html === 'function' ? api.CdsIcons.html('code-send') : '';
        if (markup) submit.insertAdjacentHTML('afterbegin', markup);
      }
    }
  }
  /* 运行时右下角那个环跟着转：它是「还在动」，不是「用了多少」。 */
  document.getElementById('composer-context')?.setAttribute('data-state', running ? 'running' : 'idle');
  syncComposerSubmitState();
  if (!running) focusComposerWhenIdle();
}

async function stopActiveConversation() {
  const pending = pendingConversation || externalConversationRun;
  if (!studioComposerBusy || !pending || pending.body.dataset.stopRequested === 'true') return;
  pending.body.dataset.stopRequested = 'true';
  const note = document.createElement('div');
  note.className = 'dsh-turn-status';
  note.textContent = '正在停止…';
  pending.body.appendChild(note);
  const result = await ConversationControl.callConversationAction(
    () => Data.stopConversation(pending.requestId),
  );
  if (!result.ok && (pendingConversation === pending || externalConversationRun === pending)) {
    delete pending.body.dataset.stopRequested;
    note.textContent = result.error;
  }
}

Data.onConversationProgress((payload) => {
  if (!pendingConversation || payload.requestId !== pendingConversation.requestId || !payload.record) return;
  if (payload.conversationId) pendingConversation.conversationId = payload.conversationId;
  if (payload.record.phase === 'user_input_accepted') {
    pendingConversation.inputAccepted = true;
    pendingPermissionAsk = null; pendingAskInput = null;
    const host = document.getElementById('composer-permission-ask');
    if (host) DecisionCard.clear(host, true);
  }
  if (!pendingConversation.scope && payload.conversationId && Number.isInteger(payload.turnIndex)) {
    pendingConversation.scope = `${payload.conversationId}#${payload.turnIndex}`;
    pendingConversation.body.replaceChildren();
    pendingConversation.renderer = DshChat.createLiveTurn(pendingConversation.body, pendingConversation.scope, { taskPanel: true });
  }
  renderConversationProgress(payload.record);
});

/* 忙态插话：文本写入 durable inbox（next-step），下一轮模型请求即携带。
   界面立即给一条排队的用户气泡，不假装它已经影响本轮。 */
async function steerActiveConversation(question: string, textarea: HTMLTextAreaElement): Promise<void> {
  const pending = pendingConversation || externalConversationRun;
  const sessionId = pending?.agentSessionId || '';
  if (!sessionId) return; // runtime 还没就绪：保持输入，不打断用户。
  const attachmentPaths = [...composerAttachments];
  const inputId = `input:studio:${Date.now()}:${studioTaskInputSequence += 1}`;
  const taskInput = buildStudioTaskInput(question, inputId, sessionId, attachmentPaths);
  if (!taskInput || !TaskInputTransport?.createTaskInputTransport) return;
  const status = document.createElement('div');
  status.className = 'dsh-turn-status';
  status.textContent = '正在排队…';
  pending?.body.appendChild(status);
  const transport = TaskInputTransport.createTaskInputTransport({
    send: (value: MagicPointerTaskInput) => Data.steerConversation(
      sessionId,
      value,
      attachmentSourcesForTask(attachmentPaths, sessionId),
    ),
    onState: (state: { status?: string; error?: string }) => {
      if (state.status === 'queueing') status.textContent = '正在排队…';
      else if (state.status === 'accepted') status.textContent = '已接收，将在下一个安全边界生效。';
      else status.textContent = `插话未送达：${String(state.error || '未知原因')}`;
    },
  });
  await transport.submit(taskInput, {
    onAccepted: () => {
      if (pending !== pendingConversation && pending !== externalConversationRun) return;
      if (textarea.value.trim() === question) {
        textarea.value = '';
        fitComposer(textarea);
      }
      composerAttachments = [];
      composerSelectedSourceIds.clear();
      renderComposerAttachments();
      renderComposerMaterials();
      const flow = document.querySelector<HTMLElement>('#stream .dsh-flow');
      if (flow) {
        const node = DshChat.userNode(question);
        node.setAttribute('data-queued', 'true');
        flow.appendChild(node);
        flow.closest('.dshw-scrollbody')?.scrollTo({ top: 1_000_000 });
      }
    },
  });
}

/* 忙态下点发送钮 = 停止本回合：优雅取消优先（Receipt + 部分结果）。
   停止后 openConversation 会用会话里的最终状态重画。 */
document.getElementById('composer-form')?.querySelector('button[type="submit"]')?.addEventListener('click', (e) => {
  if (!studioComposerBusy || !(pendingConversation || externalConversationRun)) return;
  e.preventDefault();
  e.stopPropagation();
  void stopActiveConversation();
});

document.querySelectorAll('form.dshw-input-form').forEach(form => {
  const ta = form.querySelector<HTMLTextAreaElement>('textarea');
  if (ta) {
    fitComposer(ta);
    syncComposerSubmitState();
    ta.addEventListener('input', () => { fitComposer(ta); syncComposerSubmitState(); });
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
      if (e.key === 'Tab' && !e.shiftKey && !e.isComposing && acceptComposerSuggestion(ta)) {
        e.preventDefault();
        return;
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
    /* 发送这一下就要离开首页。等桥返回再离开的话，新建的对话被写进一个
       `hidden` 的 stream 里——用户盯着首页几十秒，以为消息丢了。对话界面
       在用户按下回车的那一刻就该出现。 */
    setStudioHomeVisible(false);
    let flow = stream.querySelector<HTMLElement>('.dsh-flow');
    if (!flow) {
      flow = document.createElement('div');
      flow.className = 'dsh-flow';
      stream.replaceChildren(...(stream.querySelector('.dshw-blank, .view-empty') ? [] : [...stream.children]), flow);
    }
    /* 回答权限门的那一下也不画用户气泡：用户点的是卡上的选项。 */
    if (pendingPermissionChoice && (pendingPermissionChoice.grant || pendingPermissionChoice.deny || pendingPermissionChoice.once)) {
      flow.appendChild(DshChat.permissionAnswerNode({
        decision: pendingPermissionChoice.deny ? 'deny' : pendingPermissionChoice.once ? 'once' : 'grant',
        rule: String(pendingPermissionChoice.deny || pendingPermissionChoice.once || pendingPermissionChoice.grant || ''),
      }));
    } else {
      flow.appendChild(DshChat.userNode(requestQuestion));
    }
    const pending = document.createElement('div');
    pending.className = 'dsh-assistant';
    const pendingBody = document.createElement('div');
    pendingBody.className = 'dsh-assistant-body';
    pendingBody.appendChild(DshChat.liveActivityNode({ phase: 'runtime_boot', fields: {} }));
    pending.appendChild(pendingBody);
    flow.appendChild(pending);
    stream.scrollTop = stream.scrollHeight;
    scheduleStreamRail();

    textarea.value = '';
    fitComposer(textarea);
    /* 建议已经被采纳成这一轮了，先撤掉；下一轮结束再问新的。 */
    clearComposerSuggestion();
    studioComposerBusy = true;
    form.setAttribute('aria-busy', 'true');
    setComposerRunningState(true);
    startPendingClock(pendingBody);
    const requestId = globalThis.crypto?.randomUUID?.() || `conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const taskInput = buildStudioTaskInput(
      question,
      `input:studio:${requestId}`,
      activeTaskContext?.taskId || 'studio-pending',
      attachmentPaths,
    );
    pendingConversation = { requestId, body: pendingBody, records: new Map(), renderer: DshChat.createLiveTurn(pendingBody, undefined, { taskPanel: true }), agentSessionId: activeTaskContext?.taskId || null, streamText: '', reasoningText: '', transcript: ConversationControl.createTranscript(), liveTokens: null };
    const submittedConversation = pendingConversation;
    const conversationId = activeConversationId;
    const hadPendingInput = Boolean(pendingPermissionAsk || pendingAskInput);
    const permissionChoice = pendingPermissionChoice || undefined;
    const permissionPreset = composerPreset;
    const effort = composerEffort;
    // The new message owns this run. Keep form drafts, but withdraw the old
    // question while preparation and delivery are in progress.
    syncConversationPendingInput([]);
    renderConversationProgress({ phase: 'runtime_boot', fields: {} });
    try {
      const workspaceRoot = await prepareComposerWorktree();
      const response = await Data.sendConversation(
        conversationId,
        question,
        permissionPreset,
        requestId,
        workspaceRoot,
        effort,
        permissionChoice,
        attachmentPaths,
        taskInput,
      );
      if (pendingConversation !== submittedConversation) {
        await renderSidebar();
        return;
      }
      pendingPermissionChoice = null;
      if (response?.conversationId) activeConversationId = String(response.conversationId);
      if (!response?.ok || !response.conversationId) {
        if (response?.conversationId) {
          await openConversation(String(response.conversationId));
          await renderSidebar();
        }
        throw new Error(response?.error || '这次没有答完。');
      }
      composerAttachments = [];
      composerSelectedSourceIds.clear();
      renderComposerAttachments();
      renderComposerMaterials();
      /* 命令结算的副作用：/permission 落芯片，/model 刷新目录标签 */
      const command = (response as { command?: { type?: string; preset?: string } }).command;
      if (command?.type === 'permission' && command.preset) {
        composerPreset = String(command.preset);
        renderPermissionChip();
      } else if (command?.type === 'model') {
        await refreshComposerModel();
        if (pendingConversation !== submittedConversation) return;
      } else if ((response as { plan?: unknown }).plan && typeof (response as { plan?: unknown }).plan === 'object') {
        composerPlan = PlanList.project([{ plan: (response as { plan: unknown }).plan }]);
        renderPlanCard();
      }
      /* 结构化提问回传：权限门（kind=permission）走三键授权语义；
         ask_user_question 的 options 走逐选项按钮。都长在 composer 上沿，
         点按钮即答，不需要打字。 */
      const awaiting = response as {
        awaitingUserInput?: boolean;
        pendingInput?: NonNullable<MagicPointerTurn['pendingInput']>;
        /* 见上面 pendingPermissionAsk：运行时的权限选项自带决定，位置即契约。 */
      };
      if (awaiting.awaitingUserInput && awaiting.pendingInput) syncConversationPendingInput([{ pendingInput: awaiting.pendingInput }]);
      await openConversation(String(response.conversationId));
      await renderSidebar();
      if (pendingConversation !== submittedConversation) return;
      setComposerSettledState(awaiting.awaitingUserInput ? 'idle' : 'success');
      /* 联想词在回合彻底结束之后才问——它读的是这一轮的最终结果，不是中间态。
         故意不 await：输入框不该等一个建议。 */
      if (!awaiting.awaitingUserInput) void refreshComposerSuggestion(activeConversationTurns, activeConversationObject);
    } catch (error) {
      if (pendingConversation !== submittedConversation) return;
      if (hadPendingInput && conversationId) {
        const durable = await Data.conversation(conversationId).catch(() => undefined);
        if (pendingConversation !== submittedConversation || activeConversationId !== conversationId) return;
        // A rejected send can leave the original question pending. Once a new
        // turn exists, a provider failure must not resurrect the older request.
        if (durable) syncConversationPendingInput(durable.turns || []);
      }
      pending.replaceChildren(DshChat.turnErrorNode(error instanceof Error ? error.message : String(error)));
      textarea.value = ConversationControl.failedDraftValue(textarea.value, question);
      fitComposer(textarea);
      setComposerSettledState('error');
    } finally {
      if (pendingConversation === submittedConversation) detachPendingConversation();
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
  void refreshComposerModel();
  await renderSidebar();
  if (initialView !== 'chat') {
    show(initialView);
    return;
  }
  if (shell.dataset.view !== 'chat') return;
  startNewChat();
}

/* 新对话：清空当前这一屏，把焦点交回输入框。
   不新建记录——记录在第一次真的问出去之后才产生。 */
function detachPendingConversation() {
  if (pendingRenderTimer !== null) window.clearTimeout(pendingRenderTimer);
  pendingRenderTimer = null;
  pendingConversation = null;
  externalConversationRun = null;
  studioComposerBusy = false;
  stopPendingClock();
  document.getElementById('composer-form')?.removeAttribute('aria-busy');
  setComposerRunningState(false);
}

function startNewChat() {
  conversationOpenGeneration += 1;
  detachPendingConversation();
  if (artifactEditor.state().artifactId) {
    artifactEditor.clear();
    renderArtifactEditor();
    if (activeInspectorTab === 'artifact') setInspector(false);
  }
  activeConversationId = null;
  activeConversationView = null;
  activeConversationRecord = null;
  activeConversationTurns = [];
  activeConversationObject = {};
  conversationRefreshSequence += 1;
  recoveryRenderGeneration += 1;
  const recovery = document.getElementById('conversation-recovery');
  if (recovery) { recovery.replaceChildren(); recovery.hidden = true; }
  pendingPermissionChoice = null;
  syncConversationPendingInput([]);
  composerPlan = null;
  renderPlanCard();
  clearComposerSuggestion();
  renderProjectTasks();
  setActiveTaskContext(null, true);
  composerAttachments = [];
  renderComposerAttachments();
  void refreshFigmaConnection();
  activeConversationTurnCount = 0;
  activeConversationTab = 'chat';
  renderProjectContext();
  setStudioHomeVisible(true);
  document.querySelectorAll('#side-convos .side-item').forEach((n) => n.classList.remove('is-on'));
  const title = document.getElementById('chat-title');
  if (title) title.textContent = 'New chat';
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
  renderUsageMeter([]);
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
// conversations:turn 在一条回答的流式期间会连着来（main 的 300ms 实时 flush
// 每个回合结束再来一次），而这一组刷新里 renderSidebar 与 renderStudioHome
// 各自都要一次整库的 IPC 往返、renderArtifacts(true) 还要整份 innerHTML 重建。
// 合并到一帧的尾部：同一个 rAF 窗口里收到 N 次通知，只重建一次列表。
let conversationChangeRaf: number | null = null;
Data.onChange((change) => {
  if (change?.id) conversationNotificationSequence += 1;
  void refreshOpenConversation(change);
  if (change?.liveProgress) return;
  if (conversationChangeRaf !== null) return;
  conversationChangeRaf = window.requestAnimationFrame(() => {
    conversationChangeRaf = null;
    renderSidebar();
    if (document.getElementById('studio-home')?.hidden === false) void renderStudioHome();
    renderArtifacts(true);
    void libraryUi.render(shell.dataset.view || 'chat');
    refreshStashSummaries();
  });
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
  if (payload?.conversationId) {
    const id = String(payload.conversationId);
    void openConversation(id).then(() => {
      if (activeConversationId === id && payload.artifactId) void openArtifactEditor(id, String(payload.artifactId));
    });
  }
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
