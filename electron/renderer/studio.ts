(function bootTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document.body.toggleAttribute('data-ds-dark-theme', dark);
})();

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
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function makeShot(seed: unknown) {
  const r = rng('shot' + String(seed));
  const h = Math.floor(r() * 360);
  const a = `hsl(${h} 26% 84%)`;
  const b = `hsl(${(h + 26) % 360} 20% 73%)`;
  const c = `hsl(${(h + 52) % 360} 16% 63%)`;
  return (
    `radial-gradient(72% 60% at ${20 + r() * 40}% ${16 + r() * 30}%, ${a}, transparent 68%),` +
    `radial-gradient(64% 56% at ${52 + r() * 34}% ${58 + r() * 30}%, ${c}, transparent 66%),` +
    `linear-gradient(${Math.floor(r() * 360)}deg, ${a}, ${b})`
  );
}

function icon(id: string, cls = '') {
  return `<svg class="${cls}"><use href="#${id}"/></svg>`;
}

function emptyStateMarkup(
  iconId: string,
  title: string,
  description: string,
  action?: {label: string; view: string},
) {
  return `<div class="mp-empty-state">
    <span class="mp-empty-icon" aria-hidden="true">${icon(iconId)}</span>
    <strong>${esc(title)}</strong>
    <p>${esc(description)}</p>
    ${action ? `<button type="button" data-goto="${esc(action.view)}">${esc(action.label)}</button>` : ''}
  </div>`;
}

const KIND_TAG: Record<string, string> = {
  灵感: 'tag-indigo',
  交接: 'tag-teal',
  凭证: 'tag-amber',
  素材: 'tag-teal',
  片段: 'tag-amber',
};

const STASH_KIND_LABEL_IDS: Record<string, string> = {
  灵感: 'stash.kind.inspiration',
  交接: 'stash.kind.handoff',
  凭证: 'stash.kind.credential',
  素材: 'stash.kind.material',
  片段: 'stash.kind.snippet',
};

function stashKindLabel(kind: string): string {
  const id = STASH_KIND_LABEL_IDS[kind];
  return id ? studioT(id) : kind;
}

const PAD = 24;
const GAP = 16;
const CLUSTER_GAP = 48;
const ROW_MAX = 420;

let stashKindFilter = '';
let stashQuery = '';

interface StashBurstNode {
  t: string;
  w?: number;
  h?: number;
  desc?: string;
  src?: string;
  text?: string;
  media?: string;
  summary?: string;
  id?: string;
  capturedAt?: number;
  originalArtifactPath?: string;
  sourceId?: string;
  sourceTimeMs?: number;
  userCategory?: string;
  locator?: Record<string, unknown> | null;
  imageW?: number;
  imageH?: number;
  x: number;
  y: number;
}
interface LaidBurst extends MagicPointerStashEntry {
  nodes: StashBurstNode[];
  w: number;
  h: number;
  cx?: number;
  cy?: number;
}

function layoutBurst(b: MagicPointerStashEntry): LaidBurst {
  let x = PAD;
  let y = PAD + 8;
  let rowH = 0;
  let w = 0;
  const placed: StashBurstNode[] = b.items.map(it => {
    const imageW =
      it.t === 'shot' ? Math.max(220, Math.min(300, Number(it.w) || 240)) : 240;
    const imageH =
      it.t === 'shot' ? Math.max(130, Math.min(210, Number(it.h) || 160)) : 0;
    const summaryHeight = it.summary ? 66 : 0;
    const iw = imageW;
    const ih = it.t === 'shot' ? imageH + 58 + summaryHeight : 104;
    if (x > PAD && x + iw > ROW_MAX) {
      x = PAD;
      y += rowH + GAP;
      rowH = 0;
    }
    const node = {...it, x, y, w: iw, h: ih, imageW, imageH};
    x += iw + GAP;
    rowH = Math.max(rowH, ih);
    w = Math.max(w, x - GAP + PAD);
    return node;
  });
  return {...b, nodes: placed, w, h: y + rowH + PAD};
}

function stashDayLabel(time: string): string {
  if (time === '今天' || time === 'Today') {
    return 'Today';
  }
  if (time === '昨天' || time === 'Yesterday') {
    return 'Yesterday';
  }
  const dated = /^([0-9]+)月([0-9]+)日$/.exec(time);
  if (dated) {
    return `${dated[1]}/${dated[2]}`;
  }
  if (/^[0-9]+\/[0-9]+$/.test(time)) {
    return time;
  }
  return 'Today';
}

async function renderStash(force = false) {
  const world = document.getElementById('canvas-world');
  if (!world || (world.childElementCount && !force)) {
    return;
  }

  const all =
    stashQuery || stashKindFilter
      ? await Data.searchStash(stashQuery, stashKindFilter)
      : await Data.stash();
  const bursts = stashKindFilter
    ? all.filter(b => b.kind === stashKindFilter)
    : all;
  document.getElementById('stash-count')!.textContent = studioTCount(
    'count.items',
    bursts.reduce((n, b) => n + b.items.length, 0),
  );
  if (!bursts.length) {
    world.innerHTML = stashKindFilter
      ? `<span class="canvas-empty">${studioT('canvas.empty_filtered')}</span>`
      : emptyStateMarkup(
          'ic-stash',
          studioT('canvas.empty_title'),
          studioT('canvas.empty_body'),
          {label: studioT('canvas.empty_action'), view: 'chat'},
        );
    renderStashList([], force);
    return;
  }
  const laid = bursts.map(layoutBurst);
  let cx = 60;
  let cy = 60;
  let colH = 0;
  let maxW = 0;
  laid.forEach(b => {
    if (cx > 60 && cx + b.w > 1560) {
      cx = 60;
      cy += colH + CLUSTER_GAP;
      colH = 0;
    }
    b.cx = cx;
    b.cy = cy;
    cx += b.w + CLUSTER_GAP;
    colH = Math.max(colH, b.h);
    maxW = Math.max(maxW, cx);
  });

  world.innerHTML = laid
    .map(b => {
      const nodes = b.nodes
        .map(n => {
          const body =
            n.t === 'shot'
              ? `<span class="node-shot" style="width:${n.imageW}px;height:${n.imageH}px;${n.src ? `background-image:url('file:///${cssUrl(n.src)}');background-size:cover;background-position:center` : `background-image:${makeShot(n.desc)}`}"></span>
           <span class="node-desc">${esc(n.desc)}</span>
           ${n.summary ? `<span class="node-summary">${esc(n.summary)}</span>` : ''}`
              : `<span class="node-note">${esc(n.text)}</span>`;
          return `<span class="node" data-stash-id="${esc(n.id || '')}" data-src="${esc(n.src || '')}" data-text="${esc(n.text || '')}" data-summary="${esc(n.summary || '')}" style="left:${(b.cx as number) + n.x}px;top:${(b.cy as number) + n.y}px;width:${n.w}px;height:${n.h}px">
        <span class="node-cap">${icon(b.icon)}${esc(b.time)}<span class="kind ${KIND_TAG[b.kind] || ''}">${esc(stashKindLabel(b.kind))}</span></span>
        ${body}
      </span>`;
        })
        .join('');
      return `<span class="cluster" style="left:${(b.cx as number) - PAD}px;top:${(b.cy as number) - 6}px;width:${b.w}px;height:${b.h}px">
        <span class="cluster-label">${icon('ic-stash')}${esc(b.title)} · ${b.items.length}</span>
      </span>${nodes}`;
    })
    .join('');

  world.dataset.width = String(maxW + 60);
  world.dataset.height = String(cy + colH + 60);
  renderStashList(laid, force);
  resetCanvas();
}

function renderStashList(laid: LaidBurst[], force = false) {
  const list = document.getElementById('stash-list');
  if (!list || (list.childElementCount && !force)) {
    return;
  }
  const byTime: Record<string, LaidBurst[]> = {};
  laid.forEach(b => {
    (byTime[stashDayLabel(b.time)] ||= []).push(b);
  });
  list.innerHTML = Object.entries(byTime)
    .map(
      ([day, bs]) =>
        `<div class="stash-day">${day}<em>· ${studioTCount(
          'count.items',
          bs.reduce((n, b) => n + b.items.length, 0),
        )}</em></div>` +
        bs
          .map(b =>
            b.items
              .map(
                it => `<div class="stash-row" data-stash-id="${esc(it.id || '')}" data-src="${esc(it.src || '')}" data-text="${esc(it.text || '')}">
        <span class="sq" style="${it.src && /\.(png|jpe?g|gif|webp|bmp)$/i.test(it.src) ? `background-image:url('file:///${cssUrl(it.src)}');background-size:cover;background-position:center` : `background-image:${it.t === 'shot' ? makeShot(it.desc) : 'none'}`}"></span>
        <span class="txt">${esc(it.desc || it.text)}</span>
        <span class="src">${esc(b.app)}</span>
        <span class="kind ${KIND_TAG[b.kind] || ''}">${esc(stashKindLabel(b.kind))}</span>
        <span class="t">${esc(b.time)}</span>
        <span class="stash-row-actions">
          <button type="button" data-stash-open="${esc(it.id || '')}">${studioT('stash.open_source')}</button>
          <button type="button" data-stash-category="${esc(it.id || '')}" data-category="${esc(it.userCategory || b.kind)}">${studioT('stash.category')}</button>
          <button type="button" data-stash-remove="${esc(it.id || '')}">${studioT('common.delete')}</button>
        </span>
      </div>`,
              )
              .join(''),
          )
          .join(''),
    )
    .join('');
}

let cam = {x: 0, y: 0, k: 1};
function applyCam() {
  const w = document.getElementById('canvas-world');
  if (!w) {
    return;
  }
  w.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`;
  const cv = document.getElementById('canvas');
  if (cv) {
    cv.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
  }
  if (cv) {
    cv.style.backgroundSize = `${22 * cam.k}px ${22 * cam.k}px`;
  }
  const zv = document.getElementById('zoom-val');
  if (zv) {
    zv.textContent = Math.round(cam.k * 100) + '%';
  }
}
function resetCanvas() {
  cam = {x: 54, y: 54, k: 1};
  applyCam();
}
function fitCanvas() {
  const cv = document.getElementById('canvas');
  const w = document.getElementById('canvas-world');
  if (!cv || !w) {
    return;
  }
  const ww = Number(w.dataset.width) || 1200;
  const wh = Number(w.dataset.height) || 800;
  const r = cv.getBoundingClientRect();
  cam.k = Math.max(0.62, Math.min(1, (r.width - 130) / ww));
  cam.x = Math.max(78, (r.width - ww * cam.k) / 2);
  cam.y = Math.max(20, (r.height - wh * cam.k) / 2);
  applyCam();
}
function bindCanvas() {
  const cv = document.getElementById('canvas');
  if (!cv || cv.dataset.bound) {
    return;
  }
  cv.dataset.bound = '1';
  let drag: {x: number; y: number} | null = null;
  cv.addEventListener('pointerdown', e => {
    const target = e.target as Element | null;
    if (target && target.closest('.canvas-rail, .canvas-zoom, .node')) {
      return;
    }
    drag = {x: e.clientX - cam.x, y: e.clientY - cam.y};
    cv.classList.add('is-panning');
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', e => {
    if (!drag) {
      return;
    }
    cam.x = e.clientX - drag.x;
    cam.y = e.clientY - drag.y;
    applyCam();
  });
  cv.addEventListener('pointerup', () => {
    drag = null;
    cv.classList.remove('is-panning');
  });
  cv.addEventListener(
    'wheel',
    e => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const k = Math.max(
        0.25,
        Math.min(2.4, cam.k * (e.deltaY < 0 ? 1.11 : 0.9)),
      );
      cam.x = mx - (mx - cam.x) * (k / cam.k);
      cam.y = my - (my - cam.y) * (k / cam.k);
      cam.k = k;
      applyCam();
    },
    {passive: false},
  );
  document.getElementById('canvas-fit')?.addEventListener('click', fitCanvas);
  document.getElementById('zoom-in')?.addEventListener('click', () => {
    cam.k = Math.min(2.4, cam.k * 1.2);
    applyCam();
  });
  document.getElementById('zoom-out')?.addEventListener('click', () => {
    cam.k = Math.max(0.25, cam.k / 1.2);
    applyCam();
  });
}

let sidebarQuery = '';
let sidebarRecentOnly = false;
let activeProjectRoot = '';
let activeProjectId: string | undefined;
let composerAdditionalFolders: string[] = [];
let composerModelSelection: MagicPointerModelSelection | undefined;
let projectEnvironment: MagicPointerProjectEnvironment | null = null;
let repositoryContextDismissedFor = '';
let repositoryContextRequest = 0;
try {
  activeProjectRoot = localStorage.getItem('mp:active-project-root') || '';
  activeProjectId = localStorage.getItem('mp:active-project-id') ?? undefined;
} catch {
  /* storage unavailable */
}

function normalizedProjectRoot(root: unknown): string {
  return String(root || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/$/, '')
    .toLocaleLowerCase();
}

function normalizedBrowserResourceKey(rawUrl: string): string {
  const raw = String(rawUrl || '').trim();
  try {
    const url = new URL(
      /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`,
    );
    url.username = '';
    url.password = '';
    return `browser:${url.toString()}`;
  } catch {
    return `browser:${raw}`;
  }
}

function setActiveProject(root: unknown, projectId?: string) {
  activeProjectRoot = String(root || '').trim();
  activeProjectId =
    projectId ?? ProjectScope.find(cachedProjects || [], activeProjectRoot)?.id;
  projectEnvironment = null;
  activeTerminalRelativeDirectory = '';
  try {
    if (activeProjectId !== undefined) {
      localStorage.setItem('mp:active-project-id', activeProjectId);
    } else {
      localStorage.removeItem('mp:active-project-id');
    }
    if (activeProjectRoot) {
      localStorage.setItem('mp:active-project-root', activeProjectRoot);
    } else {
      localStorage.removeItem('mp:active-project-root');
    }
  } catch {
    /* storage unavailable */
  }
  renderProjectContext();
  void warmProjects().then(renderProjectContext);
  if (activeProjectRoot) {
    void warmComposerEnvironment(activeProjectRoot);
  }
  renderTerminalPrompt();
  if (
    document.getElementById('project-inspector') &&
    shell?.dataset.inspector === 'open'
  ) {
    void refreshProjectInspector();
  }
}

interface ComposerWorktree {
  baseBranch?: string;
  path: string;
  branch: string;
  base: string;
  conversationId: string;
}

const COMPOSER_WORKTREE_STATE_KEY = 'mp:composer-worktrees:v2';
const composerWorktrees = new Map<string, ComposerWorktree>();
const composerWorktreeEnabledKeys = new Set<string>();
let newChatWorktreeId = `new-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

function composerWorktreeKey(base: unknown, conversationId: unknown): string {
  const normalized = normalizedProjectRoot(base);
  const identity = String(conversationId || '').trim();
  return `${normalized}\u0000${identity}`;
}

function currentComposerWorktreeId(): string {
  return activeConversationId || newChatWorktreeId;
}

function currentComposerWorktreeKey(): string {
  return composerWorktreeKey(activeProjectRoot, currentComposerWorktreeId());
}

function currentComposerWorktreeEnabled(): boolean {
  return composerWorktreeEnabledKeys.has(currentComposerWorktreeKey());
}

function loadComposerWorktreeState(): void {
  try {
    const raw = localStorage.getItem(COMPOSER_WORKTREE_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        records?: unknown;
        enabled?: unknown;
      };
      if (Array.isArray(parsed.records)) {
        for (const item of parsed.records) {
          const record = item as Partial<ComposerWorktree>;
          if (
            typeof record.path === 'string' &&
            typeof record.base === 'string' &&
            typeof record.branch === 'string' &&
            typeof record.conversationId === 'string' &&
            record.path &&
            record.base &&
            record.conversationId
          ) {
            composerWorktrees.set(
              composerWorktreeKey(record.base, record.conversationId),
              {
                path: record.path,
                branch: record.branch,
                base: record.base,
                conversationId: record.conversationId,
                baseBranch: record.baseBranch,
              },
            );
          }
        }
      }
      if (Array.isArray(parsed.enabled)) {
        for (const item of parsed.enabled) {
          if (typeof item === 'string' && item) {
            composerWorktreeEnabledKeys.add(item);
          }
        }
      }
      return;
    }
    // Do not resurrect the old single global record: it had no conversation
    // identity and could silently attach a new chat to an unrelated task.
  } catch {
    /* storage unavailable */
  }
}

function persistComposerWorktrees(): void {
  try {
    localStorage.setItem(
      COMPOSER_WORKTREE_STATE_KEY,
      JSON.stringify({
        records: [...composerWorktrees.values()].slice(-64),
        enabled: [...composerWorktreeEnabledKeys].slice(-64),
      }),
    );
  } catch {
    /* storage unavailable */
  }
}

loadComposerWorktreeState();

function renderComposerWorktree() {
  const button = document.getElementById(
    'composer-worktree',
  ) as HTMLButtonElement | null;
  if (!button) {
    return;
  }
  button.hidden = !activeProjectRoot || projectEnvironment?.isGit !== true;
  const enabled = currentComposerWorktreeEnabled();
  const record = composerWorktrees.get(currentComposerWorktreeKey());
  button.setAttribute('aria-checked', String(enabled));
  button.disabled = false;
  button.title = record
    ? `Worktree active · ${record.branch} · ${record.path}`
    : enabled
      ? 'The next send uses an isolated worktree for this conversation.'
      : 'Send this conversation from an isolated worktree.';
}

function failComposerWorktree(button: HTMLElement | null, message: string) {
  button?.setAttribute('data-error', 'true');
  if (button) {
    button.title = message;
  }
}

document
  .getElementById('composer-worktree')
  ?.addEventListener('click', event => {
    if (!activeProjectRoot) {
      return;
    }
    const key = currentComposerWorktreeKey();
    if (composerWorktreeEnabledKeys.has(key)) {
      composerWorktreeEnabledKeys.delete(key);
    } else {
      composerWorktreeEnabledKeys.add(key);
    }
    (event.currentTarget as HTMLElement).removeAttribute('data-error');
    persistComposerWorktrees();
    renderComposerWorktree();
  });

interface PreparedComposerWorkspace {
  projectRoot: string;
  projectId?: string;
  executionWorkspaceRoot: string;
  contextKey: string;
}

async function prepareComposerWorktree(): Promise<PreparedComposerWorkspace> {
  const base = activeProjectRoot;
  const projectId = activeProjectId;
  const contextKey = currentComposerWorktreeKey();
  const identity = currentComposerWorktreeId();
  if (!base) {
    return {
      projectRoot: base,
      projectId,
      executionWorkspaceRoot: base,
      contextKey,
    };
  }
  const isolated = currentComposerWorktreeEnabled();
  const branchSelection = composerBranchSelection;
  const requireCurrentSelection = (): void => {
    if (
      contextKey !== currentComposerWorktreeKey() ||
      projectId !== activeProjectId ||
      currentComposerWorktreeEnabled() !== isolated ||
      composerBranchSelection !== branchSelection
    ) {
      throw new Error(
        'Workspace selection changed. Send again from the selected workspace.',
      );
    }
  };
  await warmComposerEnvironment(base);
  requireCurrentSelection();
  const selectedBranch = currentComposerBranch();
  if (!isolated && !selectedBranch) {
    return {
      projectRoot: base,
      projectId,
      executionWorkspaceRoot: base,
      contextKey,
    };
  }
  const result = await Data.projectWorktree({
    action: isolated ? 'create' : 'checkout',
    projectRoot: base,
    conversationId: identity,
    baseBranch: selectedBranch,
    path: isolated ? composerWorktrees.get(contextKey)?.path : undefined,
    previousBranch: isolated
      ? composerWorktrees.get(contextKey)?.baseBranch ?? ''
      : undefined,
  });
  if (!result?.ok || !result.path) {
    const message = String(result?.error || studioT('worktree.create_failed'));
    failComposerWorktree(document.getElementById('composer-worktree'), message);
    throw new Error(message);
  }
  if (isolated) {
    const record: ComposerWorktree = {
      path: result.path,
      branch: result.branch || 'worktree',
      base,
      conversationId: identity,
      baseBranch: selectedBranch,
    };
    composerWorktrees.set(contextKey, record);
    persistComposerWorktrees();
  }
  requireCurrentSelection();
  return {
    projectRoot: base,
    executionWorkspaceRoot: result.path,
    projectId,
    contextKey,
  };
}

function adoptComposerWorktreeConversation(
  contextKey: string,
  projectRoot: string,
  conversationId: string,
): void {
  if (!conversationId) {
    return;
  }
  const record = composerWorktrees.get(contextKey);
  const nextKey = composerWorktreeKey(projectRoot, conversationId);
  if (record) {
    composerWorktrees.delete(contextKey);
    composerWorktrees.set(nextKey, {
      ...record,
      base: projectRoot,
      conversationId,
    });
  }
  if (composerWorktreeEnabledKeys.delete(contextKey)) {
    composerWorktreeEnabledKeys.add(nextKey);
  }
  persistComposerWorktrees();
}

const COMPOSER_BRANCH_STORAGE_KEY = 'mp:composer-branches:v1';
const composerBranches = new Map<string, string>();
let composerBranchSelection: string | undefined;
let branchMenuSearch = '';

function loadComposerBranches(): void {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(COMPOSER_BRANCH_STORAGE_KEY) || '{}',
    ) as Record<string, unknown>;
    for (const [root, branch] of Object.entries(parsed)) {
      if (root && typeof branch === 'string' && branch.trim()) {
        composerBranches.set(root, branch.trim());
      }
    }
  } catch {
    /* storage unavailable */
  }
}

function persistComposerBranches(): void {
  try {
    localStorage.setItem(
      COMPOSER_BRANCH_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(composerBranches)),
    );
  } catch {
    /* storage unavailable */
  }
}

loadComposerBranches();

function currentComposerBranch(): string {
  const key = normalizedProjectRoot(activeProjectRoot);
  return (
    composerBranchSelection ??
    composerBranches.get(key) ??
    (projectEnvironment?.root &&
    normalizedProjectRoot(projectEnvironment.root) === key
      ? projectEnvironment.branch
      : '') ??
    ''
  );
}

function renderComposerBranch(): void {
  const button = document.getElementById(
    'composer-branch',
  ) as HTMLButtonElement | null;
  const label = document.getElementById('composer-branch-label');
  if (!button || !label) {
    return;
  }
  const branch = currentComposerBranch();
  button.hidden = !activeProjectRoot || projectEnvironment?.isGit !== true;
  const group = document.getElementById('composer-git-context');
  if (group) {
    group.hidden = button.hidden;
  }
  label.textContent = branch || 'Current branch';
  button.title = branch
    ? `Current branch: ${branch}`
    : 'Use the current Git branch';
}

let composerEnvironmentRequest = 0;

async function warmComposerEnvironment(root: string): Promise<void> {
  const normalized = normalizedProjectRoot(root);
  if (!normalized || normalized !== normalizedProjectRoot(activeProjectRoot)) {
    return;
  }
  if (
    projectEnvironment?.ok &&
    normalizedProjectRoot(projectEnvironment.root) === normalized
  ) {
    renderComposerBranch();
    renderComposerWorktree();
    return;
  }
  const request = ++composerEnvironmentRequest;
  const response = await Data.projectEnvironment(root, activeConversationId);
  if (
    request !== composerEnvironmentRequest ||
    normalized !== normalizedProjectRoot(activeProjectRoot)
  ) {
    return;
  }
  if (response?.ok && response.root) {
    projectEnvironment = response;
    const stored = composerBranches.get(normalized);
    if (
      stored &&
      Array.isArray(response.branches) &&
      response.branches.length > 0 &&
      !response.branches.includes(stored)
    ) {
      composerBranches.delete(normalized);
      persistComposerBranches();
    }
    renderComposerBranch();
    renderComposerWorktree();
  }
}

async function loadComposerBranchesForProject(): Promise<string[]> {
  if (!activeProjectRoot) {
    return [];
  }
  const response =
    projectEnvironment?.ok &&
    normalizedProjectRoot(projectEnvironment.root) ===
      normalizedProjectRoot(activeProjectRoot)
      ? projectEnvironment
      : await Data.projectEnvironment(activeProjectRoot, activeConversationId);
  if (
    response?.ok &&
    response.root &&
    normalizedProjectRoot(response.root) ===
      normalizedProjectRoot(activeProjectRoot)
  ) {
    projectEnvironment = response;
    const key = normalizedProjectRoot(activeProjectRoot);
    const stored = composerBranches.get(key);
    if (
      stored &&
      Array.isArray(response.branches) &&
      response.branches.length > 0 &&
      !response.branches.includes(stored)
    ) {
      composerBranches.delete(key);
      persistComposerBranches();
    }
  }
  const branches = Array.isArray(response?.branches)
    ? response.branches
        .map(branch => String(branch || '').trim())
        .filter(Boolean)
    : [];
  const selected = currentComposerBranch();
  return [...new Set([selected, ...branches])];
}

function renderComposerBranchMenu(branches: string[]): void {
  const menu = document.getElementById('composer-branch-menu');
  if (!menu) {
    return;
  }
  const query = branchMenuSearch.trim().toLocaleLowerCase();
  const filtered = branches.filter(
    branch => !query || branch.toLocaleLowerCase().includes(query),
  );
  const search = document.createElement('label');
  search.className = 'mp-branch-menu-search';
  search.innerHTML = '<svg aria-hidden="true"><use href="#ic-search" /></svg>';
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Search branches…';
  input.value = branchMenuSearch;
  input.setAttribute('aria-label', 'Search branches');
  search.append(input);
  const list = document.createElement('div');
  list.className = 'mp-branch-menu-list';
  for (const branch of filtered) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'mp-branch-menu-row';
    row.setAttribute('role', 'menuitemradio');
    row.setAttribute(
      'aria-checked',
      String(branch === currentComposerBranch()),
    );
    const name = document.createElement('span');
    name.textContent = branch;
    row.append(name);
    if (branch === currentComposerBranch()) {
      const check = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'svg',
      );
      check.setAttribute('aria-hidden', 'true');
      check.innerHTML = '<use href="#ic-check" />';
      row.append(check);
    }
    row.addEventListener('click', () => {
      if (!activeProjectRoot) {
        return;
      }
      composerBranchSelection = branch;
      captureComposerDraft();
      renderComposerBranch();
      closeAnchoredPopover('composer-branch-menu', 'composer-branch');
    });
    list.append(row);
  }
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'mp-workspace-menu-section';
    empty.textContent = 'No matching branches';
    list.append(empty);
  }
  menu.replaceChildren(list, search);
  input.addEventListener('input', () => {
    branchMenuSearch = input.value;
    renderComposerBranchMenu(branches);
    const next = menu.querySelector<HTMLInputElement>('input');
    next?.focus();
    next?.setSelectionRange(next.value.length, next.value.length);
  });
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

async function openComposerBranchMenu(): Promise<void> {
  const menu = document.getElementById('composer-branch-menu');
  if (!menu || !activeProjectRoot) {
    return;
  }
  branchMenuSearch = '';
  const branches = await loadComposerBranchesForProject();
  renderComposerBranchMenu(branches);
  positionAnchoredPopover('composer-branch-menu', 'composer-branch');
}

document.getElementById('composer-branch')?.addEventListener('click', event => {
  event.stopPropagation();
  const button = event.currentTarget as HTMLButtonElement;
  const menu = document.getElementById('composer-branch-menu');
  if (!menu) {
    return;
  }
  if (!menu.hidden) {
    closeAnchoredPopover('composer-branch-menu', 'composer-branch');
    return;
  }
  button.setAttribute('aria-expanded', 'true');
  void openComposerBranchMenu();
});

document
  .getElementById('composer-context-folder-add')
  ?.addEventListener('click', () => {
    void addComposerFolder();
  });

async function addComposerFolder(): Promise<void> {
  if (!activeProjectRoot || studioComposerBusy) {
    return;
  }
  const owner = composerLocation();
  const root = activeProjectRoot;
  const picked = await Data.pickWorkspace();
  if (
    !windowNavigation.isCurrent(owner) ||
    activeProjectRoot !== root ||
    studioComposerBusy
  ) {
    return;
  }
  const folder = picked.path?.trim();
  if (!picked.ok || !folder) {
    const note = document.getElementById('composer-folder-error');
    if (note && picked.error) {
      note.textContent = picked.error;
      note.hidden = false;
    }
    return;
  }
  const key = normalizedProjectRoot(folder);
  if (
    key !== normalizedProjectRoot(root) &&
    !composerAdditionalFolders.some(
      value => normalizedProjectRoot(value) === key,
    )
  ) {
    composerAdditionalFolders.push(folder);
  }
  captureComposerDraft();
  renderComposerFolders();
}

function renderComposerFolders(): void {
  const host = document.getElementById('composer-additional-folders');
  const add = document.getElementById(
    'composer-context-folder-add',
  ) as HTMLButtonElement | null;
  if (!host || !add) {
    return;
  }
  add.hidden = !activeProjectRoot;
  const running =
    document.getElementById('composer-form')?.getAttribute('aria-busy') ===
    'true';
  add.disabled = running;
  document.getElementById('composer-folder-error')?.setAttribute('hidden', '');
  host.replaceChildren(
    ...composerAdditionalFolders.map(folder => {
      const pill = document.createElement('span');
      pill.className = 'mp-composer-additional-folder';
      pill.dataset.additionalFolder = folder;
      pill.title = folder;
      pill.innerHTML = icon('ic-folder');
      const label = document.createElement('span');
      const name = folder.split(/[\\/]/).filter(Boolean).at(-1) || folder;
      label.textContent = name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${name}`);
      remove.innerHTML = icon('ic-x');
      remove.disabled = running;
      remove.addEventListener('click', () => {
        composerAdditionalFolders = composerAdditionalFolders.filter(
          value => value !== folder,
        );
        captureComposerDraft();
        renderComposerFolders();
      });
      pill.append(label, remove);
      return pill;
    }),
  );
}

function renderProjectContext() {
  renderComposerWorktree();
  renderComposerBranch();
  renderComposerFolders();
  const headerLabel = document.getElementById('chat-project-label');
  const locationLabel = document.getElementById('header-location-label');
  const workspaceLabel = document.getElementById('composer-workspace-label');
  const contextRow = document.querySelector<HTMLElement>(
    '.mp-composer-context-row',
  );
  const repositoryRow = document.getElementById('composer-repository-context');
  const hasProject = Boolean(activeProjectRoot);
  const selectedProject = ProjectScope.find(
    cachedProjects || [],
    activeProjectId ?? activeProjectRoot,
  );
  const projectButton = document.getElementById('composer-project');
  const projectButtonLabel = document.getElementById('composer-project-label');
  if (projectButton) {
    projectButton.hidden = !selectedProject || Boolean(selectedProject.root);
  }
  if (projectButtonLabel) {
    projectButtonLabel.textContent = selectedProject?.name || '';
  }
  const homeVisible = !document.getElementById('studio-home')?.hidden;
  if (contextRow) {
    // Keep the runtime context visible in chat so the selected project and
    // worktree state are always inspectable and switchable.
    contextRow.hidden = false;
  }
  if (repositoryRow && (!hasProject || homeVisible || !activeConversationId)) {
    repositoryRow.hidden = true;
  }
  const designStatus = document.querySelector<HTMLElement>('.mp-design-live');
  if (designStatus) {
    designStatus.classList.toggle('is-offline', !hasProject);
    const text = designStatus.lastChild;
    if (text?.nodeType === Node.TEXT_NODE) {
      text.textContent = hasProject
        ? 'Project connected'
        : 'Waiting for a project';
    }
  }
  if (!headerLabel) {
    return;
  }
  if (!hasProject) {
    headerLabel.textContent = selectedProject?.name || 'Local';
    headerLabel.removeAttribute('title');
    if (locationLabel) {
      locationLabel.textContent = selectedProject?.name || 'Local';
    }
    if (workspaceLabel) {
      workspaceLabel.textContent = 'Select folder…';
    }
    return;
  }
  const parts = activeProjectRoot
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
  const projectName = parts[parts.length - 1] || activeProjectRoot;
  headerLabel.textContent = selectedProject?.name || projectName;
  headerLabel.title = activeProjectRoot;
  if (locationLabel) {
    locationLabel.textContent = projectName;
  }
  if (workspaceLabel) {
    workspaceLabel.textContent = projectName;
  }
}

function repositoryContextKey() {
  return `${activeConversationId || ''}\u0000${normalizedProjectRoot(activeProjectRoot)}`;
}

function applyRepositoryContextBar(
  response: MagicPointerProjectEnvironment | null,
) {
  const row = document.getElementById('composer-repository-context');
  const inspectorButton = document.getElementById('inspector-toggle');
  if (!row) {
    return;
  }
  const homeVisible = !document.getElementById('studio-home')?.hidden;
  const changes = Number(response?.changedFiles || 0);
  const ahead = Number(response?.ahead || 0);
  const hasReviewableChanges = changes > 0 || ahead > 0;
  const visible = Boolean(
    activeConversationId &&
    activeProjectRoot &&
    !homeVisible &&
    response?.ok &&
    response?.isGit &&
    hasReviewableChanges &&
    repositoryContextDismissedFor !== repositoryContextKey(),
  );
  row.hidden = !visible;
  inspectorButton?.toggleAttribute('data-has-changes', visible && changes > 0);
  if (!visible || !response) {
    return;
  }

  const projectName =
    activeProjectRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() ||
    'Project';
  const displayName = String(response.name || projectName);
  const repositoryName = document.getElementById('composer-repository-name');
  const branchName = document.getElementById('composer-branch-name');
  const added = document.getElementById('composer-diff-added');
  const deleted = document.getElementById('composer-diff-deleted');
  const createPr = document.getElementById(
    'composer-create-pr',
  ) as HTMLButtonElement | null;
  if (repositoryName) {
    repositoryName.textContent = displayName;
  }
  const headerProject = document.getElementById('chat-project-label');
  if (headerProject) {
    headerProject.textContent = displayName;
  }
  if (branchName) {
    branchName.textContent = String(response.branch || 'main');
  }
  if (added) {
    added.textContent = `+${Number(response.addedLines || 0).toLocaleString('en-US')}`;
  }
  if (deleted) {
    deleted.textContent = `−${Number(response.deletedLines || 0).toLocaleString('en-US')}`;
  }
  if (createPr) {
    createPr.disabled = !hasReviewableChanges;
    createPr.textContent = changes > 0 ? 'Review changes' : 'Open compare';
    createPr.title = response.pullRequestUrl
      ? 'Open the branch comparison'
      : 'Review changes before creating a pull request';
  }
}

async function renderRepositoryContextBar(force = false) {
  const request = ++repositoryContextRequest;
  if (
    !activeConversationId ||
    !activeProjectRoot ||
    !document.getElementById('studio-home')?.hidden
  ) {
    applyRepositoryContextBar(null);
    return;
  }
  if (!force && projectEnvironment?.root === activeProjectRoot) {
    applyRepositoryContextBar(projectEnvironment);
    return;
  }
  const response = await Data.projectEnvironment(
    activeProjectRoot,
    activeConversationId,
  );
  if (request !== repositoryContextRequest) {
    return;
  }
  projectEnvironment = response;
  applyRepositoryContextBar(response);
}
interface SidebarWorkspaceGroup {
  key: string;
  label: string;
  workspaceRoot: string;
  items: MagicPointerConversationSummary[];
}
interface SidebarGroupModule {
  groupConversations(
    rows: readonly MagicPointerConversationSummary[],
  ): Array<{
    key: string;
    label: string;
    items: MagicPointerConversationSummary[];
  }>;
  filterConversations(
    rows: readonly MagicPointerConversationSummary[],
    query: string,
  ): MagicPointerConversationSummary[];
  groupByWorkspace(
    rows: readonly MagicPointerConversationSummary[],
  ): SidebarWorkspaceGroup[];
}
const sidebarGroups = (globalThis as {SidebarGroups?: SidebarGroupModule})
  .SidebarGroups!;
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
      lastOutcome?: string;
      lastFailed?: boolean;
      lastPendingInputKind?: string;
      workspaceRoot?: string;
      archived?: boolean;
      pinned?: boolean;
      acknowledgedAt?: number;
    }>;
    onOpenConversation?: (id: string) => void;
    projects?: readonly MagicPointerProject[];
    onOpenProject?: (root: string) => void;
  }): void;
}
const studioHomeGlobals = (globalThis as {StudioHome?: StudioHomeModule})
  .StudioHome!;
interface StudioSearchItem {
  kind: 'conversation' | 'project' | 'command' | 'skill' | 'route';
  key: string;
  label: string;
  detail: string;
  target: Record<string, unknown>;
}
interface StudioSearchModule {
  buildStudioSearchIndex(sources: {
    conversations?: readonly MagicPointerConversationSummary[];
    projects?: readonly MagicPointerProject[];
    commands?: readonly MagicPointerSlashEntry[];
    skills?: readonly MagicPointerSlashEntry[];
    routes?: ReadonlyArray<{
      id: string;
      label: string;
      keywords: readonly string[];
    }>;
  }): StudioSearchItem[];
  searchStudioIndex(
    index: readonly StudioSearchItem[],
    query: unknown,
    limit?: number,
  ): StudioSearchItem[];
}
const studioSearchGlobals = (globalThis as {StudioSearch?: StudioSearchModule})
  .StudioSearch!;
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
    trigger: {left: number; right: number; top: number; bottom: number},
    popup: {width: number; height: number},
    viewport: {width: number; height: number},
  ): {left: number; top: number};
}
const effortLevels = (globalThis as {EffortLevels?: EffortLevelsModule})
  .EffortLevels!;
const popoverPosition = (
  globalThis as {PopoverPosition?: PopoverPositionModule}
).PopoverPosition!;
let effortParticleController: {
  setMax(value: boolean): void;
  dispose(): void;
} | null = null;

const STUDIO_POPOVERS = [
  ['composer-permission-menu', 'composer-permission'],
  ['composer-model-menu', 'composer-model'],
  ['composer-effort-menu', 'composer-effort'],
  ['composer-attach-menu', 'composer-add'],
  ['composer-workspace-menu', 'composer-workspace'],
  ['composer-branch-menu', 'composer-branch'],
  ['composer-usage-popover', 'composer-context'],
  ['account-menu', 'account-footer'],
] as const;

function closeAnchoredPopover(popupId: string, triggerId: string) {
  if (popupId === 'composer-effort-menu') {
    effortParticleController?.dispose();
    effortParticleController = null;
  }
  if (popupId === 'account-menu') {
    closeAccountSubmenu();
  }
  if (popupId === 'composer-usage-popover') {
    setUsageDetailsOpen(false);
  }
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
    if (popupId !== exceptPopupId) {
      closeAnchoredPopover(popupId, triggerId);
    }
  }
}

function positionAnchoredPopover(
  popupId: string,
  triggerId: string,
): HTMLElement | null {
  const popup = document.getElementById(popupId);
  const trigger = document.getElementById(triggerId);
  if (!popup || !trigger || !popoverPosition) {
    return null;
  }
  closeStudioPopovers(popupId);
  popup.style.visibility = 'hidden';
  popup.hidden = false;
  const triggerRect = trigger.getBoundingClientRect();
  const point = popoverPosition.placePopover(
    triggerRect,
    {width: popup.offsetWidth, height: popup.offsetHeight},
    {width: window.innerWidth, height: window.innerHeight},
  );
  popup.style.left = `${point.left}px`;
  popup.style.top = `${point.top}px`;
  popup.style.removeProperty('visibility');
  if (
    popupId === 'composer-permission-menu' ||
    popupId === 'composer-workspace-menu'
  ) {
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
  model?: string;
  modelUsage?: Record<string, number>;
  pendingInput?: MagicPointerDecisionRequest & {requestId: string};
  resumeRequired?: boolean;
  answerSaved?: boolean;
}
interface StudioSubagentsModule {
  activeSubagentParentCallId(
    records: ReadonlyArray<Record<string, unknown>>,
  ): string;
  projectSubagentTasks(
    turns: ReadonlyArray<Record<string, unknown>>,
    live?: ReadonlyArray<Partial<StudioSubagentTask>>,
  ): StudioSubagentTask[];
}
const studioSubagentGlobals = (
  globalThis as {StudioSubagents?: StudioSubagentsModule}
).StudioSubagents!;

interface StudioWorkflowPanelModule {
  groupWorkflowTasks: typeof import('./studio_workflow_panel')['groupWorkflowTasks'];
  isWorkflowStepTaskId: typeof import('./studio_workflow_panel')['isWorkflowStepTaskId'];
}
type WorkflowRunBlockView =
  import('./studio_workflow_panel').WorkflowRunBlock;
const studioWorkflowPanel = (
  globalThis as {StudioWorkflowPanel?: StudioWorkflowPanelModule}
).StudioWorkflowPanel!;

const STUDIO_SEARCH_ROUTES = [
  {id: 'chat', label: studioT('search.route.new_chat'), keywords: ['首页', '会话', 'new']},
  {id: 'design', label: 'Design', keywords: ['设计', '素材', '画布']},
  {
    id: 'settings',
    label: studioT('search.route.customize'),
    keywords: ['设置', '插件', '模型', '权限', 'Skills', 'MCP'],
  },
  {id: 'changes', label: studioT('search.route.changes'), keywords: ['Git', 'Review', '拉取请求']},
  {id: 'browser', label: studioT('search.route.browser'), keywords: ['站点', '网页', 'localhost']},
  {id: 'tasks', label: studioT('search.route.tasks'), keywords: ['已安排', '后台', '运行中']},
] as const;
let studioSearchIndex: StudioSearchItem[] = [];
let visibleSearchResults: StudioSearchItem[] = [];
let globalSearchActiveIndex = 0;

function conversationNode(
  c: {
    id?: string;
    title?: string;
    updatedAt?: number;
    hasPendingWork?: boolean;
    failed?: boolean;
    lastOutcome?: string;
    lastFailed?: boolean;
    lastPendingInputKind?: string;
    turns?: number | MagicPointerTurn[];
  },
  active?: string,
  pinnedIds: readonly string[] = [],
): HTMLElement {
  const row = document.createElement('button');
  row.className = 'side-item' + (c.id === active ? ' is-on' : '');
  row.dataset.open = String(c.id || '');
  row.type = 'button';
  const activity = ConversationState.derive(
    c,
    studioComposerBusy && c.id === activeConversationId,
  );
  const status =
    activity === 'awaiting'
      ? 'waiting'
      : activity === 'failed'
        ? 'error'
        : activity === 'idle' || activity === 'completed'
          ? ''
          : activity;
  const statusLabel = status ? ConversationState.label(activity) : '';
  row.title = String(c.title || studioT('convo.untitled'));
  if (status) {
    row.title = `${String(c.title || studioT('convo.untitled'))}\n${statusLabel}`;
    row.dataset.taskState = status;
    row.setAttribute(
      'aria-label',
      studioT('convo.row_title', {
        title: String(c.title || studioT('convo.untitled')),
        status: statusLabel,
      }),
    );
    if (c.hasPendingWork) {
      row.dataset.pendingWork = 'true';
    }
  }
  const title = document.createElement('span');
  title.className = 'side-title';
  title.textContent = String(c.title || studioT('convo.untitled'));
  if (studioLibraries.preferences.sidebar.metadata) {
    const metadata = document.createElement('span');
    metadata.className = 'side-metadata';
    metadata.textContent =
      statusLabel ||
      (c.updatedAt
        ? new Date(c.updatedAt).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
          })
        : '');
    title.append(metadata);
  }
  const actions = document.createElement('span');
  actions.className = 'side-actions';
  const unread = studioLibraries.sessionUnread({
    id: String(c.id || ''),
    updatedAt: c.updatedAt,
  });
  row.dataset.unread = String(unread);
  if (unread) {
    const mark = document.createElement('span');
    mark.className = 'side-unread';
    mark.setAttribute('role', 'status');
    mark.setAttribute('aria-label', studioT('convo.unread'));
    actions.append(mark);
  }
  const ellipsis = document.createElement('span');
  ellipsis.className = 'side-ellipsis';
  ellipsis.setAttribute('role', 'button');
  ellipsis.setAttribute('tabindex', '0');
  ellipsis.setAttribute('aria-label', studioT('convo.row_actions'));
  ellipsis.dataset.sessionMenu = String(c.id || '');
  ellipsis.innerHTML = icon('ic-ellipsis');
  actions.appendChild(ellipsis);
  actions.appendChild(buildSessionMenu(c, pinnedIds));
  row.append(title, actions);
  return row;
}

const deletingConversations = new Set<string>();

async function deleteConversationFromUi(id: string): Promise<void> {
  if (deletingConversations.has(id)) {
    return;
  }
  deletingConversations.add(id);
  document.getElementById('conversation-delete-error')?.remove();
  try {
    const result = await Data.deleteConversation(id);
    if (!result.ok) {
      throw new Error(
        result.error === 'conversation_active'
          ? studioT('chat.delete_active')
          : result.error === 'store_failed'
            ? studioT('chat.delete_failed')
            : result.error || studioT('chat.delete_failed'),
      );
    }
    if (activeConversationId === id) {
      startNewChat();
    }
    await renderSidebar();
  } catch (error) {
    const notice = document.createElement('div');
    notice.id = 'conversation-delete-error';
    notice.className = 'notice mp-conversation-delete-error';
    notice.setAttribute('role', 'alert');
    const message = document.createElement('span');
    message.textContent = error instanceof Error ? error.message : String(error);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.textContent = '×';
    close.setAttribute('aria-label', studioT('common.close'));
    notice.append(message, close);
    document.getElementById('conversation-delete-error')?.remove();
    document.body.append(notice);
  } finally {
    deletingConversations.delete(id);
  }
}

function buildSessionMenu(
  c: {
    id?: string;
    title?: string;
    projectId?: string;
    workspaceRoot?: string;
    updatedAt?: number;
  },
  pinnedIds: readonly string[] = [],
): HTMLElement {
  const id = String(c.id || '');
  const menu = document.createElement('span');
  menu.className = 'side-session-menu';
  menu.hidden = true;
  menu.dataset.forSession = id;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Session actions');
  const glyph = (
    globalThis as unknown as {
      CdsIcons: {html: (name: string, size?: string) => string};
    }
  ).CdsIcons.html;
  type MenuItem = {
    key?: string;
    danger?: boolean;
    submenu?: boolean;
  };
  const item = (name: string, label: string, options: MenuItem = {}) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className =
      'side-session-menu-item' + (options.danger ? ' is-danger' : '');
    row.dataset.sessionAction = name;
    row.setAttribute('role', 'menuitem');
    row.tabIndex = -1;
    row.innerHTML =
      `<span class="side-menu-label">${esc(label)}</span>` +
      (options.key
        ? `<kbd>${options.key}</kbd>`
        : options.submenu
          ? `<span class="side-menu-chevron" aria-hidden="true">${glyph('chevron-section', 'small')}</span>`
          : '');
    return row;
  };
  const divider = () => {
    const line = document.createElement('hr');
    return line;
  };
  const local = studioLibraries.sessionPreference(id);
  const close = (event: Event) => {
    event.stopPropagation();
    menu.hidden = true;
  };
  const run = (name: string) => (event: Event) => {
    close(event);
    if (name === 'pin') {
      studioLibraries.setSessionPreference(id, {
        pinned: !local.pinned,
        order: Date.now(),
      });
      void renderSidebar();
      return;
    }
    if (name === 'rename') {
      openRenameDialog(id, String(c.title || ''));
      return;
    }
    if (name === 'read') {
      studioLibraries.setSessionPreference(id, {
        seenAt: studioLibraries.sessionUnread({id, updatedAt: c.updatedAt})
          ? Math.max(Date.now(), Number(c.updatedAt || 0))
          : 0,
      });
      void renderSidebar();
      return;
    }
    if (name === 'fork') {
      void branchConversationFromUi(id);
      return;
    }
    if (name === 'archive') {
      studioLibraries.setSessionPreference(id, {archived: !local.archived});
      void renderSidebar();
      return;
    }
    if (name === 'up') {
      studioLibraries.movePinned(id, -1, pinnedIds);
      void renderSidebar();
      return;
    }
    if (name === 'down') {
      studioLibraries.movePinned(id, 1, pinnedIds);
      void renderSidebar();
      return;
    }
    if (name === 'delete') {
      void deleteConversationFromUi(id);
    }
  };
  const pin = item('pin', local.pinned ? 'Unpin' : 'Pin', {
    key: 'P',
  });
  pin.dataset.sessionPinned = String(local.pinned);
  pin.addEventListener('click', run('pin'));
  menu.append(pin);
  const read = item(
    'read',
    studioLibraries.sessionUnread({id, updatedAt: c.updatedAt})
      ? 'Mark as read'
      : 'Mark as unread',
    {key: 'U'},
  );
  read.addEventListener('click', run('read'));
  menu.append(read);
  const rename = item('rename', 'Rename', {key: 'R'});
  rename.addEventListener('click', run('rename'));
  menu.append(rename);
  const fork = item('fork', 'Fork', {key: 'F'});
  fork.disabled = branchingConversations.has(id);
  fork.addEventListener('click', run('fork'));
  menu.append(fork, divider());
  const project = item('project', 'Move to project', {submenu: true});
  project.setAttribute('aria-haspopup', 'menu');
  project.setAttribute('aria-expanded', 'false');
  project.addEventListener('click', event => {
    event.stopPropagation();
    closeGroupSubmenu?.();
    void openProjectAssignment(id, project);
  });
  if (!local.pinned) {
    const parent = item('group', 'Move to', {
      submenu: true,
    });
    parent.setAttribute('aria-haspopup', 'menu');
    parent.setAttribute('aria-expanded', 'false');
    const apply = (group: string | null) => {
      if (group === null) {
        void requestStudioText(
          studioT('prompt.group_name'),
          local.group || '',
          60,
        ).then(name => {
          if (name === null) {
            return;
          }
          studioLibraries.setSessionGroup(id, name);
          void renderSidebar();
        });
        return;
      }
      studioLibraries.setSessionGroup(id, group);
      void renderSidebar();
    };
    const show = (enter = false) =>
      openGroupSubmenu(
        parent,
        studioLibraries.sessionGroups(),
        local.group || '',
        apply,
        enter,
      );
    parent.addEventListener('mouseenter', () => {
      closeProjectAssignment?.();
      closeGroupSubmenu?.();
      show();
    });
    parent.addEventListener('click', event => {
      event.stopPropagation();
      closeProjectAssignment?.();
      show(true);
    });
    menu.append(parent);
  }
  menu.append(project);
  const archive = item('archive', local.archived ? 'Unarchive' : 'Archive', {
    key: 'A',
  });
  archive.addEventListener('click', run('archive'));
  menu.append(divider(), archive);
  if (local.pinned) {
    const index = pinnedIds.indexOf(id);
    const up = item('up', 'Move up');
    up.disabled = index <= 0;
    up.addEventListener('click', run('up'));
    const down = item('down', 'Move down');
    down.disabled = index < 0 || index >= pinnedIds.length - 1;
    down.addEventListener('click', run('down'));
    menu.append(up, down, divider());
  }
  const remove = item('delete', 'Delete', {
    key: 'D',
    danger: true,
  });
  remove.addEventListener('click', run('delete'));
  menu.append(remove);
  return menu;
}

let closeGroupSubmenu: (() => void) | null = null;
let groupSubmenuAnchor: HTMLElement | null = null;
function openGroupSubmenu(
  anchor: HTMLElement,
  groups: readonly string[],
  current: string,
  pick: (group: string | null) => void,
  focusFirst = false,
): void {
  closeGroupSubmenu?.();
  const glyph = (
    globalThis as unknown as {
      CdsIcons: {html: (name: string, size?: string) => string};
    }
  ).CdsIcons.html;
  const panel = document.createElement('div');
  panel.className = 'side-session-submenu is-floating';
  panel.setAttribute('role', 'menu');
  panel.setAttribute('aria-label', 'Move to');
  panel.innerHTML =
    groups
      .map(
        (group: string) =>
          `<button type="button" role="menuitemradio" tabindex="-1" aria-checked="${current === group}" data-session-group="${esc(group)}"><span>${esc(group)}</span>${current === group ? glyph('check') : ''}</button>`,
      )
      .join('') +
    `<button type="button" role="menuitem" tabindex="-1" data-session-group-new><span>New section…</span></button>`;
  document.body.append(panel);
  const rect = anchor.getBoundingClientRect();
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const left =
    rect.right + 4 + width <= window.innerWidth - 8
      ? rect.right + 4
      : Math.max(8, rect.left - width - 4);
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(Math.max(8, Math.min(rect.top - 4, window.innerHeight - height - 8)))}px`;
  let hideTimer: number | undefined;
  const close = () => {
    cancelClose();
    anchor.removeEventListener('mouseleave', scheduleClose);
    anchor.removeEventListener('focusout', scheduleClose);
    anchor.setAttribute('aria-expanded', 'false');
    panel.remove();
    if (closeGroupSubmenu === close) {
      closeGroupSubmenu = null;
      groupSubmenuAnchor = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    if (panel.contains(document.activeElement)) {
      return;
    }
    hideTimer = window.setTimeout(close, 180);
  };
  const cancelClose = () => {
    if (hideTimer !== undefined) {
      window.clearTimeout(hideTimer);
      hideTimer = undefined;
    }
  };
  anchor.addEventListener('mouseleave', scheduleClose);
  anchor.addEventListener('focusout', scheduleClose);
  panel.addEventListener('mouseenter', cancelClose);
  panel.addEventListener('mouseleave', scheduleClose);
  panel.addEventListener('focusin', cancelClose);
  panel.addEventListener('focusout', event => {
    if (!panel.contains(event.relatedTarget as Node | null)) {
      scheduleClose();
    }
  });
  panel.addEventListener('keydown', event => {
    if (
      event.isComposing || event.keyCode === 229 ||
      event.ctrlKey || event.metaKey || event.altKey
    ) {
      return;
    }
    if (event.key === 'Escape' || event.key === 'ArrowLeft' || event.key === 'Tab') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) {
        return;
      }
      const menu = anchor.closest<HTMLElement>('.side-session-menu');
      close();
      if (event.key === 'Tab' && menu) {
        menu.hidden = true;
      } else if (anchor.isConnected) {
        anchor.focus({preventScroll: true});
      }
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const rows = studioMenuItems(panel);
      const index = rows.indexOf(document.activeElement as HTMLButtonElement);
      let next: number;
      if (event.key === 'Home') {
        next = 0;
      } else if (event.key === 'End') {
        next = rows.length - 1;
      } else if (index < 0) {
        next = event.key === 'ArrowDown' ? 0 : rows.length - 1;
      } else {
        next = (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      rows[next]?.focus();
    }
  });
  panel.addEventListener('click', event => {
    event.stopPropagation();
    const target = (event.target as Element).closest<HTMLElement>(
      '[data-session-group], [data-session-group-new]',
    );
    if (!target) {
      return;
    }
    const value = target.dataset.sessionGroup;
    const menu = anchor.closest<HTMLElement>('.side-session-menu');
    close();
    if (menu) {
      menu.hidden = true;
    }
    pick(value === undefined ? null : String(value));
  });
  anchor.setAttribute('aria-expanded', 'true');
  groupSubmenuAnchor = anchor;
  closeGroupSubmenu = close;
  if (focusFirst) {
    enterStudioMenu(panel);
  }
}

function bindSessionMenuKeys(
  menu: HTMLElement,
  trigger: HTMLElement,
  owner: HTMLElement,
): void {
  const onKey = (event: KeyboardEvent) => {
    if (!menu.contains(event.target as Node)) {
      return;
    }
    if (
      event.isComposing || event.keyCode === 229 ||
      event.metaKey || event.ctrlKey || event.altKey
    ) {
      return;
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) {
        menu.hidden = true;
      }
      return;
    }
    if (event.key === 'ArrowRight') {
      const row = (event.target as Element).closest<HTMLElement>(
        '[data-session-action="group"], [data-session-action="project"]',
      );
      if (row) {
        event.preventDefault();
        event.stopImmediatePropagation();
        row.click();
      }
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const items = studioMenuItems(menu);
      const current = items.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
              items.length;
      event.preventDefault();
      event.stopPropagation();
      items[next]?.focus();
      return;
    }
    const key = event.key.toLocaleLowerCase();
    const name =
      key === 'p'
        ? 'pin'
        : key === 'u'
          ? 'read'
          : key === 'f'
            ? 'fork'
            : key === 'a'
              ? 'archive'
              : key === 'r'
                ? 'rename'
                : key === 'd'
                  ? 'delete'
                  : '';
    if (!name) {
      return;
    }
    const row = menu.querySelector<HTMLElement>(
      `[data-session-action="${name}"]`,
    );
    if (!row) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    row.click();
  };
  const observer = new MutationObserver(() => {
    if (menu.hidden) {
      if (groupSubmenuAnchor && menu.contains(groupSubmenuAnchor)) {
        closeGroupSubmenu?.();
      }
      document.removeEventListener('keydown', onKey, true);
      observer.disconnect();
      trigger.setAttribute('aria-expanded', 'false');
      if (owner.isConnected) {
        owner.append(menu);
      } else {
        menu.remove();
      }
      if (
        trigger.isConnected &&
        (document.activeElement === document.body ||
          menu.contains(document.activeElement))
      ) {
        trigger.focus({preventScroll: true});
      }
    }
  });
  observer.observe(menu, {attributes: true, attributeFilter: ['hidden']});
  document.addEventListener('keydown', onKey, true);
  enterStudioMenu(menu);
}

let projectAssignmentRequest = 0;
let closeProjectAssignment: (() => void) | null = null;
async function openProjectAssignment(id: string, anchor: HTMLElement) {
  const request = ++projectAssignmentRequest;
  closeProjectAssignment?.();
  const parentMenu = anchor.closest<HTMLElement>(
    '.side-session-menu, .mp-library-popover',
  );
  if (!anchor.isConnected || parentMenu?.hidden) {
    return;
  }
  const popover = document.createElement('div');
  popover.className = 'mp-library-popover mp-project-assignment';
  popover.tabIndex = -1;
  popover.setAttribute('role', 'menu');
  popover.setAttribute('aria-label', 'Change project');
  const glyph = (globalThis as any).CdsIcons.html;
  popover.innerHTML = `<label class="mp-library-search">${glyph('search')}<input type="search" data-project-search placeholder="Search projects" aria-label="Search projects" /></label><div class="mp-project-options"></div><button type="button" role="menuitem" tabindex="-1" data-project-picker>${glyph('attach')}<span>Start new project…</span></button><p class="mp-library-error" role="status"></p><button type="button" role="menuitem" tabindex="-1" data-project-retry hidden>${esc(studioT('common.retry'))}</button>`;
  document.body.append(popover);
  const position = () => {
    const bounds = (parentMenu || anchor).getBoundingClientRect();
    const anchorBounds = anchor.getBoundingClientRect();
    const width = popover.offsetWidth;
    const left = bounds.right + width + 4 <= window.innerWidth - 8
      ? bounds.right + 4
      : bounds.left - width - 4;
    popover.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
    popover.style.top = `${Math.max(8, Math.min(anchorBounds.top - 4, window.innerHeight - popover.offsetHeight - 8))}px`;
  };
  anchor.setAttribute('aria-expanded', 'true');
  const listeners = new AbortController();
  let closed = false;
  const close = () => {
    closed = true;
    popover.remove();
    anchor.setAttribute('aria-expanded', 'false');
    listeners.abort();
    observer.disconnect();
    if (closeProjectAssignment === close) {
      closeProjectAssignment = null;
    }
  };
  const observer = new MutationObserver(() => {
    if (parentMenu?.hidden) {
      close();
    }
  });
  if (parentMenu) {
    observer.observe(parentMenu, {attributes: true, attributeFilter: ['hidden']});
  }
  closeProjectAssignment = close;
  popover.focus({preventScroll: true});
  document.addEventListener(
    'pointerdown',
    event => {
      if (
        !popover.contains(event.target as Node) &&
        !parentMenu?.contains(event.target as Node)
      ) {
        close();
      }
    },
    {signal: listeners.signal},
  );
  popover.addEventListener(
    'keydown',
    event => {
      if (event.isComposing || event.keyCode === 229) {
        event.stopPropagation();
        return;
      }
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat) {
          return;
        }
        close();
        if (event.key === 'Tab' && parentMenu) {
          parentMenu.hidden = true;
        } else if (anchor.isConnected) {
          anchor.focus({preventScroll: true});
        }
        return;
      }
      const altGraph = event.getModifierState('AltGraph');
      if (event.metaKey || ((event.ctrlKey || event.altKey) && !altGraph)) {
        return;
      }
      if (loading || busy || search.disabled) {
        return;
      }
      const fromSearch = event.target === search;
      if (!fromSearch && event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        if (anchor.isConnected) {
          anchor.focus({preventScroll: true});
        }
        return;
      }
      const vertical = event.key === 'ArrowDown' || event.key === 'ArrowUp';
      if (
        vertical ||
        (!fromSearch && (event.key === 'Home' || event.key === 'End'))
      ) {
        const rows = studioMenuItems(popover);
        const index = rows.indexOf(document.activeElement as HTMLButtonElement);
        let next: number;
        if (
          event.key === 'Home' ||
          (fromSearch && event.key === 'ArrowDown')
        ) {
          next = 0;
        } else if (
          event.key === 'End' ||
          (fromSearch && event.key === 'ArrowUp')
        ) {
          next = rows.length - 1;
        } else {
          next = (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) %
            rows.length;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        rows[next]?.focus();
        return;
      }
      // Search owns caret movement and editing; result rows forward text to it.
      const textKey =
        (event.key.length === 1 && event.key !== ' ') ||
        event.key === 'Backspace' ||
        (event.key === 'Delete' && !event.shiftKey);
      if (!fromSearch && textKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        let start = search.selectionStart ?? search.value.length;
        let end = search.selectionEnd ?? search.value.length;
        if (start === end && event.key === 'Backspace') {
          const width = (search.value.codePointAt(start - 2) ?? 0) > 0xffff ? 2 : 1;
          start = Math.max(0, start - width);
        } else if (start === end && event.key === 'Delete') {
          const width = (search.value.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
          end = Math.min(search.value.length, end + width);
        }
        search.focus({preventScroll: true});
        search.setRangeText(
          event.key === 'Backspace' || event.key === 'Delete' ? '' : event.key,
          start,
          end,
          'end',
        );
        search.dispatchEvent(new Event('input', {bubbles: true}));
      } else if (fromSearch) {
        event.stopPropagation();
      }
    },
    {signal: listeners.signal},
  );
  const report = (reason: unknown) => {
    popover.querySelector('.mp-library-error')!.textContent =
      reason instanceof Error ? reason.message : String(reason);
  };
  const search = popover.querySelector<HTMLInputElement>('[data-project-search]')!;
  const options = popover.querySelector<HTMLElement>('.mp-project-options')!;
  const picker = popover.querySelector<HTMLButtonElement>('[data-project-picker]')!;
  const retry = popover.querySelector<HTMLButtonElement>('[data-project-retry]')!;
  let projects: MagicPointerProject[] = [];
  let conversation: Awaited<ReturnType<typeof Data.conversation>>;
  let loading = false;
  const renderOptions = () => {
    if (!conversation) {
      return;
    }
    options.innerHTML = studioLibraries.projectOptionsMarkup(
      projects,
      conversation.projectId ?? conversation.workspaceRoot ?? '',
      search.value,
    );
    for (const item of studioMenuItems(popover)) {
      item.tabIndex = -1;
    }
  };
  const load = async () => {
    if (closed || loading) {
      return;
    }
    loading = true;
    if (popover.contains(document.activeElement)) {
      popover.focus({preventScroll: true});
    }
    search.disabled = true;
    picker.disabled = true;
    retry.hidden = true;
    popover.setAttribute('aria-busy', 'true');
    popover.querySelector('.mp-library-error')!.textContent = '';
    options.innerHTML = `<p class="mp-library-note" role="status">${esc(studioT('common.loading'))}</p>`;
    position();
    try {
      const loaded = await Promise.all([Data.projects(), Data.conversation(id)]);
      if (closed || request !== projectAssignmentRequest) {
        return;
      }
      if (!anchor.isConnected || parentMenu?.hidden) {
        close();
        return;
      }
      const loadedConversation = loaded[1];
      if (!loadedConversation) {
        throw new Error(studioT('convo.not_found'));
      }
      projects = loaded[0];
      conversation = loadedConversation;
      search.disabled = false;
      picker.disabled = false;
      renderOptions();
      position();
      if (document.activeElement === popover || document.activeElement === anchor) {
        search.focus();
      }
    } catch (reason) {
      if (!closed) {
        options.innerHTML = '';
        report(reason);
        retry.hidden = false;
        position();
        if (document.activeElement === popover) {
          retry.focus({preventScroll: true});
        }
      }
    } finally {
      loading = false;
      popover.setAttribute('aria-busy', 'false');
    }
  };
  let busy = false;
  async function move(root: string) {
    if (closed || busy || loading || !conversation) {
      return;
    }
    busy = true;
    search.disabled = true;
    popover.querySelector('.mp-library-error')!.textContent = '';
    popover.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
      button.disabled = true;
    });
    try {
      const result = await Data.setConversationProject(id, root);
      if (!result.ok) {
        throw new Error(
          result.error === 'store_failed'
            ? studioT('convo.save_failed')
            : result.error || studioT('convo.save_failed'),
        );
      }
      if (activeConversationId === id) {
        setActiveProject(
          result.conversation?.workspaceRoot ||
            conversation?.workspaceRoot ||
            '',
          result.conversation?.projectId || '',
        );
      }
      close();
      if (parentMenu) {
        parentMenu.hidden = true;
      }
      await renderSidebar();
    } catch (reason) {
      if (closed) {
        return;
      }
      report(reason);
      busy = false;
      search.disabled = false;
      popover.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
        button.disabled = false;
      });
    }
  }
  popover.addEventListener('input', event => {
    const input = event.target as HTMLInputElement;
    if (!busy && conversation && input.matches('[data-project-search]')) {
      renderOptions();
    }
  });
  popover.addEventListener('click', event => {
    event.stopPropagation();
    const button = (event.target as Element).closest<HTMLElement>('button');
    if (button?.hasAttribute('data-project-retry')) {
      void load();
      return;
    }
    if (button?.hasAttribute('data-project-root')) {
      void move(String(button.dataset.projectRoot || ''));
    }
    if (!busy && !loading && conversation && button?.hasAttribute('data-project-picker')) {
      ProjectWorkspace.create(
        popover,
        Data,
        project => {
          void move(ProjectScope.key(project));
        },
        popover.querySelector<HTMLInputElement>('[data-project-search]')?.value,
      );
    }
  });
  await load();
}

function showStudioDialog(
  dialog: HTMLDialogElement,
  cancel = () => dialog.close(),
) {
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    cancel();
  });
  dialog.addEventListener('close', () => dialog.remove(), {once: true});
  document.body.append(dialog);
  dialog.showModal();
}

function requestStudioText(
  title: string,
  initial = '',
  maxLength = 32000,
): Promise<string | null> {
  return new Promise(resolve => {
    const overlay = document.createElement('dialog');
    overlay.className = 'mpw-perm-confirm';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    const card = document.createElement('div');
    card.className = 'mpw-perm-confirm-card';
    const label = document.createElement('b');
    label.textContent = title;
    const input = document.createElement('textarea');
    input.className = 'mpw-rename-input';
    input.value = initial;
    input.maxLength = maxLength;
    input.rows = maxLength > 200 ? 4 : 1;
    input.setAttribute('aria-label', title);
    const actions = document.createElement('div');
    actions.className = 'mpw-perm-confirm-actions';
    const finish = (value: string | null) => {
      overlay.close();
      resolve(value);
    };
    const cancel = document.createElement('button');
    cancel.textContent = studioT('common.cancel');
    cancel.addEventListener('click', () => finish(null));
    const save = document.createElement('button');
    save.className = 'is-primary';
    save.textContent = studioT('common.confirm');
    save.addEventListener('click', () => {
      if (input.value.trim()) {
        finish(input.value.trim());
      }
    });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        save.click();
      }
    });
    actions.append(cancel, save);
    card.append(label, input, actions);
    overlay.append(card);
    showStudioDialog(overlay, () => finish(null));
    input.focus();
  });
}

function openRenameDialog(id: string, currentTitle: string) {
  if (!id) {
    return;
  }
  const overlay = document.createElement('dialog');
  overlay.className = 'mpw-perm-confirm';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', studioT('convo.rename_title'));
  const card = document.createElement('div');
  card.className = 'mpw-perm-confirm-card';
  const titleEl = document.createElement('b');
  titleEl.textContent = studioT('convo.rename_title');
  const input = document.createElement('input');
  input.className = 'mpw-rename-input';
  input.value = currentTitle;
  input.maxLength = 60;
  const err = document.createElement('p');
  err.className = 'mpw-rename-error';
  err.hidden = true;
  const actionsEl = document.createElement('div');
  actionsEl.className = 'mpw-perm-confirm-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = studioT('common.cancel');
  cancel.addEventListener('click', () => overlay.close());
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'is-primary';
  save.textContent = studioT('common.save');
  const submit = async () => {
    const value = input.value.trim();
    if (!value) {
      err.textContent = studioT('convo.title_empty');
      err.hidden = false;
      return;
    }
    const response = await Data.renameConversation(id, value);
    if (!response?.ok) {
      err.textContent =
        response?.error === 'invalid_id_or_title'
          ? studioT('convo.title_invalid')
          : studioT('convo.rename_failed');
      err.hidden = false;
      return;
    }
    overlay.close();
    await renderSidebar();
    const head = document.getElementById('chat-title');
    if (head && activeConversationId === id) {
      head.textContent = response.title ?? value;
    }
  };
  save.addEventListener('click', () => void submit());
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void submit();
    }
  });
  actionsEl.append(cancel, save);
  card.append(titleEl, input, err, actionsEl);
  overlay.appendChild(card);
  showStudioDialog(overlay);
  input.focus();
  input.select();
}

(function bindSessionMenuDismiss() {
  document.addEventListener('click', e => {
    const target = e.target as HTMLElement | null;
    if (!target) {
      return;
    }
    const trigger = target.closest<HTMLElement>('[data-session-menu]');
    if (trigger) {
      e.stopPropagation();
      const host = document.querySelector<HTMLElement>(`.side-session-menu[data-for-session="${CSS.escape(trigger.dataset.sessionMenu || '')}"]`);
      if (host) {
        document
          .querySelectorAll('.side-session-menu:not([hidden])')
          .forEach(m => {
            if (m !== host) {
              (m as HTMLElement).hidden = true;
            }
          });
        host.hidden = !host.hidden;
        if (!host.hidden) {
          const owner = host.parentElement!;
          document.body.append(host);
          const bounds = trigger.getBoundingClientRect();
          host.style.position = 'fixed';
          host.style.left = `${Math.max(8, Math.min(bounds.right - host.offsetWidth, window.innerWidth - host.offsetWidth - 8))}px`;
          host.style.top = `${Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - host.offsetHeight - 8))}px`;
          trigger.setAttribute('aria-expanded', 'true');
          bindSessionMenuKeys(host, trigger, owner);
        }
      }
      return;
    }
    document.querySelectorAll('.side-session-menu:not([hidden])').forEach(m => {
      if (!target.closest('.side-session-menu, .mp-project-assignment')) {
        (m as HTMLElement).hidden = true;
      }
    });
    if (
      !target.closest(
        '.side-session-menu, .side-session-submenu.is-floating, .mp-project-assignment',
      )
    ) {
      closeGroupSubmenu?.();
    }
  });
})();

const EMPTY_SESSION_SOLIDS: ReadonlyArray<
  readonly [number, number, number, number]
> = [
  [90, 0, 20, 20],
  [90, 40, 20, 20],
  [70, 20, 20, 20],
  [110, 20, 20, 20],
];
const EMPTY_SESSION_CHECKERS: ReadonlyArray<
  readonly [number, number, number, number]
> = [
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
const EMPTY_SESSION_SPARSE: ReadonlyArray<
  readonly [number, number, number, number]
> = [
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
        if (include(row, column)) {
          path += `M${left + column} ${top + row}h1v1h-1z`;
        }
      }
    }
  }
  return path;
}

function emptySessionsPictogramPath() {
  if (cachedEmptySessionsPictogramPath) {
    return cachedEmptySessionsPictogramPath;
  }
  cachedEmptySessionsPictogramPath =
    EMPTY_SESSION_SOLIDS.map(
      ([left, top, width, height]) =>
        `M${left} ${top}h${width}v${height}h${-width}z`,
    ).join('') +
    pixelRegionPath(
      EMPTY_SESSION_CHECKERS,
      (row, column) => (row + column) % 2 === 0,
    ) +
    pixelRegionPath(
      EMPTY_SESSION_SPARSE,
      (row, column) => row % 2 === 0 && column % 2 === 0,
    );
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

let sidebarRenderGeneration = 0;

async function renderSidebar() {
  const host = document.getElementById('side-convos');
  if (!host) {
    return;
  }
  const generation = ++sidebarRenderGeneration;
  const [list, projects] = await Promise.all([
    Data.conversations(),
    Data.projects(),
  ]);
  if (generation !== sidebarRenderGeneration) {
    return;
  }
  cachedProjects = projects;
  if (activeProjectId === undefined && activeProjectRoot) {
    activeProjectId = ProjectScope.find(projects, activeProjectRoot)?.id;
  }
  const registeredRoots = new Set(
    projects.map(project => normalizedProjectRoot(project.root)),
  );
  if (
    activeProjectRoot &&
    !registeredRoots.has(normalizedProjectRoot(activeProjectRoot))
  ) {
    setActiveProject('');
  } else {
    renderProjectContext();
  }
  const active =
    host.querySelector('.is-on')?.getAttribute('data-open') ??
    activeConversationId ??
    undefined;
  const nodes: HTMLElement[] = [];
  let filtered = studioLibraries.sidebarRows(
    sidebarGroups.filterConversations(list, sidebarQuery),
  ) as MagicPointerConversationSummary[];
  if (sidebarRecentOnly) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    filtered = filtered.filter(
      conversation => Number(conversation.updatedAt) >= cutoff,
    );
  }
  const projectGroups = projects
    .filter(project => !project.archived)
    .sort((a, b) => Number(Boolean(b.starred)) - Number(Boolean(a.starred)))
    .map(project => ({
      key: ProjectScope.key(project),
      label: project.name,
      items: filtered.filter(conversation =>
        ProjectScope.contains(project, conversation),
      ),
    }))
    .filter(project => {
      if (!sidebarQuery.trim()) {
        return true;
      }
      return (
        project.label
          .toLocaleLowerCase()
          .includes(sidebarQuery.trim().toLocaleLowerCase()) ||
        project.items.length > 0
      );
    });
  const localConversations = filtered.filter(
    conversation => !ProjectScope.forConversation(projects, conversation),
  );
  const groups = [
    ...projectGroups,
    ...(localConversations.length
      ? [
          {
            key: '',
            label: 'Local',
            items: localConversations,
          },
        ]
      : []),
  ];
  const displayGroups = studioLibraries.sidebarSections(
    filtered,
    groups,
  ) as Array<{
    key: string;
    label: string;
    items: MagicPointerConversationSummary[];
    virtual?: boolean;
  }>;
  const browser = host.closest<HTMLElement>('.mpw-workspace-browser');
  browser?.classList.toggle('is-empty', displayGroups.length === 0);
  if (!displayGroups.length) {
    const empty = document.createElement('div');
    empty.className = 'side-empty';
    const label = document.createElement('span');
    label.className = 'side-empty-label';
    label.textContent = projects.length
      ? 'No matching sessions'
      : 'Sessions you start will show up here';
    empty.append(label);
    if (!projects.length) {
      empty.append(emptySessionsPictogram());
    }
    nodes.push(empty);
  }
  for (const group of displayGroups) {
    const project = document.createElement('section');
    project.className = 'mpw-project';
    const open = sidebarState.groupExpanded(group.key);
    project.classList.toggle(
      'is-active',
      group.key === (activeProjectId ?? activeProjectRoot),
    );
    project.dataset.open = String(open);
    project.dataset.workspace = group.key;
    const head = document.createElement('div');
    head.className = 'mpw-project-row';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'mpw-project-toggle';
    toggle.dataset.workspaceToggle = group.key;
    toggle.setAttribute('aria-expanded', String(open));
    const chevron = document.createElement('span');
    chevron.className = 'mpw-project-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = icon('ic-chev');
    const projectName = document.createElement('span');
    projectName.className = 'mpw-project-name';
    projectName.textContent = group.label;
    toggle.append(projectName, chevron);
    toggle.setAttribute(
      'aria-label',
      studioT('sidebar.group_summary', {
        name: group.label,
        count: String(group.items.length),
      }),
    );
    const actions = document.createElement('span');
    actions.className = 'mpw-project-actions';
    const tools = document.createElement('button');
    tools.type = 'button';
    tools.dataset.projectTools = group.key;
    tools.setAttribute('aria-label', studioT('sidebar.group_sort'));
    tools.title = studioT('sidebar.group_sort');
    tools.innerHTML = icon('ic-sliders');
    actions.append(tools);
    if (group.key && !group.virtual) {
      const add = document.createElement('button');
      add.type = 'button';
      add.dataset.projectNew = group.key;
      add.setAttribute('aria-label', 'New session');
      add.innerHTML = icon('ic-plus');
      actions.append(add);
    }
    head.append(toggle, actions);
    const sessions = document.createElement('div');
    sessions.className = 'mpw-project-sessions';
    const pinnedIds = group.key === '__pinned__'
      ? group.items.map(conversation => conversation.id)
      : [];
    for (const c of group.items) {
      const node = conversationNode(c, active, pinnedIds);
      sessions.appendChild(node);
    }
    project.append(head, sessions);
    nodes.push(project);
  }
  document.querySelectorAll<HTMLElement>('.side-session-menu:not([hidden])').forEach(menu => { menu.hidden = true; });
  host.replaceChildren(...nodes);
}

function renderUpdateCard(update: MagicPointerUpdateState) {
  const card = document.getElementById(
    'update-card',
  ) as HTMLButtonElement | null;
  const title = document.getElementById('update-card-title');
  const detail = document.getElementById('update-card-detail');
  if (!card || !title || !detail) {
    return;
  }
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
      note = update.version
        ? `v${String(update.version).replace(/^v/, '')}`
        : '';
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
  const browser = document.querySelector<HTMLElement>('.mpw-workspace-browser');
  const input = document.getElementById(
    'side-search',
  ) as HTMLInputElement | null;
  const toggle = document.getElementById('side-search-toggle');
  const clear = document.getElementById(
    'side-search-clear',
  ) as HTMLButtonElement | null;
  if (!browser || !input || !toggle || !clear) {
    return;
  }

  const setExpanded = (expanded: boolean) => {
    if (expanded) {
      browser.classList.add('is-searching');
    } else {
      browser.classList.remove('is-searching');
    }
    toggle.setAttribute('aria-expanded', String(expanded));
    if (expanded) {
      requestAnimationFrame(() => input.focus());
    }
  };
  const syncClear = () => {
    clear.hidden = input.value.length === 0;
  };

  toggle.addEventListener('click', () => setExpanded(true));
  clear.addEventListener('click', () => {
    input.value = '';
    sidebarQuery = '';
    syncClear();
    void renderSidebar();
  });
  input.addEventListener('input', () => {
    sidebarQuery = input.value;
    syncClear();
    void renderSidebar();
  });
  input.addEventListener('keydown', event => {
    if (event.key !== 'Escape') {
      return;
    }
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

/** Say why a project could not be opened. */
function setWorkspaceNote(message: string): void {
  const note = document.getElementById('workspace-note');
  if (!note) {
    return;
  }
  note.textContent = message;
  note.hidden = !message;
}

async function openProjectFromPicker(preserveProjectId?: string) {
  const picked = await Data.openProject();
  if (picked?.canceled) {
    return;
  }
  if (!picked?.ok || !picked.project?.root) {
    // This used to return silently. Choosing a folder that could not be opened
    // then looked exactly like the button being broken, which is how "I pick a
    // folder and nothing happens" was reported. Show the real reason instead of
    // blaming the folder: a broken bridge and a missing folder are not the same
    // failure and must not read the same.
    const code = picked?.error || '';
    setWorkspaceNote(
      code === 'unauthorized_project_sender'
        ? 'The studio window is in a bad state. Reopen it and try again.'
        : code === 'invalid_project_folder'
          ? 'That folder could not be opened: it may have been moved or deleted, or this account cannot read it.'
          : code || 'No folder was selected.',
    );
    return;
  }
  setWorkspaceNote('');
  invalidateProjectCache();
  await warmProjects();
  setActiveProject(picked.project.root, preserveProjectId ?? picked.project.id);
  startNewChat();
  await renderSidebar();
}

document.getElementById('workspace-add')?.addEventListener('click', () => {
  void openProjectFromPicker();
});

function workspaceMenuRow(
  className: string,
  label: string,
  onClick: () => void,
  options: {role?: string; selected?: boolean; title?: string} = {},
): HTMLButtonElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = className;
  row.setAttribute('role', options.role || 'menuitem');
  if (options.selected) {
    row.setAttribute('aria-checked', 'true');
  }
  if (options.title) {
    row.title = options.title;
  }
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

// The folder menu must open with no wait, so the list is kept warm and only
// refreshed when a project is actually added or opened.
let cachedProjects: MagicPointerProject[] | null = null;

function invalidateProjectCache(): void {
  cachedProjects = null;
}

async function warmProjects(): Promise<MagicPointerProject[]> {
  if (cachedProjects) {
    return cachedProjects;
  }
  cachedProjects = await Data.projects().catch(
    () => [] as MagicPointerProject[],
  );
  return cachedProjects;
}

async function openWorkspaceMenu() {
  const menu = document.getElementById('composer-workspace-menu');
  if (!menu) {
    return;
  }
  const availableProjects = await warmProjects();
  const selectedProject = ProjectScope.find(
    availableProjects,
    activeProjectId ?? activeProjectRoot,
  );
  const preservedProjectId =
    selectedProject && !selectedProject.root ? selectedProject.id : undefined;
  const projects = availableProjects.filter(
    project => !project.archived && project.root,
  );
  const rows: HTMLElement[] = [];
  const close = () => {
    closeAnchoredPopover('composer-workspace-menu', 'composer-workspace');
  };
  rows.push(
    workspaceMenuRow(
      'mp-workspace-menu-row',
      'No folder',
      () => {
        close();
        setActiveProject('');
        startNewChat();
      },
      {selected: !activeProjectRoot},
    ),
  );
  if (projects.length) {
    const divider = document.createElement('div');
    divider.className = 'mp-workspace-menu-divider';
    rows.push(divider);
    const label = document.createElement('div');
    label.className = 'mp-workspace-menu-section';
    label.textContent = 'Recent';
    rows.push(label);
    for (const project of projects.slice(0, 6)) {
      const root = String(project.root || '');
      if (!root) {
        continue;
      }
      const name = String(project.name || root);
      rows.push(
        workspaceMenuRow(
          'mp-workspace-menu-row',
          name || root,
          () => {
            close();
            setActiveProject(root, preservedProjectId ?? project.id);
            void startNewChat();
            void renderSidebar();
          },
          {
            selected:
              normalizedProjectRoot(root) ===
              normalizedProjectRoot(activeProjectRoot),
            title: root,
          },
        ),
      );
    }
  }
  const divider = document.createElement('div');
  divider.className = 'mp-workspace-menu-divider';
  rows.push(divider);
  rows.push(
    workspaceMenuRow('mp-workspace-menu-row', 'Open folder…', () => {
      close();
      invalidateProjectCache();
      void openProjectFromPicker(preservedProjectId);
    }),
  );
  menu.replaceChildren(...rows);
  positionAnchoredPopover('composer-workspace-menu', 'composer-workspace');
}

document
  .getElementById('composer-workspace')
  ?.addEventListener('click', event => {
    event.stopPropagation();
    const button = event.currentTarget as HTMLButtonElement;
    const menu = document.getElementById('composer-workspace-menu');
    if (!menu) {
      return;
    }
    if (!menu.hidden) {
      closeAnchoredPopover('composer-workspace-menu', 'composer-workspace');
      return;
    }
    button.setAttribute('aria-expanded', 'true');
    void openWorkspaceMenu();
  });

document.getElementById('composer-project')?.addEventListener('click', () => {
  if (activeProjectId) {
    libraryUi.openProject(activeProjectId);
  }
});
document
  .getElementById('workspace-filter')
  ?.addEventListener('click', event => {
    sidebarRecentOnly = !sidebarRecentOnly;
    const button = event.currentTarget as HTMLButtonElement;
    button.classList.toggle('is-on', sidebarRecentOnly);
    button.setAttribute('aria-pressed', String(sidebarRecentOnly));
    button.title = sidebarRecentOnly ? studioT('sidebar.recent_on') : studioT('sidebar.recent_off');
    void renderSidebar();
  });

function compactTokenCount(value: number): string {
  if (value < 1000) {
    return String(value);
  }
  if (value >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(2))}M`;
  }
  return `${Number((value / 1000).toFixed(1))}k`;
}

const RAIL_START_LABEL = 'Session start';

function railEntries(): Array<{label: string; target: HTMLElement | null}> {
  const stream = document.getElementById('stream');
  if (!stream) {
    return [];
  }
  const entries: Array<{label: string; target: HTMLElement | null}> = [
    {label: RAIL_START_LABEL, target: null},
  ];
  for (const message of Array.from(
    stream.querySelectorAll<HTMLElement>('.mp-chat-user'),
  )) {
    const text = (
      message.querySelector('.mp-chat-bubble')?.textContent || ''
    ).trim();
    entries.push({
      label: text.split('\n')[0].slice(0, 60) || studioT('common.untitled'),
      target: message,
    });
  }
  return entries.length > 1 ? entries : [];
}
function syncStreamRailActive() {
  const rail = document.getElementById('stream-rail');
  const stream = document.getElementById('stream');
  if (!rail || !stream) {
    return;
  }
  const anchors = Array.from(
    rail.querySelectorAll<HTMLElement>('.mpw-rail-mark'),
  );
  if (!anchors.length) {
    return;
  }
  const streamTop = stream.getBoundingClientRect().top;
  const cursor = stream.scrollTop + 24;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  anchors.forEach((mark, index) => {
    const target =
      mark.dataset.railIndex === '0'
        ? null
        : stream.querySelectorAll<HTMLElement>('.mp-chat-user')[index - 1];
    const offset = target
      ? target.getBoundingClientRect().top - streamTop + stream.scrollTop
      : 0;
    const distance = Math.abs(offset - cursor);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  anchors.forEach((mark, index) => {
    mark.setAttribute('data-active', index === best ? 'true' : 'false');
  });
}

function railScrollTo(index: number): void {
  const stream = document.getElementById('stream');
  if (!stream) {
    return;
  }
  const reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const behavior: ScrollBehavior = reduceMotion ? 'auto' : 'smooth';
  if (index === 0) {
    stream.scrollTo({top: 0, behavior});
    return;
  }
  const message =
    stream.querySelectorAll<HTMLElement>('.mp-chat-user')[index - 1];
  message?.scrollIntoView({block: 'start', behavior});
}

function renderStreamRail() {
  const rail = document.getElementById('stream-rail');
  const marks = document.getElementById('stream-rail-marks');
  const menu = document.getElementById('stream-rail-menu');
  if (!rail || !marks || !menu) {
    return;
  }
  const entries = railEntries();
  if (!entries.length || activeConversationTab !== 'chat') {
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
    mark.className = 'mpw-rail-mark';
    mark.dataset.railIndex = String(index);
    marks.appendChild(mark);

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'mpw-rail-row';
    row.dataset.railIndex = String(index);
    const dash = document.createElement('span');
    dash.className = 'mpw-rail-dash';
    dash.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'mpw-rail-label';
    label.textContent = entry.label;
    row.append(dash, label);
    row.setAttribute('aria-label', studioT('convo.jump_to', {label: entry.label}));
    row.addEventListener('click', () => railScrollTo(index));
    menu.appendChild(row);
  });
  syncStreamRailActive();
}

let streamRailTimer = 0;
function scheduleStreamRail(delay = 80) {
  if (streamRailTimer) {
    window.clearTimeout(streamRailTimer);
  }
  streamRailTimer = window.setTimeout(() => {
    streamRailTimer = 0;
    renderStreamRail();
  }, delay);
}

function quotedSelection(text: string): string {
  const lines = text
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');
  return `${lines}\n\n`;
}

(function bindSelectionActions() {
  const stream = document.getElementById('stream');
  if (!stream) {
    return;
  }
  const pill = document.createElement('div');
  pill.className = 'mpw-select-pill';
  pill.hidden = true;
  pill.setAttribute('role', 'toolbar');
  pill.setAttribute('aria-label', studioT('composer.selection_actions'));
  const side = document.createElement('button');
  side.type = 'button';
  side.textContent = 'Start a side chat';
  const reply = document.createElement('button');
  reply.type = 'button';
  reply.textContent = 'Reply';
  pill.append(side, reply);
  document.body.appendChild(pill);

  let selected = '';
  let selectionTurn: {conversationId: string; turnIndex: number} | null = null;

  const hide = () => {
    pill.hidden = true;
  };

  const update = () => {
    const selection = window.getSelection();
    const text = selection ? String(selection).trim() : '';
    if (
      !selection ||
      selection.isCollapsed ||
      !text ||
      selection.rangeCount === 0
    ) {
      hide();
      return;
    }
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const element =
      node.nodeType === 1 ? (node as Element) : node.parentElement;
    const message = element?.closest<HTMLElement>(
      '.mp-chat-user, .mp-chat-assistant',
    );
    if (!message || !stream.contains(message)) {
      hide();
      return;
    }
    const fork = message.querySelector<HTMLElement>(
      '[data-mp-chat-branch-conversation]',
    );
    const turnIndex = Number(fork?.getAttribute('data-mp-chat-branch-turn'));
    selectionTurn =
      fork && Number.isInteger(turnIndex)
        ? {
            conversationId:
              fork.getAttribute('data-mp-chat-branch-conversation') || '',
            turnIndex,
          }
        : null;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      hide();
      return;
    }
    selected = text.slice(0, 4000);
    pill.hidden = false;
    const width = pill.offsetWidth;
    const left = Math.max(
      12,
      Math.min(window.innerWidth - width - 12, rect.left),
    );
    const below = rect.bottom + 10;
    const top =
      below + pill.offsetHeight < window.innerHeight - 12
        ? below
        : rect.top - pill.offsetHeight - 10;
    pill.style.left = `${Math.round(left)}px`;
    pill.style.top = `${Math.round(Math.max(12, top))}px`;
  };

  side.addEventListener('mousedown', event => event.preventDefault());
  reply.addEventListener('mousedown', event => event.preventDefault());
  side.addEventListener('click', () => {
    const target = selectionTurn;
    hide();
    window.getSelection()?.removeAllRanges();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '#composer-form textarea',
    );
    if (textarea) {
      textarea.value = quotedSelection(selected);
      fitComposer(textarea);
      syncComposerSubmitState();
      textarea.focus();
    }
    if (target?.conversationId) {
      document.dispatchEvent(
        new CustomEvent('mp:branch-conversation', {detail: target}),
      );
    }
  });
  reply.addEventListener('click', () => {
    hide();
    window.getSelection()?.removeAllRanges();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '#composer-form textarea',
    );
    if (!textarea) {
      return;
    }
    const quoted = quotedSelection(selected);
    textarea.value = `${quoted}${textarea.value}`;
    fitComposer(textarea);
    syncComposerSubmitState();
    textarea.focus();
    textarea.setSelectionRange(quoted.length, quoted.length);
  });

  let timer = 0;
  document.addEventListener('selectionchange', () => {
    if (timer) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(() => {
      timer = 0;
      update();
    }, 90);
  });
  stream.addEventListener('scroll', hide, {passive: true});
  document.addEventListener('mousedown', event => {
    if (!pill.contains(event.target as Node)) {
      hide();
    }
  });
})();

(function bindStreamRail() {
  const stream = document.getElementById('stream');
  if (!stream) {
    return;
  }
  let ticking = false;
  stream.addEventListener(
    'scroll',
    () => {
      if (ticking) {
        return;
      }
      ticking = true;
      window.requestAnimationFrame(() => {
        ticking = false;
        syncStreamRailActive();
      });
    },
    {passive: true},
  );
})();

let composerQuota: MagicPointerQuotaReport | null = null;
let composerQuotaError = '';
let composerQuotaPending = false;
let usageMeterTurns: MagicPointerTurn[] = [];
let usageDetailsOpen = false;
let composerQuotaKey = '';
let composerQuotaRequestKey = '';

const COMPOSER_QUOTA_STORAGE_KEY = 'mp:composer-quota:v1';

interface StoredComposerQuota {
  entries?: Record<string, MagicPointerQuotaReport>;
  key?: string;
  report?: MagicPointerQuotaReport;
}

function readStoredComposerQuota(key: string): MagicPointerQuotaReport | null {
  try {
    const raw = localStorage.getItem(COMPOSER_QUOTA_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const stored = JSON.parse(raw) as Partial<StoredComposerQuota>;
    const candidate =
      stored.entries?.[key] || (stored.key === key ? stored.report : null);
    if (!candidate || typeof candidate !== 'object') {
      return null;
    }
    const rows = Array.isArray(candidate.rows)
      ? candidate.rows.filter(
          row => row && typeof row === 'object' && typeof row.id === 'string',
        )
      : [];
    return {
      adapter:
        typeof candidate.adapter === 'string' || candidate.adapter === null
          ? candidate.adapter
          : null,
      label: typeof candidate.label === 'string' ? candidate.label : '',
      rows: rows.map(row => ({
        id: typeof row.id === 'string' ? row.id : '',
        label: typeof row.label === 'string' ? row.label : '',
        value: typeof row.value === 'string' ? row.value : '',
        percent:
          typeof row.percent === 'number' && Number.isFinite(row.percent)
            ? row.percent
            : null,
        detail: typeof row.detail === 'string' ? row.detail : '',
      })),
      error: typeof candidate.error === 'string' ? candidate.error : '',
      source: typeof candidate.source === 'string' ? candidate.source : '',
      fetchedAt:
        typeof candidate.fetchedAt === 'number' &&
        Number.isFinite(candidate.fetchedAt)
          ? candidate.fetchedAt
          : 0,
    };
  } catch {
    return null;
  }
}

function storeComposerQuota(
  key: string,
  report: MagicPointerQuotaReport,
): void {
  try {
    let entries: Record<string, MagicPointerQuotaReport> = {};
    const raw = localStorage.getItem(COMPOSER_QUOTA_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredComposerQuota;
      if (parsed.entries && typeof parsed.entries === 'object') {
        entries = parsed.entries;
      } else if (parsed.key && parsed.report) {
        entries[parsed.key] = parsed.report;
      }
    }
    entries[key] = {
      adapter: report.adapter,
      label: report.label,
      rows: report.rows,
      error: report.error,
      source: report.source,
      fetchedAt: report.fetchedAt,
    };
    const stored: StoredComposerQuota = {entries};
    localStorage.setItem(COMPOSER_QUOTA_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* A read-only browser store must not block the usage meter. */
  }
}

function syncComposerQuotaIdentity(): string {
  const catalog = activeComposerModelCatalog();
  const key = [catalog?.currentProfileId || '', catalog?.provider || ''].join(
    ':',
  );
  if (composerQuotaKey !== key) {
    // Never carry an in-memory balance across profiles or providers. A
    // matching persisted report is safe to paint while the fresh request runs.
    composerQuota = readStoredComposerQuota(key);
    composerQuotaPending = false;
    composerQuotaRequestKey = '';
    composerQuotaError = '';
    composerQuotaKey = key;
  }
  return key;
}

function ensureComposerQuota(force = false) {
  const key = syncComposerQuotaIdentity();
  if (
    composerQuotaRequestKey === key ||
    (!force && composerQuota && Date.now() - composerQuota.fetchedAt < 60_000)
  ) {
    return;
  }
  composerQuotaPending = true;
  composerQuotaRequestKey = key;
  void Data.modelQuota({
    force,
    selection: currentComposerModelSelection(),
  }).then(result => {
    if (composerQuotaRequestKey !== key) {
      return;
    }
    composerQuotaRequestKey = '';
    composerQuotaPending = false;
    if (key !== syncComposerQuotaIdentity()) {
      return;
    }
    composerQuotaError = result.error || '';
    if (result.report) {
      composerQuota = result.report;
      composerQuotaError = result.report.error || composerQuotaError;
      storeComposerQuota(key, result.report);
    }
    renderUsageMeter(usageMeterTurns);
    if (result.report?.stale && !force) {
      ensureComposerQuota(true);
    }
  });
}

const USAGE_CATEGORIES = [
  {kind: 'cache-read', label: 'Cache read'},
  {kind: 'cache-write', label: 'Cache write'},
  {kind: 'input', label: 'Input'},
  {kind: 'output', label: 'Output'},
] as const;

interface UsageCategoryRow {
  kind: string;
  label: string;
  value: number;
}

function usageCategoryRows(
  usage: MagicPointerModelUsage | undefined,
): UsageCategoryRow[] {
  if (!usage || typeof usage !== 'object') {
    return [];
  }
  const read = (key: string): number | undefined => {
    const value = usage[key];
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;
  };
  const cacheRead = read('cacheReadTokens');
  const cacheWrite = read('cacheWriteTokens');
  const input = read('inputTokens');
  const output = read('outputTokens');
  const fresh =
    input === undefined
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
      rows.push({kind: category.kind, label: category.label, value});
    }
  }
  return rows;
}

function usageSegmentShare(value: number, contextWindow: number): string {
  if (!(contextWindow > 0) || !(value > 0)) {
    return '0%';
  }
  return `${Math.max(0, Math.min(100, (value / contextWindow) * 100))}%`;
}

function contextCategoryRows(
  usage: MagicPointerModelUsage | undefined,
): Array<{kind: string; label: string; value: number}> {
  if (!usage?.contextTokens) {
    return [];
  }
  const estimates = [
    {
      kind: 'system',
      label: usageText('usage.system_prompt'),
      value: usage.systemTokensEstimate || 0,
    },
    {
      kind: 'tools',
      label: usageText('usage.tool_definitions'),
      value: usage.toolSchemaTokensEstimate || 0,
    },
    {
      kind: 'messages',
      label: usageText('usage.messages'),
      value: usage.messageTokensEstimate || 0,
    },
    {
      kind: 'results',
      label: usageText('usage.tool_results'),
      value: usage.toolResultTokensEstimate || 0,
    },
  ].filter(row => row.value > 0);
  const sum = estimates.reduce((total, row) => total + row.value, 0);
  if (sum === 0) {
    return [{kind: 'input', label: usageText('usage.request_input'), value: usage.contextTokens}];
  }
  return estimates.map(row => ({
    ...row,
    value: (row.value / sum) * usage.contextTokens!,
  }));
}

/* Slice-local label lookup: snippet tests evaluate contextCategoryRows
 * without the locale script and never assert labels. */
function usageText(
  id: string,
  params?: Record<string, string | number>,
): string {
  return typeof studioT === 'function' ? studioT(id, params) : id;
}

function latestContextUsage(
  turns: MagicPointerTurn[],
): MagicPointerModelUsage | undefined {
  for (const turn of [...turns].reverse()) {
    const records = turn.liveProgress?.trajectory || turn.trajectory || [];
    const current = [...records]
      .reverse()
      .find(
        record =>
          record.kind === 'message' &&
          typeof (record.modelUsage as MagicPointerModelUsage)
            ?.contextTokens === 'number',
      )?.modelUsage as MagicPointerModelUsage | undefined;
    if (current) {
      return current;
    }
    if (typeof turn.modelUsage?.contextTokens === 'number') {
      return turn.modelUsage;
    }
    if (turn.modelUsage) {
      return undefined;
    }
  }
  return undefined;
}

function positionUsageBreakdown() {
  const main = document.getElementById('composer-usage-popover');
  const detail = document.getElementById('composer-usage-breakdown');
  if (!main || main.hidden || !detail || detail.hidden) {
    return;
  }
  const rect = main.getBoundingClientRect();
  const gap = 8;
  detail.style.width = `${Math.min(320, Math.max(120, rect.left - gap - 12))}px`;
  detail.style.left = `${Math.max(12, rect.left - detail.offsetWidth - gap)}px`;
  detail.style.top = `${Math.max(12, Math.min(rect.top, window.innerHeight - detail.offsetHeight - 12))}px`;
}

function setUsageDetailsOpen(open: boolean) {
  usageDetailsOpen = open;
  const detail = document.getElementById('composer-usage-breakdown');
  if (detail) {
    detail.hidden = !open;
  }
  document
    .querySelectorAll(
      '#composer-usage-popover [aria-controls="composer-usage-breakdown"]',
    )
    .forEach(node => node.setAttribute('aria-expanded', String(open)));
  if (open) {
    positionUsageBreakdown();
  }
}

function renderUsageMeter(turns: MagicPointerTurn[]) {
  usageMeterTurns = turns;
  const button = document.getElementById(
    'composer-context',
  ) as HTMLButtonElement | null;
  const label = document.getElementById('composer-usage-label');
  const popover = document.getElementById('composer-usage-popover');
  if (!button || !label || !popover) {
    return;
  }
  const usageForTurn = (turn: MagicPointerTurn) =>
    latestContextUsage([turn]) || turn.modelUsage;
  const totalTokens = turns.reduce((total, turn) => {
    const usage = usageForTurn(turn);
    const reported = Number(usage?.totalTokens);
    if (Number.isFinite(reported) && reported >= 0) {
      return total + Math.round(reported);
    }
    return (
      total +
      (Number(usage?.inputTokens) || 0) +
      (Number(usage?.outputTokens) || 0)
    );
  }, 0);
  const catalog = activeComposerModelCatalog();
  const currentModel = catalog?.groups
    ?.flatMap(group => group.models || [])
    .find(
      entry =>
        entry.id === catalog?.current &&
        (!catalog?.currentProfileId ||
          entry.profileId === catalog.currentProfileId),
    );
  const latestUsage = latestContextUsage(turns);
  const contextWindow = Math.max(
    0,
    Number(latestUsage?.contextWindow) ||
      Number(currentModel?.contextWindow) ||
      0,
  );
  const contextTokens = Math.max(0, Number(latestUsage?.contextTokens) || 0);
  const measured = latestUsage?.contextEstimated === 0 || turns.length === 0;
  const known =
    typeof latestUsage?.contextTokens === 'number' || turns.length === 0;
  const contextRatio =
    contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;
  const contextProgress = Math.max(0, Math.min(100, Math.round(contextRatio)));
  button.hidden = false;
  button.style.setProperty('--mp-context-progress', String(contextProgress));
  label.textContent =
    known && contextWindow > 0
      ? `${measured ? '' : '≈'}${Math.round(contextRatio)}% context used`
      : 'Context usage unavailable';
  button.title =
    contextWindow > 0
      ? `Context ${contextTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens`
      : `Session usage: ${totalTokens.toLocaleString()} tokens`;
  popover.replaceChildren();
  const el = (tag: string, className: string, text?: string) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) {
      node.textContent = text;
    }
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
  const headValue = el(
    'span',
    'mp-usage-head-value',
    known && contextWindow > 0
      ? `${measured ? '' : '≈'}${compactTokenCount(contextTokens)} / ${compactTokenCount(contextWindow)} (${Math.round(contextRatio)}%)`
      : `${known ? compactTokenCount(contextTokens) : '—'} / ${contextWindow > 0 ? compactTokenCount(contextWindow) : '—'}`,
  );
  const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chev.setAttribute('aria-hidden', 'true');
  chev.classList.add('mp-usage-chev');
  const chevUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  chevUse.setAttribute('href', '#ic-chev');
  chev.appendChild(chevUse);
  head.append(headValue, chev);
  popover.append(head);

  const latestRows = contextCategoryRows(latestUsage);
  const bar = el('div', 'mp-usage-bar');
  if (contextWindow > 0) {
    for (const row of latestRows) {
      const segment = el('span', `mp-usage-seg is-${row.kind}`);
      segment.setAttribute('data-kind', row.kind);
      segment.title = studioT('usage.segment', {
        label: row.label,
        value: Math.round(row.value).toLocaleString(),
      });
      segment.style.width = usageSegmentShare(row.value, contextWindow);
      bar.append(segment);
    }
  }
  popover.append(bar);

  const details =
    document.getElementById('composer-usage-breakdown') ||
    el('div', 'mp-usage-breakdown');
  details.replaceChildren();
  details.hidden = !usageDetailsOpen;
  const detailHead = el('div', 'mp-usage-head');
  detailHead.append(el('span', '', 'Context window'));
  detailHead.append(
    el('span', 'mp-usage-head-value', headValue.textContent || ''),
  );
  details.append(detailHead);
  const contextRows = [
    ...latestRows,
    ...(contextWindow > 0
      ? [
          {
            kind: 'available',
            label: studioT('usage.remaining'),
            value: Math.max(0, contextWindow - contextTokens),
          },
        ]
      : []),
  ];
  for (const row of contextRows) {
    const node = el('div', 'mp-usage-row mp-usage-context-row');
    node.dataset.kind = row.kind;
    const rowLabel = el('span', 'mp-usage-row-label');
    const swatch = el('span', 'mp-usage-swatch');
    swatch.dataset.kind = row.kind;
    rowLabel.append(swatch, document.createTextNode(row.label));
    node.append(
      rowLabel,
      el(
        'span',
        'mp-usage-row-value',
        `${row.kind === 'available' ? '' : '≈'}${Math.round(row.value).toLocaleString()}`,
      ),
    );
    const track = el('div', 'mp-usage-row-track');
    const fill = el('div', 'mp-usage-row-fill');
    fill.dataset.kind = row.kind;
    fill.style.width = usageSegmentShare(row.value, contextWindow);
    track.append(fill);
    node.append(track);
    details.append(node);
  }
  if (latestRows.length) {
    details.append(
      el(
        'div',
        'mp-usage-note',
        measured
          ? 'Total is measured by the service; category shares are local estimates.'
          : 'Local estimate · updates when service usage arrives.',
      ),
    );
  }
  details.append(el('div', 'mp-usage-divider'));
  const section = el('div', 'mp-usage-section');
  section.append(
    el(
      'span',
      'mp-usage-section-label',
      `Session total · ${totalTokens.toLocaleString()} tokens`,
    ),
  );
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arrow.setAttribute('viewBox', '0 0 20 20');
  arrow.setAttribute('aria-hidden', 'true');
  arrow.classList.add('mp-usage-arrow');
  const arrowPath = document.createElementNS(
    'http://www.w3.org/2000/svg',
    'path',
  );
  arrowPath.setAttribute('d', 'M4 10h12m0 0-5-5m5 5-5 5');
  arrowPath.setAttribute('fill', 'none');
  arrowPath.setAttribute('stroke', 'currentColor');
  arrowPath.setAttribute('stroke-width', '1.5');
  arrowPath.setAttribute('stroke-linecap', 'round');
  arrowPath.setAttribute('stroke-linejoin', 'round');
  arrow.appendChild(arrowPath);
  details.append(section);

  const sessionTotals: Record<string, number> = {};
  for (const turn of turns) {
    for (const row of usageCategoryRows(
      latestContextUsage([turn]) || turn.modelUsage,
    )) {
      sessionTotals[row.kind] = (sessionTotals[row.kind] || 0) + row.value;
    }
  }
  const sessionRows = USAGE_CATEGORIES.map(category => ({
    kind: category.kind,
    label: category.label,
    value: sessionTotals[category.kind] || 0,
  })).filter(row => row.value > 0);
  for (const row of sessionRows) {
    const node = el('div', 'mp-usage-row');
    node.append(el('span', 'mp-usage-row-label', row.label));
    node.append(el('span', 'mp-usage-row-value', compactTokenCount(row.value)));
    details.append(node);
  }

  if (composerQuota && (composerQuota.rows.length > 0 || composerQuota.error)) {
    popover.append(el('div', 'mp-usage-divider'));
    const quotaSection = el('button', 'mp-usage-section mp-usage-quota-head');
    quotaSection.setAttribute('aria-expanded', String(usageDetailsOpen));
    quotaSection.setAttribute('aria-controls', 'composer-usage-breakdown');
    const quotaTitle = composerQuota.rows.some(row => row.percent !== null)
      ? 'Plan usage limits'
      : 'Usage';
    quotaSection.append(
      el(
        'span',
        'mp-usage-section-label',
        composerQuota.label
          ? `${quotaTitle} · ${composerQuota.label}`
          : quotaTitle,
      ),
    );
    const quotaArrow = arrow.cloneNode(true);
    quotaSection.append(quotaArrow);
    quotaSection.addEventListener('click', toggleDetails);
    popover.append(quotaSection);
    const quotaRows = el('div', 'mp-usage-quota-rows');
    for (const row of composerQuota.rows) {
      const node = el('div', 'mp-usage-row');
      node.append(el('span', 'mp-usage-row-label', row.label));
      const value = el('span', 'mp-usage-row-value');
      if (row.detail) {
        value.append(el('span', 'mp-usage-row-detail', row.detail));
      }
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
      row.append(el('span', 'mp-usage-row-label', studioT('usage.session_cost')));
      row.append(
        el(
          'span',
          'mp-usage-row-value',
          priced > 0 ? `≈$${cost.toFixed(6)}` : '—',
        ),
      );
      quotaRows.append(row);
      details.append(
        el(
          'div',
          'mp-usage-note',
          studioT('quota.note', {priced, reported}),
        ),
      );
    }
    if (composerQuota.error) {
      popover.append(el('div', 'mp-usage-note', composerQuota.error));
    }
    details.append(
      el(
        'div',
        'mp-usage-note',
        studioT('quota.updated', {
          time: new Date(composerQuota.fetchedAt).toLocaleTimeString(),
          source: composerQuota.source,
        }),
      ),
    );
  } else if (composerQuotaError) {
    popover.append(el('div', 'mp-usage-divider'));
    popover.append(
      el(
        'div',
        'mp-usage-section',
        `Usage unavailable · ${composerQuotaError}`,
      ),
    );
  } else {
    popover.append(el('div', 'mp-usage-divider'));
    popover.append(
      el(
        'div',
        'mp-usage-section',
        composerQuotaPending
          ? 'Loading usage…'
          : studioT('usage.quota_unavailable'),
      ),
    );
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
  if (!popover.hidden) {
    positionAnchoredPopover('composer-usage-popover', 'composer-context');
  }
  positionUsageBreakdown();
}

document
  .getElementById('composer-context')
  ?.addEventListener('click', event => {
    event.stopPropagation();
    const button = event.currentTarget as HTMLButtonElement;
    const popover = document.getElementById('composer-usage-popover');
    if (!popover) {
      return;
    }
    const open = popover.hidden;
    if (open) {
      positionAnchoredPopover('composer-usage-popover', 'composer-context');
      ensureComposerQuota();
    } else {
      closeAnchoredPopover('composer-usage-popover', 'composer-context');
    }
    button.setAttribute('aria-expanded', String(open));
  });

window.setInterval(() => {
  if (
    !document.hidden &&
    !document.getElementById('composer-usage-popover')?.hidden
  ) {
    ensureComposerQuota();
  }
}, 15_000);

let activeConversationId: string | null = null;
let activeConversationTab: 'chat' | 'trajectory' = 'chat';
let activeConversationTurnCount = 0;
let activeConversationTurns: Array<Record<string, unknown>> = [];
let activeConversationView: ReturnType<
  typeof ChatView.createConversationView
> | null = null;
let activeConversationRecord: MagicPointerConversation | null = null;
let conversationOpenGeneration = 0;
let conversationRefreshSequence = 0;
let conversationNotificationSequence = 0;
let externalConversationRun: {
  requestId: string;
  agentSessionId: string;
  body: HTMLElement;
} | null = null;
let activeConversationObject: Record<string, unknown> = {};
let activeTaskContext: MagicPointerTaskContext | null = null;
let desktopPerceptionController: DesktopPerceptionController | null = null;
let modsWorkspaceController: ModsWorkspaceController | null = null;
let modsConversationId = '';
let modsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let modsProgressConversationId = '';
const modsProgressMarkers = new Map<string, {b64: string; state: string; atMs: number; origin: number}>();

function modulesVisible(): boolean {
  return inspectorState.open && activeInspectorTab === 'modules' && shell.dataset.view === 'chat';
}

function queueModulesRefresh(conversationId: string): void {
  if (!conversationId || conversationId !== activeConversationId || !modulesVisible() || modsRefreshTimer !== null) {
    return;
  }
  modsRefreshTimer = setTimeout(() => {
    modsRefreshTimer = null;
    if (conversationId === activeConversationId && modulesVisible()) {
      modsWorkspaceController?.invalidate();
    }
  }, 120);
}

function modulesProgress(conversationId: string | undefined, record: Record<string, unknown>): void {
  if (!conversationId || conversationId !== activeConversationId || !modulesVisible()) {
    return;
  }
  const phase = String(record.phase || '');
  if (!['plan', 'session_ready', 'steer_absorbed', 'tool_result', 'model_response'].includes(phase)) {
    return;
  }
  const fields = record.fields && typeof record.fields === 'object' ? record.fields as Record<string, unknown> : {};
  if (phase === 'model_response' && (!fields.state || fields.state === 'tool_result')) {
    return;
  }
  if (modsProgressConversationId !== conversationId) {
    modsProgressConversationId = conversationId;
    modsProgressMarkers.clear();
  }
  const marker = {b64: String(fields.b64 || ''), state: String(fields.state || ''), atMs: Number(fields.atMs) || 0, origin: Number(fields.timeOriginMs) || 0};
  const previous = modsProgressMarkers.get(phase);
  if (previous && previous.b64 === marker.b64 && previous.state === marker.state && previous.atMs === marker.atMs && previous.origin === marker.origin) {
    return;
  }
  modsProgressMarkers.set(phase, marker);
  if (phase === 'tool_result') {
    try {
      const result = JSON.parse(ConversationControl.decodeChunkBlob({b64: marker.b64})) as {name?: string};
      const name = result.name || '';
      if (!name.startsWith('Context.') && !name.startsWith('Modules.') && !name.startsWith('Dashboard.') && name !== 'TodoWrite') {
        return;
      }
    } catch {
      return;
    }
  }
  queueModulesRefresh(conversationId);
}
const composerSelectedSourceIds = new Set<string>();
let figmaStatusTimer: number | null = null;
let figmaPairExpiresAt = 0;

function stopFigmaStatusPolling() {
  if (figmaStatusTimer !== null) {
    window.clearTimeout(figmaStatusTimer);
  }
  figmaStatusTimer = null;
}

function figmaConnectionElements() {
  return {
    status: document.getElementById('figma-connection-status'),
    code: document.getElementById('figma-pair-code'),
    button: document.getElementById(
      'figma-connect',
    ) as HTMLButtonElement | null,
  };
}

async function refreshFigmaConnection(poll = false) {
  const conversationId = activeConversationId;
  const {status, code, button} = figmaConnectionElements();
  if (!status || !code || !button) {
    return;
  }
  if (!conversationId) {
    stopFigmaStatusPolling();
    button.disabled = true;
    button.textContent = studioT('figma.connect');
    delete button.dataset.documentSessionId;
    code.hidden = true;
    status.textContent = studioT('figma.need_task');
    return;
  }
  button.disabled = true;
  const result = await Data.figmaStatus(conversationId);
  if (conversationId !== activeConversationId) {
    return;
  }
  const connections = Array.isArray(result.connections)
    ? result.connections
    : [];
  const connection = connections[0] as Record<string, unknown> | undefined;
  if (result.ok && connection) {
    stopFigmaStatusPolling();
    figmaPairExpiresAt = 0;
    code.hidden = true;
    button.disabled = false;
    button.textContent = studioT('figma.disconnect');
    button.dataset.documentSessionId = String(
      connection.documentSessionId || '',
    );
    status.textContent = [
      String(connection.documentName || studioT('figma.current_document')),
      String(connection.pageName || ''),
      studioTCount(
        'count.selected_nodes',
        Array.isArray(connection.selectionIds) ? connection.selectionIds.length : 0,
      ),
    ]
      .filter(Boolean)
      .join(' · ');
    return;
  }
  delete button.dataset.documentSessionId;
  button.textContent = studioT('figma.connect');
  button.disabled = false;
  if (!result.ok) {
    status.textContent =
      result.error === 'figma_connection_requires_started_task'
        ? studioT('figma.no_task')
        : String(result.error || studioT('figma.status_failed'));
    code.hidden = true;
    stopFigmaStatusPolling();
    return;
  }
  if (!figmaPairExpiresAt || Date.now() >= figmaPairExpiresAt) {
    status.textContent = studioT('figma.not_connected');
    code.hidden = true;
    stopFigmaStatusPolling();
    return;
  }
  if (poll) {
    stopFigmaStatusPolling();
    figmaStatusTimer = window.setTimeout(() => {
      void refreshFigmaConnection(true);
    }, 1000);
  }
}

async function toggleFigmaConnection() {
  const conversationId = activeConversationId;
  const {status, code, button} = figmaConnectionElements();
  if (!conversationId || !status || !code || !button) {
    return;
  }
  button.disabled = true;
  const documentSessionId = button.dataset.documentSessionId;
  if (documentSessionId) {
    const result = await Data.disconnectFigma(
      conversationId,
      documentSessionId,
    );
    if (!result.ok) {
      status.textContent = String(result.error || studioT('figma.disconnect_failed'));
    }
    await refreshFigmaConnection();
    return;
  }
  const result = await Data.pairFigma(conversationId);
  if (!result.ok) {
    status.textContent = String(result.error || studioT('figma.pair_failed'));
    button.disabled = false;
    return;
  }
  figmaPairExpiresAt = Number(result.expiresAt) || 0;
  code.textContent = `${String(result.pairCode || '')} · ${String(result.baseUrl || '')}`;
  code.hidden = false;
  status.textContent = result.installableManifestBuilt
    ? studioT('figma.pair_hint')
    : studioT('figma.no_plugin_id');
  button.disabled = false;
  stopFigmaStatusPolling();
  figmaStatusTimer = window.setTimeout(() => {
    void refreshFigmaConnection(true);
  }, 1000);
}

document.getElementById('figma-connect')?.addEventListener('click', () => {
  void toggleFigmaConnection();
});
const chatCardNodes = new Map<string, HTMLElement>();

function setStudioHomeVisible(visible: boolean) {
  const home = document.getElementById('studio-home');
  const header = document.querySelector<HTMLElement>(
    '#view-chat > .mpw-header',
  );
  const stream = document.getElementById('stream');
  const trajectory = document.getElementById('trajectory');
  const contextRow = document.querySelector<HTMLElement>(
    '.mp-composer-context-row',
  );
  const textarea = document.querySelector<HTMLTextAreaElement>(
    '#composer-form textarea',
  );
  if (home) {
    home.hidden = !visible;
  }
  if (header) {
    header.hidden = visible;
  }
  if (stream) {
    stream.hidden = visible || activeConversationTab !== 'chat';
  }
  if (trajectory) {
    trajectory.hidden = visible || activeConversationTab !== 'trajectory';
  }
  if (contextRow) {
    contextRow.hidden = false;
  }
  if (textarea) {
    applyComposerPlaceholder(textarea);
  }
  document.getElementById('nav-new-chat')?.classList.toggle('is-on', visible);
  document
    .querySelector<HTMLElement>('.mpw-scrollbody')
    ?.classList.toggle('is-home', visible);
}

let homeRefreshSequence = 0;

async function renderStudioHome() {
  const sequence = ++homeRefreshSequence;
  const [stats, conversations, projects] = await Promise.all([
    Data.conversationStats(),
    Data.conversations(),
    Data.projects(),
  ]);
  if (sequence !== homeRefreshSequence) {
    return;
  }
  studioHomeGlobals.render({
    stats,
    projects,
    conversations: conversations.map(conversation => ({
      ...conversation,
      archived: Boolean(
        studioLibraries.sessionPreference(conversation.id).archived,
      ),
      pinned: Boolean(
        studioLibraries.sessionPreference(conversation.id).pinned,
      ),
      acknowledgedAt: studioLibraries.sessionPreference(conversation.id).seenAt,
      state:
        studioComposerBusy && conversation.id === activeConversationId
          ? 'running'
          : undefined,
    })),
    onOpenConversation: id => {
      void openConversation(id);
    },
    onOpenProject: root => libraryUi.openProject(root),
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
    case 'conversation':
      return studioT('search.kind.conversation');
    case 'project':
      return studioT('search.kind.project');
    case 'command':
      return studioT('search.kind.command');
    case 'skill':
      return studioT('search.kind.skill');
    case 'route':
      return studioT('search.kind.route');
  }
}

function renderGlobalSearchResults(query: string) {
  const host = document.getElementById('global-search-results');
  if (!host) {
    return;
  }
  visibleSearchResults = studioSearchGlobals.searchStudioIndex(
    studioSearchIndex,
    query,
    20,
  );
  globalSearchActiveIndex = Math.min(
    globalSearchActiveIndex,
    Math.max(0, visibleSearchResults.length - 1),
  );
  if (!query.trim()) {
    host.innerHTML =
      '<p class="mp-global-search-empty">' + studioT('search.empty_hint') + '</p>';
    return;
  }
  if (!visibleSearchResults.length) {
    host.innerHTML = '<p class="mp-global-search-empty">' + studioT('search.no_results') + '</p>';
    return;
  }
  const rows = visibleSearchResults.map((item, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'mp-global-search-row';
    row.classList.toggle('is-active', index === globalSearchActiveIndex);
    row.dataset.searchIndex = String(index);
    row.setAttribute('role', 'option');
    row.setAttribute(
      'aria-selected',
      String(index === globalSearchActiveIndex),
    );
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
    libraryUi.openProject(
      String(item.target.projectId || item.target.workspaceRoot || ''),
    );
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
  const textarea = document.querySelector<HTMLTextAreaElement>('.mpw-input');
  if (!textarea || !name) {
    return;
  }
  textarea.value = `/${name} `;
  textarea.dispatchEvent(new Event('input', {bubbles: true}));
  textarea.focus();
}

async function openGlobalSearch() {
  const overlay = document.getElementById('global-search');
  const toggle = document.getElementById('global-search-toggle');
  const input = document.getElementById(
    'global-search-input',
  ) as HTMLInputElement | null;
  if (!overlay || !input) {
    return;
  }
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
  if (overlay) {
    overlay.hidden = true;
  }
  document
    .getElementById('global-search-toggle')
    ?.setAttribute('aria-expanded', 'false');
  visibleSearchResults = [];
  globalSearchActiveIndex = 0;
}

document
  .getElementById('global-search-toggle')
  ?.addEventListener('click', () => {
    if (document.getElementById('global-search')?.hidden === false) {
      closeGlobalSearch();
    } else {
      void openGlobalSearch();
    }
  });
document
  .querySelectorAll<HTMLElement>('[data-global-search-close]')
  .forEach(element => {
    element.addEventListener('click', closeGlobalSearch);
  });
document
  .getElementById('global-search-input')
  ?.addEventListener('input', event => {
    globalSearchActiveIndex = 0;
    renderGlobalSearchResults((event.currentTarget as HTMLInputElement).value);
  });
document
  .getElementById('global-search-input')
  ?.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!visibleSearchResults.length) {
        return;
      }
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      globalSearchActiveIndex =
        (globalSearchActiveIndex + direction + visibleSearchResults.length) %
        visibleSearchResults.length;
      renderGlobalSearchResults(
        (event.currentTarget as HTMLInputElement).value,
      );
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
  const scrollbody = document.querySelector<HTMLElement>('.mpw-scrollbody');
  const homeVisible = document.getElementById('studio-home')?.hidden === false;
  if (stream) {
    stream.hidden = homeVisible || tab !== 'chat';
  }
  if (trajectory) {
    trajectory.hidden = homeVisible || tab !== 'trajectory';
  }
  scrollbody?.classList.toggle('is-trajectory', tab === 'trajectory');
  document
    .querySelectorAll<HTMLElement>('[data-conversation-tab]')
    .forEach(button => {
      const selected = button.dataset.conversationTab === tab;
      button.classList.toggle('is-on', selected);
      button.setAttribute('aria-selected', String(selected));
    });
  if (tab === 'trajectory') {
    renderConversationActivity();
  }
  renderStreamRail();
}

async function openConversation(id: string) {
  const generation = ++conversationOpenGeneration;
  const notificationSequence = conversationNotificationSequence;
  const c = await Data.conversation(id);
  if (!c || generation !== conversationOpenGeneration) {
    return false;
  }
  captureComposerDraft();
  studioLibraries.setSessionPreference(c.id, {
    seenAt: Math.max(Date.now(), Number(c.updatedAt || 0)),
  });
  document
    .querySelectorAll<HTMLElement>('#side-convos .side-item')
    .forEach(row => {
      if (row.dataset.open === c.id) {
        row.dataset.unread = 'false';
        row.querySelector('.side-unread')?.remove();
      }
    });
  const switchedTask = activeConversationId !== c.id;
  if (switchedTask) {
    detachPendingConversation();
    pendingPermissionChoice = null;
    composerPlan = null;
    renderPlanCard();
    clearWorkspaceResources();
    if (inspectorState.open) {
      setInspector(false);
    }
  }
  if (
    artifactEditor.state().conversationId &&
    artifactEditor.state().conversationId !== c.id
  ) {
    artifactEditor.clear();
    renderArtifactEditor();
    if (activeInspectorTab === 'artifact') {
      setInspector(false);
    }
  }
  if (activeConversationId !== c.id) {
    repositoryContextDismissedFor = '';
  }
  activeConversationId = c.id;
  setProductMode(c.workMode === 'work' ? 'design' : 'walker', false);
  seedSessionPane(c.id);
  restoreWorkspaceResourceSnapshot();
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
  const projectRoot = String(
    (c as {workspaceRoot?: string}).workspaceRoot || '',
  );
  setActiveProject(projectRoot, c.projectId);
  show('chat');
  restoreComposerDraft({kind: 'conversation', id: c.id}, c);
  setStudioHomeVisible(false);
  document
    .querySelectorAll('#side-convos .side-item')
    .forEach(n =>
      (n as HTMLElement).classList.toggle(
        'is-on',
        (n as HTMLElement).dataset.open === id,
      ),
    );

  const head = document.getElementById('chat-title');
  if (head) {
    head.textContent = String(c.title);
  }
  renderProjectContext();
  await renderRepositoryContextBar(true);
  if (generation !== conversationOpenGeneration) {
    return false;
  }
  const preview = document.getElementById('chat-source-preview');
  const sourceThumb = document.getElementById(
    'chat-source-thumb',
  ) as HTMLImageElement | null;
  const peek = document.getElementById('chat-peek');
  const peekImage = document.getElementById(
    'peek-image',
  ) as HTMLImageElement | null;
  const peekLabel = document.getElementById('peek-label');
  if (preview && sourceThumb && peek && peekImage) {
    const imgPath = c.object?.annotatedPath || '';
    if (imgPath) {
      const src = 'file:///' + String(imgPath).replace(/\\/g, '/');
      const hideBrokenPreview = () => {
        preview.hidden = true;
        peek.hidden = true;
      };
      sourceThumb.onerror = hideBrokenPreview;
      peekImage.onerror = hideBrokenPreview;
      sourceThumb.src = src;
      peekImage.src = src;
      preview.hidden = false;
      peek.hidden = false;
      if (peekLabel) {
        peekLabel.textContent = c.object?.label || studioT('composer.peek_default');
      }
    } else {
      preview.hidden = true;
      peek.hidden = true;
      sourceThumb.removeAttribute('src');
      peekImage.removeAttribute('src');
    }
  }

  const stream = document.getElementById('stream');
  if (!stream) {
    return false;
  }
  LiveCards.reset();
  chatCardNodes.clear();
  const turns = c.turns || [];
  activeConversationTurns = turns as Array<Record<string, unknown>>;
  composerPlan = PlanList.project(turns);
  renderPlanCard();
  activeConversationObject =
    (c as {object?: Record<string, unknown>}).object || {};
  clearComposerSuggestion();
  renderProjectTasks();
  if (inspectorState.open && activeInspectorTab === 'activity') {
    renderConversationActivity();
  }
  if (!turns.length) {
    stream.innerHTML = emptyStateMarkup(
      'ic-message-plus',
      studioT('chat.empty_title'),
      studioT('chat.empty_body'),
    );
    syncConversationPendingInput(turns);
    renderUsageMeter([]);
    renderConversationActivity();
    setConversationTab(activeConversationTab);
    return true;
  }
  const flow = document.createElement('div');
  flow.className = 'mp-chat-flow';
  activeConversationView = ChatView.createConversationView(flow);
  activeConversationView.update(c);
  for (const [turnIndex, t] of turns.entries()) {
    const host = flow.querySelector<HTMLElement>(
      `.mp-chat-flow-item[data-turn-index="${turnIndex}"]`,
    )!;
    const proxy = LiveCards.track(
      CardModel.normalizeCard({
        id: `${t.at || 0}-a`,
        kind: 'prose',
        state: t.failed ? 'failed' : 'done',
        answer: t.answer || '',
        error: t.failed ? String(t.error || studioT('chat.turn_failed')) : '',
        steps: (t.trace || []).map(x =>
          typeof x === 'string'
            ? {label: x, state: 'done'}
            : {label: x.label, note: x.note || '', state: 'done'},
        ),
      }),
    );
    chatCardNodes.set(proxy.id, host);
  }
  stream.replaceChildren(flow);
  syncConversationPendingInput(turns);
  scrollChatToBottom();
  ChatView.bindDelegation(stream);
  syncExternalConversationRun(c);
  scheduleStreamRail();
  renderUsageMeter(turns);
  renderConversationActivity();
  setConversationTab(activeConversationTab);
  if (notificationSequence !== conversationNotificationSequence) {
    void refreshOpenConversation({id: c.id});
  }
  return true;
}

function syncConversationPendingInput(turns: MagicPointerTurn[]) {
  const last = turns.at(-1);
  const pending = last && !last.liveProgress ? last.pendingInput : null;
  // Older saved turns kept option objects in the flat list; read their labels, keep their descriptions.
  const rawOptions: unknown[] = Array.isArray(pending?.options)
    ? pending.options
    : [];
  const optionObjects = rawOptions
    .map(option =>
      option && typeof option === 'object'
        ? {
            ...(option as Record<string, unknown>),
            label: String((option as Record<string, unknown>).label || ''),
          }
        : {label: String(option ?? '')},
    )
    .filter(option => option.label) as MagicPointerDecisionQuestion['options'];
  const options = optionObjects.map(option => option.label);
  pendingPermissionAsk = null;
  pendingAskInput = null;
  if (pending?.kind === 'permission' && String(pending.tool || '').trim()) {
    pendingPermissionAsk = {
      requestId: pending.requestId || pendingToolRequestId(last),
      tool: String(pending.tool),
      prefix: String(pending.prefix || '').trim() || undefined,
      actionPreview: pending.actionPreview,
      action: pending.action,
      question: String(pending.question || '').trim() || undefined,
      options: options.length ? options : undefined,
      ...(pending.modeRaise === 'auto' ? {modeRaise: 'auto'} : {}),
    };
  } else if (
    pending &&
    (pending.kind === 'artifact' ||
      pending.questions?.length ||
      pending.question)
  ) {
    const question = String(
      pending.question || studioT('ask.default_question'),
    );
    const detailed = optionObjects.some(
      option => option.description || option.preview,
    );
    pendingAskInput = {
      ...pending,
      requestId: pending.requestId || pendingToolRequestId(last),
      question,
      options,
      ...(!pending.questions?.length && detailed
        ? {questions: [{question, options: optionObjects}]}
        : {}),
    };
  }
  renderPermissionAsk();
}

function syncExternalConversationRun(conversation: MagicPointerConversation) {
  if (pendingConversation) {
    return;
  }
  const turns = conversation.turns || [];
  const live = turns.at(-1)?.liveProgress;
  const body = document.querySelector<HTMLElement>(
    `.mp-chat-flow-item[data-turn-index="${turns.length - 1}"]`,
  );
  const wasRunning = Boolean(externalConversationRun);
  const next =
    live?.requestId && body
      ? {
          requestId: live.requestId,
          agentSessionId:
            live.agentSessionId ||
            conversation.agentSessionId ||
            conversation.taskContext?.taskId ||
            '',
          body,
        }
      : null;
  if (next && externalConversationRun?.requestId === next.requestId) {
    Object.assign(externalConversationRun, next);
  } else {
    externalConversationRun = next;
  }
  studioComposerBusy = Boolean(externalConversationRun);
  if (wasRunning !== studioComposerBusy) {
    setComposerRunningState(studioComposerBusy);
  }
}

async function refreshOpenConversation(
  change?: MagicPointerConversationChange,
) {
  const id = activeConversationId;
  if (
    !id ||
    !change?.id ||
    change.id !== id ||
    !activeConversationView ||
    pendingConversation
  ) {
    return;
  }
  const sequence = ++conversationRefreshSequence;
  let conversation: MagicPointerConversation | null;
  const index = change.turnIndex;
  if (
    change.liveProgress &&
    Number.isInteger(index) &&
    activeConversationTurns[Number(index)] &&
    activeConversationRecord
  ) {
    const turns = activeConversationTurns.slice() as MagicPointerTurn[];
    turns[Number(index)] = {
      ...turns[Number(index)],
      outcome: '进行中',
      liveProgress: change.liveProgress,
    };
    conversation = {...activeConversationRecord, turns};
  } else {
    conversation = (await Data.conversation(id)) || null;
  }
  if (
    !conversation ||
    activeConversationId !== id ||
    sequence !== conversationRefreshSequence ||
    !activeConversationView
  ) {
    return;
  }
  if (!change.liveProgress) {
    const previous = activeConversationRecord?.turns?.at(-1);
    const latest = conversation.turns?.at(-1);
    if (latest && (previous?.at !== latest.at || previous?.outcome !== latest.outcome || Boolean(previous?.liveProgress) || previous?.receipts?.length !== latest.receipts?.length)) {
      queueModulesRefresh(id);
    }
  }
  activeConversationRecord = conversation;
  activeConversationTurns = conversation.turns || [];
  activeConversationTurnCount = activeConversationTurns.length;
  composerPlan = PlanList.project(activeConversationTurns);
  renderPlanCard();
  if (conversation.taskContext) {
    setActiveTaskContext(conversation.taskContext);
  }
  const stream = document.getElementById('stream');
  if (stream) {
    followIfNearBottom(stream, () =>
      activeConversationView?.update(conversation!),
    );
  }
  syncExternalConversationRun(conversation);
  if (
    change.liveProgress &&
    inspectorState.open &&
    activeInspectorTab === 'tasks'
  ) {
    renderProjectTasks();
  }
  if (
    (inspectorState.open && activeInspectorTab === 'activity') ||
    activeConversationTab === 'trajectory'
  ) {
    renderConversationActivity();
  }
  if (!change.liveProgress) {
    finishWorkspaceResourceRun();
    void renderConversationRecovery(conversation.id);
    syncConversationPendingInput(conversation.turns || []);
    renderUsageMeter(conversation.turns || []);
    renderProjectTasks();
    renderConversationActivity();
  }
}

function renderChatCardNode(card: MagicPointerCard): HTMLElement {
  const host = document.createElement('div');
  host.className = 'mp-chat-assistant';
  for (const node of ChatView.assistantTurnNode({
    answer: card.answer,
    failed: card.state === 'failed',
    running: card.state === 'running',
    trace: (card.steps || []).map(x =>
      typeof x === 'string'
        ? x
        : {
            label: String((x as {label?: unknown}).label || ''),
            note: String((x as {note?: unknown}).note || ''),
          },
    ),
    at: card.startedAt ?? undefined,
  })) {
    host.appendChild(node);
  }
  return host;
}

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
let artifactCache: ArtifactEntry[] = [];
let artifactScope: 'all' | 'mine' = 'all';
let artifactKind = '';
let artifactQuery = '';
let artifactLayout: 'list' | 'grid' = 'list';
let artifactViewBound = false;
const artifactPreviews = new Map<string, string>();
const artifactPreviewPending = new Set<string>();

function artifactGlyph(name: string, size = 'small') {
  return (
    globalThis as unknown as {
      CdsIcons: {html(name: string, size: string): string};
    }
  ).CdsIcons.html(name, size);
}

const ARTIFACT_KIND_LABELS: Record<string, string> = {
  file: 'File',
  text: 'Text',
  document_patch: 'Document patch',
  code: 'Code',
  image: 'Image',
};

/* Slice-local label lookup: snippet tests evaluate the artifact library
 * range without the locale script and never assert labels. */
function artifactText(
  id: string,
  params?: Record<string, string | number>,
): string {
  return typeof studioT === 'function' ? studioT(id, params) : id;
}

function artifactKindLabel(kind: string) {
  return ARTIFACT_KIND_LABELS[kind] || kind;
}

function artifactKindIcon(kind: string) {
  if (kind === 'code') {
    return 'code';
  }
  if (kind === 'image') {
    return 'image';
  }
  return 'document';
}

function artifactPlainLine(value: unknown, limit = 120) {
  const text = String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim())
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

function artifactDayKey(at: number) {
  const date = new Date(at);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  }
  if (
    date.toDateString() === new Date(today.getTime() - 86400000).toDateString()
  ) {
    return 'Yesterday';
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function artifactMatches(entry: ArtifactEntry) {
  if (artifactScope === 'mine' && !String(entry.artifactId || '').trim()) {
    return false;
  }
  if (artifactKind && String(entry.kind || '') !== artifactKind) {
    return false;
  }
  if (artifactQuery) {
    const haystack =
      `${entry.name || ''} ${entry.summary || ''} ${entry.from || ''}`.toLowerCase();
    if (!haystack.includes(artifactQuery)) {
      return false;
    }
  }
  return true;
}

function artifactRowMarkup(entry: ArtifactEntry) {
  const kind = String(entry.kind || '');
  const name =
    artifactPlainLine(entry.name) ||
    artifactPlainLine(entry.summary) ||
    artifactText('artifact.untitled');
  const meta = [formatTime(entry.at)].filter(Boolean).join(' · ');
  const openAttrs = entry.artifactId
    ? `data-artifact-id="${esc(entry.artifactId)}" data-artifact-conversation="${esc(entry.conversationId)}"`
    : `data-open="${esc(entry.conversationId)}"`;
  const excerpt =
    artifactPreviews.get(`${entry.artifactId}:${entry.revision || 0}`) ||
    entry.summary ||
    name;
  return `<div class="mp-artifact-item"><button type="button" class="mp-artifact-row" ${openAttrs} title="${esc(entry.from ? `${name} · ${entry.from}` : name)}">
      <span class="mp-artifact-preview" aria-hidden="true">${studioLibraries.artifactPreviewMarkup({...entry, name}, excerpt)}</span>
      <span class="mp-artifact-tile" data-kind="${esc(kind)}" aria-hidden="true">${artifactGlyph(artifactKindIcon(kind))}</span>
      <span class="mp-artifact-name">${esc(name)}</span>
      <span class="mp-artifact-meta">${esc(meta)}</span>
    </button><details class="mp-artifact-actions"><summary aria-label="${artifactText('artifact.actions')}">${artifactGlyph('more-horizontal')}</summary>
      <div class="mp-artifact-action-menu"><button type="button" ${openAttrs}>${artifactGlyph('external')}${artifactText('artifact.open')}</button>
      ${entry.conversationId ? `<button type="button" data-open="${esc(entry.conversationId)}">${artifactGlyph('composer-aux1')}${artifactText('artifact.view_source')}</button>` : ''}</div>
    </details></div>`;
}

function artifactEmptyMarkup(message: string) {
  return `<div class="mp-artifact-empty-state">${studioLibraries.pictogram('HandShapes')}<p class="mp-artifact-empty">${esc(message)}</p></div>`;
}

function closeArtifactKindMenu() {
  const menu = document.getElementById('artifact-kind-menu');
  if (menu) {
    menu.hidden = true;
  }
  document
    .getElementById('artifact-kind-trigger')
    ?.setAttribute('aria-expanded', 'false');
}

function paintArtifactToolbar(list: ArtifactEntry[]) {
  const kinds = Array.from(
    new Set(list.map(entry => String(entry.kind || '')).filter(Boolean)),
  ).sort();
  if (artifactKind && !kinds.includes(artifactKind)) {
    artifactKind = '';
  }
  const menu = document.getElementById('artifact-kind-menu');
  if (menu) {
    menu.innerHTML = ['']
      .concat(kinds)
      .map(kind => {
        const label = kind ? artifactKindLabel(kind) : artifactText('artifact.kind_all');
        const count = kind
          ? list.filter(entry => String(entry.kind || '') === kind).length
          : list.length;
        return `<button type="button" role="menuitemradio" aria-checked="${kind === artifactKind ? 'true' : 'false'}"
        data-artifact-kind="${esc(kind || '__all__')}"><span class="mp-kind-label">${kind ? `<span class="mp-artifact-kind-icon" data-kind="${esc(kind)}">${artifactGlyph(artifactKindIcon(kind))}</span>` : ''}${esc(label)}</span><span class="mp-kind-tail">${kind === artifactKind ? artifactGlyph('check') : `<em>${count}</em>`}</span></button>`;
      })
      .join('');
  }
  const kindLabel = document.getElementById('artifact-kind-label');
  if (kindLabel) {
    kindLabel.textContent = artifactKind
      ? artifactKindLabel(artifactKind)
      : 'All types';
  }
  for (const tab of document.querySelectorAll<HTMLElement>(
    '[data-artifact-scope]',
  )) {
    const on = tab.dataset.artifactScope === artifactScope;
    tab.classList.toggle('is-on', on);
    tab.setAttribute('aria-pressed', String(on));
  }
  const layout = document.getElementById('artifact-layout-toggle');
  if (layout) {
    const grid = artifactLayout === 'grid';
    const text = grid ? artifactText('artifact.view_list') : artifactText('artifact.view_grid');
    layout.setAttribute('aria-pressed', String(grid));
    layout.setAttribute('aria-label', text);
    layout.setAttribute('title', text);
    layout.innerHTML = artifactGlyph(grid ? 'layout-list' : 'layout-grid');
  }
  const host = document.getElementById('art-list');
  if (host) {
    host.dataset.layout = artifactLayout;
  }
}

function paintArtifacts() {
  const host = document.getElementById('art-list');
  if (!host) {
    return;
  }
  paintArtifactToolbar(artifactCache);
  if (!artifactCache.length) {
    host.innerHTML = artifactEmptyMarkup(
      artifactText('artifact.empty'),
    );
    return;
  }
  const filtered = artifactCache.filter(artifactMatches);
  if (!filtered.length) {
    host.innerHTML = artifactEmptyMarkup(artifactText('artifact.no_match'));
    return;
  }
  const groups: Array<{label: string; items: ArtifactEntry[]}> = [];
  const byLabel = new Map<string, ArtifactEntry[]>();
  for (const entry of filtered) {
    const at = Number(entry.at);
    const label = Number.isFinite(at) && at > 0 ? artifactDayKey(at) : 'Earlier';
    let bucket = byLabel.get(label);
    if (!bucket) {
      bucket = [];
      byLabel.set(label, bucket);
      groups.push({label, items: bucket});
    }
    bucket.push(entry);
  }
  host.innerHTML = groups
    .map(
      group => `<div class="mp-artifact-group">
    <div class="mp-artifact-group-label">${esc(group.label)}</div>
    ${group.items.map(entry => artifactRowMarkup(entry)).join('')}
  </div>`,
    )
    .join('');
  if (artifactLayout === 'grid') {
    void loadArtifactPreviews(filtered);
  }
}

async function loadArtifactPreviews(entries: ArtifactEntry[]) {
  const pending = entries.slice(0, 24).filter(entry => {
    const key = `${entry.artifactId}:${entry.revision || 0}`;
    return (
      entry.artifactId &&
      entry.conversationId &&
      !artifactPreviews.has(key) &&
      !artifactPreviewPending.has(key)
    );
  });
  if (!pending.length) {
    return;
  }
  await Promise.all(
    pending.map(async entry => {
      const key = `${entry.artifactId}:${entry.revision || 0}`;
      artifactPreviewPending.add(key);
      try {
        const response = await Data.readArtifact(
          entry.conversationId!,
          entry.artifactId!,
        );
        artifactPreviews.set(
          key,
          response.ok ? String(response.artifact?.content || '') : '',
        );
      } catch {
        artifactPreviews.set(key, '');
      } finally {
        artifactPreviewPending.delete(key);
      }
    }),
  );
  if (artifactLayout === 'grid') {
    paintArtifacts();
  }
}

function bindArtifactView() {
  if (artifactViewBound) {
    return;
  }
  const view = document.getElementById('view-artifacts');
  const trigger = document.getElementById('artifact-kind-trigger');
  const menu = document.getElementById('artifact-kind-menu');
  const searchToggle = document.getElementById('artifact-search-toggle');
  const searchField = document.getElementById('artifact-search-field');
  const searchInput = document.getElementById(
    'artifact-search-input',
  ) as HTMLInputElement | null;
  const layoutToggle = document.getElementById('artifact-layout-toggle');
  if (
    !view ||
    !trigger ||
    !menu ||
    !searchToggle ||
    !searchField ||
    !searchInput ||
    !layoutToggle
  ) {
    return;
  }
  artifactViewBound = true;

  const setSearchOpen = (open: boolean) => {
    searchField.hidden = !open;
    searchToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      searchInput.focus();
    } else if (artifactQuery) {
      artifactQuery = '';
      searchInput.value = '';
      paintArtifacts();
    }
  };

  view.addEventListener('click', event => {
    const target = event.target as Element | null;
    const create = target?.closest<HTMLElement>('[data-artifact-create]');
    if (create) {
      document.getElementById('nav-new-chat')?.click();
      const input = document.querySelector<HTMLTextAreaElement>(
        '#composer-form textarea',
      );
      if (input) {
        input.value = String(create.dataset.artifactCreate || '');
        fitComposer(input);
        input.focus();
      }
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

  document.addEventListener('click', event => {
    if (!view.contains(event.target as Node)) {
      closeArtifactKindMenu();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') {
      return;
    }
    closeArtifactKindMenu();
    if (!searchField.hidden) {
      setSearchOpen(false);
    }
  });
}

let activeDashboardId = '';
let activeDashboardSnapshotId = '';
let dashboardRenderGeneration = 0;
let dashboardTraceDialog: HTMLDialogElement | null = null;

async function renderDashboardView(): Promise<void> {
  const root = document.getElementById('dashboard-root');
  if (!root) {
    return;
  }
  const generation = ++dashboardRenderGeneration;
  closeDashboardTrace();
  root.innerHTML = `<p class="mp-dash-note">${studioT('dashboard.loading')}</p>`;
  try {
    const items = await Data.dashboardList();
    if (
      generation !== dashboardRenderGeneration ||
      shell.dataset.view !== 'dashboard'
    ) {
      return;
    }
    const specs = items.filter(
      item => item && typeof item === 'object' && item.dashboardId,
    ) as Array<{dashboardId: string; title: string}>;
    if (
      !activeDashboardId ||
      !specs.some(s => s.dashboardId === activeDashboardId)
    ) {
      activeDashboardId = specs[0]?.dashboardId ?? '';
    }
    if (!activeDashboardId) {
      root.innerHTML = `<div class="mp-dash-empty"><h2>${studioT('dashboard.empty')}</h2><p>${studioT('dashboard.empty_hint')}</p><button type="button" data-dash-new>${studioT('dashboard.new')}</button></div>`;
      root
        .querySelector('[data-dash-new]')
        ?.addEventListener('click', () => void createDashboardWithAgent());
      return;
    }
    const opened = await Data.dashboardOpen(activeDashboardId);
    if (
      generation !== dashboardRenderGeneration ||
      shell.dataset.view !== 'dashboard'
    ) {
      return;
    }
    if (!opened || opened.ok !== true) {
      throw new Error(
        String(opened?.error || studioT('dashboard.open_failed')),
      );
    }
    const spec = opened.spec as {
      title: string;
      sources: Array<{path?: string}>;
      charts: Array<{
        chartId: string;
        title: string;
        type: 'kpi' | 'line' | 'table';
        format?: 'money' | 'number' | 'percent';
      }>;
    };
    const tabs = specs
      .map(
        s =>
          `<button type="button" data-dash-open="${esc(s.dashboardId)}" class="${s.dashboardId === activeDashboardId ? 'is-on' : ''}">${esc(s.title)}</button>`,
      )
      .join('');
    activeDashboardSnapshotId = String(opened.snapshot.snapshotId);
    root.innerHTML = `<div class="mp-dash-tabs">${tabs}<button type="button" data-dash-new>+ ${studioT('dashboard.new')}</button></div><div id="dashboard-panel"></div>`;
    root
      .querySelector('[data-dash-new]')
      ?.addEventListener('click', () => void createDashboardWithAgent());
    root.querySelectorAll('[data-dash-open]').forEach(btn => {
      btn.addEventListener('click', () => {
        activeDashboardId = String((btn as HTMLElement).dataset.dashOpen || '');
        void renderDashboardView();
      });
    });
    const panel = document.getElementById('dashboard-panel');
    if (!panel || typeof renderDashboard !== 'function') {
      return;
    }
    renderDashboard(
      panel,
      String(spec.title || ''),
      opened.snapshot,
      spec.charts,
      {
        onShare: () => void shareDashboard(spec.title, panel),
        onClose: () => show('artifacts'),
        onInspect: (chartId, trace) =>
          void inspectDashboardTrace(chartId, trace),
        onRefresh: () => void renderDashboardView(),
        onEdit: () => {
          composeLibraryPrompt(
            studioT('dashboard.edit_prompt', {
              title: spec.title,
              id: activeDashboardId,
            }),
          );
          composerAttachments = spec.sources
            .map(source => source.path)
            .filter((file): file is string => Boolean(file));
          renderComposerAttachments();
          captureComposerDraft();
        },
      },
    );
  } catch (error) {
    if (
      generation !== dashboardRenderGeneration ||
      shell.dataset.view !== 'dashboard'
    ) {
      return;
    }
    root.innerHTML = `<div class="mp-dash-empty"><p class="mp-dash-error">${esc(error instanceof Error ? error.message : String(error))}</p><button type="button" data-dash-retry>${studioT('dashboard.retry')}</button></div>`;
    root
      .querySelector('[data-dash-retry]')
      ?.addEventListener('click', () => void renderDashboardView());
  }
}

async function createDashboardWithAgent(): Promise<void> {
  const generation = dashboardRenderGeneration;
  const button = document.querySelector<HTMLButtonElement>('[data-dash-new]');
  if (button) {
    button.disabled = true;
  }
  try {
    const picked = await Data.pickProjectFiles('', 'files');
    if (
      generation !== dashboardRenderGeneration ||
      shell.dataset.view !== 'dashboard' ||
      picked.canceled
    ) {
      return;
    }
    if (!picked.ok || !picked.paths?.length) {
      throw new Error(picked.error || studioT('dashboard.choose_file'));
    }
    if (picked.paths.some(file => !/\.(csv|xlsx)$/i.test(file))) {
      throw new Error(studioT('dashboard.file_types'));
    }
    composeLibraryPrompt(studioT('dashboard.create_prompt'));
    composerAttachments = [...picked.paths];
    renderComposerAttachments();
    captureComposerDraft();
    (
      document.getElementById('composer-form') as HTMLFormElement
    ).requestSubmit();
  } catch (error) {
    const notice = document.createElement('p');
    notice.className = 'mp-dash-error';
    notice.textContent = error instanceof Error ? error.message : String(error);
    document.getElementById('dashboard-root')?.prepend(notice);
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

async function shareDashboard(
  title: string,
  panel: HTMLElement,
): Promise<void> {
  let css = '';
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      if (sheet.href && sheet.href.includes('dashboard.css')) {
        css = Array.from(sheet.cssRules)
          .map(rule => rule.cssText)
          .join('\n');
      }
    } catch {}
  }
  const copy = panel.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[data-dash-act]').forEach(control => control.remove());
  copy.querySelectorAll('button[data-dash-trace]').forEach(control => {
    const label = document.createElement('span');
    label.textContent = control.textContent;
    control.replaceWith(label);
  });
  copy.querySelectorAll('[data-dash-trace]').forEach(control => {
    control.removeAttribute('data-dash-trace');
    control.removeAttribute('tabindex');
    control.removeAttribute('role');
  });
  try {
    const result = await Data.dashboardExportHtml({
      title,
      html: copy.innerHTML,
      css:
        'body{margin:0;font:14px system-ui,sans-serif;color:#202020;background:#fff}*{box-sizing:border-box}' +
        css,
    });
    if (result?.ok !== true && !result?.canceled) {
      window.alert(String(result?.error || studioT('dashboard.export_failed')));
    }
  } catch (error) {
    window.alert(String(error instanceof Error ? error.message : error));
  }
}

function closeDashboardTrace(): void {
  dashboardTraceDialog?.close();
  dashboardTraceDialog?.remove();
  dashboardTraceDialog = null;
}

async function inspectDashboardTrace(
  chartId: string,
  traceId: string,
  offset = 0,
): Promise<void> {
  const snapshotId = activeDashboardSnapshotId;
  const dialog = dashboardTraceDialog || document.createElement('dialog');
  dashboardTraceDialog = dialog;
  dialog.className = 'mp-dash-trace-dialog';
  dialog.innerHTML = `<p>${studioT('dashboard.reading_rows')}</p>`;
  if (!dialog.isConnected) {
    document.body.append(dialog);
  }
  if (!dialog.open) {
    dialog.showModal();
  }
  dialog.oncancel = closeDashboardTrace;
  try {
    const response = await Data.dashboardTrace({snapshotId, traceId, offset});
    if (
      !dialog.isConnected ||
      snapshotId !== activeDashboardSnapshotId ||
      shell.dataset.view !== 'dashboard'
    ) {
      closeDashboardTrace();
      return;
    }
    if (!response.ok) {
      throw new Error(response.error || studioT('dashboard.rows_unavailable'));
    }
    const detail = response.detail as {
      generatedAt: string;
      source: {sourceId: string; kind: string; path?: string; sheet?: string};
      formula: string;
      value: number | null;
      columns: string[];
      rows: Array<{rowNumber: number; values: Record<string, unknown>}>;
      totalRows: number;
      offset: number;
      excludedCount: number;
      warnings: string[];
    };
    dialog.innerHTML = `<header><h2>${studioT('dashboard.source_rows')} · ${esc(chartId)}</h2><button type="button" data-trace-close aria-label="${studioT('common.close')}">×</button></header><p>${esc(detail.source.path || studioT('dashboard.inline_data'))}${detail.source.sheet ? ` · ${esc(detail.source.sheet)}` : ''}</p><p>${studioT('dashboard.snapshot')}: ${esc(new Date(detail.generatedAt).toLocaleString(getStudioLanguage()))} · ${studioT('dashboard.value')}: ${detail.value === null ? studioT('dashboard.no_value') : esc(String(detail.value))}</p><pre>${esc(detail.formula)}</pre>${detail.excludedCount ? `<p>${studioT('dashboard.excluded', {count: detail.excludedCount})}</p>` : ''}${detail.warnings.length ? `<ul>${detail.warnings.map(warning => `<li>${esc(warning)}</li>`).join('')}</ul>` : ''}<div class="mp-dash-table-scroll"><table class="mp-dash-table"><thead><tr><th>${studioT('dashboard.source_row')}</th>${detail.columns.map(column => `<th>${esc(column)}</th>`).join('')}</tr></thead><tbody>${detail.rows.map(row => `<tr><th>${row.rowNumber}</th>${detail.columns.map(column => `<td>${esc(String(row.values[column] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table></div><footer><span>${studioT('dashboard.row_count', {range: detail.totalRows ? `${detail.offset + 1}–${detail.offset + detail.rows.length}` : '0', total: detail.totalRows})}</span><button type="button" data-trace-prev ${detail.offset === 0 ? 'disabled' : ''}>${studioT('dashboard.previous')}</button><button type="button" data-trace-next ${detail.offset + detail.rows.length >= detail.totalRows ? 'disabled' : ''}>${studioT('dashboard.next')}</button><button type="button" data-trace-export>${studioT('dashboard.export_csv')}</button></footer><p role="status" data-trace-status></p>`;
    dialog
      .querySelector('[data-trace-close]')
      ?.addEventListener('click', closeDashboardTrace);
    dialog
      .querySelector('[data-trace-prev]')
      ?.addEventListener(
        'click',
        () =>
          void inspectDashboardTrace(
            chartId,
            traceId,
            Math.max(0, detail.offset - 100),
          ),
      );
    dialog
      .querySelector('[data-trace-next]')
      ?.addEventListener(
        'click',
        () =>
          void inspectDashboardTrace(
            chartId,
            traceId,
            detail.offset + detail.rows.length,
          ),
      );
    dialog
      .querySelector('[data-trace-export]')
      ?.addEventListener('click', async event => {
        const button = event.currentTarget as HTMLButtonElement;
        button.disabled = true;
        try {
          const result = await Data.dashboardExportCsv({snapshotId, traceId});
          dialog.querySelector('[data-trace-status]')!.textContent = result.ok
            ? studioT('dashboard.saved', {path: String(result.path)})
            : result.canceled
              ? ''
              : String(result.error);
        } catch (error) {
          dialog.querySelector('[data-trace-status]')!.textContent =
            String(error);
        } finally {
          button.disabled = false;
        }
      });
  } catch (error) {
    dialog.innerHTML = `<p class="mp-dash-error">${esc(error instanceof Error ? error.message : String(error))}</p><button type="button" data-trace-close>${studioT('common.close')}</button>`;
    dialog
      .querySelector('[data-trace-close]')
      ?.addEventListener('click', closeDashboardTrace);
  }
}

async function renderArtifacts(_force = false) {
  bindArtifactView();
  const host = document.getElementById('art-list');
  if (!host) {
    return;
  }
  const [list] = await Promise.all([
    Data.artifacts() as Promise<ArtifactEntry[]>,
    studioLibraries.loadPictograms(),
  ]);
  studioLibraries.mountPreviews(
    document.getElementById('v-artifacts') || document,
  );
  artifactCache = list
    .slice()
    .sort((left, right) => (Number(right.at) || 0) - (Number(left.at) || 0));
  paintArtifacts();
}

const artifactEditor = ArtifactEditor.createArtifactEditor({
  read: payload =>
    Data.readArtifact(
      String(payload.conversationId || ''),
      String(payload.artifactId || ''),
      payload.revision === undefined ? undefined : Number(payload.revision),
    ),
  restore: payload =>
    Data.restoreArtifact(
      String(payload.conversationId || ''),
      String(payload.artifactId || ''),
      Number(payload.revision),
      Number(payload.expectedRevision),
    ),
  edit: payload =>
    Data.editArtifact({
      conversationId: String(payload.conversationId || ''),
      artifactId: String(payload.artifactId || ''),
      expectedRevision: Number(payload.expectedRevision),
      content: String(payload.content ?? ''),
      patchPayload:
        payload.patchPayload && typeof payload.patchPayload === 'object'
          ? (payload.patchPayload as Record<string, unknown>)
          : null,
    }),
  accept: payload =>
    Data.acceptArtifact(
      String(payload.conversationId || ''),
      String(payload.artifactId || ''),
      Number(payload.revision),
    ),
  apply: payload =>
    Data.applyArtifact(
      String(payload.conversationId || ''),
      String(payload.artifactId || ''),
      Number(payload.revision),
    ),
  undo: payload =>
    Data.undoArtifact(
      String(payload.conversationId || ''),
      String(payload.artifactId || ''),
      Number(payload.revision),
      payload.confirmed === true,
    ),
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
): {key: string; documentSessionId: string; nodeId: string} | null {
  const locator =
    operation.locator && typeof operation.locator === 'object'
      ? (operation.locator as Record<string, unknown>)
      : null;
  const value =
    locator?.value && typeof locator.value === 'object'
      ? (locator.value as Record<string, unknown>)
      : null;
  if (locator?.kind !== 'figma-node' || !value) {
    return null;
  }
  const documentSessionId = String(value.documentSessionId || '').trim();
  const nodeId = String(value.nodeId || '').trim();
  if (!documentSessionId || !nodeId) {
    return null;
  }
  return {
    key: `${state.artifactId}:${state.revision}:${index}:${documentSessionId}:${nodeId}`,
    documentSessionId,
    nodeId,
  };
}

async function loadFigmaArtifactPreview(
  index: number,
  force = false,
): Promise<void> {
  const state = artifactEditor.state();
  const operations = Array.isArray(state.patchPayload?.operations)
    ? (state.patchPayload.operations as Array<Record<string, unknown>>)
    : [];
  const operation = operations[index];
  const coordinates = operation
    ? figmaPatchCoordinates(state, operation, index)
    : null;
  if (!coordinates || !state.conversationId) {
    return;
  }
  if (!force && figmaArtifactPreviews.has(coordinates.key)) {
    return;
  }
  figmaArtifactPreviews.set(coordinates.key, {status: 'loading'});
  renderArtifactPatchPreview(state);
  const result = await Data.exportFigmaPreview(
    state.conversationId,
    coordinates.documentSessionId,
    coordinates.nodeId,
  );
  const latest = artifactEditor.state();
  const latestOperations = Array.isArray(latest.patchPayload?.operations)
    ? (latest.patchPayload.operations as Array<Record<string, unknown>>)
    : [];
  const latestCoordinates = latestOperations[index]
    ? figmaPatchCoordinates(latest, latestOperations[index], index)
    : null;
  if (latestCoordinates?.key !== coordinates.key) {
    return;
  }
  const payload =
    result.result && typeof result.result === 'object'
      ? (result.result as Record<string, unknown>)
      : {};
  const mimeType = String(payload.mimeType || '');
  const base64 = String(payload.base64 || '');
  if (
    result.ok &&
    mimeType === 'image/png' &&
    /^[A-Za-z0-9+/=]+$/.test(base64)
  ) {
    figmaArtifactPreviews.set(coordinates.key, {
      status: 'ready',
      dataUrl: `data:image/png;base64,${base64}`,
    });
  } else {
    figmaArtifactPreviews.set(coordinates.key, {
      status: 'error',
      error: String(result.error || studioT('figma.preview_unavailable')),
    });
  }
  renderArtifactPatchPreview(latest);
}

async function refreshFigmaArtifactPreviews(force = false): Promise<void> {
  const state = artifactEditor.state();
  const operations = Array.isArray(state.patchPayload?.operations)
    ? (state.patchPayload.operations as Array<Record<string, unknown>>)
    : [];
  await Promise.all(
    operations.map(async (operation, index) => {
      if (figmaPatchCoordinates(state, operation, index)) {
        await loadFigmaArtifactPreview(index, force);
      }
    }),
  );
}

async function retargetFigmaArtifact(index: number): Promise<void> {
  const state = artifactEditor.state();
  const operations = Array.isArray(state.patchPayload?.operations)
    ? (state.patchPayload.operations as Array<Record<string, unknown>>)
    : [];
  const operation = operations[index];
  const coordinates = operation
    ? figmaPatchCoordinates(state, operation, index)
    : null;
  if (!coordinates || !state.patchPayload) {
    return;
  }
  figmaArtifactPreviews.set(coordinates.key, {status: 'loading'});
  renderArtifactPatchPreview(state);
  const response = await Data.inspectFigmaSelection(
    state.conversationId,
    coordinates.documentSessionId,
  );
  const current = artifactEditor.state();
  if (
    current.selectionGeneration !== state.selectionGeneration ||
    current.revision !== state.revision ||
    current.patchPayload !== state.patchPayload
  ) {
    return;
  }
  const result =
    response.result && typeof response.result === 'object'
      ? (response.result as Record<string, unknown>)
      : {};
  const selectionIds = Array.isArray(result.selectionIds)
    ? result.selectionIds.map(value => String(value || ''))
    : [];
  const nodes = Array.isArray(result.nodes)
    ? result.nodes.filter(
        (value): value is Record<string, unknown> =>
          Boolean(value) && typeof value === 'object' && !Array.isArray(value),
      )
    : [];
  const selected = nodes.find(node =>
    selectionIds.includes(String(node.id || '')),
  );
  if (!response.ok || !selected) {
    figmaArtifactPreviews.set(coordinates.key, {
      status: 'error',
      error: String(
        response.error || studioT('figma.pick_writable'),
      ),
    });
    renderArtifactPatchPreview(artifactEditor.state());
    return;
  }
  try {
    const nextPayload = ArtifactEditor.retargetFigmaPatch(
      state.patchPayload,
      index,
      {...selected, pageId: result.pageId},
    );
    artifactEditor.updatePatchPayload(nextPayload);
    for (const key of [...figmaArtifactPreviews.keys()]) {
      if (key.startsWith(`${state.artifactId}:`)) {
        figmaArtifactPreviews.delete(key);
      }
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

function renderArtifactPatchPreview(state: MagicPointerArtifactEditorState) {
  const host = document.getElementById('artifact-patch-changes');
  if (!host) {
    return;
  }
  const operations = Array.isArray(state.patchPayload?.operations)
    ? (state.patchPayload.operations as Array<Record<string, unknown>>)
    : [];
  if (!operations.length) {
    host.innerHTML =
      '<p class="mp-inspector-empty">' +
      studioT('inspector.no_file_changes') +
      '</p>';
    return;
  }
  const busy = ['loading', 'saving', 'accepting', 'applying'].includes(
    state.status,
  );
  host.innerHTML = operations
    .map((operation, index) => {
      const figmaCoordinates = figmaPatchCoordinates(state, operation, index);
      const preview = figmaCoordinates
        ? figmaArtifactPreviews.get(figmaCoordinates.key)
        : null;
      const figmaPreview = !figmaCoordinates
        ? ''
        : `<div class="mp-figma-artifact-preview">
      ${
        preview?.dataUrl
          ? `<img src="${esc(preview.dataUrl)}" alt="${esc(studioT('figma.preview_alt', {id: figmaCoordinates.nodeId}))}" />`
          : `<p>${esc(preview?.status === 'loading' ? studioT('figma.exporting') : preview?.error || studioT('figma.preview_pending'))}</p>`
      }
      <div>
        <button type="button" data-figma-preview-index="${index}" ${busy ? 'disabled' : ''}>${studioT('figma.refresh_preview')}</button>
        <button type="button" data-figma-retarget-index="${index}" ${busy ? 'disabled' : ''}>${studioT('figma.use_selection')}</button>
      </div>
    </div>`;
      return `<article class="mp-artifact-change">
      ${ArtifactPatchFields.render(operation, index, busy)}
      ${figmaPreview}
    </article>`;
    })
    .join('');
}

function renderArtifactEditor(options: {preservePatchFields?: boolean} = {}) {
  const state = artifactEditor.state();
  document
    .getElementById('artifact-editor')
    ?.classList.toggle('is-document-patch', state.kind === 'document_patch');
  const content = document.getElementById(
    'artifact-editor-content',
  ) as HTMLTextAreaElement | null;
  const kind = document.getElementById('artifact-editor-kind');
  const revision = document.getElementById('artifact-editor-revision');
  const status = document.getElementById('artifact-editor-status');
  const save = document.getElementById(
    'artifact-editor-save',
  ) as HTMLButtonElement | null;
  const accept = document.getElementById(
    'artifact-editor-accept',
  ) as HTMLButtonElement | null;
  const apply = document.getElementById(
    'artifact-editor-apply',
  ) as HTMLButtonElement | null;
  const undo = document.getElementById(
    'artifact-editor-undo',
  ) as HTMLButtonElement | null;
  if (content && document.activeElement !== content) {
    content.value = state.content;
  }
  if (kind) {
    kind.textContent =
      state.kind === 'document_patch' ? 'Document patch' : 'Draft';
  }
  if (revision) {
    revision.textContent = state.revision
      ? `revision ${state.revision}`
      : 'revision —';
  }
  const busy = ['loading', 'saving', 'accepting', 'applying'].includes(
    state.status,
  );
  renderArtifactVersions(state, busy);
  if (undo) {
    undo.hidden = !state.undoAvailable;
    undo.disabled = busy || state.dirty || Boolean(state.preview);
  }
  if (content) {
    content.disabled = busy || !state.artifactId;
    content.hidden = Boolean(state.preview);
  }
  if (save) {
    save.disabled =
      busy ||
      Boolean(state.patchError) ||
      !state.dirty ||
      Boolean(state.preview);
  }
  if (accept) {
    accept.disabled =
      busy ||
      Boolean(state.preview) ||
      state.dirty ||
      !state.artifactId ||
      state.acceptedRevision === state.revision;
  }
  if (apply) {
    apply.disabled =
      busy ||
      Boolean(state.preview) ||
      state.dirty ||
      state.kind !== 'document_patch' ||
      state.applied ||
      state.acceptedRevision !== state.revision;
  }
  if (status) {
    const resultStatus = String(state.applyResult?.status || '');
    status.textContent =
      state.patchError ||
      (state.error === 'stale_revision'
        ? studioT('artifact.newer_version')
        : state.error) ||
      (state.status === 'loading'
        ? studioT('artifact.reading_version')
        : state.status === 'saving'
          ? studioT('artifact.saving_version')
          : state.status === 'accepting'
            ? studioT('artifact.binding_version')
            : state.status === 'applying'
              ? studioT('artifact.writing_verify')
              : resultStatus === 'succeeded'
                ? state.applyResult?.undone
                  ? studioT('artifact.reverted_verified')
                  : studioT('artifact.written_verified')
                : state.acceptedRevision === state.revision &&
                    state.revision > 0
                  ? studioT('artifact.version_accepted')
                  : state.dirty
                    ? studioT('artifact.unsaved_edits')
                    : '');
    status.dataset.tone = state.error || state.patchError ? 'error' : 'neutral';
  }
  if (!options.preservePatchFields && !state.patchError) {
    renderArtifactPatchPreview(state);
  }
  const patchPreview = document.querySelector<HTMLElement>(
    '#artifact-editor .mp-artifact-patch-preview',
  );
  if (patchPreview) {
    patchPreview.hidden = Boolean(state.preview);
  }
}

function renderArtifactVersions(
  state: MagicPointerArtifactEditorState,
  busy: boolean,
): void {
  const select = document.getElementById(
    'artifact-version-select',
  ) as HTMLSelectElement | null;
  const restore = document.getElementById(
    'artifact-version-restore',
  ) as HTMLButtonElement | null;
  const preview = document.getElementById('artifact-version-preview');
  if (select) {
    const versions = artifactEditor.versions();
    select.replaceChildren(
      ...versions.map(version => {
        const option = document.createElement('option');
        option.value = String(version.revision);
        option.textContent = `${studioT('artifact.version_number', {revision: version.revision})}${version.revision === state.revision ? ` · ${studioT('artifact.current_version')}` : ''}`;
        return option;
      }),
    );
    select.value = String(state.preview?.revision || state.revision);
    select.disabled = busy || Boolean(state.patchError) || versions.length < 2;
    select.setAttribute('aria-label', studioT('artifact.version_history'));
  }
  if (restore) {
    restore.hidden = !state.preview;
    restore.disabled = busy || state.dirty;
    restore.textContent = studioT('artifact.restore_version');
  }
  if (preview) {
    preview.hidden = !state.preview;
    const text = preview.querySelector('pre');
    const label = preview.querySelector('strong');
    if (label) {
      label.textContent = studioT('artifact.historical_preview');
    }
    if (text) {
      text.textContent = state.preview
        ? state.preview.content +
          (state.preview.patchPayload
            ? `\n\n${JSON.stringify(state.preview.patchPayload.operations || [], null, 2)}`
            : '')
        : '';
    }
  }
}

document
  .getElementById('artifact-version-select')
  ?.addEventListener('change', async event => {
    const select = event.currentTarget as HTMLSelectElement;
    const revision = Number(select.value);
    const pending = artifactEditor.previewVersion(revision);
    renderArtifactEditor();
    select.value = String(revision);
    await pending;
    renderArtifactEditor();
  });
document
  .getElementById('artifact-version-restore')
  ?.addEventListener('click', async () => {
    const revision = artifactEditor.state().preview?.revision;
    if (!revision) {
      return;
    }
    const pending = artifactEditor.restoreVersion(revision);
    renderArtifactEditor();
    await pending;
    renderArtifactEditor();
  });

async function openArtifactEditor(
  conversationId: string,
  artifactId: string,
  options: {fromResourceTab?: boolean; auto?: boolean} = {},
) {
  if (!conversationId || !artifactId) {
    return;
  }
  if (activeConversationId !== conversationId) {
    await openConversation(conversationId);
  }
  if (!options.fromResourceTab) {
    openWorkspaceResource({
      kind: 'artifact',
      title: 'Artifact',
      resourceKey: `artifact:${conversationId}:${artifactId}`,
      conversationId,
      artifactId,
      auto: options.auto,
    });
  }
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

document
  .getElementById('artifact-editor-content')
  ?.addEventListener('input', event => {
    artifactEditor.updateContent(
      (event.currentTarget as HTMLTextAreaElement).value,
    );
    renderArtifactEditor();
  });
function updateArtifactPatchFields(event: Event): void {
  const target = event.target as HTMLElement | null;
  const host = document.getElementById('artifact-patch-changes');
  if (
    !host ||
    !target?.closest('[data-value-path], [data-cell-type], [data-color-none]')
  ) {
    return;
  }
  const cell = target.closest('[data-cell-editor]');
  const cellInput = cell?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    '[data-value-path]',
  );
  if (cellInput && target.matches('[data-cell-type]')) {
    cellInput.readOnly = (target as HTMLSelectElement).value === 'blank';
    if (cellInput.readOnly) {
      cellInput.value = '';
    }
  }
  if (target.matches('[data-color-none]')) {
    const color = target
      .closest('[data-optional-color]')
      ?.querySelector<HTMLInputElement>('[type="color"]');
    if (color) {
      color.disabled = (target as HTMLInputElement).checked;
    }
  }
  const state = artifactEditor.state();
  const operations = Array.isArray(state.patchPayload?.operations)
    ? (state.patchPayload.operations as Array<Record<string, unknown>>)
    : [];
  try {
    artifactEditor.updatePatchPayload({
      ...state.patchPayload,
      operations: ArtifactPatchFields.read(host, operations),
    });
  } catch (error) {
    artifactEditor.setPatchError(
      error instanceof Error ? error.message : String(error),
    );
  }
  renderArtifactEditor({preservePatchFields: true});
}
document
  .getElementById('artifact-patch-changes')
  ?.addEventListener('input', updateArtifactPatchFields);
document
  .getElementById('artifact-patch-changes')
  ?.addEventListener('change', updateArtifactPatchFields);
document
  .getElementById('artifact-patch-changes')
  ?.addEventListener('keydown', ArtifactPatchFields.editText);
document
  .getElementById('artifact-patch-changes')
  ?.addEventListener('paste', ArtifactPatchFields.editText);
document
  .getElementById('artifact-patch-changes')
  ?.addEventListener('click', event => {
    const target = event.target as Element | null;
    const preview = target?.closest<HTMLButtonElement>(
      '[data-figma-preview-index]',
    );
    if (preview) {
      void loadFigmaArtifactPreview(
        Number(preview.dataset.figmaPreviewIndex),
        true,
      );
      return;
    }
    const retarget = target?.closest<HTMLButtonElement>(
      '[data-figma-retarget-index]',
    );
    if (retarget) {
      void retargetFigmaArtifact(Number(retarget.dataset.figmaRetargetIndex));
    }
  });
document
  .getElementById('artifact-editor-save')
  ?.addEventListener('click', async () => {
    const pending = artifactEditor.save();
    renderArtifactEditor();
    await pending;
    renderArtifactEditor();
    void refreshFigmaArtifactPreviews();
  });
document
  .getElementById('artifact-editor-accept')
  ?.addEventListener('click', async () => {
    const pending = artifactEditor.accept();
    renderArtifactEditor();
    await pending;
    renderArtifactEditor();
  });
document
  .getElementById('artifact-editor-apply')
  ?.addEventListener('click', async () => {
    const pending = artifactEditor.apply();
    renderArtifactEditor();
    await pending;
    const state = artifactEditor.state();
    for (const key of [...figmaArtifactPreviews.keys()]) {
      if (key.startsWith(`${state.artifactId}:`)) {
        figmaArtifactPreviews.delete(key);
      }
    }
    renderArtifactEditor();
    void refreshFigmaArtifactPreviews();
  });

document
  .getElementById('artifact-editor-undo')
  ?.addEventListener('click', async () => {
    if (
      !window.confirm(
        studioT('artifact.confirm_revert'),
      )
    ) {
      return;
    }
    const pending = artifactEditor.undo(true);
    renderArtifactEditor();
    await pending;
    renderArtifactEditor();
    void refreshFigmaArtifactPreviews(true);
  });

let recoveryRenderGeneration = 0;

/* Slice-local copy of the recovery strings: snippet tests evaluate this
 * range without the locale script, and one frozen test pins the Chinese
 * fallback text. In the studio page this delegates to studioT. */
const RECOVERY_TEXT_ZH: Record<string, string> = {
  'recovery.no_record':
    '找不到此任务的运行记录，暂时无法核对执行恢复状态。已保存的对话仍可查看。',
  'recovery.read_failed': '无法读取执行恢复状态：{error}',
  'recovery.pending_title': '待核对 · {title}',
  'recovery.pick_readback': '选择用于核对的读取记录',
  'recovery.read_first': '请先让 Agent 读取目标并核对现场，再允许重新执行。',
  'task.allow_after_verify': '核对后允许重新执行',
  'task.confirm_allow': '确认已核对显示的读回内容，并允许重新执行这项操作？',
  'recovery.failed': '恢复失败',
  'common.unknown_error': '未知错误',
};

function recoveryText(
  id: string,
  params?: Record<string, string | number>,
): string {
  if (typeof studioT === 'function') {
    return studioT(id, params);
  }
  let out = RECOVERY_TEXT_ZH[id] ?? id;
  if (params) {
    for (const key of Object.keys(params)) {
      out = out.split(`{${key}}`).join(String(params[key]));
    }
  }
  return out;
}
async function renderConversationRecovery(
  conversationId: string,
): Promise<void> {
  const generation = ++recoveryRenderGeneration;
  const host = document.getElementById('conversation-recovery');
  if (!host) {
    return;
  }
  host.replaceChildren();
  host.hidden = true;
  const response: Record<string, any> = await Data.recovery({
    conversationId,
  }).catch((error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  if (
    activeConversationId !== conversationId ||
    generation !== recoveryRenderGeneration
  ) {
    return;
  }
  const attention = document.getElementById('execution-attention');
  if (attention) {
    attention.hidden = true;
    attention.textContent = '';
  }
  if (response.ok === false) {
    const message = document.createElement('p');
    message.textContent =
      response.error === 'session_not_found'
        ? recoveryText('recovery.no_record')
        : recoveryText('recovery.read_failed', {
            error: String(response.error || recoveryText('common.unknown_error')),
          });
    host.appendChild(message);
    host.hidden = false;
    return;
  }
  const operations = Array.isArray(response.pendingRecovery)
    ? response.pendingRecovery
    : [];
  if (attention && operations.length) {
    attention.hidden = false;
    attention.textContent = String(operations.length);
  }
  for (const operation of operations) {
    const section = document.createElement('details');
    const title = document.createElement('summary');
    const label = ChatView.toolRowModel(
      String(operation.tool || ''),
      JSON.stringify(operation.arguments || {}),
    );
    title.textContent = label.summary
      ? `${recoveryText('recovery.pending_title', {title: label.title})} · ${label.summary}`
      : recoveryText('recovery.pending_title', {title: label.title});
    const details = document.createElement('pre');
    details.textContent = JSON.stringify(operation.arguments, null, 2);
    const candidates = Array.isArray(operation.verificationCandidates)
      ? operation.verificationCandidates
      : [];
    const select = document.createElement('select');
    select.setAttribute('aria-label', recoveryText('recovery.pick_readback'));
    candidates.forEach((candidate: any, index: number) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `${String(candidate.tool)} · ${String(candidate.callId)}`;
      select.appendChild(option);
    });
    const readback = document.createElement('pre');
    const showReadback = () => {
      const candidate = candidates[Number(select.value) || 0];
      readback.textContent = candidate
        ? JSON.stringify(
            {arguments: candidate.arguments, result: candidate.result},
            null,
            2,
          )
        : recoveryText('recovery.read_first');
    };
    select.addEventListener('change', showReadback);
    showReadback();
    const allow = document.createElement('button');
    allow.textContent = recoveryText('task.allow_after_verify');
    allow.disabled = !candidates.length;
    allow.addEventListener('click', async () => {
      const candidate = candidates[Number(select.value) || 0];
      if (
        !candidate ||
        !window.confirm(recoveryText('task.confirm_allow'))
      ) {
        return;
      }
      allow.disabled = true;
      const result = await Data.recovery({
        conversationId,
        action: 'resolve',
        operationId: operation.operationId,
        verificationCallId: candidate.callId,
        confirmed: true,
      });
      if (result.ok) {
        await renderConversationRecovery(conversationId);
      } else {
        readback.textContent = String(result.error || recoveryText('recovery.failed'));
        allow.disabled = false;
      }
    });
    section.append(title, details, select, readback, allow);
    host.appendChild(section);
  }
  host.hidden = operations.length === 0;
}

function renderConversationActivity(): void {
  const host = document.getElementById('conversation-activity');
  if (!host) {
    return;
  }
  const turns = [...activeConversationTurns] as MagicPointerTurn[];
  const turn = turns.at(-1);
  if (pendingConversation) {
    const turnIndex = pendingConversation.scope
      ? Number(pendingConversation.scope.split('#').at(-1))
      : turns.length;
    const index =
      Number.isInteger(turnIndex) && turnIndex >= 0 ? turnIndex : turns.length;
    turns[index] = {
      ...turns[index],
      question: turns[index]?.question || pendingConversation.question,
      startedAt: turns[index]?.startedAt || pendingConversation.startedAt,
      liveProgress: pendingConversation.transcript,
    };
  }
  const input: MagicPointerSessionLogInput = {
    scope: activeConversationId || pendingConversation?.conversationId || 'new',
    turns,
    workspaceBranch: currentComposerBranch() || undefined,
    worktreeBranch:
      composerWorktrees.get(currentComposerWorktreeKey())?.branch || undefined,
    waiting: Boolean(
      turn?.pendingInput &&
      !turn.liveProgress &&
      !pendingConversation?.inputAccepted,
    ),
    running: Boolean(pendingConversation || turn?.liveProgress),
    onLocate: (index, callId) => {
      setConversationTab('chat');
      const message =
        document.querySelector<HTMLElement>(
          `.mp-chat-flow-item[data-turn-index="${index}"]`,
        ) || pendingConversation?.body;
      const target =
        (callId &&
          message?.querySelector<HTMLElement>(
            `[data-call-id="${CSS.escape(callId)}"]`,
          )) ||
        message;
      if (!target) {
        return;
      }
      target.scrollIntoView({
        block: 'center',
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      });
      target.classList.add('mp-session-located');
      window.setTimeout(
        () => target.classList.remove('mp-session-located'),
        1600,
      );
    },
  };
  ExecutionView.render(host, input);
  const full = document.getElementById('trajectory');
  if (full && activeConversationTab === 'trajectory') {
    ExecutionView.render(full, input);
  }
}

function pendingToolRequestId(turn?: MagicPointerTurn): string {
  const calls = turn?.trajectory || [];
  return String(
    [...calls]
      .reverse()
      .find(
        record =>
          record.kind === 'tool' &&
          ['AskUser', 'AskUserQuestion', 'ask_user_question'].includes(
            String(record.name),
          ),
      )?.callId || '',
  );
}

function esc(v: unknown) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cssUrl(v: unknown) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '/')
    .replace(/'/g, '%27')
    .replace(/"/g, '%22');
}

const shell = document.getElementById('shell') as HTMLElement;
const aux = document.getElementById('aux') as HTMLElement;
let lastNonSettingsView = 'chat';
const studioShell = globalThis.StudioShell;
const sidebarState = StudioSidebarState.create(localStorage, window.innerWidth);
const VIEWS: Record<string, string> = Object.fromEntries(
  studioShell.STUDIO_VIEWS.map((view: {id: string}) => [
    view.id,
    `view-${view.id}`,
  ]),
);
const libraryUi = studioLibraries.createController({
  data: Data,
  show,
  compose: composeLibraryPrompt,
  startProjectChat: (project: MagicPointerProject, prompt: string) => {
    setActiveProject(project.root, project.id);
    composeLibraryPrompt(prompt);
    const location = composerLocation();
    captureComposerDraft();
    const draft = windowNavigation.draft(location)!;
    windowNavigation.saveDraft(location, {
      ...draft,
      returnToProject: ProjectScope.key(project),
    });
    (
      document.getElementById('composer-form') as HTMLFormElement
    ).requestSubmit();
  },
  openProject: openProjectFromPicker,
  selectProject: setActiveProject,
  projectDraft: (key: string) =>
    windowNavigation.draft({kind: 'project', id: key})?.text || '',
  onProjectDraftChange: (key: string, text: string) => {
    windowNavigation.saveDraft(
      {kind: 'project', id: key},
      {text, attachments: [], sourceIds: [], workspaceRoot: ''},
    );
  },
  renameConversation: openRenameDialog,
  changeProject: (id: string, anchor: HTMLElement) => {
    void openProjectAssignment(id, anchor);
  },
  refreshSidebar: renderSidebar,
  requestText: requestStudioText,
  connectFigma: () => {
    show('chat');
    setInspector(true, 'files');
    void refreshFigmaConnection(true);
  },
  conversationId: () => activeConversationId,
});

function composeLibraryPrompt(prompt: string): void {
  startNewChat();
  show('chat');
  const input = document.querySelector<HTMLTextAreaElement>(
    '#composer-form textarea',
  );
  if (input) {
    input.value = prompt;
    fitComposer(input);
    input.focus();
  }
}

const personalActivityUi = globalThis.PersonalActivityView?.mount(
  document.getElementById('personal-activity'),
  window.magicPointerDashboard?.personalActivity,
);
const resourceLibraryUi = globalThis.ResourceLibrary?.mount(
  document.getElementById('resource-library')!,
  window.magicPointerDashboard?.resources,
  {openTask: id => {void openConversation(id);}, openCanvas: () => show('stash')},
);
document
  .getElementById('personal-activity')
  ?.addEventListener('personal-activity-open-conversation', event => {
    const id = (event as CustomEvent<{conversationId: string}>).detail
      ?.conversationId;
    if (id) {
      void openConversation(id);
    }
  });
document
  .getElementById('personal-activity')
  ?.addEventListener('personal-activity-analyze', event => {
    const date = (event as CustomEvent<{date: string}>).detail?.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return;
    }
    startNewChat();
    show('chat');
    const input = document.querySelector<HTMLTextAreaElement>('.mpw-input');
    if (input) {
      input.value = `请用 Activity.read 回顾 ${date} 的已记录活动：按工作主题整理实际推进和产物，列出有原始证据的待核查线索，以及可继续的下一步。引用具体时间、窗口或文件；区分观察和推断，不把截图间隔当作连续工作时间，不凭聊天片段确认承诺或未回复。缺少的记录请直接说明。`;
      input.dispatchEvent(new Event('input', {bubbles: true}));
      input.focus();
    }
  });

function show(view: string, projectKey?: string) {
  dismissSidebar();
  const current = studioShell.shellState(view);
  view = current.activeView;
  if (view !== 'dashboard') {
    dashboardRenderGeneration += 1;
    closeDashboardTrace();
  }
  if (view !== 'chat') {
    captureComposerDraft();
    conversationOpenGeneration += 1;
  }
  shell.dataset.view = view;
  document.getElementById('workspace-eyebrow')!.textContent = current.eyebrow;
  document.getElementById('workspace-title')!.textContent = current.title;
  document.getElementById('workspace-description')!.textContent =
    current.description;
  if (view !== 'settings') {
    lastNonSettingsView = view;
  }
  Object.entries(VIEWS).forEach(([k, id]) => {
    const element = document.getElementById(id);
    if (element) {
      element.hidden = k !== view;
    }
  });
  document.querySelectorAll<HTMLElement>('[data-goto]').forEach(item => {
    const layout =
      document.querySelector<HTMLElement>('#stash-mode .is-on')?.dataset.mode;
    item.classList.toggle(
      'is-on',
      item.dataset.goto === view &&
        (!item.dataset.designLayout || item.dataset.designLayout === layout),
    );
  });
  if (view === 'stash') {
    renderStash(true);
    bindCanvas();
  }
  if (view === 'artifacts') {
    renderArtifacts();
  }
  if (view === 'dashboard') {
    void renderDashboardView();
  }
  if (view === 'settings') {
    renderSettings();
  }
  if (view === 'personal') {
    personalActivityUi?.show();
  } else {
    personalActivityUi?.hide();
  }
  if (view === 'resources') {resourceLibraryUi?.show();} else {resourceLibraryUi?.hide();}
  void libraryUi.render(
    view,
    view === 'projects' ? projectKey || '' : undefined,
  );
  if (view !== 'chat') {
    closeAux();
    if (shell.dataset.inspector === 'open') {
      setInspector(false);
    }
    if (shell.dataset.bottomPanel === 'open') {
      setBottomPanel(false);
    }
  }
  recordWindowNavigation(view, projectKey);
}

const windowNavigation = StudioNavigation.create();
interface NavigationSubmission {
  location: StudioComposerLocation;
  draft: StudioComposerDraft;
  keepOriginal: boolean;
  accepted: boolean;
  workspace?: PreparedComposerWorkspace;
}
const navigationSubmissions = new Map<string, NavigationSubmission>();
let displayedComposer: {
  location: StudioComposerLocation;
  workspaceRoot: string;
  projectId?: string;
} | null = null;

function composerLocation(): StudioComposerLocation {
  const id = activeConversationId || pendingConversation?.conversationId;
  return id
    ? {kind: 'conversation', id}
    : {kind: 'draft', id: newChatWorktreeId};
}

function captureComposerDraft(): void {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    '#composer-form textarea',
  );
  if (!displayedComposer || !textarea || shell.dataset.view !== 'chat') {
    return;
  }
  const owner = displayedComposer;
  const submission = [...navigationSubmissions.values()].find(
    item =>
      !item.accepted &&
      item.location.kind === owner.location.kind &&
      item.location.id === owner.location.id,
  );
  if (
    submission?.keepOriginal &&
    !textarea.value &&
    composerAttachments.length === submission.draft.attachments.length &&
    composerAttachments.every(
      (file, index) => file === submission.draft.attachments[index],
    ) &&
    composerSelectedSourceIds.size === submission.draft.sourceIds.length &&
    submission.draft.sourceIds.every(sourceId =>
      composerSelectedSourceIds.has(sourceId),
    ) &&
    composerAdditionalFolders.length ===
      (submission.draft.additionalFolders?.length || 0) &&
    composerAdditionalFolders.every(
      (folder, index) => folder === submission.draft.additionalFolders?.[index],
    ) &&
    sameModelSelection(
      currentComposerModelSelection(),
      submission.draft.modelSelection,
    ) &&
    composerPreset === submission.draft.permissionPreset &&
    composerEffort === submission.draft.effort &&
    currentComposerBranch() === submission.draft.branch &&
    currentComposerWorktreeEnabled() === submission.draft.worktree
  ) {
    return;
  }
  if (submission) {
    submission.keepOriginal = false;
  }
  windowNavigation.saveDraft(displayedComposer.location, {
    text: textarea.value,
    attachments: [...composerAttachments],
    sourceIds: [...composerSelectedSourceIds],
    workspaceRoot: displayedComposer.workspaceRoot,
    projectId: displayedComposer.projectId,
    additionalFolders: [...composerAdditionalFolders],
    returnToProject: windowNavigation.draft(owner.location)?.returnToProject,
    modelSelection: currentComposerModelSelection(),
    permissionPreset: composerPreset,
    effort: composerEffort,
    branch: currentComposerBranch(),
    worktree: currentComposerWorktreeEnabled(),
  });
}

function restoreComposerDraft(
  location: StudioComposerLocation,
  saved?: Pick<
    MagicPointerConversation,
    'additionalFolders' | 'modelSelection' | 'taskContext' | 'turns'
  >,
): void {
  const draft = windowNavigation.draft(location);
  const project = ProjectScope.find(
    cachedProjects || [],
    activeProjectId || activeProjectRoot,
  );
  const environment =
    location.kind === 'draft' && !draft && !saved
      ? project?.environments?.find(
          item => item.id === project.defaultEnvironmentId,
        )
      : undefined;
  const savedWorkspace = saved?.turns?.at(-1)?.request as {
    branch?: string;
    worktree?: boolean;
    executionWorkspaceRoot?: string;
    executionBranch?: string;
  } | undefined;
  composerBranchSelection =
    draft?.branch ?? (saved ? savedWorkspace?.branch ?? '' : environment?.branch);
  const worktreeKey = currentComposerWorktreeKey();
  const worktree =
    draft?.worktree ??
    (saved
      ? savedWorkspace?.worktree ?? composerWorktreeEnabledKeys.has(worktreeKey)
      : environment?.worktree ?? false);
  if (worktree) {
    composerWorktreeEnabledKeys.add(worktreeKey);
    if (
      savedWorkspace?.executionWorkspaceRoot &&
      !composerWorktrees.has(worktreeKey)
    ) {
      composerWorktrees.set(worktreeKey, {
        path: savedWorkspace.executionWorkspaceRoot,
        branch:
          savedWorkspace.executionBranch || savedWorkspace.branch || 'worktree',
        baseBranch: savedWorkspace.branch || '',
        base: activeProjectRoot,
        conversationId: location.id,
      });
    }
  } else {
    composerWorktreeEnabledKeys.delete(worktreeKey);
  }
  persistComposerWorktrees();
  renderComposerBranch();
  renderComposerWorktree();
  const textarea = document.querySelector<HTMLTextAreaElement>(
    '#composer-form textarea',
  );
  if (textarea) {
    textarea.value = draft?.text || '';
    fitComposer(textarea);
  }
  composerAttachments = [...(draft?.attachments || [])];
  composerAdditionalFolders = [
    ...(draft?.additionalFolders ??
      saved?.additionalFolders ??
      environment?.additionalFolders ??
      []),
  ];
  const selection =
    draft?.modelSelection ?? saved?.modelSelection ?? environment?.modelSelection;
  composerModelSelection = selection ? {...selection} : undefined;
  const savedPreset = permPresets.presetForMode(
    saved?.taskContext?.permissionMode,
  );
  composerPreset =
    (pendingPermissionSelections.has(`${location.kind}:${location.id}`)
      ? draft?.permissionPreset
      : savedPreset) ??
    draft?.permissionPreset ??
    environment?.permissionPreset ??
    defaultComposerPreset;
  composerEffort =
    draft?.effort ??
    saved?.taskContext?.effort ??
    environment?.effort ??
    defaultComposerEffort;
  renderEffortChip();
  renderPermissionChip();
  renderComposerModel();
  renderComposerFolders();
  composerSelectedSourceIds.clear();
  const available = new Set(
    activeTaskContext?.sources.map(source => source.sourceId) || [],
  );
  for (const sourceId of draft?.sourceIds || []) {
    if (available.has(sourceId)) {
      composerSelectedSourceIds.add(sourceId);
    }
  }
  displayedComposer = {
    location,
    workspaceRoot: activeProjectRoot,
    projectId: activeProjectId,
  };
  renderComposerAttachments();
  renderComposerMaterials();
  syncComposerSubmitState();
}

function acceptSubmissionNavigation(
  requestId: string,
  conversationId: string,
  title?: string,
): void {
  const submission = navigationSubmissions.get(requestId);
  if (!submission || submission.accepted) {
    return;
  }
  const visible =
    displayedComposer?.location.kind === submission.location.kind &&
    displayedComposer.location.id === submission.location.id;
  if (visible) {
    captureComposerDraft();
  }
  if (submission.keepOriginal) {
    windowNavigation.clearDraft(submission.location);
  }
  const location: StudioComposerLocation = {
    kind: 'conversation',
    id: conversationId,
  };
  windowNavigation.retarget(submission.location, location);
  submission.location = location;
  submission.accepted = true;
  submission.keepOriginal = false;
  if (submission.workspace) {
    adoptComposerWorktreeConversation(
      submission.workspace.contextKey,
      submission.workspace.projectRoot,
      conversationId,
    );
  }
  if (visible && displayedComposer) {
    displayedComposer.location = location;
    composerAttachments = composerAttachments.filter(
      file => !submission.draft.attachments.includes(file),
    );
    for (const sourceId of submission.draft.sourceIds) {
      composerSelectedSourceIds.delete(sourceId);
    }
    renderComposerAttachments();
    renderComposerMaterials();
    if (pendingConversation?.requestId === requestId) {
      activeConversationId = conversationId;
      const heading = document.getElementById('chat-title');
      if (heading && title) {
        heading.textContent = title;
      }
    }
  }
  syncWindowNavigation();
}

function syncWindowNavigation() {
  const back = document.getElementById(
    'window-back',
  ) as HTMLButtonElement | null;
  const forward = document.getElementById(
    'window-forward',
  ) as HTMLButtonElement | null;
  const state = windowNavigation.state();
  if (back) {
    back.disabled = !state.canBack;
  }
  if (forward) {
    forward.disabled = !state.canForward;
  }
}

function recordWindowNavigation(view: string, projectKey?: string) {
  const location: StudioLocation =
    view === 'chat'
      ? composerLocation()
      : view === 'projects' && projectKey
        ? {kind: 'project', id: projectKey}
        : {kind: 'view', view};
  windowNavigation.visit(location);
  syncWindowNavigation();
}

function moveWindowNavigation(delta: -1 | 1) {
  captureComposerDraft();
  const next = windowNavigation.move(delta);
  if (!next) {
    return;
  }
  syncWindowNavigation();
  if (next.kind === 'project') {
    show('projects', next.id);
  } else if (next.kind === 'conversation') {
    void openConversation(next.id).then(opened => {
      if (!opened && windowNavigation.isCurrent(next)) {
        windowNavigation.replace({kind: 'view', view: 'chats'});
        show('chats');
      }
    });
  } else if (next.kind === 'draft') {
    startNewChat(next.id);
    show('chat');
  } else {
    show(next.view);
  }
}

document
  .getElementById('window-back')
  ?.addEventListener('click', () => moveWindowNavigation(-1));
document
  .getElementById('window-forward')
  ?.addEventListener('click', () => moveWindowNavigation(1));
syncWindowNavigation();

type ProductMode = 'walker' | 'design';
let productMode: ProductMode = 'walker';

function setProductMode(mode: ProductMode, navigate = true) {
  const changed = productMode !== mode;
  productMode = mode;
  shell.dataset.productMode = mode;
  const designNav = document.querySelector<HTMLElement>('.mp-design-nav');
  const workNav = document.querySelector<HTMLElement>('.mp-main-navigation');
  if (designNav) {
    designNav.hidden = true;
  }
  if (workNav) {
    workNav.hidden = false;
  }
  document
    .querySelectorAll<HTMLElement>('[data-product-mode]')
    .forEach(button => {
      const selected = button.dataset.productMode === mode;
      button.classList.toggle('is-on', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
  try {
    localStorage.setItem('mp:product-mode', mode);
  } catch {
    /* renderer storage unavailable */
  }
  if (navigate) {
    if (changed && activeConversationId) {
      startNewChat();
    }
    show('chat');
  }
}

(function bindProductMode() {
  try {
    productMode =
      localStorage.getItem('mp:product-mode') === 'design'
        ? 'design'
        : 'walker';
  } catch {
    productMode = 'walker';
  }
  setProductMode(productMode, false);
  document
    .getElementById('mode-work')
    ?.addEventListener('click', () => setProductMode('walker'));
  document
    .getElementById('mode-design')
    ?.addEventListener('click', () => setProductMode('design'));
  document.getElementById('mode-switch')?.addEventListener('keydown', event => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const mode =
      event.key === 'Home'
        ? 'design'
        : event.key === 'End'
          ? 'walker'
          : productMode === 'walker'
            ? 'design'
            : 'walker';
    setProductMode(mode);
    document
      .getElementById(mode === 'walker' ? 'mode-work' : 'mode-design')
      ?.focus();
  });
})();

(function bindDesignHome() {
  document
    .querySelectorAll<HTMLElement>('[data-design-action]')
    .forEach(button => {
      button.addEventListener('click', () => {
        const action = button.dataset.designAction;
        if (action === 'canvas' || action === 'list') {
          show('stash');
          requestAnimationFrame(() => {
            document
              .querySelector<HTMLElement>(`#stash-mode [data-mode="${action}"]`)
              ?.click();
          });
          return;
        }
        if (action === 'files') {
          show('design');
          setInspector(true, 'files');
          return;
        }
        if (action === 'artifacts') {
          show('artifacts');
        }
      });
    });
})();

let windowMenuTrigger: HTMLElement | null = null;

function studioMenuItems(menu: HTMLElement): HTMLButtonElement[] {
  return [
    ...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
  ].filter(
    button =>
      button.closest('[role="menu"]') === menu &&
      button.getClientRects().length > 0,
  );
}

function enterStudioMenu(menu: HTMLElement): void {
  const items = studioMenuItems(menu);
  for (const item of items) {
    if (!item.hasAttribute('role')) {
      item.setAttribute('role', 'menuitem');
    }
    item.tabIndex = -1;
  }
  items[0]?.focus();
}

function closeWindowMenu(restoreFocus = false) {
  const popover = document.getElementById('window-menu-popover');
  if (popover) {
    popover.hidden = true;
  }
  document
    .querySelectorAll<HTMLElement>('[data-window-menu]')
    .forEach(button => button.setAttribute('aria-expanded', 'false'));
  document.getElementById('app-menu')?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) {
    windowMenuTrigger?.focus({preventScroll: true});
  }
  windowMenuTrigger = null;
}

function openWindowMenu(button: HTMLElement, menuName: string) {
  const popover = document.getElementById('window-menu-popover');
  if (!popover) {
    return;
  }
  const wasOpen =
    !popover.hidden && button.getAttribute('aria-expanded') === 'true';
  closeWindowMenu();
  if (wasOpen) {
    return;
  }
  document
    .querySelectorAll<HTMLElement>('[data-window-menu-panel]')
    .forEach(panel => {
      panel.hidden =
        menuName !== 'all' && panel.dataset.windowMenuPanel !== menuName;
    });
  const rect = button.getBoundingClientRect();
  popover.style.left = `${Math.max(4, rect.left)}px`;
  popover.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  windowMenuTrigger = button;
  enterStudioMenu(popover);
}

document
  .querySelectorAll<HTMLElement>('.mp-window-menu-bar [data-window-menu]')
  .forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      openWindowMenu(button, button.dataset.windowMenu || 'file');
    });
    button.addEventListener('pointerenter', () => {
      if (document.getElementById('window-menu-popover')?.hidden === false) {
        openWindowMenu(button, button.dataset.windowMenu || 'file');
      }
    });
  });

document.getElementById('app-menu')?.addEventListener('click', event => {
  event.stopPropagation();
  openWindowMenu(event.currentTarget as HTMLElement, 'all');
});

function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark');
  try {
    localStorage.setItem('mp:theme', theme);
  } catch {
    /* renderer storage unavailable */
  }
  window.magicPointerDashboard?.setTheme?.(theme);
  const use = document.getElementById('theme-toggle-icon');
  use?.setAttribute('href', theme === 'dark' ? '#ic-sun' : '#ic-moon');
  const toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.setAttribute(
      'aria-label',
      theme === 'dark' ? studioT('theme.to_light') : studioT('theme.to_dark'),
    );
  }
}

function toggleAnimatedTheme(origin?: {x: number; y: number}) {
  const next =
    document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  const documentWithTransition = document as Document & {
    startViewTransition?: (callback: () => void) => {ready: Promise<void>};
  };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!documentWithTransition.startViewTransition || reduceMotion) {
    applyTheme(next);
    return;
  }
  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? 22;
  const radius = Math.hypot(
    Math.max(x, innerWidth - x),
    Math.max(y, innerHeight - y),
  );
  const transition = documentWithTransition.startViewTransition(() =>
    applyTheme(next),
  );
  void transition.ready
    .then(() => {
      document.documentElement.animate(
        {
          clipPath: [
            `circle(0px at ${x}px ${y}px)`,
            `circle(${radius}px at ${x}px ${y}px)`,
          ],
        },
        {
          duration: 400,
          easing: 'cubic-bezier(.2,.8,.2,1)',
          pseudoElement: '::view-transition-new(root)',
        } as KeyframeAnimationOptions,
      );
    })
    .catch(() => {});
}

(function bindVisibleThemeToggle() {
  const button = document.getElementById('theme-toggle');
  const current =
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  document.body.toggleAttribute('data-ds-dark-theme', current === 'dark');
  const use = document.getElementById('theme-toggle-icon');
  use?.setAttribute('href', current === 'dark' ? '#ic-sun' : '#ic-moon');
  button?.setAttribute(
    'aria-label',
    current === 'dark' ? studioT('theme.to_light') : studioT('theme.to_dark'),
  );
  button?.addEventListener('click', () => {
    const rect = button.getBoundingClientRect();
    toggleAnimatedTheme({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
  });
})();

function openInformationDialog(title: string, detail: string) {
  const overlay = document.createElement('dialog');
  overlay.className = 'mpw-perm-confirm';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title);
  const card = document.createElement('div');
  card.className = 'mpw-perm-confirm-card';
  const heading = document.createElement('b');
  heading.textContent = title;
  const body = document.createElement('p');
  body.style.whiteSpace = 'pre-line';
  body.textContent = detail;
  const actions = document.createElement('div');
  actions.className = 'mpw-perm-confirm-actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'is-primary';
  close.textContent = studioT('common.done');
  close.addEventListener('click', () => overlay.close());
  actions.appendChild(close);
  card.append(heading, body, actions);
  overlay.appendChild(card);
  overlay.addEventListener('click', event => {
    if (event.target === overlay) {
      overlay.close();
    }
  });
  showStudioDialog(overlay);
  close.focus();
}

async function executeWindowMenuCommand(command: string, origin?: HTMLElement) {
  closeWindowMenu(
    document.getElementById('window-menu-popover')?.contains(document.activeElement),
  );
  if (command === 'new-chat') {
    show('chat');
    startNewChat();
    return;
  }
  if (command === 'open-project') {
    await openProjectFromPicker();
    return;
  }
  if (command === 'add-files' || command === 'add-folder') {
    const picked = await Data.pickProjectFiles(
      activeProjectRoot,
      command === 'add-folder' ? 'folder' : 'files',
    );
    if (picked?.ok && Array.isArray(picked.paths)) {
      composerAttachments = [
        ...new Set([...composerAttachments, ...picked.paths.map(String)]),
      ];
      renderComposerAttachments();
      show('chat');
    }
    return;
  }
  if (command === 'open-project-folder') {
    if (activeProjectRoot) {
      await Data.openProjectPath(activeProjectRoot, '');
    }
    return;
  }
  if (command === 'toggle-sidebar') {
    toggleSidebar();
    return;
  }
  if (command === 'toggle-inspector') {
    if (inspectorState.open) {
      closeInspectorPanel();
    } else {
      setInspector(true, activeInspectorTab);
    }
    return;
  }
  if (command === 'toggle-bottom-panel') {
    toggleTerminalPanel();
    return;
  }
  if (command === 'toggle-theme') {
    const rect = origin?.getBoundingClientRect();
    toggleAnimatedTheme(
      rect
        ? {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2}
        : undefined,
    );
    return;
  }
  if (command === 'settings') {
    show('settings');
    return;
  }
  if (command === 'shortcuts') {
    openInformationDialog(
      studioT('shortcuts.title'),
      studioT('shortcuts.body'),
    );
    return;
  }
  if (command === 'about') {
    const result = await Data.windowCommand('about');
    openInformationDialog(
      studioT('help.about'),
      `Magic Pointer ${result.version || ''}\nElectron ${result.electron || ''}\nChromium ${result.chrome || ''}`,
    );
    return;
  }
  await Data.windowCommand(command);
}

function closeAccountMenu(restoreFocus = false) {
  closeAnchoredPopover('account-menu', 'account-footer');
  if (restoreFocus) {
    document.getElementById('account-footer')?.focus({preventScroll: true});
  }
}

function closeAccountSubmenu(restoreFocus = false): void {
  const menu = document.getElementById('account-submenu');
  const parentCommand = menu?.dataset.parentCommand;
  if (menu) {
    menu.hidden = true;
    delete menu.dataset.parentCommand;
  }
  document
    .querySelectorAll('[data-account-command][aria-haspopup]')
    .forEach(row => row.setAttribute('aria-expanded', 'false'));
  if (restoreFocus && parentCommand) {
    document
      .querySelector<HTMLElement>(`[data-account-command="${parentCommand}"]`)
      ?.focus({preventScroll: true});
  }
}

function dismissStudioMenu(menu: HTMLElement): void {
  if (menu.id === 'window-menu-popover') {
    closeWindowMenu(true);
  } else if (menu.id === 'thread-menu') {
    closeThreadMenu(true);
  } else if (menu.id === 'sidebar-menu') {
    closeSidebarMenu(true);
  } else if (menu.id === 'account-submenu') {
    closeAccountSubmenu(true);
  } else {
    closeStudioPopovers();
    const trigger = STUDIO_POPOVERS.find(([id]) => id === menu.id)?.[1];
    document
      .getElementById(trigger || 'composer-add')
      ?.focus({preventScroll: true});
  }
}

function openAccountMenu() {
  const menu = document.getElementById('account-menu');
  const sidebar = document.querySelector<HTMLElement>('.mpw-sidebar-col');
  const footer = document.getElementById('account-footer');
  if (!menu || !sidebar || !footer) {
    return;
  }
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
  requestAnimationFrame(() => enterStudioMenu(menu));
}

async function executeAccountCommand(command: string) {
  if (command === 'learn-more' || command === 'language') {
    openAccountSubmenu(command);
    return;
  }
  closeAccountMenu(true);
  if (command === 'settings') {
    show('settings');
    return;
  }
  if (command === 'models') {
    show('settings');
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>('[data-settings-page="models-agents"]')
        ?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    });
    return;
  }
  if (command === 'updates') {
    await Data.checkForUpdates();
    return;
  }
  if (command === 'usage') {
    show('chat');
    setStudioHomeVisible(true);
    return;
  }
  if (command === 'help') {
    await Data.openProjectUrl(
      'https://github.com/Wang-auspicious/Magic-Pointer#readme',
    );
    return;
  }
  if (command === 'changelog') {
    await Data.windowCommand('changelog');
    return;
  }
  if (command === 'shortcuts' || command === 'about') {
    await executeWindowMenuCommand(command);
  }
}

document.getElementById('account-footer')?.addEventListener('click', event => {
  event.stopPropagation();
  const menu = document.getElementById('account-menu');
  if (menu?.hidden) {
    openAccountMenu();
  } else {
    closeAccountMenu();
  }
});

document.getElementById('account-menu')?.addEventListener('click', event => {
  const row = (event.target as Element | null)?.closest<HTMLElement>(
    '[data-account-command]',
  );
  if (!row) {
    return;
  }
  event.stopPropagation();
  void executeAccountCommand(row.dataset.accountCommand || '');
});

document
  .getElementById('account-menu')
  ?.addEventListener('pointerover', event => {
    const row = (event.target as Element)?.closest<HTMLElement>(
      '[data-account-command]',
    );
    if (row?.dataset.accountCommand === 'learn-more') {
      openAccountSubmenu('learn-more');
    } else if (row) {
      closeAccountSubmenu();
    }
  });

document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing) {
    return;
  }
  if (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'u' &&
    document.getElementById('composer-form')?.getClientRects().length
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeStudioPopovers();
    void executeWindowMenuCommand('add-files');
    return;
  }
  const target = event.target as HTMLElement;
  const menu = target?.closest<HTMLElement>(
    '.mp-compact-menu, #account-menu, #window-menu-popover, .mp-thread-menu',
  );
  if (!menu || menu.hidden || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  const rows = studioMenuItems(menu);
  const index = rows.indexOf(target.closest('button') as HTMLButtonElement);
  if (event.key === 'ArrowRight' && menu.id === 'account-menu') {
    const command = rows[index]?.dataset.accountCommand;
    if (command === 'language' || command === 'learn-more') {
      event.preventDefault();
      event.stopImmediatePropagation();
      openAccountSubmenu(command);
    }
    return;
  }
  if (event.key === 'ArrowLeft' && menu.id === 'account-submenu') {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeAccountSubmenu(true);
    return;
  }
  if (event.key === 'Tab') {
    if (menu.id === 'account-submenu') {
      closeAccountMenu();
      document.getElementById('account-footer')?.focus({preventScroll: true});
    } else {
      dismissStudioMenu(menu);
    }
    return;
  }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : index < 0
            ? event.key === 'ArrowDown'
              ? 0
              : rows.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) %
              rows.length;
    rows[next]?.focus();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) {
      dismissStudioMenu(menu);
    }
  }
});

document
  .getElementById('window-menu-popover')
  ?.addEventListener('click', event => {
    const command = (event.target as Element | null)?.closest<HTMLElement>(
      '[data-window-command]',
    );
    if (command) {
      void executeWindowMenuCommand(
        command.dataset.windowCommand || '',
        command,
      );
    }
  });

document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing) {
    return;
  }
  if (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    event.key.toLocaleLowerCase() === 'k'
  ) {
    event.preventDefault();
    void openGlobalSearch();
    return;
  }
  if (event.key === 'Escape') {
    if (event.repeat) {
      event.preventDefault();
      return;
    }
    const globalSearchOpen =
      document.getElementById('global-search')?.hidden === false;
    if (globalSearchOpen) {
      event.preventDefault();
      closeGlobalSearch();
      return;
    }
    const menuWasOpen =
      [
        'window-menu-popover',
        'sidebar-menu',
        'magic-brain-popover',
        'composer-add-menu',
        'composer-permission-menu',
        'composer-model-menu',
        'composer-effort-menu',
        'composer-usage-popover',
        'account-menu',
      ].some(id => document.getElementById(id)?.hidden === false) ||
      Boolean(document.getElementById('thread-menu')) ||
      Boolean(document.querySelector('.side-session-menu:not([hidden])'));
    closeWindowMenu();
    closeThreadMenu();
    closeSidebarMenu();
    closeSlashMenu();
    closePermissionMenu();
    closeModelMenu();
    closeEffortMenu();
    closeAccountMenu();
    const brain = document.getElementById('magic-brain-popover');
    if (brain) {
      brain.hidden = true;
    }
    document
      .getElementById('magic-brain-toggle')
      ?.setAttribute('aria-expanded', 'false');
    closeAnchoredPopover('composer-usage-popover', 'composer-context');
    document
      .querySelectorAll<HTMLElement>('.side-session-menu:not([hidden])')
      .forEach(menu => {
        menu.hidden = true;
      });
    if (!menuWasOpen && sidebarState.layout() === 'overlay') {
      event.preventDefault();
      dismissSidebar();
      document.getElementById('sidebar-toggle')?.focus();
      return;
    }
    if (
      !menuWasOpen &&
      studioComposerBusy &&
      (pendingConversation || externalConversationRun)
    ) {
      void stopActiveConversation();
    }
    return;
  }
  if (event.altKey && event.key === 'ArrowLeft') {
    event.preventDefault();
    moveWindowNavigation(-1);
    return;
  }
  if (event.altKey && event.key === 'ArrowRight') {
    event.preventDefault();
    moveWindowNavigation(1);
    return;
  }
  if (!event.ctrlKey || event.altKey) {
    return;
  }
  const key = event.key.toLocaleLowerCase();
  const command =
    key === 'n'
      ? 'new-chat'
      : key === 'o'
        ? 'open-project'
        : key === 'b' && event.shiftKey
          ? 'toggle-inspector'
          : key === 'b'
            ? 'toggle-sidebar'
            : key === 'j'
              ? 'toggle-bottom-panel'
              : key === ','
                ? 'settings'
                : key === '/'
                  ? 'shortcuts'
                  : '';
  if (!command) {
    return;
  }
  event.preventDefault();
  void executeWindowMenuCommand(command);
});

document.addEventListener('mp:retry-question', (event: Event) => {
  const detail = (event as CustomEvent<{question?: string}>).detail;
  const question = String(detail?.question || '').trim();
  if (!question || studioComposerBusy) {
    return;
  }
  const textarea = document.querySelector<HTMLTextAreaElement>(
    '#composer-form textarea',
  );
  const form = document.getElementById(
    'composer-form',
  ) as HTMLFormElement | null;
  if (!textarea || !form) {
    return;
  }
  textarea.value = question;
  fitComposer(textarea);
  syncComposerSubmitState();
  form.requestSubmit();
});

document.addEventListener('mp:open-artifact', (event: Event) => {
  const detail = (
    event as CustomEvent<{artifactId?: string; conversationId?: string}>
  ).detail;
  const artifactId = String(detail?.artifactId || '');
  const conversationId =
    String(detail?.conversationId || '') || String(activeConversationId || '');
  if (!artifactId) {
    return;
  }
  void openArtifactEditor(conversationId, artifactId);
});

document.addEventListener('mp:open-file', async (event: Event) => {
  const detail = (
    event as CustomEvent<{
      path?: string;
      absolutePath?: string;
      previewPath?: string;
      originUnknown?: boolean;
      diffReference?: ProjectFileDiffReference;
    }>
  ).detail;
  const raw = String(detail?.path || '').trim();
  const previewPath = String(detail?.previewPath || '').trim();
  const absolutePath = String(detail?.absolutePath || '').trim();
  const readPath = previewPath || absolutePath || raw;
  const root = String(activeProjectRoot || '').replace(/[\\/]+$/, '');
  if (!raw) {
    return;
  }
  if (detail?.originUnknown) {
    document.getElementById('delivered-file-error')?.remove();
    const notice = document.createElement('div');
    notice.id = 'delivered-file-error';
    notice.className = 'notice';
    notice.setAttribute('role', 'alert');
    notice.textContent = `${raw}: ${studioT('files.origin_unknown')}`;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.setAttribute('aria-label', studioT('common.close'));
    close.textContent = '×';
    close.addEventListener('click', () => notice.remove());
    notice.append(close);
    document.body.append(notice);
    return;
  }
  const absolute =
    /^[a-z]:[\\/]/i.test(readPath) ||
    readPath.startsWith('\\\\') ||
    readPath.startsWith('/');
  const normalizedRead = readPath.replace(/\\/g, '/');
  const normalizedRoot = root.replace(/\\/g, '/');
  const relative =
    !previewPath &&
    !absolutePath &&
    absolute &&
    root &&
    normalizedRead.toLowerCase().startsWith(normalizedRoot.toLowerCase() + '/')
      ? normalizedRead.slice(normalizedRoot.length + 1)
      : readPath;
  if (relative.split(/[\\/]/).includes('..')) {
    return;
  }
  if (!activeProjectRoot && !absolute) {
    void openProjectFromPicker();
    return;
  }
  await selectProjectFile(
    relative,
    previewPath
      ? {snapshot: true, title: `${raw} · ${studioT('files.deleted')}`}
      : absolutePath
        ? {title: raw, diffReference: detail?.diffReference}
        : {},
  );
});

const branchingConversations = new Set<string>();

async function branchConversationFromUi(
  conversationId: string,
  turnIndex?: number,
): Promise<void> {
  if (branchingConversations.has(conversationId)) {
    return;
  }
  branchingConversations.add(conversationId);
  document.getElementById('conversation-branch-error')?.remove();
  const progress = document.createElement('div');
  progress.id = 'conversation-branch-progress';
  progress.className = 'notice mp-conversation-branch-progress';
  progress.setAttribute('role', 'status');
  progress.textContent = studioT('chat.fork_creating');
  document.body.append(progress);
  const report = (error?: unknown) => {
    const notice = document.createElement('div');
    notice.id = 'conversation-branch-error';
    notice.className = 'notice mp-conversation-branch-error';
    notice.setAttribute('role', 'alert');
    const message = document.createElement('span');
    message.textContent =
      !error || error === 'store_failed'
        ? studioT('chat.fork_failed')
        : error instanceof Error
          ? error.message
          : String(error);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.textContent = '×';
    close.setAttribute('aria-label', studioT('common.close'));
    notice.append(message, close);
    document.body.append(notice);
  };
  let result: Awaited<ReturnType<typeof Data.branchConversation>>;
  try {
    if (turnIndex === undefined) {
      const source = await Data.conversation(conversationId);
      if (!source?.turns?.length) {
        throw new Error(studioT('chat.fork_failed'));
      }
      turnIndex = source.turns.length - 1;
    }
    result = await Data.branchConversation(conversationId, turnIndex);
  } catch (error) {
    report(error);
    return;
  } finally {
    branchingConversations.delete(conversationId);
    progress.remove();
  }
  if (!result?.ok || !result.conversation?.id) {
    report(result?.error);
    return;
  }
  await renderSidebar();
  await openConversation(result.conversation.id);
}

document.addEventListener('mp:branch-conversation', (event: Event) => {
  const detail = (
    event as CustomEvent<{conversationId?: string; turnIndex?: number}>
  ).detail;
  const conversationId = String(detail?.conversationId || '');
  const turnIndex = Number(detail?.turnIndex);
  if (!conversationId || !Number.isInteger(turnIndex)) {
    return;
  }
  void branchConversationFromUi(conversationId, turnIndex);
});

function renderSidebarLayout(): void {
  const layout = sidebarState.layout();
  const visible = layout !== 'hidden';
  shell.dataset.sidebar = layout === 'docked' ? 'expanded' : 'collapsed';
  shell.dataset.sidebarOverlay = String(layout === 'overlay');
  const sidebar = document.getElementById('studio-sidebar');
  if (sidebar) {
    sidebar.inert = !visible;
    sidebar.setAttribute('aria-hidden', String(!visible));
  }
  const backdrop = document.getElementById('sidebar-backdrop');
  if (backdrop) {
    backdrop.hidden = layout !== 'overlay' || !sidebarState.isNarrow();
  }
  const button = document.getElementById('sidebar-toggle');
  button?.setAttribute('aria-expanded', String(visible));
  button?.setAttribute('aria-label', visible ? studioT('sidebar.collapse') : studioT('sidebar.expand'));
  if (button instanceof HTMLElement) {
    button.title = visible ? studioT('sidebar.collapse') : studioT('sidebar.expand');
  }
}

function toggleSidebar(): void {
  sidebarState.toggle();
  renderSidebarLayout();
  syncSessionPaneViewport();
  syncInspectorGeometry();
}

function dismissSidebar(): void {
  if (sidebarState.layout() === 'overlay') {
    sidebarState.dismiss();
    renderSidebarLayout();
  }
}

(function bindSidebarCollapse() {
  renderSidebarLayout();
  const button = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('studio-sidebar');
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelClose = () => clearTimeout(closeTimer);
  const scheduleClose = () => {
    cancelClose();
    closeTimer = setTimeout(() => {
      if (
        !sidebarState.isNarrow() &&
        !sidebar?.contains(document.activeElement)
      ) {
        dismissSidebar();
      }
    }, 180);
  };
  button?.addEventListener('click', event => {
    event.stopPropagation();
    cancelClose();
    toggleSidebar();
  });
  button?.addEventListener('pointerenter', event => {
    if (event.pointerType === 'mouse') {
      cancelClose();
      sidebarState.peek();
      renderSidebarLayout();
    }
  });
  button?.addEventListener('pointerleave', scheduleClose);
  sidebar?.addEventListener('pointerenter', cancelClose);
  sidebar?.addEventListener('pointerleave', scheduleClose);
  sidebar?.addEventListener('focusin', cancelClose);
  sidebar?.addEventListener('focusout', () => {
    if (!sidebar.matches(':hover')) {
      scheduleClose();
    }
  });
  document.getElementById('sidebar-backdrop')?.addEventListener('click', () => {
    dismissSidebar();
    button?.focus();
  });
  document.addEventListener('pointerdown', event => {
    const target = event.target as Element | null;
    if (target && !target.closest('#studio-sidebar, #sidebar-toggle')) {
      dismissSidebar();
    }
  });
  window.addEventListener('resize', () => {
    sidebarState.resize(window.innerWidth);
    renderSidebarLayout();
  });
})();

function openAux() {
  aux.hidden = false;
  shell.classList.add('has-aux');
}
function closeAux() {
  shell.classList.remove('has-aux');
  setTimeout(() => {
    aux.hidden = true;
  }, 240);
}

function closeThreadMenu(restoreFocus = false) {
  document.getElementById('thread-menu')?.remove();
  document
    .getElementById('thread-more')
    ?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) {
    document.getElementById('thread-more')?.focus({preventScroll: true});
  }
}

function openThreadMenu(button: HTMLElement) {
  closeThreadMenu();
  const menu = document.createElement('div');
  menu.id = 'thread-menu';
  menu.className = 'mp-thread-menu';
  menu.setAttribute('role', 'menu');
  const make = (
    label: string,
    run: () => void,
    options: {danger?: boolean; disabled?: boolean; shortcut?: string} = {},
  ) => {
    const item = document.createElement('button');
    item.type = 'button';
    const text = document.createElement('span');
    text.textContent = label;
    item.append(text);
    if (options.shortcut) {
      const hint = document.createElement('kbd');
      hint.textContent = options.shortcut;
      item.append(hint);
    }
    item.disabled = options.disabled === true;
    item.classList.toggle('is-danger', options.danger === true);
    item.addEventListener('click', event => {
      event.stopPropagation();
      closeThreadMenu(true);
      run();
    });
    return item;
  };
  const divider = () => document.createElement('hr');
  const unavailable = !activeConversationId;
  menu.append(
    make('Files', () => toggleMaterialsPanel(), {shortcut: 'Ctrl+Shift+F'}),
    make('Terminal', () => toggleTerminalPanel()),
    make('Preview', () => setInspector(true, 'browser')),
    make('Mods', () => setInspector(true, 'modules')),
    divider(),
    make('Open project folder', () => {
      if (activeProjectRoot) {
        void Data.openProjectPath(activeProjectRoot, '');
      } else {
        void openProjectFromPicker();
      }
    }),
    make(
      'Rename',
      () => {
        if (activeConversationId) {
          openRenameDialog(
            activeConversationId,
            document.getElementById('chat-title')?.textContent || '',
          );
        }
      },
      {disabled: unavailable, shortcut: 'R'},
    ),
    make('Transcript view', () => setConversationTab('trajectory'), {
      disabled: unavailable,
    }),
    make(
      'Fork',
      () => {
        if (!activeConversationId || activeConversationTurnCount < 1) {
          return;
        }
        void branchConversationFromUi(
          activeConversationId,
          activeConversationTurnCount - 1,
        );
      },
      {disabled: unavailable || activeConversationTurnCount < 1, shortcut: 'F'},
    ),
    make(
      'Export session log',
      () => {
        if (activeConversationId) {
          void Data.exportConversation(activeConversationId);
        }
      },
      {disabled: unavailable},
    ),
    divider(),
    make(
      'Delete',
      () => {
        if (!activeConversationId) {
          return;
        }
        void deleteConversationFromUi(activeConversationId);
      },
      {danger: true, disabled: unavailable, shortcut: 'D'},
    ),
  );
  document.body.appendChild(menu);
  const rect = button.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  button.setAttribute('aria-expanded', 'true');
  enterStudioMenu(menu);
}

document.getElementById('thread-more')?.addEventListener('click', event => {
  event.stopPropagation();
  const button = event.currentTarget as HTMLElement;
  if (document.getElementById('thread-menu')) {
    closeThreadMenu();
  } else {
    openThreadMenu(button);
  }
});

function closeSidebarMenu(restoreFocus = false) {
  document.getElementById('sidebar-menu')?.remove();
  document
    .getElementById('sidebar-more')
    ?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) {
    document.getElementById('sidebar-more')?.focus({preventScroll: true});
  }
}

function openSidebarMenu(button: HTMLElement) {
  closeSidebarMenu();
  libraryUi.closeMenu();
  const menu = document.createElement('div');
  menu.id = 'sidebar-menu';
  menu.className = 'mp-thread-menu';
  menu.setAttribute('role', 'menu');
  for (const view of studioLibraries.preferences.hiddenNavigation as string[]) {
    if (view === 'designs') {
      continue;
    }
    const source = document.querySelector<HTMLElement>(
      `[data-library-nav="${CSS.escape(view)}"] .mp-nav-label`,
    );
    if (!source) {
      continue;
    }
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = source.textContent;
    item.addEventListener('click', event => {
      event.stopPropagation();
      closeSidebarMenu(true);
      show(view);
    });
    menu.append(item);
  }
  for (const [label, view, id] of [
    [studioT('sidebar.all_chats'), 'chats', 'nav-chats'],
    [studioT('sidebar.review'), 'personal', 'nav-personal'],
    [studioT('sidebar.design'), 'designs', 'nav-designs'],
    [studioT('sidebar.saved_dashboards'), 'dashboard', 'nav-dashboard'],
  ] as Array<[string, string, string]>) {
    const item = document.createElement('button');
    item.type = 'button';
    item.id = id;
    item.dataset.goto = view;
    const text = document.createElement('span');
    text.textContent = label;
    item.append(text);
    item.addEventListener('click', event => {
      event.stopPropagation();
      closeSidebarMenu(true);
      show(view);
    });
    menu.append(item);
  }
  for (const [label, action] of [
    [studioT('sidebar.group_sort'), () => libraryUi.groupMenu(button)],
    [studioT('sidebar.edit'), () => libraryUi.openSidebarEditor(button)],
  ] as Array<[string, () => void]>) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.addEventListener('click', event => {
      event.stopPropagation();
      closeSidebarMenu();
      action();
    });
    menu.append(item);
  }
  document.body.appendChild(menu);
  const rect = button.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${Math.max(8, rect.left)}px`;
  button.setAttribute('aria-expanded', 'true');
  enterStudioMenu(menu);
}

document.getElementById('sidebar-more')?.addEventListener('click', event => {
  event.stopPropagation();
  const button = event.currentTarget as HTMLElement;
  if (document.getElementById('sidebar-menu')) {
    closeSidebarMenu();
  } else {
    openSidebarMenu(button);
  }
});

type ProjectTreeEntry = {
  name: string;
  path: string;
  kind: 'directory' | 'file';
};
const projectTreeCache = new Map<string, ProjectTreeEntry[]>();
const expandedProjectDirectories = new Set<string>(['']);
let selectedProjectFile = '';
let selectedProjectFileText = '';
let selectedProjectPreview: MagicPointerProjectPreview | null = null;
let projectFileTreeFilter = '';
let projectFileRequest = 0;
let selectedProjectFileMarkdown = false;
let selectedProjectFileSnapshot = false;
let selectedProjectFileReadFailed = false;
let selectedProjectFileLoading = false;
type ProjectFileDiffReference = {beforePath: string | null; afterPath: string};
let selectedProjectFileDiff: {
  kind: 'file_diff';
  beforeText: string;
  afterText: string;
} | null = null;
let projectFileCodeView = false;
let activeInspectorTab = 'files';
let inspectorReturnFocus: HTMLElement | null = null;
let bottomPanelReturnFocus: HTMLElement | null = null;
let focusedSubagentId = '';

type WorkspaceResourceKind =
  'file' | 'artifact' | 'browser' | 'terminal' | 'transcript';

interface WorkspaceResourceTab {
  id: string;
  kind: WorkspaceResourceKind;
  title: string;
  resourceKey: string;
  active: boolean;
  closable: boolean;
  path?: string;
  snapshot?: boolean;
  diffReference?: ProjectFileDiffReference;
  url?: string;
  conversationId?: string;
  artifactId?: string;
  taskId?: string;
}

let workspaceResourceTabs: WorkspaceResourceTab[] = [];
let workspaceResourceSequence = 0;
let workspaceAutoOpenedResourceKey = '';
const workspaceResourceSnapshots = new Map<string, WorkspaceResourceTab[]>();

function workspaceResourceScopeKey(): string {
  if (activeConversationId) {
    return `conversation:${activeConversationId}`;
  }
  const project = normalizedProjectRoot(activeProjectRoot);
  return project ? `project:${project}` : '';
}

function saveWorkspaceResourceSnapshot(): void {
  const scope = workspaceResourceScopeKey();
  if (!scope) {
    return;
  }
  workspaceResourceSnapshots.set(
    scope,
    workspaceResourceTabs.map(tab => ({...tab, active: tab.active})),
  );
}

function restoreWorkspaceResourceSnapshot(): void {
  const scope = workspaceResourceScopeKey();
  const snapshot = scope ? workspaceResourceSnapshots.get(scope) : null;
  workspaceResourceTabs = snapshot
    ? snapshot.map(tab => ({...tab, active: tab.active}))
    : [];
  workspaceAutoOpenedResourceKey = '';
  renderWorkspaceResourceTabs();
}

function workspaceResourceState() {
  const active = workspaceResourceTabs.find(tab => tab.active);
  return {
    activeId: active?.id || '',
    tabs: workspaceResourceTabs.map(tab => ({
      id: tab.id,
      kind: tab.kind,
      title: tab.title,
      resourceKey: tab.resourceKey,
      active: tab.active,
      closable: tab.closable,
    })),
  };
}

function renderWorkspaceResourceTabs() {
  const host = document.getElementById('workspace-resource-tabs-host');
  if (!host || !ProjectPreviewView.renderWorkspaceResourceTabs) {
    return;
  }
  host.hidden = workspaceResourceTabs.length === 0;
  if (host.hidden) {
    host.replaceChildren();
    return;
  }
  ProjectPreviewView.renderWorkspaceResourceTabs(
    host,
    workspaceResourceState(),
    tabId => activateWorkspaceResource(tabId),
    tabId => closeWorkspaceResource(tabId),
  );
}

function resourcePanelFor(kind: WorkspaceResourceKind): string {
  switch (kind) {
    case 'artifact':
      return 'artifact';
    case 'browser':
      return 'browser';
    case 'terminal':
      return 'terminal';
    case 'transcript':
      return 'tasks';
    default:
      return 'files';
  }
}

function openWorkspaceResource(request: {
  kind: WorkspaceResourceKind;
  title: string;
  resourceKey: string;
  path?: string;
  snapshot?: boolean;
  diffReference?: ProjectFileDiffReference;
  url?: string;
  conversationId?: string;
  artifactId?: string;
  taskId?: string;
  auto?: boolean;
}): void {
  const resourceKey = String(request.resourceKey || '').trim();
  if (!resourceKey) {
    return;
  }
  const existing = workspaceResourceTabs.find(
    tab => tab.resourceKey === resourceKey,
  );
  const id =
    existing?.id || `workspace-resource-${++workspaceResourceSequence}`;
  workspaceResourceTabs = workspaceResourceTabs
    .map(tab => ({...tab, active: tab.id === id}))
    .filter(tab => tab.id !== id);
  workspaceResourceTabs.push({
    ...(existing || {}),
    id,
    kind: request.kind,
    title: String(request.title || resourceKey),
    resourceKey,
    active: true,
    closable: true,
    ...(request.path ? {path: request.path} : {}),
    ...(request.snapshot ? {snapshot: true} : {}),
    ...(request.diffReference ? {diffReference: request.diffReference} : {}),
    ...(request.url ? {url: request.url} : {}),
    ...(request.conversationId ? {conversationId: request.conversationId} : {}),
    ...(request.artifactId ? {artifactId: request.artifactId} : {}),
    ...(request.taskId ? {taskId: request.taskId} : {}),
  });
  workspaceAutoOpenedResourceKey = request.auto ? resourceKey : '';
  renderWorkspaceResourceTabs();
  setInspector(
    true,
    request.kind === 'transcript' && request.conversationId
      ? 'activity'
      : resourcePanelFor(request.kind),
  );
}

function activateWorkspaceResource(tabId: string): void {
  const target = workspaceResourceTabs.find(tab => tab.id === tabId);
  if (!target) {
    return;
  }
  workspaceResourceTabs = workspaceResourceTabs.map(tab => ({
    ...tab,
    active: tab.id === tabId,
  }));
  workspaceAutoOpenedResourceKey = '';
  renderWorkspaceResourceTabs();
  setInspector(
    true,
    target.kind === 'transcript' && target.conversationId
      ? 'activity'
      : resourcePanelFor(target.kind),
  );
  if (target.kind === 'file' && target.path) {
    void selectProjectFile(target.path, {
      fromResourceTab: true,
      resourceKey: target.resourceKey,
      snapshot: target.snapshot,
      diffReference: target.diffReference,
      title: target.title,
    });
  } else if (target.kind === 'browser') {
    const input = document.getElementById(
      'project-browser-url',
    ) as HTMLInputElement | null;
    if (input && target.url) {
      input.value = target.url;
    }
    void openProjectBrowser(target.url || '', target.path || '', {
      fromResourceTab: true,
      resourceKey: target.resourceKey,
    });
  } else if (
    target.kind === 'artifact' &&
    target.conversationId &&
    target.artifactId
  ) {
    void openArtifactEditor(target.conversationId, target.artifactId, {
      fromResourceTab: true,
    });
  } else if (target.kind === 'transcript' && target.taskId) {
    focusedSubagentId = target.taskId;
    renderProjectTasks();
  } else if (target.kind === 'transcript' && target.conversationId) {
    setConversationTab('trajectory');
    renderConversationActivity();
  }
}

function closeWorkspaceResource(tabId: string): void {
  const closed = workspaceResourceTabs.find(tab => tab.id === tabId);
  if (!closed) {
    return;
  }
  const wasActive = closed.active;
  workspaceResourceTabs = workspaceResourceTabs.filter(tab => tab.id !== tabId);
  if (closed.kind === 'browser') {
    void Data.browserViewCommand('close-tab', closed.resourceKey);
  }
  if (workspaceResourceTabs.length && wasActive) {
    workspaceResourceTabs = workspaceResourceTabs.map((tab, index, list) => ({
      ...tab,
      active: index === list.length - 1,
    }));
  }
  if (!workspaceResourceTabs.length) {
    workspaceAutoOpenedResourceKey = '';
    projectFileRequest++;
    selectedProjectFile = '';
    selectedProjectFileDiff = null;
    selectedProjectFileLoading = false;
    selectedProjectFileText = '';
    selectedProjectPreview = null;
    document.getElementById('project-file-content')?.replaceChildren();
    setInspector(false);
  } else {
    renderWorkspaceResourceTabs();
    const active = workspaceResourceTabs.find(tab => tab.active);
    if (active) {
      activateWorkspaceResource(active.id);
    }
  }
}

function clearWorkspaceResources(): void {
  saveWorkspaceResourceSnapshot();
  const hadTerminal = workspaceResourceTabs.some(
    tab => tab.kind === 'terminal',
  );
  workspaceResourceTabs
    .filter(tab => tab.kind === 'browser')
    .forEach(tab => {
      void Data.browserViewCommand('close-tab', tab.resourceKey);
    });
  workspaceResourceTabs = [];
  workspaceAutoOpenedResourceKey = '';
  if (hadTerminal) {
    void Data.stopProjectTerminal();
  }
  renderWorkspaceResourceTabs();
}

function finishWorkspaceResourceRun(): void {
  if (!workspaceAutoOpenedResourceKey) {
    return;
  }
  const active = workspaceResourceTabs.find(tab => tab.active);
  if (active?.resourceKey === workspaceAutoOpenedResourceKey) {
    setInspector(false);
  }
  workspaceAutoOpenedResourceKey = '';
}
interface InspectorState {
  open: boolean;
  maximized: boolean;
  width: number;
  previousWidth: number;
  tab: string;
  contentSelection?: {kind: 'material' | 'artifact'; id: string} | null;
}
interface InspectorStateModule {
  sessionRailGeometry(availableWidth: number): {
    width: number;
    overlay: boolean;
  };
  clampInspectorWidth(desired: unknown, availableWidth: unknown): number;
  reduceInspectorState(
    state: InspectorState,
    action: Record<string, unknown>,
  ): InspectorState;
}
const inspectorStatePolicy = (
  globalThis as {StudioInspectorState?: InspectorStateModule}
).StudioInspectorState!;
const INSPECTOR_WIDTH_KEY = 'mp:inspector-width';
let initialInspectorWidth = 560;
try {
  const stored = Number(localStorage.getItem(INSPECTOR_WIDTH_KEY));
  if (Number.isFinite(stored)) {
    initialInspectorWidth = stored;
  }
} catch {
  /* storage unavailable */
}
const preferredInspectorWidth = inspectorStatePolicy.clampInspectorWidth(
  initialInspectorWidth,
  1320,
);
let inspectorState: InspectorState = {
  open: false,
  maximized: false,
  width: inspectorStatePolicy.clampInspectorWidth(
    preferredInspectorWidth,
    window.innerWidth - 288,
  ),
  previousWidth: preferredInspectorWidth,
  tab: 'files',
};

interface SessionPaneAgentSidebarState {
  expandedBySession: Record<string, boolean>;
  autoOpenSeededFor: Record<string, boolean>;
  perSessionExpanded: Record<string, boolean>;
  userCollapsed: boolean;
  isViewportNarrow: boolean;
  isCuDocked: boolean;
  isOverlayOpen: boolean;
}

interface SessionPaneStateModule {
  PANE_OVERLAY_WIDTH: number;
  createAgentSidebarState(): SessionPaneAgentSidebarState;
  sidebarViewportIsNarrow(containerWidth: unknown): boolean;
  setSidebarViewportNarrow(
    state: SessionPaneAgentSidebarState,
    narrow: boolean,
  ): SessionPaneAgentSidebarState;
  sidebarIsExpandedForSession(
    state: SessionPaneAgentSidebarState,
    sessionId: string,
    options?: {perSession?: boolean; fallback?: boolean},
  ): boolean;
  toggleSidebarForSession(
    state: SessionPaneAgentSidebarState,
    sessionId: string,
  ): SessionPaneAgentSidebarState;
  seedSidebarCollapsedForSession(
    state: SessionPaneAgentSidebarState,
    sessionId: string,
  ): SessionPaneAgentSidebarState;
  serializeAgentSidebarState(state: SessionPaneAgentSidebarState): string;
  restoreAgentSidebarState(raw: unknown): SessionPaneAgentSidebarState;
}
const sessionPanePolicy = (
  globalThis as {SessionPaneState?: SessionPaneStateModule}
).SessionPaneState;
const SESSION_PANE_KEY = 'mp:agent-sidebar';
let sessionPaneState: SessionPaneAgentSidebarState | null = null;
if (sessionPanePolicy) {
  let storedSessionPane = '';
  try {
    storedSessionPane = localStorage.getItem(SESSION_PANE_KEY) || '';
  } catch {
    /* storage unavailable */
  }
  sessionPaneState =
    sessionPanePolicy.restoreAgentSidebarState(storedSessionPane);
}

function sessionPaneSessionId(): string {
  return activeConversationId || '';
}

function persistSessionPane(): void {
  const policy = sessionPanePolicy;
  const state = sessionPaneState;
  if (!policy || !state) {
    return;
  }
  try {
    localStorage.setItem(
      SESSION_PANE_KEY,
      policy.serializeAgentSidebarState(state),
    );
  } catch {
    /* storage unavailable */
  }
}

// A per-session override, when one exists, wins over the global collapse flag.
function sessionPaneIsExpandedFor(sessionId: string): boolean {
  const policy = sessionPanePolicy;
  const state = sessionPaneState;
  if (!policy || !state) {
    return true;
  }
  if (
    Object.prototype.hasOwnProperty.call(state.perSessionExpanded, sessionId)
  ) {
    return policy.sidebarIsExpandedForSession(state, sessionId, {
      perSession: true,
      fallback: false,
    });
  }
  return policy.sidebarIsExpandedForSession(state, sessionId);
}

function seedSessionPane(sessionId: string): void {
  const policy = sessionPanePolicy;
  const state = sessionPaneState;
  if (!policy || !state) {
    return;
  }
  sessionPaneState = policy.seedSidebarCollapsedForSession(state, sessionId);
}

// The machine's own toggle reads the session's current expansion, so what is on
// screen has to be what it believes.
function trackSessionPaneExpansion(sessionId: string, expanded: boolean): void {
  const state = sessionPaneState;
  if (!state || state.expandedBySession[sessionId] === expanded) {
    return;
  }
  sessionPaneState = {
    ...state,
    expandedBySession: {...state.expandedBySession, [sessionId]: expanded},
  };
}

// Under 768px of the pane's own container Claude stops making the pane a column
// and floats it instead.
function syncSessionPaneViewport(): void {
  const policy = sessionPanePolicy;
  const state = sessionPaneState;
  if (!policy || !state) {
    return;
  }
  const next = policy.setSidebarViewportNarrow(
    state,
    policy.sidebarViewportIsNarrow(inspectorAvailableWidth()),
  );
  if (next.isViewportNarrow === state.isViewportNarrow) {
    return;
  }
  sessionPaneState = next;
  syncInspectorGeometry();
}

function toggleSessionPane(tab: string): void {
  const policy = sessionPanePolicy;
  const state = sessionPaneState;
  const sessionId = sessionPaneSessionId();
  if (!policy || !state) {
    setInspector(shell.dataset.inspector !== 'open', tab);
    return;
  }
  seedSessionPane(sessionId);
  const toggled = policy.toggleSidebarForSession(
    sessionPaneState || state,
    sessionId,
  );
  sessionPaneState = toggled;
  persistSessionPane();
  setInspector(
    toggled.isViewportNarrow
      ? toggled.isOverlayOpen
      : sessionPaneIsExpandedFor(sessionId),
    tab,
  );
}

function inspectorError(message: string) {
  const host = document.getElementById('project-file-tree');
  if (host) {
    host.innerHTML = `<p class="mp-inspector-empty">${esc(message)}</p>`;
  }
}

function renderProjectFileTree() {
  const host = document.getElementById('project-file-tree');
  if (!host) {
    return;
  }
  const query = projectFileTreeFilter.trim().toLocaleLowerCase();
  const root = normalizedProjectRoot(activeProjectRoot);
  const selected = normalizedProjectRoot(selectedProjectFile);
  const selectedPath =
    root && selected.startsWith(root + '/')
      ? selected.slice(root.length + 1)
      : selected;
  const buildLevel = (directory: string, depth: number): Node[] => {
    const nodes: Node[] = [];
    for (const entry of projectTreeCache.get(directory) || []) {
      if (
        query &&
        !entry.name.toLocaleLowerCase().includes(query) &&
        entry.kind !== 'directory'
      ) {
        continue;
      }
      const row = document.createElement('button');
      row.type = 'button';
      row.className =
        'mp-file-tree-row' +
        (normalizedProjectRoot(entry.path) === selectedPath ? ' is-on' : '');
      row.dataset.projectPath = entry.path;
      row.dataset.projectKind = entry.kind;
      row.dataset.depth = String(depth);
      row.dataset.treeRow = 'true';
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(depth + 1));
      row.tabIndex = -1;
      row.style.paddingLeft = `${8 + depth * 8}px`;
      const expanded =
        entry.kind === 'directory' &&
        expandedProjectDirectories.has(entry.path);
      if (entry.kind === 'directory') {
        row.setAttribute('aria-expanded', String(expanded));
      }
      row.innerHTML = `${
        entry.kind === 'directory'
          ? icon(expanded ? 'ic-tree-folder-open' : 'ic-tree-folder')
          : icon('ic-tree-file')
      }<span>${esc(entry.name)}</span>`;
      nodes.push(row);
      if (!expanded) {
        continue;
      }
      nodes.push(...buildLevel(entry.path, depth + 1));
    }
    return nodes;
  };
  const roots = buildLevel('', 0);
  if (!roots.length) {
    const empty = document.createElement('p');
    empty.className = 'mp-inspector-empty';
    empty.textContent = query ? studioT('files.no_match') : studioT('files.empty_project');
    roots.push(empty);
  }
  host.replaceChildren(...roots);
}

async function loadProjectDirectory(relativePath = '') {
  if (!activeProjectRoot) {
    inspectorError(studioT('project.open_first'));
    return;
  }
  const response = await Data.projectTree(activeProjectRoot, relativePath);
  if (!response?.ok) {
    inspectorError(response?.error || studioT('files.tree_failed'));
    return;
  }
  projectTreeCache.set(relativePath, response.entries || []);
  renderProjectFileTree();
}

async function refreshProjectInspector() {
  projectFileRequest++;
  selectedProjectPreview = null;
  projectTreeCache.clear();
  expandedProjectDirectories.clear();
  expandedProjectDirectories.add('');
  selectedProjectFile = '';
  selectedProjectFileText = '';
  projectFileTreeFilter = '';
  const fileTreeFilter = document.getElementById(
    'file-tree-filter',
  ) as HTMLInputElement | null;
  if (fileTreeFilter) {
    fileTreeFilter.value = '';
  }
  selectedProjectFileMarkdown = false;
  selectedProjectFileSnapshot = false;
  selectedProjectFileReadFailed = false;
  selectedProjectFileLoading = false;
  selectedProjectFileDiff = null;
  projectFileCodeView = false;
  const preview = document.getElementById('project-file-preview');
  if (preview) {
    preview.hidden = true;
  }
  preview?.closest('.mp-inspector-panel')?.classList.remove('is-previewing');
  if (activeProjectRoot) {
    await loadProjectDirectory('');
  } else {
    inspectorError(studioT('project.open_first'));
  }
  if (activeInspectorTab === 'changes') {
    await renderProjectChanges();
  }
}

function renderSelectedProjectFile() {
  const preview = document.getElementById('project-file-preview');
  const content = document.getElementById('project-file-content');
  const code = document.getElementById('project-file-code');
  if (!preview || !content) {
    return;
  }
  const renderMarkdown = selectedProjectFileMarkdown && !projectFileCodeView;
  const media = selectedProjectPreview?.kind === 'image' || selectedProjectPreview?.kind === 'pdf';
  content.setAttribute('aria-busy', String(selectedProjectFileLoading));
  preview.classList.toggle('is-markdown', renderMarkdown);
  code?.setAttribute('aria-pressed', String(projectFileCodeView));
  if (code) {
    code.hidden =
      selectedProjectFileLoading ||
      selectedProjectFileDiff !== null ||
      selectedProjectFileSnapshot ||
      media ||
      selectedProjectPreview?.kind === 'document' ||
      selectedProjectPreview?.kind === 'spreadsheet';
  }
  const external = document.getElementById(
    'project-file-open',
  ) as HTMLButtonElement | null;
  if (external) {
    external.disabled = selectedProjectFileSnapshot || selectedProjectFileLoading;
  }
  const copy = document.getElementById('project-file-copy');
  if (copy) {
    copy.hidden = media;
    (copy as HTMLButtonElement).disabled = selectedProjectFileLoading;
  }
  if (selectedProjectPreview && selectedProjectPreview.kind !== 'text') {
    ProjectPreviewView.renderProjectPreview(content, selectedProjectPreview);
    return;
  }
  content.classList.remove('is-office-preview', 'is-browser-pane');
  if (selectedProjectFileDiff) {
    content.replaceChildren(ChatView.fileDiffNode(selectedProjectFileDiff));
  } else if (selectedProjectFileSnapshot && !selectedProjectFileReadFailed) {
    content.replaceChildren(ChatView.deletedFileNode(selectedProjectFileText));
  } else if (renderMarkdown) {
    content.replaceChildren(ChatMarkdown.render(selectedProjectFileText));
  } else {
    const pre = document.createElement('pre');
    pre.textContent = selectedProjectFileText;
    content.replaceChildren(pre);
  }
}

async function selectProjectFile(
  relativePath: string,
  options: {
    fromResourceTab?: boolean;
    resourceKey?: string;
    snapshot?: boolean;
    diffReference?: ProjectFileDiffReference;
    title?: string;
  } = {},
) {
  const root = activeProjectRoot;
  const absolute =
    /^[a-z]:[\\/]/i.test(relativePath) ||
    relativePath.startsWith('\\\\') ||
    relativePath.startsWith('/');
  const browserFile =
    !options.diffReference &&
    !options.snapshot &&
    !absolute &&
    /\.(?:html?|pdf|png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(relativePath);
  const resourceKey =
    options.resourceKey ||
    (options.diffReference ? `diff:${JSON.stringify(options.diffReference)}:` : '') +
    `${options.snapshot ? 'snapshot' : 'file'}:${normalizedProjectRoot(root)}:${relativePath
      .replace(/\\/g, '/')
      .toLocaleLowerCase()}`;
  if (!options.fromResourceTab) {
    openWorkspaceResource({
      kind: browserFile ? 'browser' : 'file',
      title: options.title || relativePath.split(/[\\/]/).at(-1) || relativePath,
      resourceKey,
      path: relativePath,
      snapshot: options.snapshot,
      diffReference: options.diffReference,
    });
  }
  const request = ++projectFileRequest;
  selectedProjectFileLoading = Boolean(options.diffReference);
  if (options.diffReference) {
    selectedProjectFile = relativePath;
    selectedProjectFileReadFailed = false;
    selectedProjectFileDiff = null;
    selectedProjectPreview = null;
    selectedProjectFileSnapshot = false;
    selectedProjectFileMarkdown = false;
    selectedProjectFileText = studioT('chat.diff_loading');
    const preview = document.getElementById('project-file-preview');
    if (preview) {
      preview.hidden = false;
      preview.closest('.mp-inspector-panel')?.classList.add('is-previewing');
    }
    const name = document.getElementById('project-file-name');
    if (name) {
      name.textContent = options.title || relativePath;
    }
    renderSelectedProjectFile();
  }
  if (browserFile) {
    selectedProjectFile = relativePath;
    setInspector(true, 'browser');
    await openProjectBrowser('', relativePath, {
      fromResourceTab: true,
      resourceKey,
    });
    return;
  }
  const diff = options.diffReference
    ? await window.magicPointer.readFileDiff(options.diffReference)
    : null;
  const response: MagicPointerProjectFileResponse = options.diffReference
    ? diff?.ok
      ? {ok: true, kind: 'text', text: diff.presentation.afterText}
      : {ok: false, error: diff && !diff.ok ? diff.error : studioT('files.read_failed')}
    : await Data.readProjectFile(root, relativePath);
  if (request !== projectFileRequest || root !== activeProjectRoot) {
    return;
  }
  const preview = document.getElementById('project-file-preview');
  if (!preview) {
    return;
  }
  preview.hidden = false;
  const panel = preview.closest<HTMLElement>('.mp-inspector-panel');
  panel?.classList.add('is-previewing');
  selectedProjectFile = relativePath;
  selectedProjectFileSnapshot = options.snapshot === true;
  selectedProjectFileLoading = false;
  selectedProjectFileDiff = diff?.ok ? diff.presentation : null;
  selectedProjectFileReadFailed = !response?.ok;
  selectedProjectFileText = response?.ok
    ? String(response.text || '')
    : String(response?.error || studioT('files.read_failed'));
  selectedProjectPreview =
    response?.ok && response.kind === 'document'
      ? {
          kind: 'document',
          blocks: response.blocks || [],
          truncated: response.truncated === true,
        }
      : response?.ok && response.kind === 'spreadsheet'
        ? {
            kind: 'spreadsheet',
            sheets: response.sheets || [],
            truncated: response.truncated === true,
          }
        : response?.ok && (response.kind === 'image' || response.kind === 'pdf')
          ? {
              kind: response.kind,
              url: String(response.url || ''),
              name: options.title || response.name || relativePath,
              truncated: false,
            }
        : null;
  if (selectedProjectPreview?.kind === 'document') {
    selectedProjectFileText = selectedProjectPreview.blocks
      .map(block =>
        block.kind === 'paragraph'
          ? block.text
          : block.rows.map(row => row.join('\t')).join('\n'),
      )
      .join('\n\n');
  } else if (selectedProjectPreview?.kind === 'spreadsheet') {
    selectedProjectFileText = selectedProjectPreview.sheets
      .map(
        sheet =>
          sheet.name + '\n' + sheet.rows.map(row => row.join('\t')).join('\n'),
      )
      .join('\n\n');
  }
  selectedProjectFileMarkdown =
    !options.diffReference &&
    /\.(?:md|mdx|markdown)$/i.test(relativePath) && Boolean(response?.ok);
  projectFileCodeView = false;
  const name = document.getElementById('project-file-name');
  const inspectorTitle = document.getElementById('inspector-title');
  if (inspectorTitle) {
    inspectorTitle.textContent = 'File';
  }
  if (name) {
    name.textContent =
      (options.title || relativePath) +
      (response?.truncated ? studioT('files.truncated') : '');
  }
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

async function _renderMagicBrain(force = false) {
  const popover = document.getElementById('magic-brain-popover');
  if (!popover) {
    return;
  }
  const projectName =
    activeProjectRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() ||
    studioT('project.current');
  const project = document.getElementById('magic-brain-project');
  if (project) {
    project.textContent = projectName;
  }
  const projectRows = [
    document.getElementById('magic-brain-changes'),
    document.getElementById('magic-brain-branch'),
  ];
  projectRows.forEach(row => {
    if (row) {
      row.hidden = !activeProjectRoot;
    }
  });
  if (!activeProjectRoot) {
    projectEnvironment = null;
    document.getElementById('magic-brain-changes-detail')!.textContent =
      studioT('project.open_first_bare');
    document.getElementById('magic-brain-branch-name')!.textContent =
      studioT('git.branch');
    document.getElementById('magic-brain-branch-detail')!.textContent =
      studioT('project.no_env');
    const sourceHost = document.getElementById('magic-brain-source-list')!;
    const materialNodes = magicBrainMaterialNodes();
    if (materialNodes.length) {
      sourceHost.replaceChildren(...materialNodes);
    } else {
      sourceHost.innerHTML = activeConversationId
        ? '<p>' + studioT('materials.empty_task') + '</p>'
        : '<p>' + studioT('materials.empty_started') + '</p>';
    }
    void refreshFigmaConnection();
    return;
  }
  if (!force && projectEnvironment?.root === activeProjectRoot) {
    return;
  }
  document.getElementById('magic-brain-changes-detail')!.textContent =
    studioT('common.loading');
  document.getElementById('magic-brain-branch-detail')!.textContent =
    studioT('common.loading');
  const response = await Data.projectEnvironment(
    activeProjectRoot,
    activeConversationId,
  );
  projectEnvironment = response;
  applyRepositoryContextBar(response);
  const changes = Number(response.changedFiles || 0);
  const added = Number(response.addedLines || 0);
  const deleted = Number(response.deletedLines || 0);
  document.getElementById('magic-brain-changes-detail')!.textContent =
    response.ok
      ? changes
        ? studioTCount('count.git_files', changes, {added, deleted})
        : studioT('git.clean')
      : String(response.error || studioT('git.read_failed'));
  document.getElementById('magic-brain-branch-name')!.textContent =
    response.branch || (response.isGit ? studioT('git.repo') : studioT('git.not_init'));
  const sync: string[] = [];
  if (response.upstream) {
    sync.push(response.upstream);
  }
  if (response.ahead) {
    sync.push(studioT('git.ahead', {n: response.ahead}));
  }
  if (response.behind) {
    sync.push(studioT('git.behind', {n: response.behind}));
  }
  document.getElementById('magic-brain-branch-detail')!.textContent =
    sync.join(' · ') || (response.remoteUrl ? studioT('git.remote_connected') : studioT('git.local_only'));
  const sourceHost = document.getElementById('magic-brain-source-list');
  if (!sourceHost) {
    return;
  }
  const sources = Array.isArray(response.sources) ? response.sources : [];
  const materialNodes = magicBrainMaterialNodes();
  sourceHost.replaceChildren(
    ...materialNodes,
    ...sources.map((url, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mp-brain-source';
      button.dataset.sourceUrl = url;
      button.style.setProperty(
        '--item-index',
        String(materialNodes.length + index),
      );
      let label = url;
      try {
        const parsed = new URL(url);
        label = `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
      } catch {
        /* show raw URL */
      }
      button.innerHTML = `${icon('ic-globe', 'codex-icon')}<span>${esc(label)}</span>`;
      button.title = url;
      return button;
    }),
  );
  if (!sources.length && !materialNodes.length) {
    sourceHost.innerHTML = '<p>' + studioT('materials.empty_sources') + '</p>';
  }
}

document
  .getElementById('magic-brain-changes')
  ?.addEventListener('click', () => {
    document.getElementById('magic-brain-popover')!.hidden = true;
    document
      .getElementById('magic-brain-toggle')
      ?.setAttribute('aria-expanded', 'false');
    setInspector(true, 'changes');
  });
document.getElementById('magic-brain-branch')?.addEventListener('click', () => {
  const url =
    projectEnvironment?.pullRequestUrl || projectEnvironment?.remoteUrl || '';
  if (url) {
    void Data.openProjectUrl(url);
  } else {
    setInspector(true, 'changes');
  }
});
document
  .getElementById('magic-brain-sources')
  ?.addEventListener('click', event => {
    const material = (event.target as Element | null)?.closest<HTMLElement>(
      '[data-material-source-id]',
    );
    if (material?.dataset.materialSourceId) {
      setInspector(true, 'materials');
      inspectorState = inspectorStatePolicy.reduceInspectorState(
        inspectorState,
        {
          type: 'select-content',
          contentKind: 'material',
          contentId: material.dataset.materialSourceId,
        },
      );
      renderTaskMaterials();
      return;
    }
    const source = (event.target as Element | null)?.closest<HTMLElement>(
      '[data-source-url]',
    );
    if (!source?.dataset.sourceUrl) {
      return;
    }
    setInspector(true, 'browser');
    const input = document.getElementById(
      'project-browser-url',
    ) as HTMLInputElement | null;
    if (input) {
      input.value = source.dataset.sourceUrl;
    }
    void openProjectBrowser(source.dataset.sourceUrl);
  });

async function renderProjectChanges() {
  const host = document.getElementById('project-changes');
  if (!host) {
    return;
  }
  if (!activeProjectRoot) {
    host.innerHTML = '<p class="mp-inspector-empty">' + studioT('project.open_first') + '</p>';
    return;
  }
  host.innerHTML = '<p class="mp-inspector-empty">' + studioT('git.reading') + '</p>';
  const root = activeProjectRoot;
  const response = await Data.projectEnvironment(
    root,
    activeConversationId,
  );
  if (root !== activeProjectRoot) {
    return;
  }
  projectEnvironment = response;
  if (!response.ok) {
    host.innerHTML = `<p class="mp-inspector-empty">${esc(response.error || studioT('git.env_failed'))}</p>`;
    return;
  }
  const header = document.createElement('header');
  header.className = 'mp-changes-header';
  const branch = document.createElement('span');
  branch.innerHTML = `${icon('ic-branch', 'codex-icon')}<strong>${esc(response.branch || studioT('project.local'))}</strong>`;
  const count = document.createElement('small');
  count.textContent = studioTCount('count.git_changed', Number(response.changedFiles || 0), {
    added: Number(response.addedLines || 0),
    deleted: Number(response.deletedLines || 0),
  });
  header.append(branch, count);
  const list = document.createElement('div');
  list.className = 'mp-change-list';
  for (const [index, change] of (response.fileChanges || []).entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mp-change-row';
    button.dataset.changePath = change.path;
    button.dataset.changeRoot = root;
    if (change.deletionBase) {
      button.dataset.deletionBase = change.deletionBase;
    }
    button.style.setProperty('--item-index', String(index));
    button.innerHTML = `<span class="mp-change-status">${esc(change.status || 'M')}</span><span>${esc(change.path)}</span>${change.staged ? `<small>${studioT('git.staged')}</small>` : ''}`;
    list.appendChild(button);
  }
  if (!list.childElementCount) {
    list.innerHTML = '<p class="mp-inspector-empty">' + studioT('git.clean_sentence') + '</p>';
  }
  host.replaceChildren(header, list);
}

document.getElementById('project-changes')?.addEventListener('click', async event => {
  const row = (event.target as Element | null)?.closest<HTMLButtonElement>(
    '[data-change-path]',
  );
  if (!row?.dataset.changePath) {
    return;
  }
  if (row.disabled) {
    return;
  }
  const base = row.dataset.deletionBase;
  if (base === 'head' || base === 'index') {
    const root = row.dataset.changeRoot || activeProjectRoot;
    const request = ++projectFileRequest;
    row.disabled = true;
    row.setAttribute('aria-busy', 'true');
    document.getElementById('git-file-preview-error')?.remove();
    try {
      const response = await Data.prepareDeletedProjectFile(
        root,
        row.dataset.changePath,
        base,
      );
      if (root !== activeProjectRoot || request !== projectFileRequest) {
        return;
      }
      if (!response.ok || !response.previewPath) {
        throw new Error(response.error || studioT('files.read_failed'));
      }
      await selectProjectFile(response.previewPath, {
        snapshot: true,
        title: `${row.dataset.changePath} · ${studioT('files.deleted')}`,
      });
    } catch (error) {
      if (root === activeProjectRoot && request === projectFileRequest) {
        const notice = document.createElement('p');
        notice.id = 'git-file-preview-error';
        notice.className = 'mp-inspector-empty';
        notice.setAttribute('role', 'alert');
        notice.textContent =
          error instanceof Error ? error.message : String(error);
        document.getElementById('project-changes')?.append(notice);
      }
    } finally {
      row.disabled = false;
      row.removeAttribute('aria-busy');
    }
    return;
  }
  setInspector(true, 'files');
  await selectProjectFile(row.dataset.changePath);
});

let browserViewVisible = false;
let latestBrowserViewState: MagicPointerBrowserViewState = {};

function projectBrowserBounds() {
  const host = document.getElementById('project-browser-host');
  if (!host) {
    return null;
  }
  const rect = host.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) {
    return null;
  }
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

function renderBrowserToolbarLanguage(): void {
  for (const [id, label] of [
    ['project-browser-back', 'browser.back'],
    ['project-browser-forward', 'browser.forward'],
    [
      'project-browser-reload',
      latestBrowserViewState.loading
        ? 'browser.stop_loading'
        : 'browser.reload',
    ],
    ['project-browser-external', 'browser.external'],
  ] as const) {
    const button = document.getElementById(id);
    button?.setAttribute('aria-label', studioT(label));
    button?.setAttribute('title', studioT(label));
  }
  const input = document.getElementById('project-browser-url');
  input?.setAttribute('aria-label', studioT('browser.address'));
  input?.setAttribute('placeholder', studioT('browser.address_hint'));
  const go = document.querySelector('#project-browser-form button');
  go?.setAttribute('aria-label', studioT('browser.go'));
  go?.setAttribute('title', studioT('browser.go'));
  document
    .getElementById('project-browser-host')
    ?.setAttribute('aria-label', studioT('browser.host'));
  const message = document.querySelector<HTMLElement>(
    '#project-browser-empty p',
  );
  if (message?.dataset.browserMessage) {
    message.textContent = studioT(message.dataset.browserMessage);
  }
}

function setBrowserMessage(id: string, detail?: string): void {
  const message = document.querySelector<HTMLElement>(
    '#project-browser-empty p',
  );
  if (message) {
    message.dataset.browserMessage = detail ? '' : id;
    message.textContent = detail || studioT(id);
  }
}

function renderBrowserViewState(state: MagicPointerBrowserViewState) {
  latestBrowserViewState = {...latestBrowserViewState, ...state};
  if (Array.isArray(state.tabs)) {
    const syncActive = inspectorState.open && activeInspectorTab === 'browser';
    const browserTabs = new Map(state.tabs.map(tab => [tab.key, tab]));
    workspaceResourceTabs = workspaceResourceTabs
      .filter(tab => tab.kind !== 'browser' || browserTabs.has(tab.resourceKey))
      .map(tab => {
        const browser = browserTabs.get(tab.resourceKey);
        if (!browser) {
          return tab;
        }
        return {
          ...tab,
          title: browser.title || tab.title,
          url: browser.url || tab.url,
          active:
            syncActive && state.activeKey
              ? browser.key === state.activeKey
              : browser.active,
        };
      });
    if (syncActive && state.activeKey) {
      workspaceResourceTabs = workspaceResourceTabs.map(tab => ({
        ...tab,
        active: tab.kind === 'browser' && tab.resourceKey === state.activeKey,
      }));
    }
    renderWorkspaceResourceTabs();
  }
  const input = document.getElementById(
    'project-browser-url',
  ) as HTMLInputElement | null;
  if (input && state.url && document.activeElement !== input) {
    input.value = state.url;
  }
  const back = document.getElementById(
    'project-browser-back',
  ) as HTMLButtonElement | null;
  const forward = document.getElementById(
    'project-browser-forward',
  ) as HTMLButtonElement | null;
  if (back) {
    back.disabled = !state.canGoBack;
  }
  if (forward) {
    forward.disabled = !state.canGoForward;
  }
  renderBrowserToolbarLanguage();
  if (state.title) {
    document
      .getElementById('inspector-browser')
      ?.setAttribute('aria-label', state.title);
  }
}

async function openProjectBrowser(
  rawUrl: string,
  relativePath = '',
  options: {fromResourceTab?: boolean; resourceKey?: string} = {},
) {
  const localResourceKey =
    options.resourceKey ||
    (relativePath
      ? `file:${normalizedProjectRoot(activeProjectRoot)}:${relativePath
          .replace(/\\/g, '/')
          .toLocaleLowerCase()}`
      : normalizedBrowserResourceKey(rawUrl));
  if (!options.fromResourceTab) {
    const browserTitle = relativePath
      ? relativePath.split(/[\\/]/).at(-1) || relativePath
      : rawUrl.replace(/^https?:\/\//i, '').split('/')[0] || 'Browser';
    openWorkspaceResource({
      kind: 'browser',
      title: browserTitle,
      resourceKey: localResourceKey,
      ...(relativePath ? {path: relativePath} : {url: rawUrl}),
    });
  }
  const bounds = projectBrowserBounds();
  if (!bounds) {
    return;
  }
  const empty = document.getElementById('project-browser-empty');
  const response = await Data.openBrowserView(
    rawUrl,
    bounds,
    activeProjectRoot,
    relativePath,
    options.resourceKey,
  );
  if (
    response?.ok &&
    response.key &&
    response.key !== localResourceKey &&
    !options.fromResourceTab
  ) {
    const resource = workspaceResourceTabs.find(
      tab => tab.resourceKey === localResourceKey,
    );
    if (resource) {
      resource.resourceKey = response.key;
      renderWorkspaceResourceTabs();
    }
  }
  browserViewVisible = response?.ok === true;
  if (empty) {
    empty.hidden = browserViewVisible;
  }
  if (response?.state) {
    renderBrowserViewState(response.state);
  }
  if (!response?.ok && empty) {
    empty.hidden = false;
    setBrowserMessage('browser.open_failed', response?.error);
  }
}

function resizeProjectBrowser() {
  if (
    shell.dataset.paneDragging === 'true' ||
    !browserViewVisible ||
    activeInspectorTab !== 'browser' ||
    shell.dataset.inspector !== 'open'
  ) {
    return;
  }
  const bounds = projectBrowserBounds();
  if (bounds) {
    void Data.resizeBrowserView(bounds);
  }
}

document
  .getElementById('composer-repository-location')
  ?.addEventListener('click', () => setInspector(true, 'changes'));
document
  .getElementById('composer-repository-diff')
  ?.addEventListener('click', () => setInspector(true, 'changes'));
document.getElementById('composer-create-pr')?.addEventListener('click', () => {
  const url = projectEnvironment?.pullRequestUrl || '';
  const changedFiles = Number(projectEnvironment?.changedFiles || 0);
  if (changedFiles > 0) {
    setInspector(true, 'changes');
  } else if (url && Number(projectEnvironment?.ahead || 0) > 0) {
    void Data.openProjectUrl(url);
  } else {
    setInspector(true, 'changes');
  }
});
document
  .getElementById('composer-pr-menu')
  ?.addEventListener('click', () => setInspector(true, 'changes'));
document
  .getElementById('composer-repository-dismiss')
  ?.addEventListener('click', () => {
    repositoryContextDismissedFor = repositoryContextKey();
    applyRepositoryContextBar(projectEnvironment);
  });

function subagentStatusLabel(status: string): string {
  if (status === 'running') {
    return studioT('subagent.running');
  }
  if (status === 'awaiting_user') {
    return studioT('subagent.awaiting_user');
  }
  if (status === 'needs_verification') {
    return studioT('subagent.needs_verification');
  }
  if (status === 'partial') {
    return studioT('subagent.partial');
  }
  if (status === 'stalled') {
    return studioT('subagent.stalled');
  }
  if (status === 'provider_unavailable') {
    return studioT('subagent.provider_unavailable');
  }
  if (status === 'budget_exhausted') {
    return studioT('subagent.budget_exhausted');
  }
  if (status === 'invariant_failed') {
    return studioT('subagent.invariant_failed');
  }
  if (status === 'user_interrupt') {
    return studioT('subagent.user_interrupt');
  }
  if (status === 'stop_hook') {
    return studioT('subagent.stop_hook');
  }
  if (status === 'failed') {
    return studioT('subagent.failed');
  }
  if (status === 'stopped') {
    return studioT('subagent.stopped');
  }
  if (status === 'completed') {
    return studioT('subagent.completed');
  }
  return studioT('subagent.unknown');
}

function subagentResumeText(task: StudioSubagentTask): string {
  const continueInstruction = studioT('task.continue_instruction', {id: task.id});
  if (task.pendingInput) {
    return studioT('task.interrupted_note', {instruction: continueInstruction});
  }
  if (task.answerSaved) {
    return studioT('task.saved_not_resumed', {instruction: continueInstruction});
  }
  return studioT('task.interrupted_idle', {instruction: continueInstruction});
}

function currentSubagentTasks() {
  return studioSubagentGlobals.projectSubagentTasks(
    pendingConversation
      ? [
          ...activeConversationTurns,
          {trajectory: pendingConversation.transcript.trajectory},
        ]
      : activeConversationTurns,
    backgroundAgentSnapshots.get(activeConversationId || '') || [],
  );
}

const backgroundAgentSnapshots = new Map<string, StudioSubagentTask[]>();
const acceptedChildInputs = new Set<string>();
let backgroundAgentRefreshTimer: ReturnType<typeof setTimeout> | null = null;
const backgroundAgentRefreshInFlight = new Set<string>();

function childActive(status: string): boolean {
  return status === 'running' || status === 'awaiting_user';
}
function childNeedsAttention(task: StudioSubagentTask): boolean {
  return (
    task.resumeRequired === true ||
    task.status === 'partial' ||
    task.status === 'needs_verification'
  );
}

async function refreshBackgroundAgentTasks(
  conversationId: string,
): Promise<void> {
  if (!conversationId || backgroundAgentRefreshInFlight.has(conversationId)) {
    return;
  }
  backgroundAgentRefreshInFlight.add(conversationId);
  try {
    const result = await Data.subagents({conversationId});
    if (!result.ok) {
      throw new Error(result.error || 'Could not refresh background tasks.');
    }
    backgroundAgentSnapshots.set(
      conversationId,
      (result.tasks || []) as StudioSubagentTask[],
    );
    if (activeConversationId === conversationId) {
      renderProjectTasks();
    }
  } catch (error) {
    if (activeConversationId === conversationId) {
      const host = document.getElementById('project-tasks');
      let notice = host?.querySelector<HTMLElement>('.mp-background-error');
      if (host && !notice) {
        notice = document.createElement('p');
        notice.className = 'mp-background-error';
        notice.setAttribute('role', 'status');
        host.prepend(notice);
      }
      if (notice) {
        notice.textContent =
          error instanceof Error ? error.message : String(error);
      }
    }
  } finally {
    backgroundAgentRefreshInFlight.delete(conversationId);
    scheduleBackgroundAgentRefresh();
  }
}

function scheduleBackgroundAgentRefresh(): void {
  if (
    backgroundAgentRefreshTimer ||
    !activeConversationId ||
    backgroundAgentRefreshInFlight.has(activeConversationId)
  ) {
    return;
  }
  if (!currentSubagentTasks().some(task => childActive(task.status))) {
    return;
  }
  backgroundAgentRefreshTimer = setTimeout(
    () => {
      backgroundAgentRefreshTimer = null;
      if (activeConversationId) {
        void refreshBackgroundAgentTasks(activeConversationId);
      }
    },
    document.hidden ? 5000 : 1200,
  );
}

async function respondToChildInput(
  host: HTMLElement,
  task: StudioSubagentTask,
  conversationId: string,
  response: MagicPointerDecisionResponse,
): Promise<void> {
  const requestId = task.pendingInput?.requestId;
  if (!requestId) {
    return;
  }
  try {
    const result = await Data.respondSubagent({
      conversationId,
      subagentId: task.id,
      requestId,
      response,
    });
    if (!result.ok) {
      throw new Error(
        result.error || 'Could not answer the child task. Try again.',
      );
    }
    acceptedChildInputs.add(`${conversationId}:${task.id}:${requestId}`);
    if (result.resumeRequired) {
      task.answerSaved = true;
    }
    DecisionCard.resolve(host);
    await refreshBackgroundAgentTasks(conversationId);
  } catch (error) {
    DecisionCard.pending(
      host,
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
}

const backgroundTaskViews = new Map<
  string,
  {scope: string; finishedOpen: boolean; cleared: Set<string>}
>();

function backgroundTaskView() {
  const scope =
    activeConversationId ||
    pendingConversation?.agentSessionId ||
    pendingConversation?.requestId ||
    'draft';
  let view = backgroundTaskViews.get(scope);
  if (!view) {
    view = {scope, finishedOpen: false, cleared: new Set()};
    backgroundTaskViews.set(scope, view);
  }
  return view;
}

async function stopSubagentTask(row: HTMLElement) {
  const conversationId = row.dataset.conversationId || '';
  const subagentId = row.dataset.taskId || '';
  const button = row.querySelector<HTMLButtonElement>('.mp-subagent-stop')!;
  const error = row.querySelector<HTMLElement>('.mp-subagent-stop-error')!;
  if (!conversationId || !subagentId || button.disabled) {
    return;
  }
  row.dataset.stopState = 'pending';
  row.querySelector<HTMLElement>('.mp-subagent-state')!.textContent =
    studioT('subagent.stopping');
  button.disabled = true;
  button.title = 'Stopping task…';
  button.setAttribute('aria-label', 'Stopping task');
  error.hidden = true;
  try {
    const result = await Data.stopSubagent({conversationId, subagentId});
    if (!childActive(row.dataset.status || '')) {
      return;
    }
    if (!result.ok) {
      throw new Error(result.error || 'Could not stop this task. Try again.');
    }
    row.dataset.stopState = 'requested';
  } catch (failure) {
    if (!childActive(row.dataset.status || '')) {
      return;
    }
    delete row.dataset.stopState;
    row.querySelector<HTMLElement>('.mp-subagent-state')!.textContent = '';
    button.disabled = false;
    button.title = 'Stop task';
    button.setAttribute('aria-label', 'Stop task');
    error.textContent =
      failure instanceof Error ? failure.message : String(failure);
    error.hidden = false;
  }
}

async function stopWorkflowRun(block: HTMLElement) {
  const conversationId = block.dataset.conversationId || '';
  const runId = block.dataset.runId || '';
  const button = block.querySelector<HTMLButtonElement>('.mpwf-stop')!;
  const error = block.querySelector<HTMLElement>('.mpwf-stop-error')!;
  if (!conversationId || !runId || button.disabled) {
    return;
  }
  block.dataset.stopState = 'pending';
  button.disabled = true;
  button.title = 'Stopping run…';
  button.setAttribute('aria-label', 'Stopping run');
  error.hidden = true;
  try {
    const result = await Data.stopWorkflow({conversationId, runId});
    if (block.dataset.active !== '1') {
      return;
    }
    if (!result.ok) {
      throw new Error(result.error || 'Could not stop this run. Try again.');
    }
    block.dataset.stopState = 'requested';
  } catch (failure) {
    if (block.dataset.active !== '1') {
      return;
    }
    delete block.dataset.stopState;
    button.disabled = false;
    button.title = 'Stop run';
    button.setAttribute('aria-label', 'Stop run');
    error.textContent =
      failure instanceof Error ? failure.message : String(failure);
    error.hidden = false;
  }
}

function workflowTokensText(tokens: number): string {
  return tokens > 0
    ? `${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens`
    : '';
}

function renderWorkflowRunBlocks(
  host: HTMLElement,
  blocks: WorkflowRunBlockView[],
  conversationId: string,
): HTMLElement[] {
  const existing = new Map(
    Array.from(host.querySelectorAll<HTMLElement>('.mpwf-run')).map(block => [
      block.dataset.runId,
      block,
    ]),
  );
  const setText = (node: Element, text: string) => {
    if (node.textContent !== text) {
      node.textContent = text;
    }
  };
  const rendered: HTMLElement[] = [];
  for (const block of blocks) {
    let section = existing.get(block.runId);
    if (!section) {
      section = document.createElement('section');
      section.className = 'mpwf-run';
      section.innerHTML =
        '<header class="mpwf-header"><strong class="mpwf-name"></strong>' +
        '<button type="button" class="mpwf-stop" title="Stop run" aria-label="Stop run"><svg aria-hidden="true"><use href="#ic-stop" /></svg></button></header>' +
        '<p class="mpwf-meta"><span class="mpwf-state"></span><span class="mpwf-progress"></span><span class="mpwf-tokens"></span></p>' +
        '<ol class="mpwf-timeline"></ol>' +
        '<p class="mpwf-stop-error" role="status" hidden></p>';
      const created = section;
      created
        .querySelector('.mpwf-stop')!
        .addEventListener('click', () => {
          void stopWorkflowRun(created);
        });
    }
    section.dataset.runId = block.runId;
    section.dataset.conversationId = conversationId;
    section.dataset.active = block.active ? '1' : '0';
    setText(
      section.querySelector('.mpwf-name')!,
      `Workflow ${block.runId.slice(0, 8)}`,
    );
    const succeeded = block.steps.filter(
      step => step.status === 'succeeded',
    ).length;
    const failed = block.steps.some(step => step.status === 'failed');
    setText(
      section.querySelector('.mpwf-state')!,
      block.active
        ? 'Running'
        : failed
          ? 'Failed'
          : succeeded === block.steps.length
            ? 'Completed'
            : 'Stopped',
    );
    setText(
      section.querySelector('.mpwf-progress')!,
      `${succeeded}/${block.steps.length} steps`,
    );
    setText(
      section.querySelector('.mpwf-tokens')!,
      workflowTokensText(
        block.steps.reduce((sum, step) => sum + step.tokens, 0),
      ),
    );
    const stop = section.querySelector<HTMLButtonElement>('.mpwf-stop')!;
    stop.hidden = !block.active || !conversationId;
    if (!block.active) {
      delete section.dataset.stopState;
      section.querySelector<HTMLElement>('.mpwf-stop-error')!.hidden = true;
    }
    stop.disabled = Boolean(section.dataset.stopState);
    const timeline = section.querySelector<HTMLElement>('.mpwf-timeline')!;
    const stepRows = new Map(
      Array.from(timeline.children).map(item => [
        (item as HTMLElement).dataset.stepId,
        item as HTMLElement,
      ]),
    );
    const wanted: HTMLElement[] = [];
    for (const step of block.steps) {
      let item = stepRows.get(step.stepId);
      if (!item) {
        item = document.createElement('li');
        item.className = 'mpwf-step';
        item.dataset.stepId = step.stepId;
        item.innerHTML =
          '<span class="mpwf-dot" aria-hidden="true"></span>' +
          '<span class="mpwf-step-title"><code class="mpwf-step-id"></code><span class="mpwf-step-name"></span></span>' +
          '<span class="mpwf-step-attempts"></span>' +
          '<span class="mpwf-step-tokens"></span>';
      }
      item.dataset.status = step.status;
      item.title = step.title;
      setText(item.querySelector('.mpwf-step-id')!, step.stepId);
      setText(item.querySelector('.mpwf-step-name')!, step.title);
      setText(
        item.querySelector('.mpwf-step-attempts')!,
        step.attempts > 1 ? `⟳${step.attempts}` : '',
      );
      setText(
        item.querySelector('.mpwf-step-tokens')!,
        workflowTokensText(step.tokens),
      );
      wanted.push(item);
    }
    for (const child of Array.from(timeline.children)) {
      if (!wanted.includes(child as HTMLElement)) {
        child.remove();
      }
    }
    wanted.forEach((item, index) => {
      if (timeline.children[index] !== item) {
        timeline.insertBefore(item, timeline.children[index] || null);
      }
    });
    rendered.push(section);
  }
  for (const [runId, section] of existing) {
    if (!blocks.some(block => block.runId === runId)) {
      section.remove();
    }
  }
  return rendered;
}

function renderProjectTasks() {
  renderPlanCard();
  scheduleBackgroundAgentRefresh();
  const host = document.getElementById('project-tasks');
  if (!host) {
    return;
  }
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
  const tasks = allTasks.filter(
    task =>
      childActive(task.status) ||
      childNeedsAttention(task) ||
      !view.cleared.has(task.id),
  );
  if (!tasks.length) {
    const empty = document.createElement('p');
    empty.className = 'mp-inspector-empty';
    empty.textContent = composerPlan?.steps.length ? '' : 'No tasks yet.';
    empty.hidden = Boolean(composerPlan?.steps.length);
    host.replaceChildren(empty);
    return;
  }
  const workflowBlocks = studioWorkflowPanel.groupWorkflowTasks(
    tasks as Array<Record<string, any>>,
  );
  const plainTasks = workflowBlocks.length
    ? tasks.filter(
        task => !studioWorkflowPanel.isWorkflowStepTaskId(task.id),
      )
    : tasks;
  const rows = new Map(
    Array.from(host.querySelectorAll<HTMLElement>('.mp-subagent-task')).map(
      row => [row.dataset.taskId, row],
    ),
  );
  const setText = (node: Element, text: string) => {
    if (node.textContent !== text) {
      node.textContent = text;
    }
  };
  host.querySelector('.mp-inspector-empty')?.remove();
  const makeSection = (label: string, items: StudioSubagentTask[]) => {
    let section = host.querySelector<HTMLElement>(
      `[data-task-section="${label}"]`,
    );
    if (!section) {
      section = document.createElement('section');
      section.className = 'mp-subagent-section';
      section.dataset.taskSection = label;
      const heading = document.createElement('div');
      heading.className = 'mp-subagent-section-header';
      if (label === 'Finished') {
        heading.innerHTML =
          '<button type="button" class="mp-subagent-finished-toggle"><span></span><svg aria-hidden="true"><use href="#ic-chev" /></svg></button>' +
          '<button type="button" class="mp-subagent-clear">Clear</button>';
        heading.querySelector('button')!.addEventListener('click', () => {
          view.finishedOpen = !view.finishedOpen;
          renderProjectTasks();
        });
        heading
          .querySelector('.mp-subagent-clear')!
          .addEventListener('click', () => {
            for (const task of currentSubagentTasks()) {
              if (!childActive(task.status) && !childNeedsAttention(task)) {
                view.cleared.add(task.id);
              }
            }
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
      const toggle = section.querySelector<HTMLElement>(
        '.mp-subagent-finished-toggle',
      )!;
      toggle.setAttribute('aria-expanded', String(view.finishedOpen));
      setText(toggle.querySelector('span')!, `Finished ${items.length}`);
    }
    for (const task of items) {
      let row = rows.get(task.id) || rows.get(`parent:${task.parentCallId}`);
      if (!row) {
        row = document.createElement('article');
        row.className = 'mp-subagent-task';
        row.innerHTML =
          '<div class="mp-subagent-heading"><strong></strong><button type="button" class="mp-subagent-stop" title="Stop task" aria-label="Stop task"><svg aria-hidden="true"><use href="#ic-stop" /></svg></button></div>' +
          '<div class="mp-subagent-meta"><span>Agent</span><span class="mp-subagent-model"></span><span class="mp-subagent-time"></span><span class="mp-subagent-state"></span></div>' +
          '<div class="mp-subagent-stats"><span class="mp-subagent-tool-uses"></span><span class="mp-subagent-current-tool"></span><span class="mp-subagent-usage"></span>' +
          '<button type="button" class="mp-subagent-transcript" aria-expanded="false">View transcript</button></div>' +
          '<p class="mp-subagent-stop-error" role="status" hidden></p>' +
          '<div class="mp-subagent-permission" hidden></div>' +
          '<p class="mp-subagent-resume-note" role="status" hidden></p>' +
          '<div class="mp-subagent-body" hidden><details class="mp-subagent-thinking"><summary>Thinking</summary><pre></pre></details>' +
          '<p class="mp-subagent-step-window" hidden></p>' +
          '<div class="mp-subagent-answer"></div><div class="mp-subagent-steps"></div><p class="mp-subagent-result"></p></div>';
        const taskRow = row;
        row
          .querySelector('.mp-subagent-stop')!
          .addEventListener('click', () => {
            void stopSubagentTask(taskRow);
          });
        row
          .querySelector('.mp-subagent-transcript')!
          .addEventListener('click', () => {
            const body =
              taskRow.querySelector<HTMLElement>('.mp-subagent-body')!;
            body.hidden = !body.hidden;
            const button = taskRow.querySelector<HTMLButtonElement>(
              '.mp-subagent-transcript',
            )!;
            button.textContent = body.hidden
              ? 'View transcript'
              : 'Hide transcript';
            button.setAttribute('aria-expanded', String(!body.hidden));
          });
      }
      row.dataset.taskId = task.id;
      row.dataset.parentCallId = task.parentCallId;
      row.dataset.conversationId =
        activeConversationId || pendingConversation?.conversationId || '';
      row.dataset.status = task.status;
      setText(row.querySelector('strong')!, task.description);
      setText(row.querySelector('.mp-subagent-model')!, task.model || '');
      setText(
        row.querySelector('.mp-subagent-time')!,
        task.elapsedMs ? ChatView.formatRunMeta(task.elapsedMs, null) : '',
      );
      setText(
        row.querySelector('.mp-subagent-state')!,
        task.resumeRequired
          ? studioT('subagent.needs_resume')
          : task.status === 'running'
            ? row.dataset.stopState
              ? studioT('subagent.stopping')
              : ''
            : subagentStatusLabel(task.status),
      );
      setText(
        row.querySelector('.mp-subagent-tool-uses')!,
        `${task.stepCount} tool ${task.stepCount === 1 ? 'use' : 'uses'}`,
      );
      setText(
        row.querySelector('.mp-subagent-current-tool')!,
        task.currentTool ||
          (task.status === 'running'
            ? task.phase === 'writing'
              ? studioT('subagent.writing')
              : studioT('subagent.thinking')
            : ''),
      );
      const usage = task.modelUsage;
      const reportedTokens =
        Number(usage?.totalTokens) ||
        Number(usage?.inputTokens || 0) + Number(usage?.outputTokens || 0);
      setText(
        row.querySelector('.mp-subagent-usage')!,
        reportedTokens > 0
          ? `${reportedTokens >= 1000 ? `${(reportedTokens / 1000).toFixed(1)}k` : reportedTokens} tokens`
          : '',
      );
      const stop = row.querySelector<HTMLButtonElement>('.mp-subagent-stop')!;
      stop.hidden =
        !childActive(task.status) ||
        task.id.startsWith('parent:') ||
        !row.dataset.conversationId;
      if (!childActive(task.status)) {
        delete row.dataset.stopState;
        row.querySelector<HTMLElement>('.mp-subagent-stop-error')!.hidden =
          true;
      }
      stop.disabled = Boolean(row.dataset.stopState);
      const permission = row.querySelector<HTMLElement>(
        '.mp-subagent-permission',
      )!;
      const input = task.pendingInput;
      const inputKey = `${row.dataset.conversationId}:${task.id}:${input?.requestId}`;
      if (
        input &&
        (task.status === 'awaiting_user' ||
          (task.status === 'stopped' && task.resumeRequired)) &&
        !acceptedChildInputs.has(inputKey)
      ) {
        const conversationId = row.dataset.conversationId!;
        DecisionCard.render(permission, {...input, key: inputKey}, response => {
          void respondToChildInput(permission, task, conversationId, response);
        });
      } else {
        DecisionCard.clear(permission);
      }
      const resumeNote = row.querySelector<HTMLElement>(
        '.mp-subagent-resume-note',
      )!;
      resumeNote.hidden = !task.resumeRequired;
      if (task.resumeRequired) {
        setText(resumeNote, subagentResumeText(task));
      }
      const thinking = row.querySelector<HTMLDetailsElement>(
        '.mp-subagent-thinking',
      )!;
      thinking.hidden = !task.reasoning;
      setText(
        thinking.querySelector('summary')!,
        task.status === 'running' && task.phase === 'thinking'
          ? studioT('subagent.thinking_live')
          : studioT('subagent.thought'),
      );
      setText(thinking.querySelector('pre')!, task.reasoning || '');
      const answer = row.querySelector<HTMLElement>('.mp-subagent-answer')!;
      answer.hidden = !task.answer;
      setText(answer, task.answer || '');
      const stepsHost = row.querySelector<HTMLElement>('.mp-subagent-steps')!;
      const stepWindow = row.querySelector<HTMLElement>(
        '.mp-subagent-step-window',
      )!;
      stepWindow.hidden = task.stepCount <= task.steps.length;
      if (!stepWindow.hidden) {
        setText(
          stepWindow,
          `Showing latest ${task.steps.length} of ${task.stepCount} tool uses`,
        );
      }
      const stepRows = new Map(
        Array.from(stepsHost.children).map(item => [
          (item as HTMLElement).dataset.stepId,
          item as HTMLElement,
        ]),
      );
      const wantedSteps: HTMLElement[] = [];
      for (const step of task.steps) {
        const stepId = step.callId || String(step.index);
        let item = stepRows.get(stepId);
        if (!item) {
          item = document.createElement('details');
          item.className = 'mp-subagent-step-evidence';
          item.dataset.stepId = stepId;
          item.innerHTML =
            '<summary class="mp-subagent-step"><span class="mp-subagent-step-marker"></span><span class="mp-subagent-step-name"></span><small></small></summary><pre class="mp-subagent-step-input"></pre><pre class="mp-subagent-step-output"></pre>';
        }
        item.dataset.status = step.status;
        item.querySelector<HTMLElement>('summary')!.dataset.status =
          step.status;
        setText(
          item.querySelector('.mp-subagent-step-marker')!,
          step.status === 'completed'
            ? '✓'
            : step.status === 'failed'
              ? '!'
              : '·',
        );
        setText(
          item.querySelector('.mp-subagent-step-name')!,
          step.tool || `Step ${step.index}`,
        );
        setText(
          item.querySelector('small')!,
          [
            step.usedBackend,
            step.latencyMs ? `${Math.round(step.latencyMs)}ms` : '',
          ]
            .filter(Boolean)
            .join(' · '),
        );
        setText(
          item.querySelector('.mp-subagent-step-input')!,
          step.input || '',
        );
        setText(
          item.querySelector('.mp-subagent-step-output')!,
          step.output || '',
        );
        wantedSteps.push(item);
      }
      for (const child of Array.from(stepsHost.children)) {
        if (!wantedSteps.includes(child as HTMLElement)) {
          child.remove();
        }
      }
      wantedSteps.forEach((item, i) => {
        if (stepsHost.children[i] !== item) {
          stepsHost.insertBefore(item, stepsHost.children[i] || null);
        }
      });
      setText(row.querySelector('.mp-subagent-result')!, task.summary);
      const index = items.indexOf(task);
      if (list.children[index] !== row) {
        list.insertBefore(row, list.children[index] || null);
      }
    }
    return section;
  };
  const running = plainTasks.filter(task => childActive(task.status));
  const attention = plainTasks.filter(
    task => !childActive(task.status) && childNeedsAttention(task),
  );
  const finished = plainTasks.filter(
    task => !childActive(task.status) && !attention.includes(task),
  );
  const sections: HTMLElement[] = [
    ...renderWorkflowRunBlocks(
      host,
      workflowBlocks,
      activeConversationId || pendingConversation?.conversationId || '',
    ),
  ];
  if (running.length) {
    sections.push(makeSection('Running', running));
  }
  if (attention.length) {
    sections.push(makeSection('Needs attention', attention));
  }
  if (finished.length) {
    sections.push(makeSection('Finished', finished));
  }
  for (const row of rows.values()) {
    if (!plainTasks.some(task => task.id === row.dataset.taskId)) {
      row.remove();
    }
  }
  for (const section of Array.from(host.children)) {
    if (!sections.includes(section as HTMLElement)) {
      section.remove();
    }
  }
  sections.forEach((section, index) => {
    if (host.children[index] !== section) {
      host.insertBefore(section, host.children[index] || null);
    }
  });
}

document.addEventListener('mp:open-subagent', event => {
  const detail = (event as CustomEvent<{id?: string; parentCallId?: string}>)
    .detail;
  const requestedId = String(detail?.id || '');
  const parentCallId = String(detail?.parentCallId || '');
  const tasks = currentSubagentTasks();
  const matchingTask = tasks.find(
    task => task.id === requestedId || task.parentCallId === parentCallId,
  );
  focusedSubagentId = matchingTask?.id || requestedId;
  openWorkspaceResource({
    kind: 'transcript',
    title: matchingTask?.description || 'Transcript',
    resourceKey: `transcript:${focusedSubagentId || parentCallId || requestedId}`,
    taskId: focusedSubagentId || undefined,
  });
  if (matchingTask) {
    const view = backgroundTaskView();
    view.cleared.delete(matchingTask.id);
    if (matchingTask.status !== 'running') {
      view.finishedOpen = true;
    }
  }
  setInspector(true, 'tasks');
  renderProjectTasks();
  if (focusedSubagentId) {
    requestAnimationFrame(() => {
      const taskRow = document.querySelector<HTMLElement>(
        `.mp-subagent-task[data-task-id="${CSS.escape(focusedSubagentId)}"]`,
      );
      taskRow?.scrollIntoView({block: 'nearest'});
      taskRow
        ?.querySelector<HTMLElement>('.mp-subagent-transcript')
        ?.focus({preventScroll: true});
    });
  }
});

let projectBrowserResizeFrame: number | null = null;

function scheduleProjectBrowserResize() {
  if (projectBrowserResizeFrame !== null) {
    return;
  }
  projectBrowserResizeFrame = requestAnimationFrame(() => {
    projectBrowserResizeFrame = null;
    resizeProjectBrowser();
  });
}

function closeProjectBrowserView() {
  if (!browserViewVisible) {
    return;
  }
  browserViewVisible = false;
  void Data.browserViewCommand('hide');
}

Data.onBrowserViewState(state => renderBrowserViewState(state));
const projectBrowserHost = document.getElementById('project-browser-host');
if (projectBrowserHost && typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => scheduleProjectBrowserResize()).observe(
    projectBrowserHost,
  );
}
window.addEventListener('resize', () => {
  scheduleStreamRail();
  syncSessionPaneViewport();
  if (inspectorState.open && !inspectorState.maximized) {
    inspectorState = inspectorStatePolicy.reduceInspectorState(inspectorState, {
      type: 'viewport',
      availableWidth: inspectorAvailableWidth(),
    });
    syncInspectorGeometry();
    return;
  }
  scheduleProjectBrowserResize();
});

seedSessionPane(sessionPaneSessionId());
syncSessionPaneViewport();

function inspectorAvailableWidth(): number {
  const sidebarWidth =
    sidebarState.layout() === 'docked'
      ? (document.querySelector('.mpw-sidebar-col')?.getBoundingClientRect()
          .width ?? 288)
      : 0;
  return Math.max(0, shell.clientWidth - sidebarWidth);
}

function renderInspectorTitle() {
  const inspector = document.getElementById('project-inspector');
  const title = document.getElementById('inspector-title');
  if (!inspector || !title) {
    return;
  }
  const labels: Record<string, string> = {
    activity: 'activity.log',
    materials: 'inspector.materials',
    files: 'inspector.files',
    browser: 'inspector.browser',
    terminal: 'inspector.terminal',
    changes: 'inspector.changes',
    tasks:
      inspector.dataset.taskLayout === 'background'
        ? 'inspector.background_tasks'
        : 'inspector.tasks',
    artifact: 'inspector.artifact',
    modules: 'inspector.modules',
  };
  title.textContent = studioT(labels[inspectorState.tab] || 'inspector.task');
}

function syncInspectorGeometry() {
  const inspector = document.getElementById('project-inspector');
  const maximize = document.getElementById('inspector-maximize');
  if (!inspector) {
    return;
  }
  inspector.hidden = !inspectorState.open;
  const taskRail = inspectorState.tab === 'tasks';
  const backgroundTasks =
    taskRail && inspector.dataset.taskLayout === 'background';
  const rail = inspectorStatePolicy.sessionRailGeometry(
    inspectorAvailableWidth(),
  );
  inspector.dataset.taskRail = String(taskRail && !backgroundTasks);
  inspector.dataset.backgroundTasks = String(backgroundTasks);
  inspector.dataset.railOverlay = String(
    taskRail && !backgroundTasks && rail.overlay,
  );
  if (sessionPaneState && sessionPaneState.isViewportNarrow) {
    sessionPaneState = {
      ...sessionPaneState,
      isOverlayOpen: inspectorState.open,
    };
  }
  if (
    sessionPaneState &&
    sessionPaneState.isViewportNarrow &&
    inspectorState.open
  ) {
    shell.dataset.inspectorOverlay = 'true';
  } else {
    delete shell.dataset.inspectorOverlay;
  }
  shell.dataset.taskSurface = !inspectorState.open
    ? ''
    : backgroundTasks
      ? 'background'
      : taskRail
        ? 'plan'
        : 'document';
  inspector.style.width =
    taskRail && !backgroundTasks
      ? `${rail.width}px`
      : inspectorState.maximized
        ? ''
        : backgroundTasks
          ? '416px'
          : `${inspectorState.width}px`;
  renderInspectorTitle();
  if (maximize) {
    maximize.hidden = taskRail && !backgroundTasks;
  }
  const resizeHandle = document.getElementById('inspector-resize-handle');
  if (resizeHandle) {
    resizeHandle.hidden = taskRail;
    resizeHandle.setAttribute('aria-valuenow', String(inspectorState.width));
    resizeHandle.setAttribute(
      'aria-valuemin',
      String(
        inspectorStatePolicy.clampInspectorWidth(0, inspectorAvailableWidth()),
      ),
    );
    resizeHandle.setAttribute(
      'aria-valuemax',
      String(
        inspectorStatePolicy.clampInspectorWidth(
          Number.MAX_SAFE_INTEGER,
          inspectorAvailableWidth(),
        ),
      ),
    );
  }
  if (inspectorState.open) {
    shell.dataset.inspector = 'open';
  } else {
    delete shell.dataset.inspector;
  }
  if (inspectorState.maximized && (!taskRail || backgroundTasks)) {
    shell.dataset.inspectorMaximized = 'true';
  } else {
    delete shell.dataset.inspectorMaximized;
  }
  maximize?.setAttribute('aria-pressed', String(inspectorState.maximized));
  maximize?.setAttribute(
    'aria-label',
    inspectorState.maximized
      ? studioT('tasks.collapse')
      : studioT('tasks.expand'),
  );
  try {
    localStorage.setItem(
      INSPECTOR_WIDTH_KEY,
      String(inspectorState.previousWidth),
    );
  } catch {
    /* storage unavailable */
  }
  document
    .getElementById('inspector-toggle')
    ?.setAttribute('aria-expanded', String(inspectorState.open));
  scheduleProjectBrowserResize();
}

function restorePanelFocus(origin: HTMLElement | null): void {
  if (origin?.isConnected && origin.getClientRects().length) {
    origin.focus({preventScroll: true});
  } else {
    document
      .querySelector<HTMLTextAreaElement>('#composer-form textarea')
      ?.focus({preventScroll: true});
  }
}

function setInspector(open: boolean, tab = activeInspectorTab) {
  const inspector = document.getElementById('project-inspector');
  if (!inspector) {
    return;
  }
  if (open && !inspectorState.open) {
    const focused = document.activeElement;
    inspectorReturnFocus =
      focused instanceof HTMLElement &&
      focused !== document.body &&
      !inspector.contains(focused)
        ? focused
        : null;
  }
  inspectorState = inspectorStatePolicy.reduceInspectorState(
    inspectorState,
    open
      ? {type: 'open', tab, availableWidth: inspectorAvailableWidth()}
      : {type: 'close'},
  );
  activeInspectorTab = inspectorState.tab;
  trackSessionPaneExpansion(sessionPaneSessionId(), inspectorState.open);
  syncInspectorGeometry();
  document
    .querySelectorAll<HTMLElement>('[data-inspector-panel]')
    .forEach(panel => {
      panel.hidden = panel.dataset.inspectorPanel !== activeInspectorTab;
    });
  document
    .querySelectorAll<HTMLElement>('.mp-inspector-tabs [data-inspector-tab]')
    .forEach(button => {
      const active = button.dataset.inspectorTab === activeInspectorTab;
      button.classList.toggle('is-on', active);
      button.setAttribute('aria-selected', String(active));
    });
  if (!open) {
    closeProjectBrowserView();
    return;
  }
  if (activeInspectorTab !== 'browser') {
    closeProjectBrowserView();
  }
  if (activeInspectorTab === 'files' && !projectTreeCache.has('')) {
    void refreshProjectInspector();
  }
  if (activeInspectorTab === 'materials') {
    renderTaskMaterials();
  }
  if (activeInspectorTab === 'changes') {
    void renderProjectChanges();
  }
  if (activeInspectorTab === 'tasks') {
    renderProjectTasks();
  }
  if (activeInspectorTab === 'activity') {
    renderConversationActivity();
  }
  if (open && activeInspectorTab === 'modules') {
    modsConversationId = activeConversationId || '';
    void modsWorkspaceController?.refresh();
  }
  if (activeInspectorTab === 'artifact') {
    renderArtifactEditor();
  }
  if (activeInspectorTab === 'browser') {
    browserViewVisible = Boolean(latestBrowserViewState.url);
    scheduleProjectBrowserResize();
  }
}

/**
 * The thread header keeps one visible action besides the trajectory entry. The
 * terminal, materials and preview toggles are secondary, so they live in the
 * overflow menu where the reference keeps its own secondary actions.
 */
function toggleMaterialsPanel(): void {
  const activeResource = workspaceResourceTabs.find(tab => tab.active);
  toggleSessionPane(
    activeResource
      ? resourcePanelFor(activeResource.kind)
      : activeProjectRoot
        ? 'files'
        : 'materials',
  );
}

function toggleTerminalPanel(): void {
  if (shell.dataset.bottomPanel === 'open') {
    closeBottomPanel();
  } else {
    setBottomPanel(true);
  }
}

document
  .getElementById('execution-toggle')
  ?.addEventListener('click', () => setInspector(true, 'activity'));
const executionActivity = document.getElementById('conversation-activity');
if (executionActivity) {
  ChatView.bindDelegation(executionActivity);
}
function closeInspectorPanel(): void {
  workspaceAutoOpenedResourceKey = '';
  setInspector(false);
  restorePanelFocus(inspectorReturnFocus);
  inspectorReturnFocus = null;
}
document
  .getElementById('inspector-close')
  ?.addEventListener('click', closeInspectorPanel);
document.getElementById('project-inspector')?.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  document.getElementById('inspector-close')?.click();
});
document.getElementById('inspector-maximize')?.addEventListener('click', () => {
  workspaceAutoOpenedResourceKey = '';
  inspectorState = inspectorStatePolicy.reduceInspectorState(
    inspectorState,
    inspectorState.maximized
      ? {type: 'restore', availableWidth: inspectorAvailableWidth()}
      : {type: 'maximize'},
  );
  syncInspectorGeometry();
});
document
  .getElementById('project-inspector')
  ?.addEventListener('pointerdown', event => {
    const target = event.target as Element | null;
    if (
      target?.closest(
        '#inspector-close, #inspector-maximize, #inspector-resize-handle, .mpw-workspace-tab',
      )
    ) {
      return;
    }
    workspaceAutoOpenedResourceKey = '';
  });

(function bindInspectorResize() {
  const handle = document.getElementById('inspector-resize-handle');
  if (!handle) {
    return;
  }
  let cancelDrag: (() => void) | null = null;
  const resize = (width: number) => {
    workspaceAutoOpenedResourceKey = '';
    inspectorState = inspectorStatePolicy.reduceInspectorState(inspectorState, {
      type: 'resize',
      width,
      availableWidth: inspectorAvailableWidth(),
    });
    syncInspectorGeometry();
  };
  const balance = () => resize((inspectorAvailableWidth() - 8) / 2);
  handle.addEventListener('dblclick', balance);
  handle.addEventListener('keydown', event => {
    if (
      cancelDrag ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      inspectorState.maximized
    ) {
      return;
    }
    const step = event.shiftKey ? 64 : 16;
    const width =
      event.key === 'ArrowLeft'
        ? inspectorState.width + step
        : event.key === 'ArrowRight'
          ? inspectorState.width - step
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? Number.MAX_SAFE_INTEGER
              : null;
    if (width !== null || event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (width === null) {
        balance();
      } else {
        resize(width);
      }
    }
  });
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || inspectorState.maximized || cancelDrag) {
      return;
    }
    event.preventDefault();
    handle.focus({preventScroll: true});
    const startX = event.clientX;
    const startWidth = inspectorState.width;
    const previousWidth = inspectorState.previousWidth;
    let moved = false;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      if (
        moveEvent.pointerId !== event.pointerId ||
        (!moved && Math.abs(moveEvent.clientX - startX) < 4)
      ) {
        return;
      }
      if (!moved) {
        moved = true;
        handle.dataset.dragging = 'true';
        shell.dataset.paneDragging = 'true';
        if (browserViewVisible) {
          void Data.browserViewCommand('hide');
        }
      }
      resize(startWidth + startX - moveEvent.clientX);
    };
    const finish = (cancel: boolean) => {
      cancelDrag = null;
      delete handle.dataset.dragging;
      delete shell.dataset.paneDragging;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', commit);
      handle.removeEventListener('pointercancel', cancelResize);
      handle.removeEventListener('lostpointercapture', cancelResize);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', cancelResize);
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      if (cancel && moved) {
        inspectorState = {...inspectorState, width: startWidth, previousWidth};
        syncInspectorGeometry();
      }
      scheduleProjectBrowserResize();
    };
    const commit = () => finish(false);
    const cancelResize = () => finish(true);
    const escape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') {
        keyEvent.preventDefault();
        keyEvent.stopImmediatePropagation();
        cancelResize();
      }
    };
    cancelDrag = cancelResize;
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', commit);
    handle.addEventListener('pointercancel', cancelResize);
    handle.addEventListener('lostpointercapture', cancelResize);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', cancelResize);
  });
})();
document
  .getElementById('project-file-tree')
  ?.addEventListener('click', event => {
    const row = (event.target as Element | null)?.closest<HTMLElement>(
      '[data-project-path]',
    );
    if (!row) {
      return;
    }
    const relativePath = row.dataset.projectPath || '';
    if (row.dataset.projectKind === 'directory') {
      if (expandedProjectDirectories.has(relativePath)) {
        expandedProjectDirectories.delete(relativePath);
        renderProjectFileTree();
      } else {
        expandedProjectDirectories.add(relativePath);
        if (projectTreeCache.has(relativePath)) {
          renderProjectFileTree();
        } else {
          void loadProjectDirectory(relativePath);
        }
      }
      return;
    }
    void selectProjectFile(relativePath);
  });
document
  .getElementById('project-file-tree')
  ?.addEventListener('contextmenu', event => {
    const row = (event.target as Element | null)?.closest<HTMLElement>(
      '[data-project-path]',
    );
    if (!row || !activeProjectRoot) {
      return;
    }
    event.preventDefault();
    const relativePath = row.dataset.projectPath || '';
    const kind = row.dataset.projectKind === 'directory' ? 'directory' : 'file';
    void Data.showProjectContextMenu(
      activeProjectRoot,
      relativePath,
      kind,
    ).then(result => {
      if (!result?.ok) {
        return;
      }
      if (result.action === 'preview' && kind === 'file') {
        void selectProjectFile(relativePath);
      }
      if (result.action === 'open-in-browser' && kind === 'file') {
        setInspector(true, 'browser');
        void openProjectBrowser('', relativePath);
      }
      if (result.action === 'terminal-here') {
        activeTerminalRelativeDirectory = relativePath;
        openWorkspaceResource({
          kind: 'terminal',
          title: relativePath ? `PowerShell · ${relativePath}` : 'PowerShell',
          resourceKey: `terminal:${normalizedProjectRoot(activeProjectRoot)}:${activeTerminalRelativeDirectory}`,
        });
        renderTerminalPrompt();
      }
    });
  });
(function bindFileTreeKeyboard() {
  const host = document.getElementById('project-file-tree');
  if (!host) {
    return;
  }
  const rows = () => [...host.querySelectorAll<HTMLElement>('[data-tree-row]')];
  const visible = (row: HTMLElement) => {
    const box = host.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    return rect.bottom > box.top && rect.top < box.bottom;
  };
  const focusRow = (row: HTMLElement | undefined | null) => {
    row?.focus();
    row?.scrollIntoView({block: 'nearest'});
  };
  const currentRow = () => {
    const active = document.activeElement as HTMLElement | null;
    const all = rows();
    return active && all.includes(active)
      ? active
      : all.find(row => row.classList.contains('is-on') && visible(row)) ||
          all.find(visible) ||
          all[0];
  };
  host.addEventListener('focus', event => {
    if (event.target !== host) {
      return;
    }
    focusRow(currentRow());
  });
  host.addEventListener('keydown', event => {
    const all = rows();
    if (!all.length) {
      return;
    }
    const row = currentRow();
    const index = row ? all.indexOf(row) : -1;
    const go = (next: number) => {
      event.preventDefault();
      focusRow(all[Math.max(0, Math.min(all.length - 1, next))]);
    };
    if (event.key === 'ArrowDown') {
      go(index < 0 ? 0 : index + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      if (index <= 0) {
        event.preventDefault();
        document.getElementById('file-tree-filter')?.focus();
        return;
      }
      go(index - 1);
      return;
    }
    if (event.key === 'Home') {
      go(0);
      return;
    }
    if (event.key === 'End') {
      go(all.length - 1);
      return;
    }
    if (!row) {
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (
        row.dataset.projectKind === 'directory' &&
        row.getAttribute('aria-expanded') === 'false'
      ) {
        row.click();
      } else {
        go(index + 1);
      }
      return;
    }
    if (event.key === 'ArrowLeft') {
      if (row.getAttribute('aria-expanded') === 'true') {
        event.preventDefault();
        row.click();
        return;
      }
      const depth = Number(row.dataset.depth || '0');
      if (depth <= 0) {
        return;
      }
      event.preventDefault();
      for (let i = index - 1; i >= 0; i -= 1) {
        if (Number(all[i].dataset.depth || '0') < depth) {
          focusRow(all[i]);
          return;
        }
      }
    }
  });
})();
document
  .getElementById('file-tree-filter')
  ?.addEventListener('input', event => {
    event.stopPropagation();
    projectFileTreeFilter = (event.currentTarget as HTMLInputElement).value;
    renderProjectFileTree();
  });
document.getElementById('project-file-back')?.addEventListener('click', () => {
  projectFileRequest++;
  const preview = document.getElementById('project-file-preview');
  if (preview) {
    preview.hidden = true;
  }
  preview?.closest('.mp-inspector-panel')?.classList.remove('is-previewing');
  selectedProjectFile = '';
  selectedProjectFileText = '';
  selectedProjectFileDiff = null;
  document.getElementById('project-file-content')?.replaceChildren();
  selectedProjectFileLoading = false;
  selectedProjectFileMarkdown = false;
  projectFileCodeView = false;
  const inspectorTitle = document.getElementById('inspector-title');
  if (inspectorTitle) {
    inspectorTitle.textContent = 'Files';
  }
  renderProjectFileTree();
});
const projectFileContent = document.getElementById('project-file-content');
if (projectFileContent) {
  ChatView.bindDelegation(projectFileContent);
}

document.getElementById('project-file-code')?.addEventListener('click', () => {
  projectFileCodeView = !projectFileCodeView;
  renderSelectedProjectFile();
});
document.getElementById('project-file-copy')?.addEventListener('click', () => {
  if (selectedProjectFileText) {
    void navigator.clipboard.writeText(selectedProjectFileText);
  }
});
document
  .getElementById('project-file-search')
  ?.addEventListener('click', () => {
    const input = document.getElementById(
      'project-file-search-input',
    ) as HTMLInputElement | null;
    if (!input) {
      return;
    }
    input.hidden = !input.hidden;
    if (!input.hidden) {
      input.focus();
    }
  });
document
  .getElementById('project-file-search-input')
  ?.addEventListener('input', event => {
    const query = (event.currentTarget as HTMLInputElement).value;
    const find = (window as Window & {find?: (...args: unknown[]) => boolean})
      .find;
    if (query && find) {
      find.call(window, query, false, false, true, false, true, false);
    }
  });
document
  .getElementById('project-browser-form')
  ?.addEventListener('submit', event => {
    event.preventDefault();
    const input = document.getElementById(
      'project-browser-url',
    ) as HTMLInputElement | null;
    if (input?.value.trim()) {
      void openProjectBrowser(input.value.trim());
    }
  });
document
  .getElementById('project-browser-back')
  ?.addEventListener('click', () => {
    void Data.browserViewCommand('back');
  });
document
  .getElementById('project-browser-forward')
  ?.addEventListener('click', () => {
    void Data.browserViewCommand('forward');
  });
document
  .getElementById('project-browser-reload')
  ?.addEventListener('click', () => {
    void Data.browserViewCommand(
      latestBrowserViewState.loading ? 'stop' : 'reload',
    );
  });
document
  .getElementById('project-browser-external')
  ?.addEventListener('click', () => {
    if (browserViewVisible) {
      void Data.browserViewCommand('external');
    } else {
      const url = (
        document.getElementById(
          'project-browser-url',
        ) as HTMLInputElement | null
      )?.value.trim();
      if (url) {
        void Data.openProjectUrl(
          /^https?:\/\//i.test(url) ? url : `https://${url}`,
        );
      }
    }
  });

let activeTerminalRelativeDirectory = '';

function renderTerminalPrompt() {
  const suffix = activeTerminalRelativeDirectory
    ? `\\${activeTerminalRelativeDirectory.replace(/\//g, '\\')}`
    : '';
  for (const id of ['project-terminal-output', 'bottom-terminal-output']) {
    const output = document.getElementById(id);
    const label = output?.querySelector('.mp-terminal-label');
    if (label) {
      label.textContent = `PowerShell · ${studioT('terminal.current_project')}${suffix}`;
    }
  }
}

function renderTerminalLanguage(): void {
  document
    .getElementById('bottom-panel')
    ?.setAttribute('aria-label', studioT('terminal.bottom_panel'));
  document
    .getElementById('bottom-panel-close')
    ?.setAttribute('aria-label', studioT('terminal.close_bottom'));
  const tools = document.querySelector('#bottom-panel nav');
  tools?.setAttribute('aria-label', studioT('terminal.bottom_tools'));
  const title = tools?.querySelector('button');
  if (title) {
    title.textContent = studioT('terminal.title');
  }
  for (const form of document.querySelectorAll<HTMLFormElement>(
    '.mp-terminal-form',
  )) {
    form
      .querySelector('input')
      ?.setAttribute('aria-label', studioT('terminal.command'));
    const button = form.querySelector('button[type="submit"]');
    if (button) {
      button.textContent = studioT(
        form.dataset.submitting === 'true'
          ? 'terminal.sending'
          : 'terminal.run',
      );
    }
  }
  for (const button of document.querySelectorAll('[data-terminal-stop]')) {
    button.textContent = studioT('terminal.stop');
  }
  renderTerminalPrompt();
}

async function runTerminalCommand(command: string): Promise<boolean> {
  if (!command) {
    return false;
  }
  if (!activeProjectRoot) {
    appendTerminalOutput(`\n${studioT('project.open_first')}\n`);
    return false;
  }
  try {
    const started = await Data.startProjectTerminal(
      activeProjectRoot,
      activeTerminalRelativeDirectory,
    );
    if (!started.ok) {
      throw new Error(started.error || studioT('terminal.start_failed'));
    }
    const written = await Data.writeProjectTerminal(command);
    if (!written.ok) {
      throw new Error(written.error || studioT('terminal.write_failed'));
    }
    appendTerminalOutput(`\n> ${command}\n`);
    return true;
  } catch (error) {
    appendTerminalOutput(
      `\n${error instanceof Error ? error.message : String(error)}\n`,
    );
    return false;
  }
}

function appendTerminalOutput(text: string) {
  for (const id of ['project-terminal-output', 'bottom-terminal-output']) {
    const output = document.getElementById(id);
    if (!output) {
      continue;
    }
    let log = output.querySelector<HTMLPreElement>('.mp-terminal-log');
    if (!log) {
      log = document.createElement('pre');
      log.className = 'mp-terminal-log';
      output.append(log);
    }
    log.textContent = `${(log.textContent || '') + text}`.slice(-512 * 1024);
    output.scrollTop = output.scrollHeight;
  }
}

Data.onProjectTerminalEvent(event => {
  appendTerminalOutput(
    event.type === 'output'
      ? event.text
      : `\nTerminal exited (${event.code ?? 'stopped'})\n`,
  );
});

document.querySelectorAll('[data-terminal-stop]').forEach(button => {
  button.addEventListener('click', () => void Data.stopProjectTerminal());
});

document.getElementById('project-file-open')?.addEventListener('click', () => {
  if (selectedProjectFile) {
    void Data.openProjectPath(activeProjectRoot, selectedProjectFile);
  }
});

for (const pair of [
  [
    'project-terminal-form',
    'project-terminal-input',
    'project-terminal-output',
  ],
  ['bottom-terminal-form', 'bottom-terminal-input', 'bottom-terminal-output'],
] as const) {
  document.getElementById(pair[0])?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = document.getElementById(pair[1]) as HTMLInputElement | null;
    const output = document.getElementById(pair[2]);
    const command = input?.value.trim() || '';
    if (!input || !command || !output || form.dataset.submitting === 'true') {
      return;
    }
    const submittedText = input.value;
    const scope = workspaceResourceScopeKey();
    const button = form.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    )!;
    form.dataset.submitting = 'true';
    form.setAttribute('aria-busy', 'true');
    button.disabled = true;
    button.textContent = studioT('terminal.sending');
    try {
      if (form.id === 'project-terminal-form' && activeProjectRoot) {
        openWorkspaceResource({
          kind: 'terminal',
          title: activeTerminalRelativeDirectory
            ? `PowerShell · ${activeTerminalRelativeDirectory}`
            : 'PowerShell',
          resourceKey: `terminal:${normalizedProjectRoot(activeProjectRoot)}:${activeTerminalRelativeDirectory}`,
        });
      }
      const accepted = await runTerminalCommand(command);
      if (
        accepted &&
        input.value === submittedText &&
        workspaceResourceScopeKey() === scope
      ) {
        input.value = '';
      }
    } finally {
      delete form.dataset.submitting;
      form.removeAttribute('aria-busy');
      button.disabled = false;
      button.textContent = studioT('terminal.run');
    }
  });
}

function setBottomPanel(open: boolean) {
  const panel = document.getElementById('bottom-panel');
  if (!panel) {
    return;
  }
  if (open && panel.hidden) {
    const focused = document.activeElement;
    bottomPanelReturnFocus =
      focused instanceof HTMLElement &&
      focused !== document.body &&
      !panel.contains(focused)
        ? focused
        : null;
  }
  panel.hidden = !open;
  if (open) {
    shell.dataset.bottomPanel = 'open';
  } else {
    delete shell.dataset.bottomPanel;
  }
  document
    .getElementById('bottom-panel-toggle')
    ?.setAttribute('aria-expanded', String(open));
  if (open) {
    renderTerminalPrompt();
    requestAnimationFrame(() =>
      (
        document.getElementById(
          'bottom-terminal-input',
        ) as HTMLInputElement | null
      )?.focus(),
    );
  }
}

document
  .getElementById('bottom-panel-toggle')
  ?.addEventListener('click', toggleTerminalPanel);
function closeBottomPanel(): void {
  setBottomPanel(false);
  restorePanelFocus(bottomPanelReturnFocus);
  bottomPanelReturnFocus = null;
}
document
  .getElementById('bottom-panel-close')
  ?.addEventListener('click', closeBottomPanel);
document.getElementById('bottom-panel')?.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  document.getElementById('bottom-panel-close')?.click();
});

let pluginDirectoryCatalog: MagicPointerSlashDirectory | null = null;
let pluginDirectoryKind: 'skills' | 'commands' = 'skills';

function closePluginDirectory() {
  const overlay = document.getElementById('plugin-directory');
  if (overlay) {
    overlay.hidden = true;
  }
  document.getElementById('nav-plugins')?.classList.remove('is-on');
}

function renderPluginDirectory() {
  const host = document.getElementById('plugin-directory-list');
  if (!host) {
    return;
  }
  const query =
    (
      document.getElementById(
        'plugin-directory-search',
      ) as HTMLInputElement | null
    )?.value
      .trim()
      .toLocaleLowerCase() || '';
  const entries =
    (pluginDirectoryKind === 'skills'
      ? pluginDirectoryCatalog?.skills
      : pluginDirectoryCatalog?.commands) || [];
  const filtered = entries.filter(entry =>
    [entry.name, entry.description, entry.whenToUse, entry.source]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
      .includes(query),
  );
  document.getElementById('plugin-directory-kind-label')!.textContent =
    pluginDirectoryKind === 'skills' ? studioT('directory.installed_skills') : studioT('directory.available_commands');
  document.getElementById('plugin-directory-count')!.textContent =
    studioTCount('count.items', filtered.length);
  host.replaceChildren(
    ...filtered.map(entry => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'mp-directory-card';
      card.innerHTML = `<strong>/${esc(entry.name)}</strong><p>${esc(entry.description || entry.whenToUse || studioT('directory.composer_hint'))}</p><small>${esc(entry.source || entry.path || 'Magic Pointer')}</small>`;
      card.addEventListener('click', () => {
        insertSlashToken(entry.name);
        closePluginDirectory();
        show('chat');
      });
      return card;
    }),
  );
  if (!filtered.length) {
    host.innerHTML = '<p class="mp-inspector-empty">' + studioT('directory.no_projects') + '</p>';
  }
}

async function openPluginDirectory() {
  const overlay = document.getElementById('plugin-directory');
  if (!overlay) {
    return;
  }
  overlay.hidden = false;
  document.getElementById('nav-plugins')?.classList.add('is-on');
  const host = document.getElementById('plugin-directory-list');
  if (host) {
    host.innerHTML = '<p class="mp-inspector-empty">' + studioT('directory.loading') + '</p>';
  }
  pluginDirectoryCatalog = await Data.slashDirectory();
  renderPluginDirectory();
  requestAnimationFrame(() =>
    (
      document.getElementById(
        'plugin-directory-search',
      ) as HTMLInputElement | null
    )?.focus(),
  );
}

document
  .getElementById('plugin-directory-search')
  ?.addEventListener('input', renderPluginDirectory);
document
  .querySelectorAll<HTMLElement>('[data-directory-kind]')
  .forEach(button => {
    button.addEventListener('click', () => {
      pluginDirectoryKind =
        button.dataset.directoryKind === 'commands' ? 'commands' : 'skills';
      document
        .querySelectorAll<HTMLElement>('[data-directory-kind]')
        .forEach(item => item.classList.toggle('is-on', item === button));
      renderPluginDirectory();
    });
  });

document.addEventListener('click', e => {
  const target = e.target as Element | null;
  if (!target) {
    return;
  }
  if (!target.closest('#window-menu-popover') && !target.closest('#app-menu')) {
    closeWindowMenu();
  }
  if (!target.closest('#account-menu') && !target.closest('#account-footer')) {
    closeAccountMenu();
  }
  if (
    !target.closest('#magic-brain-popover') &&
    !target.closest('#magic-brain-toggle')
  ) {
    const brain = document.getElementById('magic-brain-popover');
    if (brain) {
      brain.hidden = true;
    }
    document
      .getElementById('magic-brain-toggle')
      ?.setAttribute('aria-expanded', 'false');
  }
  if (target.closest('[data-directory-close]')) {
    closePluginDirectory();
    return;
  }
  if (target.closest('[data-directory-open]')) {
    void openPluginDirectory();
    return;
  }
  if (!target.closest('#thread-menu') && !target.closest('#thread-more')) {
    closeThreadMenu();
  }
  if (!target.closest('#sidebar-menu') && !target.closest('#sidebar-more')) {
    closeSidebarMenu();
  }
  if (target.closest('[data-settings-close]')) {
    show(lastNonSettingsView);
    return;
  }

  const inspectorTarget = target.closest<HTMLElement>('[data-inspector-tab]');
  if (inspectorTarget) {
    workspaceAutoOpenedResourceKey = '';
    show('chat');
    setInspector(true, inspectorTarget.dataset.inspectorTab || 'files');
    return;
  }

  const settingsTarget = target.closest<HTMLElement>('[data-settings-section]');
  if (settingsTarget) {
    show('settings');
    requestAnimationFrame(() => {
      const requested =
        settingsTarget.dataset.settingsSection || 'models-agents';
      (
        document.querySelector(`[data-settings-page="${requested}"]`) ||
        document.querySelector('[data-settings-page="models-agents"]')
      )?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    });
    return;
  }

  const permMenu = document.getElementById('composer-permission-menu');
  if (
    permMenu &&
    !permMenu.hidden &&
    !target.closest('#composer-permission-menu') &&
    !target.closest('#composer-permission')
  ) {
    closePermissionMenu();
  }

  const modelMenu = document.getElementById('composer-model-menu');
  if (
    modelMenu &&
    !modelMenu.hidden &&
    !target.closest('#composer-model-menu') &&
    !target.closest('#composer-model')
  ) {
    closeModelMenu();
  }

  const effortMenu = document.getElementById('composer-effort-menu');
  if (
    effortMenu &&
    !effortMenu.hidden &&
    !target.closest('#composer-effort-menu') &&
    !target.closest('#composer-effort')
  ) {
    closeEffortMenu();
  }

  const addBtn = target.closest<HTMLElement>('#composer-add');
  const addMenu = document.getElementById('composer-add-menu');
  if (addBtn) {
    const attach = document.getElementById('composer-attach-menu');
    if (attach?.hidden) {
      openAttachMenu();
    } else {
      closeAnchoredPopover('composer-attach-menu', 'composer-add');
    }
    return;
  }
  if (!target.closest('#composer-attach-menu')) {
    closeAnchoredPopover('composer-attach-menu', 'composer-add');
  }
  if (addMenu && !addMenu.hidden && !target.closest('#composer-add-menu')) {
    closeSlashMenu();
  }

  const mention = target.closest<HTMLElement>('#composer-mention');
  if (mention) {
    if (activeTaskContext?.sources.length) {
      setInspector(true, 'materials');
      return;
    }
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '#composer-form textarea',
    );
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
    const project = ProjectScope.find(
      cachedProjects || [],
      projectNew.dataset.projectNew || '',
    );
    setActiveProject(project?.root || '', project?.id);
    startNewChat();
    show('chat');
    return;
  }
  const projectTools = target.closest<HTMLElement>('[data-project-tools]');
  if (projectTools) {
    libraryUi.groupMenu(projectTools);
    return;
  }
  const projectToggle = target.closest<HTMLElement>('[data-workspace-toggle]');
  if (projectToggle) {
    const key = projectToggle.dataset.workspaceToggle || '';
    const project = projectToggle.closest<HTMLElement>('.mpw-project');
    const expanded = sidebarState.toggleGroup(key);
    if (project) {
      project.dataset.open = String(expanded);
    }
    projectToggle.setAttribute('aria-expanded', String(expanded));
    return;
  }

  const conversationTab = target.closest<HTMLElement>(
    '[data-conversation-tab]',
  );
  if (conversationTab) {
    const trajectory = conversationTab.dataset.conversationTab === 'trajectory';
    if (trajectory && activeConversationId) {
      openWorkspaceResource({
        kind: 'transcript',
        title: 'Conversation history',
        resourceKey: `conversation-history:${activeConversationId}`,
        conversationId: activeConversationId,
      });
    } else {
      setConversationTab(trajectory ? 'trajectory' : 'chat');
    }
    return;
  }

  const usagePopover = document.getElementById('composer-usage-popover');
  if (
    usagePopover &&
    !usagePopover.hidden &&
    !target.closest('#composer-context') &&
    !target.closest('#composer-usage-popover, #composer-usage-breakdown')
  ) {
    closeAnchoredPopover('composer-usage-popover', 'composer-context');
  }

  const open = target.closest('[data-session-menu], .side-session-menu')
    ? null
    : target.closest<HTMLElement>('[data-open]');
  if (open && open.dataset.open) {
    void openConversation(open.dataset.open);
    return;
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
      if (result.ok) {
        await renderStash(true);
      } else if (!result.canceled) {
        window.alert(String(result.error || studioT('stash.save_file_failed')));
      }
    })();
    return;
  }

  if (target.closest('#stash-add-note')) {
    void (async () => {
      const text = await requestStudioText(studioT('stash.note_prompt'));
      if (!text?.trim()) {
        return;
      }
      const category = await requestStudioText(studioT('stash.category'), studioT('stash.note_default'), 100);
      if (category === null) {
        return;
      }
      const result = await Data.addStashNote(text, category);
      if (result.ok) {
        await renderStash(true);
      } else {
        window.alert(String(result.error || studioT('stash.note_failed')));
      }
    })();
    return;
  }

  const stashOpen = target.closest<HTMLElement>('[data-stash-open]');
  if (stashOpen?.dataset.stashOpen) {
    void (async () => {
      const result = await Data.openStashEntry(
        stashOpen.dataset.stashOpen || '',
      );
      if (!result.ok) {
        const at = Number(result.sourceTimeMs);
        const when =
          Number.isFinite(at) && at > 0
            ? studioT('stash.source_time', {
                time: new Date(at).toLocaleString(),
              })
            : '';
        window.alert(
          studioT('stash.unreachable', {when}) +
            (result.error ? `\n${result.error}` : ''),
        );
      }
    })();
    return;
  }

  const stashCategory = target.closest<HTMLElement>('[data-stash-category]');
  if (stashCategory?.dataset.stashCategory) {
    void (async () => {
      const category = await requestStudioText(
        studioT('stash.edit_category'),
        stashCategory.dataset.category || '',
        100,
      );
      if (!category) {
        return;
      }
      const result = await Data.updateStashCategory(
        stashCategory.dataset.stashCategory || '',
        category,
      );
      if (result.ok) {
        await renderStash(true);
      } else {
        window.alert(String(result.error || studioT('stash.category_failed')));
      }
    })();
    return;
  }

  const stashRemove = target.closest<HTMLElement>('[data-stash-remove]');
  if (stashRemove?.dataset.stashRemove) {
    if (!window.confirm(studioT('stash.confirm_delete'))) {
      return;
    }
    void (async () => {
      const result = await Data.removeStashEntry(
        stashRemove.dataset.stashRemove || '',
      );
      if (result.ok) {
        await renderStash(true);
      } else {
        window.alert(String(result.error || studioT('stash.delete_failed')));
      }
    })();
    return;
  }

  const imgNode = target.closest<HTMLElement>(
    '.node[data-src], .stash-row[data-src]',
  );
  if (
    imgNode &&
    imgNode.dataset.src &&
    /\.(png|jpe?g|gif|webp|bmp)$/i.test(imgNode.dataset.src)
  ) {
    openStashViewer(imgNode.dataset.src, imgNode.dataset.text || '');
    e.stopPropagation();
    return;
  }

  const note = target.closest<HTMLElement>(
    '.node[data-text] .node-note, .stash-row .txt',
  );
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
      document
        .querySelectorAll<HTMLElement>('.mp-design-nav [data-design-layout]')
        .forEach(button => button.classList.toggle('is-on', button === goto));
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(
            `#stash-mode [data-mode="${designLayout}"]`,
          )
          ?.click();
      });
    }
    return;
  }

  if (target.closest('[data-open-artifact]')) {
    openAux();
    return;
  }
  if (target.closest('#aux-close')) {
    closeAux();
    return;
  }

  const tab = target.closest<HTMLElement>('.tab');
  if (tab) {
    tab
      .parentElement!.querySelectorAll('.tab')
      .forEach(t => t.classList.remove('is-on'));
    tab.classList.add('is-on');
    stashKindFilter = tab.dataset.kind || '';
    renderStash(true);
    return;
  }
  const mode = target.closest<HTMLElement>('#stash-mode button');
  if (mode) {
    mode
      .parentElement!.querySelectorAll('button')
      .forEach(b => b.classList.remove('is-on'));
    mode.classList.add('is-on');
    const canvas = mode.dataset.mode === 'canvas';
    document.getElementById('canvas')!.hidden = !canvas;
    document.getElementById('stash-list')!.hidden = canvas;
    document
      .querySelectorAll<HTMLElement>('.mp-design-nav [data-design-layout]')
      .forEach(button => {
        button.classList.toggle(
          'is-on',
          button.dataset.designLayout === mode.dataset.mode,
        );
      });
    return;
  }
  const seg = target.closest<HTMLElement>('.seg-toggle button');
  if (seg) {
    seg
      .parentElement!.querySelectorAll('button')
      .forEach(b => b.classList.remove('is-on'));
    seg.classList.add('is-on');
    return;
  }
  const notice = target.closest<HTMLElement>('.notice .close');
  if (notice) {
    notice.closest('.notice')!.remove();
  }
});

document.getElementById('stash-search')?.addEventListener('input', event => {
  stashQuery = String(
    (event.target as HTMLInputElement | null)?.value || '',
  ).trim();
  void renderStash(true);
});

let studioComposerBusy = false;

let slashDirectory: MagicPointerSlashDirectory | null = null;
let slashDirectoryLoaded = false;

function closeSlashMenu() {
  const menu = document.getElementById('composer-add-menu');
  document
    .getElementById('composer-add')
    ?.setAttribute('aria-expanded', 'false');
  if (menu) {
    menu.hidden = true;
  }
}

function slashRow(
  entry: MagicPointerSlashEntry,
  group: 'command' | 'skill',
): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'mpw-slash-row';
  row.setAttribute('role', 'menuitem');
  row.dataset.slashName = entry.name;
  row.dataset.slashGroup = group;
  const head = document.createElement('span');
  head.className = 'mpw-slash-name';
  const slash = document.createElement('em');
  slash.textContent = `/${entry.name}`;
  head.appendChild(slash);
  const desc = document.createElement('small');
  desc.textContent = entry.description;
  const body = document.createElement('span');
  body.className = 'mpw-slash-text';
  body.append(head, desc);
  row.appendChild(body);
  return row;
}

function renderSlashRows(filter: string) {
  const host = document.getElementById('composer-slash-rows');
  if (!host || !slashDirectory) {
    return;
  }
  const needle = filter.trim().toLowerCase();
  const nodes: HTMLElement[] = [];
  const commands = (slashDirectory.commands || []).filter(
    e =>
      !needle ||
      e.name.toLowerCase().includes(needle) ||
      e.description.toLowerCase().includes(needle),
  );
  const skills = (slashDirectory.skills || []).filter(
    e =>
      !needle ||
      e.name.toLowerCase().includes(needle) ||
      e.description.toLowerCase().includes(needle) ||
      (e.whenToUse || '').toLowerCase().includes(needle),
  );
  if (commands.length) {
    const head = document.createElement('div');
    head.className = 'mpw-slash-group';
    head.textContent = studioT('directory.commands');
    nodes.push(head, ...commands.map(e => slashRow(e, 'command')));
  }
  if (skills.length) {
    const head = document.createElement('div');
    head.className = 'mpw-slash-group';
    head.textContent = studioT('directory.skills');
    nodes.push(head, ...skills.map(e => slashRow(e, 'skill')));
  }
  if (!nodes.length) {
    const empty = document.createElement('div');
    empty.className = 'mpw-slash-empty';
    empty.textContent = slashDirectoryLoaded
      ? studioT('directory.no_match')
      : studioT('directory.unavailable');
    nodes.push(empty);
  }
  host.replaceChildren(...nodes);
  setActiveSlashRow(slashRows()[0] || null);
}

function slashRows(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '#composer-slash-rows [data-slash-name]',
    ),
  ];
}

function activeSlashRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '#composer-slash-rows [data-slash-name].is-active',
  );
}

function setActiveSlashRow(row: HTMLElement | null) {
  slashRows().forEach(r => {
    r.classList.toggle('is-active', r === row);
    if (r === row) {
      r.setAttribute('aria-selected', 'true');
    } else {
      r.removeAttribute('aria-selected');
    }
  });
  row?.scrollIntoView({block: 'nearest'});
}

function moveSlashSelection(delta: number): boolean {
  const rows = slashRows();
  if (!rows.length) {
    return false;
  }
  const current = activeSlashRow();
  const index = current ? rows.indexOf(current) : -1;
  const next =
    rows[Math.min(rows.length - 1, Math.max(0, index + delta))] ||
    (delta < 0 ? rows[rows.length - 1] : rows[0]);
  setActiveSlashRow(next);
  return true;
}

async function openSlashMenu(inlineFilter?: string) {
  const menu = document.getElementById('composer-add-menu');
  if (!menu) {
    return;
  }
  const inline = typeof inlineFilter === 'string';
  if (!slashDirectoryLoaded && !inline) {
    const rows = document.getElementById('composer-slash-rows');
    if (rows) {
      rows.replaceChildren();
    }
    const loading = document.createElement('div');
    loading.className = 'mpw-slash-empty';
    loading.textContent = studioT('directory.loading');
    if (rows) {
      rows.appendChild(loading);
    }
  }
  if (!slashDirectoryLoaded) {
    slashDirectory = await Data.slashDirectory();
    slashDirectoryLoaded = slashDirectory !== null;
  }
  renderSlashRows(inline ? inlineFilter : '');
  menu.hidden = false;
  const search = document.getElementById(
    'composer-slash-search',
  ) as HTMLInputElement | null;
  if (search && !inline) {
    search.value = '';
    search.focus();
  }
}

function insertSlashToken(name: string) {
  const ta = document.querySelector<HTMLTextAreaElement>('.mpw-input');
  if (!ta) {
    return;
  }
  const token = `/${name} `;
  const caret = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, caret);
  const trimmed = before.replace(/\/[a-z0-9-]*$/i, '');
  ta.value = trimmed + token + ta.value.slice(caret);
  const nextCaret = (trimmed + token).length;
  ta.setSelectionRange(nextCaret, nextCaret);
  ta.focus();
  ta.dispatchEvent(new Event('input', {bubbles: true}));
}

function bindSlashMenu() {
  const search = document.getElementById('composer-slash-search');
  search?.addEventListener('input', () => {
    renderSlashRows((search as HTMLInputElement).value);
  });
  search?.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeSlashMenu();
      e.stopPropagation();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSlashSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSlashSelection(-1);
    } else if (e.key === 'Enter') {
      const active = activeSlashRow();
      if (active) {
        e.preventDefault();
        insertSlashToken(active.dataset.slashName || '');
        closeSlashMenu();
      }
    }
  });
  document.getElementById('composer-add-menu')?.addEventListener('click', e => {
    const row = (e.target as Element | null)?.closest<HTMLElement>(
      '[data-slash-name]',
    );
    if (!row) {
      return;
    }
    e.stopPropagation();
    insertSlashToken(row.dataset.slashName || '');
    closeSlashMenu();
  });
}
bindSlashMenu();

const EFFORT_STORAGE_KEY = 'mp:composer-effort';
let composerEffort = (() => {
  try {
    const stored = localStorage.getItem(EFFORT_STORAGE_KEY);
    return stored ? String(stored) : 'xhigh';
  } catch {
    return 'xhigh';
  }
})();
let defaultComposerEffort = composerEffort;

function persistEffort() {
  defaultComposerEffort = composerEffort;
  try {
    localStorage.setItem(EFFORT_STORAGE_KEY, composerEffort);
  } catch {
    /* storage unavailable */
  }
}

function renderEffortChip() {
  const button = document.getElementById('composer-effort');
  const label = document.getElementById('composer-effort-label');
  const option = effortLevels.effortOption(composerEffort);
  if (label) {
    label.textContent = option.label;
  }
  if (button instanceof HTMLButtonElement) {
    button.title = `Reasoning effort: ${option.label} — ${option.description}`;
    button.setAttribute('aria-label', `Reasoning effort: ${option.label}`);
  }
}

function closeEffortMenu() {
  closeAnchoredPopover('composer-effort-menu', 'composer-effort');
}

function checkGlyph(): Element {
  const api = globalThis as unknown as {
    CdsIcons?: {html?: (name: string, size?: string) => string};
  };
  const markup =
    typeof api.CdsIcons?.html === 'function' ? api.CdsIcons.html('check') : '';
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
  check.classList.add('mpw-perm-check');
  return check;
}

function openEffortMenu() {
  const menu = document.getElementById('composer-effort-menu');
  if (!menu) {
    return;
  }
  const levels = effortLevels.EFFORT_LEVELS;
  const currentIndex = Math.max(
    0,
    levels.findIndex(option => option.value === composerEffort),
  );

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
  const position = (ratio: number) =>
    `calc(var(--mp-effort-inset) + ${ratio} * (100% - 2 * var(--mp-effort-inset)))`;
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
    const inset = 8;
    const usable = rect.width - inset * 2;
    if (usable <= 0) {
      return activeIndex;
    }
    const ratio = (clientX - rect.left - inset) / usable;
    return Math.round(ratio * (levels.length - 1));
  };
  track.addEventListener('pointerdown', event => {
    track.dataset.dragging = 'true';
    select(indexFromPointer(event.clientX));
    try {
      track.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic pointer */
    }
  });
  track.addEventListener('pointermove', event => {
    if (track.hasPointerCapture(event.pointerId)) {
      select(indexFromPointer(event.clientX));
    }
  });
  const endDrag = () => {
    delete track.dataset.dragging;
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
  track.addEventListener('lostpointercapture', endDrag);
  track.addEventListener('keydown', event => {
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      select(event.key === 'Home' ? 0 : levels.length - 1);
      return;
    }
    const delta =
      event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (!delta) {
      return;
    }
    event.preventDefault();
    select(activeIndex + delta);
  });

  const body = document.createElement('div');
  body.className = 'mp-effort-body';
  body.append(scale, track);
  effortParticleController?.dispose();
  menu.replaceChildren(head, body);
  const opened = positionAnchoredPopover(
    'composer-effort-menu',
    'composer-effort',
  );
  const particleApi = (
    globalThis as {
      EffortParticles?: {
        mount(
          canvas: HTMLCanvasElement,
        ): NonNullable<typeof effortParticleController>;
      };
    }
  ).EffortParticles;
  effortParticleController = particleApi?.mount(particles) || null;
  effortParticleController?.setMax(currentIndex === levels.length - 1);
  requestAnimationFrame(() =>
    opened?.querySelector<HTMLElement>('.mp-effort-track')?.focus(),
  );
}

function bindEffortChip() {
  renderEffortChip();
  document
    .getElementById('composer-effort')
    ?.addEventListener('click', event => {
      event.stopPropagation();
      const menu = document.getElementById('composer-effort-menu');
      if (menu?.hidden) {
        openEffortMenu();
      } else {
        closeEffortMenu();
      }
    });
}

const COMPOSER_PRESET_KEY = 'mp:composer-permission-preset:v1';
const defaultComposerPreset: MagicPointerPermissionPreset = (() => {
  try {
    const stored = localStorage.getItem(COMPOSER_PRESET_KEY);
    return stored &&
      [
        'auto',
        'read-only',
        'workspace-write',
        'plan',
        'danger-full-access',
      ].includes(stored)
      ? (stored as MagicPointerPermissionPreset)
      : 'auto';
  } catch {
    return 'auto';
  }
})();
let composerPreset = defaultComposerPreset;
const pendingPermissionSelections = new Set<string>();
let composerAttachments: string[] = [];

function normalizedTaskContext(value: unknown): MagicPointerTaskContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const taskId = String(raw.taskId || '').trim();
  if (!taskId) {
    return null;
  }
  try {
    const sources = (Array.isArray(raw.sources) ? raw.sources : []).map(
      source => TaskSources.normalizeSourceRef(source),
    ) as MagicPointerTaskSource[];
    const referenceValues = Array.isArray(raw.references)
      ? raw.references
      : raw.references && typeof raw.references === 'object'
        ? Object.values(raw.references as Record<string, unknown>)
        : [];
    const references = referenceValues.map(reference =>
      TaskSources.normalizeReferenceBinding(reference),
    ) as MagicPointerTaskReference[];
    return {
      taskId,
      sources: sources.filter(source => source.taskId === taskId),
      references,
      referenceRevision: Math.max(0, Number(raw.referenceRevision) || 0),
      permissionMode:
        typeof raw.permissionMode === 'string' ? raw.permissionMode : undefined,
      effort: typeof raw.effort === 'string' ? raw.effort : undefined,
    };
  } catch {
    return null;
  }
}

function setActiveTaskContext(value: unknown, resetSelection = false) {
  const next = normalizedTaskContext(value);
  if (
    next?.permissionMode &&
    (resetSelection ||
      next.permissionMode !== activeTaskContext?.permissionMode)
  ) {
    const preset = permPresets.presetForMode(next.permissionMode);
    const owner = composerLocation();
    if (
      preset &&
      !pendingPermissionSelections.has(`${owner.kind}:${owner.id}`)
    ) {
      composerPreset = preset;
      const draft = windowNavigation.draft(owner);
      if (draft) {
        windowNavigation.saveDraft(owner, {...draft, permissionPreset: preset});
      }
      renderPermissionChip();
    }
  }
  if (
    next?.effort &&
    (resetSelection || next.effort !== activeTaskContext?.effort)
  ) {
    composerEffort = effortLevels.normalizeEffort(next.effort);
    renderEffortChip();
  }
  if (
    resetSelection ||
    (activeTaskContext?.taskId && activeTaskContext.taskId !== next?.taskId)
  ) {
    composerSelectedSourceIds.clear();
    inspectorState = inspectorStatePolicy.reduceInspectorState(inspectorState, {
      type: 'clear-content',
    });
  }
  const previousTaskContext = activeTaskContext;
  activeTaskContext = next;
  if (next && previousTaskContext?.taskId === next.taskId && (previousTaskContext.referenceRevision !== next.referenceRevision || previousTaskContext.sources.length !== next.sources.length || next.sources.some((source, index) => {
    const previous = previousTaskContext.sources[index];
    return source.sourceId !== previous?.sourceId || source.title !== previous.title || source.kind !== previous.kind || source.origin !== previous.origin;
  }))) {
    queueModulesRefresh(activeConversationId || '');
  }
  desktopPerceptionController?.updateContext(next);
  desktopPerceptionController?.updateEvidence(activeConversationRecord?.object);
  if (inspectorState.open && activeInspectorTab === 'modules' && modsConversationId !== (activeConversationId || '')) {
    modsConversationId = activeConversationId || '';
    void modsWorkspaceController?.refresh();
  }
  const known = new Set(next?.sources.map(source => source.sourceId) || []);
  for (const sourceId of [...composerSelectedSourceIds]) {
    if (!known.has(sourceId)) {
      composerSelectedSourceIds.delete(sourceId);
    }
  }
  renderTaskMaterials();
  renderComposerMaterials();
}

function referencesForSource(sourceId: string): MagicPointerTaskReference[] {
  return (activeTaskContext?.references || [])
    .filter(reference => reference.active && reference.sourceId === sourceId)
    .sort((left, right) => left.ordinal - right.ordinal);
}

function taskSourceLabel(source: MagicPointerTaskSource): string {
  const role = referencesForSource(source.sourceId)
    .map(reference => `${reference.label} · ${reference.role}`)
    .join('，');
  return [source.kind, source.origin, role].filter(Boolean).join(' · ');
}

function selectTaskMaterial(sourceId: string) {
  if (
    !activeTaskContext?.sources.some(source => source.sourceId === sourceId)
  ) {
    return;
  }
  if (composerSelectedSourceIds.has(sourceId)) {
    composerSelectedSourceIds.delete(sourceId);
  } else {
    composerSelectedSourceIds.add(sourceId);
  }
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
  if (!host || !detail) {
    return;
  }
  const sources = activeTaskContext?.sources || [];
  if (!sources.length) {
    host.innerHTML =
      '<p class="mp-inspector-empty">' + studioT('materials.empty_plus') + '</p>';
    detail.hidden = true;
    detail.replaceChildren();
    return;
  }
  host.replaceChildren(
    ...sources.map(source => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'mp-task-material';
      row.dataset.materialSourceId = source.sourceId;
      row.classList.toggle(
        'is-selected',
        composerSelectedSourceIds.has(source.sourceId),
      );
      row.setAttribute(
        'aria-pressed',
        String(composerSelectedSourceIds.has(source.sourceId)),
      );
      row.title = source.sourceId;
      const iconHost = document.createElement('span');
      iconHost.className = 'mp-task-material-icon';
      iconHost.innerHTML = icon(
        source.kind === 'web'
          ? 'ic-globe'
          : source.kind === 'figma'
            ? 'ic-pen'
            : 'ic-file',
      );
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
    }),
  );
  const selectedId =
    inspectorState.contentSelection?.kind === 'material'
      ? inspectorState.contentSelection.id
      : '';
  const selected = sources.find(source => source.sourceId === selectedId);
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
  scope.textContent = studioT('materials.capabilities', {
    caps:
      selected.capabilities.join(getStudioLanguage() === 'zh-CN' ? '、' : ', ') ||
      studioT('common.none'),
  });
  const provenance = document.createElement('pre');
  provenance.textContent = JSON.stringify(selected.identity, null, 2);
  const referenceSummary = document.createElement('p');
  const referenceSeparator = getStudioLanguage() === 'zh-CN' ? '，' : ', ';
  referenceSummary.textContent = references.length
    ? studioT('materials.refs', {
        text: references
          .map(reference =>
            getStudioLanguage() === 'zh-CN'
              ? `${reference.label}（${reference.role}）`
              : `${reference.label} (${reference.role})`,
          )
          .join(referenceSeparator),
      })
    : studioT('materials.no_refs');
  detail.replaceChildren(title, sourceId, scope, referenceSummary, provenance);
  if (selected.identity.absolutePath && activeConversationId) {
    const conversationId = activeConversationId;
    const controls = document.createElement('div');
    controls.className = 'mp-material-watch';
    const task = document.createElement('input');
    task.className = 'mpw-rename-input';
    task.value = studioT('watch.default_task');
    task.maxLength = 4000;
    task.setAttribute('aria-label', studioT('watch.task_label'));
    const cadence = document.createElement('select');
    cadence.setAttribute('aria-label', studioT('watch.cadence_label'));
    cadence.innerHTML =
      '<option value="filesystem">' + studioT('watch.on_change') + '</option>' + ['daily', 'weekly', 'monthly'].map(value => `<option value="${value}">${studioT(`routine.${value}`)}</option>`).join('');
    const follow = document.createElement('button');
    follow.type = 'button';
    follow.textContent = studioT('watch.follow');
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.textContent = studioT('watch.unfollow');
    stop.hidden = true;
    const status = document.createElement('p');
    status.textContent = studioT('watch.hint');
    const update = async (action: string) => {
      follow.disabled = stop.disabled = true;
      try {
        const result = await Data.trackMaterial({
          conversationId,
          sourceId: selected.sourceId,
          action,
          task: task.value,
          cadence: cadence.value,
        });
        if (!controls.isConnected) {
          return;
        }
        if (!result.ok) {
          status.textContent = String(result.error || studioT('watch.save_failed'));
          return;
        }
        const tracker = result.tracker;
        stop.hidden = tracker?.enabled !== true;
        follow.textContent = tracker?.enabled ? studioT('watch.update') : studioT('watch.follow');
        if (tracker) {
          task.value = tracker.task;
          cadence.value =
            tracker.trigger.kind === 'schedule' ? tracker.trigger.calendar || 'daily' : 'filesystem';
          status.textContent = tracker.enabled
            ? studioT('watch.active')
            : studioT('watch.stopped');
          if (tracker.lastRun) {
            status.textContent += tracker.lastRun.ok
              ? studioT('watch.draft_ready')
              : studioT('watch.last_incomplete', {
                  error: tracker.lastRun.error || studioT('watch.see_result'),
                });
          }
        }
      } catch (error) {
        status.textContent = studioT('watch.save_error', {error: String(error)});
      } finally {
        follow.disabled = stop.disabled = false;
      }
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
  if (!host) {
    return;
  }
  const sourceById = new Map(
    (activeTaskContext?.sources || []).map(source => [source.sourceId, source]),
  );
  const selected = [...composerSelectedSourceIds]
    .map(sourceId => sourceById.get(sourceId))
    .filter((source): source is MagicPointerTaskSource => Boolean(source));
  host.hidden = selected.length === 0;
  host.replaceChildren(
    ...selected.map(source => {
      const chip = document.createElement('span');
      chip.className = 'mp-composer-attachment mp-composer-material';
      chip.title = source.sourceId;
      const name = document.createElement('span');
      name.textContent = source.title;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute(
        'aria-label',
        studioT('watch.remove_source', {title: source.title}),
      );
      remove.innerHTML = '<svg aria-hidden="true"><use href="#ic-x" /></svg>';
      remove.addEventListener('click', () =>
        selectTaskMaterial(source.sourceId),
      );
      chip.append(name, remove);
      return chip;
    }),
  );
}

function buildStudioTaskInput(
  instruction: string,
  inputId: string,
  taskId: string,
  attachments: string[] = [],
  sourceIds: string[] = [...composerSelectedSourceIds],
): MagicPointerTaskInput {
  const capturedAtMs = Date.now();
  return TaskSources.bindConversationTaskInput(
    {
      inputId,
      taskId: taskId || 'studio-pending',
      target: 'next-step',
      instruction,
      referenceUpdates: [],
      sourceIds,
      timeline: [],
      capturedAtMs,
    },
    {
      taskId: taskId || 'studio-pending',
      instruction,
      attachments,
      capturedAtMs,
    },
  ) as MagicPointerTaskInput;
}

function attachmentSourcesForTask(
  paths: string[],
  taskId: string,
): Array<Record<string, unknown>> {
  return paths.map(filePath =>
    TaskSources.attachmentSourceRef(filePath, taskId),
  );
}

function renderComposerAttachments() {
  const host = document.getElementById('composer-attachments');
  if (!host) {
    return;
  }
  host.hidden = composerAttachments.length === 0;
  host.replaceChildren(
    ...composerAttachments.map(filePath => {
      const chip = document.createElement('span');
      chip.className = 'mp-composer-attachment';
      chip.title = filePath;
      const name = document.createElement('span');
      name.textContent =
        filePath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ||
        filePath;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute(
        'aria-label',
        studioT('common.remove_named', {name: String(name.textContent || '')}),
      );
      remove.innerHTML = '<svg aria-hidden="true"><use href="#ic-x" /></svg>';
      remove.addEventListener('click', () => {
        composerAttachments = composerAttachments.filter(
          path => path !== filePath,
        );
        renderComposerAttachments();
      });
      chip.append(name, remove);
      return chip;
    }),
  );
}
interface PermPresetOption {
  value: string;
  name: string;
  label: string;
  description: string;
  detail?: string;
  glyph: string;
  confirm?: {title: string; description: string};
  badge?: string;
  action?: string;
  shortcut?: string;
}
interface PermPresetsModule {
  PRESETS: PermPresetOption[];
  optionOf(value: string): PermPresetOption | undefined;
  presetSvg(option: PermPresetOption): string;
  presetForMode(mode: unknown): MagicPointerPermissionPreset | undefined;
}
const permPresets = (globalThis as {PermissionPresets?: PermPresetsModule})
  .PermissionPresets!;

function renderPermissionChip() {
  const btn = document.getElementById('composer-permission');
  const glyph = document.getElementById('composer-permission-glyph');
  const label = document.getElementById('composer-permission-label');
  const option = permPresets.optionOf(composerPreset);
  if (btn instanceof HTMLButtonElement) {
    btn.title = [option?.description, option?.detail]
      .filter(Boolean)
      .join('\n');
    const owner = windowNavigation.state().current;
    btn.disabled = Boolean(
      owner &&
      (owner.kind === 'conversation' || owner.kind === 'draft') &&
      pendingPermissionSelections.has(`${owner.kind}:${owner.id}`),
    );
    btn.setAttribute('aria-busy', String(btn.disabled));
  }
  if (glyph) {
    glyph.innerHTML = option ? permPresets.presetSvg(option) : '';
  }
  if (label) {
    label.textContent = option?.label || composerPreset;
  }
}

async function selectComposerPermission(
  preset: MagicPointerPermissionPreset,
  owner = composerLocation(),
): Promise<void> {
  const key = `${owner.kind}:${owner.id}`;
  if (pendingPermissionSelections.has(key)) {
    return;
  }
  if (windowNavigation.isCurrent(owner)) {
    captureComposerDraft();
  }
  const before = windowNavigation.draft(owner);
  if (!before) {
    return;
  }
  pendingPermissionSelections.add(key);
  windowNavigation.saveDraft(owner, {...before, permissionPreset: preset});
  if (windowNavigation.isCurrent(owner)) {
    composerPreset = preset;
    renderPermissionChip();
  }
  const result =
    owner.kind === 'conversation'
      ? await Data.setConversationPermission(owner.id, preset)
      : {ok: true, preset};
  pendingPermissionSelections.delete(key);
  const selected = result.ok
    ? result.preset || preset
    : before.permissionPreset || defaultComposerPreset;
  const draft = windowNavigation.draft(owner);
  if (draft) {
    windowNavigation.saveDraft(owner, {...draft, permissionPreset: selected});
  }
  if (!windowNavigation.isCurrent(owner)) {
    return;
  }
  composerPreset = selected;
  renderPermissionChip();
  if (!result.ok || result.warning) {
    const menu = document.getElementById('composer-permission-menu');
    const note = modelMenuNote(
      result.warning === 'conversation_not_saved'
        ? studioT('permission.changed_not_saved')
        : result.warning === 'permission_save_unconfirmed'
          ? studioT('permission.save_unconfirmed')
          : result.error || studioT('common.switch_failed'),
    );
    note.setAttribute('role', result.warning ? 'status' : 'alert');
    const content = [note];
    if (result.warning) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'mp-compact-menu-row';
      retry.dataset.permissionRetry = 'true';
      retry.textContent = studioT('permission.retry_save');
      retry.addEventListener('click', () => {
        closePermissionMenu();
        void selectComposerPermission(selected, owner);
      });
      content.push(retry);
    }
    menu?.replaceChildren(...content);
    positionAnchoredPopover('composer-permission-menu', 'composer-permission');
    menu?.querySelector<HTMLButtonElement>('[data-permission-retry]')?.focus({preventScroll: true});
  }
}

function closePermissionMenu() {
  closeAnchoredPopover('composer-permission-menu', 'composer-permission');
}

function openPermissionMenu() {
  const menu = document.getElementById('composer-permission-menu');
  if (!menu) {
    return;
  }
  const heading = document.createElement('div');
  heading.className = 'mpw-perm-heading';
  heading.textContent = 'Mode';
  const rows = permPresets.PRESETS.map(option => {
    const row = document.createElement('button');
    row.type = 'button';
    const selected = option.value === composerPreset;
    row.className = 'mpw-perm-row' + (selected ? ' is-active' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(selected));
    row.dataset.permValue = option.value;
    if (option.detail) {
      row.title = option.detail;
    }
    if (option.shortcut) {
      row.dataset.permKey = option.shortcut;
    }
    row.title = option.description;
    const text = document.createElement('span');
    text.className = 'mpw-perm-row-text';
    const name = document.createElement('span');
    name.className = 'mpw-perm-row-name';
    name.textContent = option.label;
    if (option.badge) {
      const badge = document.createElement('span');
      badge.className = 'mpw-perm-badge';
      badge.textContent = option.badge;
      name.appendChild(badge);
    }
    const desc = document.createElement('small');
    desc.textContent = option.description;
    text.append(name, desc);
    row.append(text);
    const trail = document.createElement('span');
    trail.className = 'mpw-perm-trail';
    if (option.action) {
      const action = document.createElement('span');
      action.className = 'mpw-perm-action';
      action.textContent = option.action;
      trail.appendChild(action);
    } else {
      if (selected) {
        trail.appendChild(selectedCheck());
      }
      if (option.shortcut) {
        const key = document.createElement('span');
        key.className = 'mpw-perm-key';
        key.textContent = option.shortcut;
        trail.appendChild(key);
      }
    }
    row.appendChild(trail);
    return row;
  });
  menu.replaceChildren(heading, ...rows);
  const opened = positionAnchoredPopover(
    'composer-permission-menu',
    'composer-permission',
  );
  bindDigitShortcuts(menu, 'permKey');
  requestAnimationFrame(() =>
    opened?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus(),
  );
}

function confirmFullAccess() {
  const owner = composerLocation();
  const option = permPresets.PRESETS.find(
    p => p.value === 'danger-full-access',
  );
  const confirmSpec = option?.confirm;
  if (!confirmSpec) {
    return;
  }
  const overlay = document.createElement('dialog');
  overlay.className = 'mpw-perm-confirm';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', confirmSpec.title);
  const card = document.createElement('div');
  card.className = 'mpw-perm-confirm-card';
  const title = document.createElement('b');
  title.textContent = confirmSpec.title;
  const desc = document.createElement('p');
  desc.textContent = confirmSpec.description;
  const ackRow = document.createElement('label');
  ackRow.className = 'mpw-perm-confirm-ack';
  const box = document.createElement('input');
  box.type = 'checkbox';
  const ackText = document.createElement('span');
  ackText.textContent = studioT('risk.ack');
  ackRow.append(box, ackText);
  const actions = document.createElement('div');
  actions.className = 'mpw-perm-confirm-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = studioT('common.cancel');
  cancel.addEventListener('click', () => overlay.close());
  const enable = document.createElement('button');
  enable.type = 'button';
  enable.className = 'is-primary';
  enable.textContent = studioT('risk.enable_full');
  enable.disabled = true;
  box.addEventListener('change', () => {
    enable.disabled = !box.checked;
  });
  enable.addEventListener('click', () => {
    void selectComposerPermission('danger-full-access', owner);
    overlay.close();
  });
  actions.append(cancel, enable);
  card.append(title, desc, ackRow, actions);
  overlay.appendChild(card);
  showStudioDialog(overlay);
}

function bindPermissionChip() {
  renderPermissionChip();
  document
    .getElementById('composer-permission')
    ?.addEventListener('click', e => {
      e.stopPropagation();
      const menu = document.getElementById('composer-permission-menu');
      if (menu?.hidden) {
        openPermissionMenu();
      } else {
        closePermissionMenu();
      }
    });
  document
    .getElementById('composer-permission-menu')
    ?.addEventListener('click', e => {
      const row = (e.target as Element | null)?.closest<HTMLElement>(
        '[data-perm-value]',
      );
      if (!row) {
        return;
      }
      e.stopPropagation();
      const value = row.dataset.permValue || '';
      closePermissionMenu();
      if (value === composerPreset) {
        return;
      }
      if (value === 'danger-full-access') {
        confirmFullAccess();
        return;
      }
      if (permPresets.PRESETS.some(option => option.value === value)) {
        void selectComposerPermission(value as MagicPointerPermissionPreset);
      }
    });
}
let composerPlan: ReturnType<typeof PlanList.project> = null;

function renderPlanCard() {
  const host = document.getElementById('project-plan');
  if (!host) {
    return;
  }
  PlanList.render(host, composerPlan, {
    sessionKey: activeConversationId || pendingConversation?.requestId || '',
  });
}

let pendingPermissionAsk: {
  requestId?: string;
  tool: string;
  prefix?: string;
  actionPreview?: string;
  action?: {tool?: string; arguments?: Record<string, unknown>};
  question?: string;
  options?: string[];
  modeRaise?: 'auto';
} | null = null;
let pendingPermissionChoice: {
  grant?: string;
  deny?: string;
  once?: string;
} | null = null;
let pendingAskInput: NonNullable<MagicPointerTurn['pendingInput']> | null =
  null;
const pendingInputHost = document.getElementById('composer-permission-ask');
let pendingDailyWrapSources: {
  key: string;
  sources?: Array<{id: string; title?: string}>;
  error?: string;
} | null = null;

function loadDailyWrapSources(key: string) {
  const state: NonNullable<typeof pendingDailyWrapSources> = {key};
  pendingDailyWrapSources = state;
  void Data.conversations()
    .then(list => {
      if (pendingDailyWrapSources !== state) {
        return;
      }
      state.sources = list.map(conversation => ({
        id: conversation.id,
        title: conversation.title,
      }));
      renderPermissionAsk();
    })
    .catch(error => {
      if (pendingDailyWrapSources !== state) {
        return;
      }
      state.error = `Could not load saved tasks: ${error instanceof Error ? error.message : String(error)}`;
      renderPermissionAsk();
    });
}

function renderPermissionAsk() {
  const host =
    document.getElementById('composer-permission-ask') || pendingInputHost;
  if (!host) {
    return;
  }
  const input = pendingPermissionAsk || pendingAskInput;
  if (!input) {
    pendingDailyWrapSources = null;
    DecisionCard.clear(host);
    return;
  }
  const conversationId = activeConversationId || '';
  const requestId = input.requestId || '';
  const key = `${conversationId}:${requestId}`;
  const isDailyWrap =
    pendingPermissionAsk?.tool === 'DailyWrap.read' &&
    pendingPermissionAsk.action?.tool === 'DailyWrap.read';
  if (isDailyWrap) {
    if (pendingDailyWrapSources?.key !== key) {
      loadDailyWrapSources(key);
    }
  } else {
    pendingDailyWrapSources = null;
  }
  const dock = document.querySelector('.mpw-composer-stack');
  if (dock && host.parentElement !== dock) {
    dock.prepend(host);
  }
  host.dataset.mode = pendingPermissionAsk ? 'permission' : 'ask';
  DecisionCard.render(
    host,
    {
      ...input,
      key,
      presentation: 'inline',
      kind: pendingPermissionAsk
        ? 'permission'
        : pendingAskInput?.kind || 'ask',
      ...(pendingAskInput?.kind === 'artifact'
        ? {
            openArtifact: () => {
              void openArtifactEditor(
                conversationId,
                pendingAskInput?.artifactId || '',
              );
            },
          }
        : {}),
      historySources: isDailyWrap
        ? pendingDailyWrapSources?.sources
        : undefined,
      historySourcesError: isDailyWrap
        ? pendingDailyWrapSources?.error
        : undefined,
      retryHistorySources: isDailyWrap
        ? () => {
            if (pendingDailyWrapSources?.key !== key) {
              return;
            }
            pendingDailyWrapSources = null;
            renderPermissionAsk();
          }
        : undefined,
      questions:
        pendingAskInput?.questions ||
        (pendingAskInput && pendingAskInput.kind !== 'artifact'
          ? [
              {
                question:
                  pendingAskInput.question || studioT('ask.default_question'),
                options: (pendingAskInput.options || []).map(label => ({
                  label,
                })),
              },
            ]
          : undefined),
    },
    response => {
      void respondToPendingInput(conversationId, requestId, response);
    },
  );
}

async function respondToPendingInput(
  conversationId: string,
  requestId: string,
  response: MagicPointerDecisionResponse,
) {
  const host = document.getElementById('composer-permission-ask');
  if (studioComposerBusy || pendingConversation || externalConversationRun) {
    if (host) {
      DecisionCard.pending(host, false, studioT('task.updating'));
    }
    return;
  }
  if (!host || conversationId !== activeConversationId) {
    return;
  }
  if (!requestId || !conversationId) {
    DecisionCard.pending(
      host,
      false,
      studioT('task.record_missing'),
    );
    return;
  }
  const turnIndex = activeConversationTurnCount - 1;
  const body = document.querySelector<HTMLElement>(
    `.mp-chat-flow-item[data-turn-index="${turnIndex}"]`,
  );
  if (!body) {
    DecisionCard.pending(host, false, studioT('task.current_missing'));
    return;
  }
  const requestToken = `response-${Date.now()}-${++studioTaskInputSequence}`;
  const scope = `${conversationId}#${turnIndex}`;
  const transcript = ConversationControl.createTranscript();
  const previous = activeConversationTurns[turnIndex] as
    MagicPointerTurn | undefined;
  transcript.trajectory = (previous?.trajectory || []).map(record => ({
    ...record,
  }));
  const submitted: PendingConversation = {
    requestId: requestToken,
    scope,
    body,
    records: new Map(),
    renderer: ChatView.createLiveTurn(body, scope, {taskPanel: true}),
    agentSessionId: activeConversationRecord?.agentSessionId || null,
    streamText: '',
    reasoningText: '',
    transcript,
    liveTokens: null,
  };
  pendingConversation = submitted;
  studioComposerBusy = true;
  setComposerRunningState(true);
  startPendingClock(body);
  let accepted = false;
  try {
    const result = await Data.respondConversation({
      conversationId,
      requestId,
      response,
      requestToken,
      permissionPreset: composerPreset,
      effort: composerEffort,
    });
    accepted = result.accepted === true || submitted.inputAccepted === true;
    if (
      pendingConversation !== submitted ||
      activeConversationId !== conversationId
    ) {
      return;
    }
    if (!accepted) {
      DecisionCard.pending(
        host,
        false,
        String(result.error || studioT('ask.save_failed')),
      );
      return;
    }
    pendingPermissionAsk = null;
    pendingAskInput = null;
    DecisionCard.resolve(host);
    await openConversation(conversationId);
    if (
      pendingConversation !== submitted ||
      activeConversationId !== conversationId
    ) {
      return;
    }
    setComposerSettledState(result.ok ? 'success' : 'error');
    await renderSidebar();
  } catch (error) {
    if (
      pendingConversation === submitted &&
      activeConversationId === conversationId
    ) {
      accepted = submitted.inputAccepted === true;
      if (accepted) {
        await openConversation(conversationId);
        setComposerSettledState('error');
      } else {
        DecisionCard.pending(
          host,
          false,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  } finally {
    if (pendingConversation === submitted) {
      detachPendingConversation();
      if (accepted) {
        void refreshOpenConversation({id: conversationId});
      }
    }
  }
}

bindEffortChip();
bindPermissionChip();
let composerFitRaf: number | null = null;
let composerFitTarget: HTMLTextAreaElement | null = null;

function fitComposer(ta: HTMLTextAreaElement) {
  composerFitTarget = ta;
  if (composerFitRaf !== null) {
    return;
  }
  composerFitRaf = window.requestAnimationFrame(() => {
    composerFitRaf = null;
    const target = composerFitTarget;
    composerFitTarget = null;
    if (!target) {
      return;
    }
    target.style.height = 'auto';
    const maxHeight = Number.parseFloat(getComputedStyle(target).maxHeight);
    target.style.height = `${Math.min(Number.isFinite(maxHeight) ? maxHeight : 384, target.scrollHeight)}px`;
  });
}

let composerSuggestion = '';
let composerSuggestionRequest = 0;
// How many predictions in a row the user has been shown and ignored. The
// reference drops the frequency after a run of them and restores it as soon as
// one is used, so the feature backs off instead of nagging. Accepting is what
// resets it — seeing is not using.
const COMPOSER_SUGGESTION_UNUSED_LIMIT = 3;
let composerSuggestionUnused = 0;

const COMPOSER_PLACEHOLDER_HOME = 'Describe a task or ask a question';
const COMPOSER_PLACEHOLDER_THREAD = 'Type / for commands';

function applyComposerPlaceholder(ta?: HTMLTextAreaElement | null) {
  const textarea =
    ta ||
    document.querySelector<HTMLTextAreaElement>('#composer-form textarea');
  if (!textarea) {
    return;
  }
  const home = !document.getElementById('studio-home')?.hidden;
  const base = home ? COMPOSER_PLACEHOLDER_HOME : COMPOSER_PLACEHOLDER_THREAD;
  textarea.placeholder =
    !home && composerSuggestion ? composerSuggestion : base;
  if (!home && composerSuggestion) {
    textarea.setAttribute(
      'aria-description',
      'Press Tab to use the suggested follow-up. Edit it before sending.',
    );
  } else {
    textarea.removeAttribute('aria-description');
  }
}

function clearComposerSuggestion() {
  composerSuggestion = '';
  composerSuggestionRequest += 1;
  applyComposerPlaceholder();
}

async function refreshComposerSuggestion(turns: unknown, object: unknown) {
  const request = ++composerSuggestionRequest;
  if (composerSuggestionUnused >= COMPOSER_SUGGESTION_UNUSED_LIMIT) {
    composerSuggestion = '';
    applyComposerPlaceholder();
    return;
  }
  const suggestion = await Data.suggestNextPrompt(turns, object);
  if (request !== composerSuggestionRequest) {
    return;
  }
  if (suggestion) {
    composerSuggestionUnused += 1;
  }
  composerSuggestion = suggestion;
  applyComposerPlaceholder();
}

function syncComposerSubmitState() {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    '#composer-form textarea',
  );
  const submit = document.querySelector<HTMLButtonElement>(
    '#composer-form button[type="submit"]',
  );
  if (!textarea || !submit) {
    return;
  }
  submit.disabled = !studioComposerBusy && !textarea.value.trim();
}

let modelCatalog: MagicPointerModelCatalog | null = null;
let modelCatalogRequest = 0;
let modelSelectionRequest = 0;
const pendingModelSelections = new Map<string, number>();

function currentComposerModelSelection():
  MagicPointerModelSelection | undefined {
  if (composerModelSelection) {
    return {...composerModelSelection};
  }
  if (!modelCatalog?.current) {
    return undefined;
  }
  return {
    model: modelCatalog.current,
    ...(modelCatalog.currentProfileId
      ? {profileId: modelCatalog.currentProfileId}
      : {}),
  };
}

function sameModelSelection(
  left: MagicPointerModelSelection | undefined,
  right: MagicPointerModelSelection | undefined,
): boolean {
  return left?.model === right?.model && left?.profileId === right?.profileId;
}

function activeComposerModelCatalog(): MagicPointerModelCatalog | null {
  const selection = currentComposerModelSelection();
  if (!modelCatalog || !selection) {
    return modelCatalog;
  }
  const group = modelCatalog.groups?.find(
    item => item.profileId === selection.profileId,
  );
  return {
    ...modelCatalog,
    groups: modelCatalog.groups?.map(item =>
      item === group && !item.models.some(model => model.id === selection.model)
        ? {
            ...item,
            models: [
              {id: selection.model, profileId: selection.profileId},
              ...item.models,
            ],
          }
        : item,
    ),
    current: selection.model,
    currentProfileId: selection.profileId,
    provider:
      group?.provider ||
      (selection.profileId === modelCatalog.currentProfileId
        ? modelCatalog.provider
        : ''),
  };
}

async function refreshComposerModel() {
  const request = ++modelCatalogRequest;
  let catalog: MagicPointerModelCatalog | null = null;
  try {
    catalog = await Data.models();
  } catch {
    catalog = null;
  }
  if (request !== modelCatalogRequest) {
    return;
  }
  if (catalog) {
    modelCatalog = catalog;
  }
  renderComposerModel();
}

window.addEventListener('mp:model-connections-changed', () => {
  void refreshComposerModel();
});

function renderComposerModel() {
  const label = document.getElementById('composer-model-label');
  const btn = document.getElementById('composer-model');
  const current = currentComposerModelSelection()?.model || '';
  syncComposerQuotaIdentity();
  if (modelCatalog) {
    ensureComposerQuota();
  }
  if (label) {
    label.textContent = current || studioT('model.default');
  }
  btn?.removeAttribute('title');
  renderUsageMeter(activeConversationTurns as MagicPointerTurn[]);
}

function closeModelMenu() {
  closeAnchoredPopover('composer-model-menu', 'composer-model');
}

async function openModelMenu() {
  const menu = document.getElementById('composer-model-menu');
  if (!menu) {
    return;
  }
  modelMoreOpen = false;
  menu.replaceChildren(...modelMenuRows(activeComposerModelCatalog()));
  positionAnchoredPopover('composer-model-menu', 'composer-model');
  bindDigitShortcuts(menu, 'modelKey');
  const request = ++modelCatalogRequest;
  let catalog: MagicPointerModelCatalog | null = null;
  try {
    catalog = await Data.models(true);
  } catch {
    catalog = null;
  }
  if (request !== modelCatalogRequest) {
    return;
  }
  if (!catalog) {
    if (menu.hidden || modelCatalog) {
      return;
    }
    menu.replaceChildren(
      modelMenuNote(studioT('model.dir_unavailable')),
    );
    return;
  }
  modelCatalog = catalog;
  renderComposerModel();
  if (menu.hidden) {
    return;
  }
  renderModelMenu();
}

function bindDigitShortcuts(
  menu: HTMLElement,
  attribute: 'modelKey' | 'permKey',
): void {
  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (!/^[1-9]$/.test(event.key)) {
      return;
    }
    const row = Array.from(menu.querySelectorAll<HTMLElement>('button')).find(
      item => item.dataset[attribute] === event.key,
    );
    if (!row) {
      return;
    }
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
  observer.observe(menu, {attributes: true, attributeFilter: ['hidden']});
  document.addEventListener('keydown', onKey, true);
}

const MODEL_PIN_LIMIT = 4;
const MODEL_PIN_STORAGE = 'mp:model-pins';
let modelMoreOpen = false;

type ModelMenuEntry = MagicPointerModelEntry & {key: string; provider: string};

function modelEntries(
  catalog: MagicPointerModelCatalog | null,
): ModelMenuEntry[] {
  const entries: ModelMenuEntry[] = [];
  for (const group of catalog?.groups || []) {
    for (const entry of group.models || []) {
      const profileId = entry.profileId || group.profileId;
      entries.push({
        ...entry,
        profileId,
        provider: group.provider || group.name,
        key: profileId ? JSON.stringify([profileId, entry.id]) : entry.id,
      });
    }
  }
  return entries;
}

let modelPinsCache: string[] | null = null;

function readModelPins(): string[] | null {
  try {
    const saved = localStorage.getItem(MODEL_PIN_STORAGE);
    if (saved === null) {
      return modelPinsCache;
    }
    const raw: unknown = JSON.parse(saved);
    return Array.isArray(raw)
      ? raw.map(id => (typeof id === 'string' ? id : ''))
      : null;
  } catch {
    return modelPinsCache;
  }
}

function writeModelPins(ids: string[]): void {
  modelPinsCache = [...ids];
  try {
    localStorage.setItem(MODEL_PIN_STORAGE, JSON.stringify(ids));
  } catch {
    /* 浏览器存储只读时，本次会话内仍然生效 */
  }
}

function resolveModelPins(catalog: MagicPointerModelCatalog | null): string[] {
  const entries = modelEntries(catalog);
  const known = new Set(entries.map(entry => entry.key));
  const saved = readModelPins();
  if (saved !== null) {
    const seen = new Set<string>();
    return Array.from({length: MODEL_PIN_LIMIT}, (_, index) => {
      const raw = saved[index] || '';
      const id = known.has(raw)
        ? raw
        : entries.find(
            entry =>
              entry.id === raw && entry.profileId === catalog?.currentProfileId,
          )?.key ||
          entries.find(entry => entry.id === raw)?.key ||
          '';
      if (!known.has(id) || seen.has(id)) {
        return '';
      }
      seen.add(id);
      return id;
    });
  }
  const pins: string[] = [];
  const current =
    entries.find(
      entry =>
        entry.id === catalog?.current &&
        (!catalog.currentProfileId ||
          entry.profileId === catalog.currentProfileId),
    )?.key || '';
  if (current && known.has(current) && !pins.includes(current)) {
    pins.unshift(current);
    pins.length = Math.min(pins.length, MODEL_PIN_LIMIT);
  }
  for (const entry of entries) {
    if (pins.length >= MODEL_PIN_LIMIT) {
      break;
    }
    if (!pins.includes(entry.key)) {
      pins.push(entry.key);
    }
  }
  if (entries.length >= MODEL_PIN_LIMIT) {
    writeModelPins(pins);
  }
  return pins;
}

function modelMenuDivider(): HTMLElement {
  const line = document.createElement('hr');
  line.className = 'mpw-model-divider';
  return line;
}

function modelMenuRow(
  id: string,
  _vision: boolean,
  index: number,
  selected: boolean,
): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'mpw-model-row' + (selected ? ' is-active' : '');
  row.setAttribute('role', 'option');
  row.dataset.modelId = id;
  const name = document.createElement('span');
  name.className = 'mpw-model-name';
  name.textContent = id;
  row.appendChild(name);
  row.setAttribute('aria-selected', String(selected));
  row.dataset.modelKey = String(index + 1);
  if (selected) {
    row.appendChild(selectedCheck());
  } else {
    const key = document.createElement('kbd');
    key.className = 'mpw-model-key';
    key.textContent = String(index + 1);
    row.appendChild(key);
  }
  return row;
}

function modelMoreRow(open: boolean): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'mpw-model-row mpw-model-more';
  row.dataset.modelMore = 'true';
  row.setAttribute('aria-expanded', String(open));
  const label = document.createElement('span');
  label.className = 'mpw-model-name';
  label.textContent = 'More models';
  row.appendChild(label);
  const chevron = document.createElement('span');
  chevron.className = 'mpw-model-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = (
    globalThis as unknown as {
      CdsIcons: {html(name: string, size: string): string};
    }
  ).CdsIcons.html('chevron-section', 'small');
  row.appendChild(chevron);
  return row;
}

function modelSourceBadge(provider: string): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'mpw-model-source';
  badge.textContent = provider;
  badge.title = provider;
  return badge;
}

function modelMorePanel(
  entries: ModelMenuEntry[],
  pins: string[],
): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'mpw-model-more-panel';
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', 'More models');
  for (const entry of entries) {
    const pinned = pins.includes(entry.key);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'mpw-model-pin-row';
    row.setAttribute('role', 'menuitemcheckbox');
    row.setAttribute('aria-checked', String(pinned));
    row.dataset.modelPin = entry.key;
    row.title = `${entry.id}${entry.provider ? ` · ${entry.provider}` : ''}${entry.contextWindow ? ` · ${entry.contextWindow.toLocaleString()} tokens` : ''}`;
    if (!pinned && pins.filter(Boolean).length >= MODEL_PIN_LIMIT) {
      row.setAttribute('aria-disabled', 'true');
    }
    const box = document.createElement('span');
    box.className = 'mpw-model-pin-box';
    box.setAttribute('aria-hidden', 'true');
    if (pinned) {
      box.appendChild(checkGlyph());
    }
    const name = document.createElement('span');
    name.className = 'mpw-model-name';
    const label = document.createElement('span');
    label.className = 'mpw-model-label';
    label.textContent = entry.id;
    name.append(label, modelSourceBadge(entry.provider));
    row.append(box, name);
    panel.appendChild(row);
  }
  return panel;
}

function modelMenuRows(
  catalog: MagicPointerModelCatalog | null,
): HTMLElement[] {
  if (!catalog) {
    return [modelMenuNote(studioT('model.loading'))];
  }
  const rows: HTMLElement[] = [];
  if (catalog.error) {
    rows.push(modelMenuNote(catalog.error));
  }
  const entries = modelEntries(catalog);
  if (!entries.length) {
    return rows.length ? rows : [modelMenuNote(studioT('model.no_models'))];
  }
  const byKey = new Map(entries.map(entry => [entry.key, entry]));
  const pins = resolveModelPins(catalog);
  pins.forEach((key, index) => {
    const entry = byKey.get(key);
    if (!entry) {
      return;
    }
    const row = modelMenuRow(
      entry.id,
      Boolean(entry.vision),
      index,
      entry.id === catalog.current &&
        (!catalog.currentProfileId ||
          entry.profileId === catalog.currentProfileId),
    );
    const name = row.querySelector('.mpw-model-name');
    const label = document.createElement('span');
    label.className = 'mpw-model-label';
    label.textContent = entry.id;
    name?.replaceChildren(label, modelSourceBadge(entry.provider));
    if (entry.profileId) {
      row.dataset.modelProfileId = entry.profileId;
    }
    row.title = `${entry.id}${entry.provider ? ` · ${entry.provider}` : ''}${entry.contextWindow ? ` · ${entry.contextWindow.toLocaleString()} tokens` : ''}`;
    rows.push(row);
  });
  rows.push(modelMenuDivider());
  rows.push(modelMoreRow(modelMoreOpen));
  if (modelMoreOpen) {
    rows.push(modelMorePanel(entries, pins));
  }
  if (modelMoreOpen) {
    const panel = rows[rows.length - 1];
    for (const group of catalog.groups || []) {
      if (group.error) {
        panel.appendChild(modelMenuNote(`${group.name}：${group.error}`));
      }
    }
  }
  return rows;
}

function renderModelMenu(): void {
  const menu = document.getElementById('composer-model-menu');
  if (!menu) {
    return;
  }
  const scrollTop = menu.querySelector('.mpw-model-more-panel')?.scrollTop || 0;
  const focused =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.modelPin
      : undefined;
  menu.replaceChildren(...modelMenuRows(activeComposerModelCatalog()));
  positionAnchoredPopover('composer-model-menu', 'composer-model');
  positionModelMorePanel();
  const panel = menu.querySelector<HTMLElement>('.mpw-model-more-panel');
  if (panel) {
    panel.scrollTop = scrollTop;
    if (focused) {
      Array.from(panel.querySelectorAll<HTMLElement>('[data-model-pin]'))
        .find(row => row.dataset.modelPin === focused)
        ?.focus({preventScroll: true});
    }
  }
}

function positionModelMorePanel(): void {
  const menu = document.getElementById('composer-model-menu');
  const panel = menu?.querySelector<HTMLElement>('.mpw-model-more-panel');
  if (!menu || menu.hidden || !panel) {
    return;
  }
  const rect = menu.getBoundingClientRect();
  const margin = 8;
  const top = Math.max(
    margin,
    (document.getElementById('window-titlebar')?.getBoundingClientRect()
      .bottom || 0) + margin,
  );
  panel.style.maxHeight = `${Math.max(24, Math.min(216, window.innerHeight - top - margin))}px`;
  const right = rect.right + 4;
  const left =
    right + panel.offsetWidth <= window.innerWidth - margin
      ? right
      : rect.left - 4 - panel.offsetWidth;
  panel.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - margin - panel.offsetWidth))}px`;
  panel.style.top = `${Math.max(top, Math.min(rect.bottom - panel.offsetHeight, window.innerHeight - margin - panel.offsetHeight))}px`;
}

window.addEventListener('resize', () => {
  const menu = document.getElementById('composer-model-menu');
  if (menu && !menu.hidden) {
    positionAnchoredPopover('composer-model-menu', 'composer-model');
    positionModelMorePanel();
  }
  const permissionMenu = document.getElementById('composer-permission-menu');
  if (permissionMenu && !permissionMenu.hidden) {
    positionAnchoredPopover('composer-permission-menu', 'composer-permission');
  }
});

function menuGlyph(name: string, size = 'small'): string {
  return (
    (
      globalThis as {CdsIcons?: {html(name: string, size: string): string}}
    ).CdsIcons?.html(name, size) || ''
  );
}

function compactMenuItem(
  label: string,
  icon: string,
  action: () => void,
  trailing = '',
): HTMLButtonElement {
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
    const key = document.createElement('kbd');
    key.textContent = trailing;
    row.append(key);
  }
  row.addEventListener('click', event => {
    event.stopPropagation();
    action();
  });
  return row;
}

function openAccountSubmenu(kind: string) {
  const menu = document.getElementById('account-submenu');
  const trigger = document.querySelector<HTMLElement>(
    `[data-account-command="${kind}"]`,
  );
  if (!menu || !trigger) {
    return;
  }
  const run = (command: string) => () => {
    void executeAccountCommand(command);
  };
  const rows =
    kind === 'language'
      ? [
          compactMenuItem(
            'English',
            '',
            () => setStudioLanguage('en'),
            getStudioLanguage() === 'en' ? '✓' : '',
          ),
          compactMenuItem(
            '中文',
            '',
            () => setStudioLanguage('zh-CN'),
            getStudioLanguage() === 'zh-CN' ? '✓' : '',
          ),
        ]
      : [
          compactMenuItem('About Magic Pointer', '', run('about')),
          compactMenuItem('Documentation', '', run('help')),
          compactMenuItem('Check for updates', '', run('updates')),
          compactMenuItem('Keyboard shortcuts', '', run('shortcuts'), 'Ctrl+/'),
        ];
  menu.replaceChildren(...rows);
  menu.dataset.parentCommand = kind;
  menu.hidden = false;
  const rect = trigger.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.right + 4, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(36, Math.min(rect.top, innerHeight - menu.offsetHeight - 8))}px`;
  document
    .querySelectorAll('[data-account-command][aria-haspopup]')
    .forEach(row => row.setAttribute('aria-expanded', String(row === trigger)));
  enterStudioMenu(menu);
}

function setStudioLanguage(language: 'en' | 'zh-CN'): void {
  applyStudioLanguage(language);
  closeAccountMenu(true);
  const view = shell.dataset.view || 'chat';
  show(view);
  if (view === 'chat' && activeConversationId) {
    void openConversation(activeConversationId);
  }
}

window.addEventListener('mp:language-change', () => {
  renderTerminalLanguage();
  renderBrowserToolbarLanguage();
  if (inspectorState.open && activeInspectorTab === 'tasks') {
    renderProjectTasks();
  }
  if (inspectorState.open) {
    renderInspectorTitle();
  }
});

renderTerminalLanguage();
renderBrowserToolbarLanguage();

try {
  applyStudioLanguage(
    localStorage.getItem('mp:language:v1') === 'zh-CN' ? 'zh-CN' : 'en',
  );
} catch {
  applyStudioLanguage('en');
}

function openSettingsPage(page: string) {
  show('settings');
  requestAnimationFrame(() =>
    document
      .querySelector<HTMLElement>(`[data-settings-page="${page}"]`)
      ?.click(),
  );
}

const desktopPerceptionHost = document.getElementById('desktop-perception');
const modulesHost = document.getElementById('modules-workspace');
if (modulesHost && globalThis.ModsWorkspace) {
  const unavailableModules = () => ({
    ok: false, sessionId: '', modules: [], errors: [],
    error: getStudioLanguage() === 'zh-CN' ? '请先打开一个已开始的任务。' : 'Open a started task to use its modules.',
  });
  modsWorkspaceController = ModsWorkspace.create(modulesHost, {
    sessionId: () => activeConversationRecord?.agentSessionId || '',
    visible: modulesVisible,
    list: async () => activeConversationId && window.magicPointerDashboard?.modules
      ? window.magicPointerDashboard.modules.list({conversationId: activeConversationId})
      : unavailableModules(),
    invoke: async request => activeConversationId && window.magicPointerDashboard?.modules
      ? window.magicPointerDashboard.modules.invoke({...request, conversationId: activeConversationId})
      : unavailableModules(),
    composeAgentRequest: (sessionId, request) => {
      const textarea = document.querySelector<HTMLTextAreaElement>('.mpw-input');
      if (
        !sessionId ||
        activeConversationRecord?.agentSessionId !== sessionId ||
        !textarea
      ) {
        return false;
      }
      const requestText = getStudioLanguage() === 'zh-CN'
        ? `请在当前任务中继续模块操作：${request.moduleTitle} / ${request.actionLabel}。\n模块：${request.moduleId}\n工具：${request.toolName}\n参数：\n${JSON.stringify(request.arguments, null, 2)}`
        : `Continue this module action in the current task: ${request.moduleTitle} / ${request.actionLabel}.\nModule: ${request.moduleId}\nTool: ${request.toolName}\nArguments:\n${JSON.stringify(request.arguments, null, 2)}`;
      textarea.value += `${textarea.value ? '\n\n' : ''}${requestText}`;
      textarea.dispatchEvent(new Event('input', {bubbles: true}));
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      return true;
    },
    language: () => getStudioLanguage(),
  });
  const controller = modsWorkspaceController;
  window.addEventListener('mp:language-change', () => controller.updateLanguage());
  window.addEventListener('beforeunload', () => controller.dispose(), {once: true});
}
const desktopPerceptionBridge = window.magicPointerDashboard?.desktopPerception;
desktopPerceptionController = desktopPerceptionHost && globalThis.DesktopPerception
  ? DesktopPerception.create(desktopPerceptionHost, {
      readStatus: async () => {
        if (!desktopPerceptionBridge) {
          throw new Error('Desktop pointing is unavailable in this window.');
        }
        return desktopPerceptionBridge.status();
      },
      activate: async () => desktopPerceptionBridge
        ? desktopPerceptionBridge.activate()
        : {ok: false, error: 'Desktop pointing is unavailable in this window.'},
      setPaused: async paused => desktopPerceptionBridge
        ? desktopPerceptionBridge.setPaused(paused)
        : {ok: false, error: 'Desktop pointing is unavailable in this window.'},
      openSettings: openSettingsPage,
      openMaterials: sourceId => {
        if (sourceId) {
          inspectorState = inspectorStatePolicy.reduceInspectorState(inspectorState, {
            type: 'select-content', contentKind: 'material', contentId: sourceId,
          });
        }
        setInspector(true, 'materials');
        renderTaskMaterials();
      },
      language: () => getStudioLanguage(),
    })
  : null;
if (desktopPerceptionController) {
  const controller = desktopPerceptionController;
  controller.updateContext(activeTaskContext);
  const unsubscribe = desktopPerceptionBridge?.onChanged(status => controller.updateStatus(status));
  window.addEventListener('focus', () => { void controller.refresh(); });
  window.addEventListener('mp:language-change', () => controller.updateLanguage());
  window.addEventListener('beforeunload', () => {
    unsubscribe?.();
    controller.dispose();
  }, {once: true});
}

function openAttachMenu() {
  closeSlashMenu();
  const menu = document.getElementById('composer-attach-menu');
  if (!menu) {
    return;
  }
  const action = (run: () => void) => () => {
    closeAnchoredPopover('composer-attach-menu', 'composer-add');
    run();
  };
  const entries = [
    {
      id: 'files',
      label: 'Add files or photos',
      icon: 'attach-file',
      key: 'Ctrl+U',
      run: () => {
        void executeWindowMenuCommand('add-files');
      },
    },
    {
      id: 'folder',
      label: 'Add folder',
      icon: 'folder',
      run: () => {
        void executeWindowMenuCommand('add-folder');
      },
    },
    {
      id: 'slash',
      label: 'Slash commands',
      icon: 'attach-skills',
      run: () => {
        void openSlashMenu();
      },
    },
    {
      id: 'connectors',
      label: 'Add connectors',
      icon: 'attach-connector',
      run: () => openSettingsPage('connectors'),
    },
    {
      id: 'plugins',
      label: 'Add plugins',
      icon: 'attach-plugins',
      run: () => openSettingsPage('plugins'),
    },
  ];
  menu.replaceChildren(
    ...entries.map(entry => {
      const row = compactMenuItem(
        entry.label,
        entry.icon,
        action(entry.run),
        entry.key,
      );
      row.dataset.attachCommand = entry.id;
      return row;
    }),
  );
  positionAnchoredPopover('composer-attach-menu', 'composer-add');
  const trigger = document
    .getElementById('composer-add')!
    .getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(trigger.left, innerWidth - menu.offsetWidth - 8))}px`;
  menu.querySelector<HTMLButtonElement>('button')?.focus();
}

function modelMenuNote(text: string): HTMLElement {
  const note = document.createElement('div');
  note.className = 'mpw-model-note';
  note.textContent = text;
  return note;
}

function bindModelSeat() {
  document
    .getElementById('composer-model')
    ?.addEventListener('click', async e => {
      e.stopPropagation();
      const menu = document.getElementById('composer-model-menu');
      if (menu?.hidden) {
        await openModelMenu();
      } else {
        closeModelMenu();
      }
    });
  document
    .getElementById('composer-model-menu')
    ?.addEventListener('click', async e => {
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
        const pins = resolveModelPins(activeComposerModelCatalog());
        const index = pins.includes(id) ? pins.indexOf(id) : pins.indexOf('');
        if (index < 0) {
          return;
        }
        pins[index] = pins[index] === id ? '' : id;
        writeModelPins(pins);
        renderModelMenu();
        return;
      }
      const row = target?.closest<HTMLElement>('[data-model-id]');
      if (!row) {
        return;
      }
      e.stopPropagation();
      const modelId = row.dataset.modelId || '';
      const profileId = row.dataset.modelProfileId;
      const selection = {model: modelId, ...(profileId ? {profileId} : {})};
      if (sameModelSelection(selection, currentComposerModelSelection())) {
        closeModelMenu();
        return;
      }
      const selectionRequest = ++modelSelectionRequest;
      const owner = composerLocation();
      const key = `${owner.kind}:${owner.id}`;
      pendingModelSelections.set(key, selectionRequest);
      captureComposerDraft();
      const before = windowNavigation.draft(owner)!;
      composerModelSelection = selection;
      windowNavigation.saveDraft(owner, {...before, modelSelection: selection});
      ++modelCatalogRequest;
      closeModelMenu();
      renderComposerModel();
      const result =
        owner.kind === 'conversation'
          ? await Data.setConversationModel(owner.id, selection)
          : {ok: true, selection};
      if (pendingModelSelections.get(key) !== selectionRequest) {
        return;
      }
      pendingModelSelections.delete(key);
      const selected = result.ok
        ? result.selection || selection
        : before.modelSelection;
      const currentDraft = windowNavigation.draft(owner);
      if (currentDraft) {
        windowNavigation.saveDraft(owner, {
          ...currentDraft,
          modelSelection: selected,
        });
      }
      if (!windowNavigation.isCurrent(owner)) {
        return;
      }
      composerModelSelection = selected;
      renderComposerModel();
      if (!result?.ok) {
        if (menu) {
          menu.replaceChildren(modelMenuNote(result?.error || studioT('common.switch_failed')));
        }
        positionAnchoredPopover('composer-model-menu', 'composer-model');
        return;
      }
    });
}
bindModelSeat();

interface PendingConversation {
  conversationId?: string;
  question?: string;
  startedAt?: number;
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
  liveTokens: number | null;
}
let pendingConversation: PendingConversation | null = null;
let studioTaskInputSequence = 0;

function progressKey(record: Record<string, unknown>): string {
  const phase = String(record.phase || '');
  const fields =
    record.fields && typeof record.fields === 'object'
      ? (record.fields as Record<string, unknown>)
      : {};
  if (phase === 'tool_call' || phase === 'tool_result') {
    return `tool:${String(fields.id || fields.name || '')}`;
  }
  return 'status';
}

function renderConversationProgress(record: Record<string, unknown>) {
  if (!pendingConversation) {
    return;
  }
  ConversationControl.appendTranscript(pendingConversation.transcript, record);
  const sid = ConversationControl.sessionIdFromRecord(record);
  if (sid) {
    pendingConversation.agentSessionId = sid;
    setComposerRunningState(true);
  }
  const tokenFields =
    record.fields && typeof record.fields === 'object'
      ? (record.fields as Record<string, unknown>)
      : {};
  const reportedTokens = Number(
    tokenFields.total_tokens ?? tokenFields.tokens ?? tokenFields.output_tokens,
  );
  if (Number.isFinite(reportedTokens) && reportedTokens > 0) {
    pendingConversation.liveTokens = reportedTokens;
  }
  if (String(record.phase || '') === 'model_usage') {
    const usage = latestContextUsage([
      {liveProgress: pendingConversation.transcript},
    ]);
    if (usage?.totalTokens !== undefined) {
      pendingConversation.liveTokens = usage.totalTokens;
    }
    return;
  }
  if (String(record.phase || '') === 'plan') {
    const snapshot = ConversationControl.planStepsFromRecord(record);
    if (snapshot) {
      composerPlan = PlanList.project([{plan: snapshot}]);
      renderPlanCard();
    }
  }
  if (String(record.phase || '') === 'subagent') {
    schedulePendingRender();
    return;
  }
  if (String(record.phase || '') === 'answer_chunk') {
    const fields =
      record.fields && typeof record.fields === 'object'
        ? (record.fields as Record<string, string>)
        : {};
    appendLiveStreamText(ConversationControl.decodeChunkBlob(fields));
    return;
  }
  if (String(record.phase || '') === 'reasoning_chunk') {
    const fields =
      record.fields && typeof record.fields === 'object'
        ? (record.fields as Record<string, string>)
        : {};
    appendLiveReasoningText(ConversationControl.decodeChunkBlob(fields));
    return;
  }
  pendingConversation.records.set(progressKey(record), record);
  schedulePendingRender();
}

let pendingRenderTimer: number | null = null;
function schedulePendingRender() {
  if (pendingRenderTimer !== null || !pendingConversation) {
    return;
  }
  const scheduled = pendingConversation;
  pendingRenderTimer = window.setTimeout(
    () => {
      pendingRenderTimer = null;
      if (pendingConversation !== scheduled) {
        return;
      }
      followIfNearBottom(scheduled.body, renderPendingBody);
      if (inspectorState.open && activeInspectorTab === 'tasks') {
        renderProjectTasks();
      }
      if (
        (inspectorState.open && activeInspectorTab === 'activity') ||
        activeConversationTab === 'trajectory'
      ) {
        renderConversationActivity();
      }
    },
    document.hidden ? 200 : 33,
  );
}

function renderPendingBody() {
  const pending = pendingConversation;
  if (!pending) {
    return;
  }
  pending.renderer.update({
    ...pending.transcript,
    records: [...pending.records.values()],
  });
  const plan = PlanList.project([{liveProgress: pending.transcript}]);
  if (plan) {
    composerPlan = plan;
    renderPlanCard();
  }
  pendingClockWrite?.();
}

function acceptComposerSuggestion(textarea: HTMLTextAreaElement): boolean {
  if (
    textarea.value ||
    !composerSuggestion ||
    studioComposerBusy ||
    !document.getElementById('studio-home')?.hidden
  ) {
    return false;
  }
  textarea.value = composerSuggestion;
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  // Using one brings the frequency back to normal.
  composerSuggestionUnused = 0;
  clearComposerSuggestion();
  textarea.dispatchEvent(new Event('input', {bubbles: true}));
  return true;
}

const SCROLL_FOLLOW_THRESHOLD_PX = 40;
let streamFollowPinned = true;
let streamLastInputAt = -Infinity;
let streamLastScrollTop = 0;

function isNearBottom(
  el: HTMLElement,
  threshold = SCROLL_FOLLOW_THRESHOLD_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function updateScrollPill() {
  const scroller = document.getElementById('stream');
  const pill = document.getElementById('scroll-pill');
  if (!scroller || !pill) {
    return;
  }
  pill.hidden =
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 120;
}

function scrollChatToBottom() {
  const scroller = document.getElementById('stream');
  if (!scroller) {
    return;
  }
  streamFollowPinned = true;
  streamLastInputAt = -Infinity;
  scroller.scrollTo({top: scroller.scrollHeight, behavior: 'instant'});
  streamLastScrollTop = scroller.scrollTop;
  updateScrollPill();
}

let pendingClockTimer: number | null = null;
let pendingClockWrite: (() => void) | null = null;

function startPendingClock(body: HTMLElement) {
  stopPendingClock();
  const startedAt = Date.now();
  const tick = () => {
    const slot = body.querySelector<HTMLElement>('[data-turn-meta]');
    if (!slot) {
      return;
    }
    const elapsed = Date.now() - startedAt;
    const text = ChatView.formatRunMeta(
      elapsed,
      pendingConversation?.liveTokens ?? null,
    );
    if (slot.textContent !== text) {
      slot.textContent = text;
    }
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
  const scroller = body.closest('#stream');
  const follow =
    streamFollowPinned && performance.now() - streamLastInputAt > 150;
  mutate();
  if (follow && scroller) {
    scrollChatToBottom();
  }
  updateScrollPill();
}

(function bindScrollPill() {
  const scroller = document.getElementById('stream');
  const pill = document.getElementById('scroll-pill');
  if (!scroller || !pill || scroller.dataset.pillBound) {
    return;
  }
  scroller.dataset.pillBound = '1';
  const release = () => {
    streamLastInputAt = performance.now();
    streamFollowPinned = false;
  };
  scroller.addEventListener('wheel', release, {passive: true});
  scroller.addEventListener('touchstart', release, {passive: true});
  scroller.addEventListener('pointerdown', event => {
    if (event.target === scroller) {
      release();
    }
  });
  scroller.addEventListener('keydown', event => {
    if (
      !(event.target as Element)?.closest(
        'input, textarea, select, [contenteditable]',
      ) &&
      [
        'ArrowUp',
        'ArrowDown',
        'PageUp',
        'PageDown',
        'Home',
        'End',
        ' ',
      ].includes(event.key)
    ) {
      release();
    }
  });
  scroller.addEventListener(
    'scroll',
    () => {
      const top = scroller.scrollTop;
      if (top < streamLastScrollTop) {
        streamFollowPinned = false;
      } else if (top > streamLastScrollTop && isNearBottom(scroller)) {
        streamFollowPinned = true;
      }
      streamLastScrollTop = top;
      updateScrollPill();
    },
    {passive: true},
  );
  pill.addEventListener('click', scrollChatToBottom);
})();

function appendLiveStreamText(text: string) {
  const pending = pendingConversation;
  if (!pending || !text) {
    return;
  }
  pending.streamText += text;
  schedulePendingRender();
}

function appendLiveReasoningText(text: string) {
  const pending = pendingConversation;
  if (!pending || !text) {
    return;
  }
  pending.reasoningText += text;
  schedulePendingRender();
}

function focusComposerWhenIdle() {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    '#composer-form textarea',
  );
  if (!textarea) {
    return;
  }
  const active = document.activeElement;
  const tagName = String(
    (active as HTMLElement | null)?.tagName || '',
  ).toLowerCase();
  const anotherTypingTarget =
    active !== textarea && (tagName === 'input' || tagName === 'textarea');
  if (!anotherTypingTarget) {
    textarea.focus();
  }
}

let composerSettledTimer: number | null = null;

function setComposerSettledState(state: 'idle' | 'error' | 'success') {
  const form = document.getElementById('composer-form');
  if (!form) {
    return;
  }
  if (composerSettledTimer !== null) {
    window.clearTimeout(composerSettledTimer);
  }
  composerSettledTimer = null;
  form.setAttribute('data-state', state);
  if (state === 'idle') {
    return;
  }
  composerSettledTimer = window.setTimeout(() => {
    if (form.dataset.state === state) {
      form.setAttribute('data-state', 'idle');
    }
    composerSettledTimer = null;
  }, 1200);
}

function setComposerRunningState(running: boolean) {
  const folderControls = document.querySelectorAll<HTMLButtonElement>(
    '#composer-context-folder-add, [data-additional-folder] button',
  );
  folderControls.forEach(button => {
    button.disabled = running;
  });
  const form = document.getElementById('composer-form');
  const submit = document.querySelector<HTMLButtonElement>(
    '#composer-form button[type="submit"]',
  );
  if (running) {
    form?.setAttribute('aria-busy', 'true');
  } else {
    form?.removeAttribute('aria-busy');
  }
  if (running || form?.dataset.state === 'running') {
    form?.setAttribute('data-state', running ? 'running' : 'idle');
  }
  if (submit) {
    submit.classList.toggle('is-stop', running);
    submit.title = running ? 'Stop' : 'Send';
    submit.setAttribute('aria-label', running ? 'Stop' : 'Send');
    const hasStop = Boolean(submit.querySelector('use[href="#ic-stop"]'));
    if (running !== hasStop) {
      submit.replaceChildren();
      if (running) {
        const stop = document.createElementNS(
          'http://www.w3.org/2000/svg',
          'svg',
        );
        stop.setAttribute('width', '20');
        stop.setAttribute('height', '20');
        stop.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS(
          'http://www.w3.org/2000/svg',
          'use',
        );
        use.setAttribute('href', '#ic-stop');
        stop.appendChild(use);
        submit.appendChild(stop);
      } else {
        const api = globalThis as unknown as {
          CdsIcons?: {html?: (name: string, size?: string) => string};
        };
        const markup =
          typeof api.CdsIcons?.html === 'function'
            ? api.CdsIcons.html('code-send')
            : '';
        if (markup) {
          submit.insertAdjacentHTML('afterbegin', markup);
        }
      }
    }
  }
  document
    .getElementById('composer-context')
    ?.setAttribute('data-state', running ? 'running' : 'idle');
  syncComposerSubmitState();
  if (!running) {
    focusComposerWhenIdle();
  }
}

async function stopActiveConversation() {
  const pending = pendingConversation || externalConversationRun;
  if (
    !studioComposerBusy ||
    !pending ||
    pending.body.dataset.stopRequested === 'true'
  ) {
    return;
  }
  pending.body.dataset.stopRequested = 'true';
  const note = document.createElement('div');
  note.className = 'mp-chat-turn-status';
  note.textContent = studioT('run.stopping');
  pending.body.appendChild(note);
  const result = await ConversationControl.callConversationAction(() =>
    Data.stopConversation(pending.requestId),
  );
  if (
    !result.ok &&
    (pendingConversation === pending || externalConversationRun === pending)
  ) {
    delete pending.body.dataset.stopRequested;
    note.textContent = result.error;
  }
}

Data.onConversationProgress(payload => {
  if (payload.record) {
    modulesProgress(payload.conversationId, payload.record);
  }
  if (payload.requestId && payload.conversationId) {
    acceptSubmissionNavigation(
      payload.requestId,
      payload.conversationId,
      payload.title,
    );
  }
  if (
    !pendingConversation ||
    payload.requestId !== pendingConversation.requestId ||
    !payload.record
  ) {
    return;
  }
  if (payload.conversationId) {
    pendingConversation.conversationId = payload.conversationId;
  }
  if (payload.record.phase === 'user_input_accepted') {
    pendingConversation.inputAccepted = true;
    pendingPermissionAsk = null;
    pendingAskInput = null;
    const host = document.getElementById('composer-permission-ask');
    if (host) {
      DecisionCard.resolve(host);
    }
  }
  if (
    !pendingConversation.scope &&
    payload.conversationId &&
    Number.isInteger(payload.turnIndex)
  ) {
    pendingConversation.scope = `${payload.conversationId}#${payload.turnIndex}`;
    pendingConversation.body.replaceChildren();
    pendingConversation.renderer = ChatView.createLiveTurn(
      pendingConversation.body,
      pendingConversation.scope,
      {taskPanel: true},
    );
  }
  renderConversationProgress(payload.record);
});

async function steerActiveConversation(
  question: string,
  textarea: HTMLTextAreaElement,
): Promise<void> {
  const pending = pendingConversation || externalConversationRun;
  const sessionId = pending?.agentSessionId || '';
  if (!sessionId) {
    return;
  }
  const attachmentPaths = [...composerAttachments];
  const inputId = `input:studio:${Date.now()}:${(studioTaskInputSequence += 1)}`;
  const taskInput = buildStudioTaskInput(
    question,
    inputId,
    sessionId,
    attachmentPaths,
  );
  if (!taskInput || !TaskInputTransport?.createTaskInputTransport) {
    return;
  }
  const status = document.createElement('div');
  status.className = 'mp-chat-turn-status';
  status.textContent = studioT('run.queued');
  pending?.body.appendChild(status);
  const transport = TaskInputTransport.createTaskInputTransport({
    send: (value: MagicPointerTaskInput) =>
      Data.steerConversation(
        sessionId,
        value,
        attachmentSourcesForTask(attachmentPaths, sessionId),
      ),
    onState: (state: {status?: string; error?: string}) => {
      if (state.status === 'queueing') {
        status.textContent = studioT('run.queued');
      } else if (state.status === 'accepted') {
        status.textContent = studioT('run.accepted');
      } else {
        status.textContent = studioT('run.barge_failed', {
          reason: String(state.error || studioT('common.unknown_reason')),
        });
      }
    },
  });
  await transport.submit(taskInput, {
    onAccepted: () => {
      if (
        pending !== pendingConversation &&
        pending !== externalConversationRun
      ) {
        return;
      }
      if (textarea.value.trim() === question) {
        textarea.value = '';
        fitComposer(textarea);
      }
      composerAttachments = [];
      composerSelectedSourceIds.clear();
      renderComposerAttachments();
      renderComposerMaterials();
      const flow = document.querySelector<HTMLElement>('#stream .mp-chat-flow');
      if (flow) {
        const node = ChatView.userNode(question);
        node.setAttribute('data-queued', 'true');
        flow.appendChild(node);
        scrollChatToBottom();
      }
    },
  });
}

async function submitOpenUiAction(detail: {
  scope: string;
  blockId: string;
  event: {
    type: string;
    humanFriendlyMessage?: string;
    formState?: Record<string, unknown>;
    params?: Record<string, unknown>;
  };
}): Promise<void> {
  const conversationId = detail.scope.slice(0, detail.scope.lastIndexOf('#'));
  const conversation = activeConversationRecord;
  if (
    !conversationId ||
    conversationId !== activeConversationId ||
    conversation?.id !== conversationId ||
    !conversation.agentSessionId
  ) {
    throw new Error('Open the original task to use this interface.');
  }
  if (detail.event.type === 'open_url') {
    const result = await Data.openProjectUrl(
      String(detail.event.params?.url || ''),
    );
    if (!result.ok) {
      throw new Error(result.error || 'Could not open this link.');
    }
    return;
  }
  if (detail.event.type !== 'continue_conversation') {
    throw new Error('This interface action is not available.');
  }
  if (pendingPermissionAsk || pendingAskInput) {
    throw new Error(
      'Answer the current task question before continuing this interface.',
    );
  }
  const question = [
    detail.event.humanFriendlyMessage ||
      'Continue with these interface values.',
    `\n[Interactive response: ${detail.scope}, ${detail.blockId}]`,
    JSON.stringify({
      fields: detail.event.formState ?? {},
      context: detail.event.params?.context ?? null,
    }),
  ].join('\n');
  return submitConversationFollowup({
    conversationId,
    question,
    inputPrefix: 'openui',
    allowSteer: true,
  });
}

async function submitFileUndo(detail: {
  conversationId: string;
  turnIndex: number;
}): Promise<void> {
  const conversationId = detail.conversationId;
  if (
    !conversationId ||
    conversationId !== activeConversationId ||
    activeConversationRecord?.id !== conversationId ||
    !activeConversationRecord.agentSessionId
  ) {
    throw new Error('Open the original task to undo these file changes.');
  }
  if (
    studioComposerBusy ||
    pendingConversation ||
    externalConversationRun ||
    pendingPermissionAsk ||
    pendingAskInput
  ) {
    throw new Error(
      'Finish the current task or answer its question before undoing file changes.',
    );
  }
  const conversation = await Data.conversation(conversationId);
  if (conversation?.hasPendingWork) {
    throw new Error('Finish the current task before undoing file changes.');
  }
  const turn =
    Number.isInteger(detail.turnIndex) && detail.turnIndex >= 0
      ? conversation?.turns?.[detail.turnIndex]
      : undefined;
  const question =
    turn && !turn.pendingInput && !turn.liveProgress
      ? ChatView.fileUndoQuestion(turn)
      : undefined;
  if (!question) {
    throw new Error('This turn has no available file changes to undo.');
  }
  const workspaceRoot = String(conversation?.workspaceRoot || '');
  const executionWorkspaceRoot = String(
    turn?.request?.executionWorkspaceRoot || workspaceRoot,
  );
  return submitConversationFollowup({
    conversationId,
    question,
    inputPrefix: 'file-undo',
    allowSteer: false,
    workspace: {
      projectRoot: workspaceRoot,
      executionWorkspaceRoot,
      projectId: conversation?.projectId,
    },
  });
}

async function submitConversationFollowup(request: {
  conversationId: string;
  question: string;
  inputPrefix: string;
  allowSteer: boolean;
  workspace?: {
    projectRoot: string;
    executionWorkspaceRoot: string;
    projectId?: string;
  };
}): Promise<void> {
  const {conversationId, question} = request;
  const conversation = activeConversationRecord;
  if (
    activeConversationId !== conversationId ||
    conversation?.id !== conversationId ||
    !conversation.agentSessionId
  ) {
    throw new Error('The active task changed before the request was sent.');
  }
  if (pendingPermissionAsk || pendingAskInput) {
    throw new Error('Answer the current task question before continuing.');
  }
  const requestId = crypto.randomUUID();
  const taskInput = buildStudioTaskInput(
    question,
    `input:${request.inputPrefix}:${requestId}`,
    conversation.agentSessionId,
    [],
    [],
  );
  if (studioComposerBusy || pendingConversation || externalConversationRun) {
    if (!request.allowSteer) {
      throw new Error('Finish the current task before undoing file changes.');
    }
    const result = await Data.steerConversation(
      conversation.agentSessionId,
      taskInput,
    );
    if (!result.ok) {
      throw new Error(result.error || 'Could not send the interface response.');
    }
    if (activeConversationId === conversationId) {
      const receipt = ChatView.userNode(question) as HTMLElement;
      receipt.dataset.queued = 'true';
      document.querySelector('#stream .mp-chat-flow')?.append(receipt);
      scrollChatToBottom();
    }
    return;
  }
  const flow = document.querySelector<HTMLElement>('#stream .mp-chat-flow');
  if (!flow) {
    throw new Error('The task conversation is not visible.');
  }
  captureComposerDraft();
  const body = document.createElement('div');
  body.className = 'mp-chat-assistant-body';
  flow.append(ChatView.userNode(question) as HTMLElement, body);
  const submitted: PendingConversation = {
    requestId,
    question,
    startedAt: Date.now(),
    body,
    records: new Map(),
    renderer: ChatView.createLiveTurn(body, undefined, {taskPanel: true}),
    agentSessionId: conversation.agentSessionId,
    streamText: '',
    reasoningText: '',
    transcript: ConversationControl.createTranscript(),
    liveTokens: null,
  };
  pendingConversation = submitted;
  studioComposerBusy = true;
  setComposerRunningState(true);
  startPendingClock(body);
  renderConversationProgress({phase: 'runtime_boot', fields: {}});
  const permissionPreset = composerPreset;
  const effort = composerEffort;
  const modelSelection = currentComposerModelSelection();
  try {
    const workspace = request.workspace ?? (await prepareComposerWorktree());
    if (
      activeConversationId !== conversationId ||
      pendingConversation !== submitted
    ) {
      throw new Error('The active task changed before the request was sent.');
    }
    const result = await Data.sendConversation({
      conversationId,
      question,
      requestId,
      taskInput,
      attachments: [],
      permissionPreset,
      effort,
      modelSelection,
      workspaceRoot: workspace.projectRoot,
      executionWorkspaceRoot: workspace.executionWorkspaceRoot,
      projectId: workspace.projectId,
      additionalFolders: conversation.additionalFolders,
    });
    if (!result?.ok) {
      throw new Error(result?.error || 'The request did not complete.');
    }
    if (
      activeConversationId === conversationId &&
      pendingConversation === submitted
    ) {
      await openConversation(conversationId);
    }
  } catch (error) {
    if (
      activeConversationId === conversationId &&
      pendingConversation === submitted
    ) {
      body.replaceChildren(
        ChatView.turnErrorNode(
          error instanceof Error ? error.message : String(error),
        ) as HTMLElement,
      );
    }
    throw error;
  } finally {
    if (pendingConversation === submitted) {
      detachPendingConversation();
    }
    void renderSidebar();
  }
}

document.addEventListener('mp:openui-action', event => {
  const detail = (event as CustomEvent<Parameters<typeof submitOpenUiAction>[0] & {
    respond?: (result: {ok: boolean; error?: string}) => void;
  }>).detail;
  void submitOpenUiAction(detail).then(
    () => detail.respond?.({ok: true}),
    error => detail.respond?.({ok: false, error: error instanceof Error ? error.message : String(error)}),
  );
});

document.addEventListener('mp:undo-file-changes', event => {
  const detail = (event as CustomEvent<{
    conversationId: string; turnIndex: number;
    respond?: (result: {ok: boolean; error?: string}) => void;
  }>).detail;
  void submitFileUndo(detail).then(
    () => detail.respond?.({ok: true}),
    error => detail.respond?.({ok: false, error: error instanceof Error ? error.message : String(error)}),
  );
});

document
  .getElementById('composer-form')
  ?.querySelector('button[type="submit"]')
  ?.addEventListener('click', e => {
    if (
      !studioComposerBusy ||
      !(pendingConversation || externalConversationRun)
    ) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    void stopActiveConversation();
  });

document.querySelectorAll('form.mpw-input-form').forEach(form => {
  const ta = form.querySelector<HTMLTextAreaElement>('textarea');
  if (ta) {
    fitComposer(ta);
    syncComposerSubmitState();
    ta.addEventListener('input', () => {
      fitComposer(ta);
      syncComposerSubmitState();
    });
    ta.addEventListener('input', () => {
      const caret = ta.selectionStart ?? ta.value.length;
      const token = SlashTrigger.detectSlashToken(ta.value.slice(0, caret));
      if (token !== null) {
        void openSlashMenu(token);
      } else {
        closeSlashMenu();
      }
    });
    ta.addEventListener('keydown', e => {
      const menu = document.getElementById('composer-add-menu');
      if (menu && !menu.hidden) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          moveSlashSelection(1);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          moveSlashSelection(-1);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeSlashMenu();
          return;
        }
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
      if (
        e.key === 'Tab' &&
        !e.shiftKey &&
        !e.isComposing &&
        acceptComposerSuggestion(ta)
      ) {
        e.preventDefault();
        return;
      }
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) {
        return;
      }
      e.preventDefault();
      (form as HTMLFormElement).requestSubmit();
    });
  }
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const textarea = form.querySelector<HTMLTextAreaElement>('textarea');
    const question = textarea?.value.trim() || '';
    if (!textarea || !question) {
      textarea?.focus();
      return;
    }
    if (studioComposerBusy) {
      await steerActiveConversation(question, textarea);
      return;
    }

    captureComposerDraft();
    const navigationLocation = composerLocation();
    const navigationDraft: StudioComposerDraft = {
      text: textarea.value,
      attachments: [...composerAttachments],
      sourceIds: [...composerSelectedSourceIds],
      workspaceRoot: activeProjectRoot,
      projectId: activeProjectId,
      additionalFolders: [...composerAdditionalFolders],
      returnToProject:
        windowNavigation.draft(navigationLocation)?.returnToProject,
      modelSelection: currentComposerModelSelection(),
      permissionPreset: composerPreset,
      effort: composerEffort,
      branch: currentComposerBranch(),
      worktree: currentComposerWorktreeEnabled(),
    };
    windowNavigation.saveDraft(navigationLocation, navigationDraft);
    const attachmentPaths = [...composerAttachments];
    const requestQuestion = attachmentPaths.length
      ? question +
        studioT('chat.attachments_prefix') +
        attachmentPaths.map(filePath => `- ${filePath}`).join('\n')
      : question;

    const stream = document.getElementById('stream');
    if (!stream) {
      return;
    }
    setStudioHomeVisible(false);
    let flow = stream.querySelector<HTMLElement>('.mp-chat-flow');
    if (!flow) {
      flow = document.createElement('div');
      flow.className = 'mp-chat-flow';
      stream.replaceChildren(
        ...(stream.querySelector('.mpw-blank, .view-empty')
          ? []
          : [...stream.children]),
        flow,
      );
    }
    if (
      pendingPermissionChoice &&
      (pendingPermissionChoice.grant ||
        pendingPermissionChoice.deny ||
        pendingPermissionChoice.once)
    ) {
      flow.appendChild(
        ChatView.permissionAnswerNode({
          decision: pendingPermissionChoice.deny
            ? 'deny'
            : pendingPermissionChoice.once
              ? 'once'
              : 'grant',
          rule: String(
            pendingPermissionChoice.deny ||
              pendingPermissionChoice.once ||
              pendingPermissionChoice.grant ||
              '',
          ),
        }),
      );
    } else {
      flow.appendChild(ChatView.userNode(requestQuestion));
    }
    const pending = document.createElement('div');
    pending.className = 'mp-chat-assistant';
    const pendingBody = document.createElement('div');
    pendingBody.className = 'mp-chat-assistant-body';
    pendingBody.appendChild(
      ChatView.liveActivityNode({phase: 'runtime_boot', fields: {}}),
    );
    pending.appendChild(pendingBody);
    flow.appendChild(pending);
    scrollChatToBottom();
    scheduleStreamRail();

    textarea.value = '';
    fitComposer(textarea);
    clearComposerSuggestion();
    studioComposerBusy = true;
    form.setAttribute('aria-busy', 'true');
    setComposerRunningState(true);
    startPendingClock(pendingBody);
    const requestId =
      globalThis.crypto?.randomUUID?.() ||
      `conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const taskInput = buildStudioTaskInput(
      question,
      `input:studio:${requestId}`,
      activeTaskContext?.taskId || 'studio-pending',
      attachmentPaths,
    );
    pendingConversation = {
      requestId,
      question,
      startedAt: Date.now(),
      body: pendingBody,
      records: new Map(),
      renderer: ChatView.createLiveTurn(pendingBody, undefined, {
        taskPanel: true,
      }),
      agentSessionId: activeTaskContext?.taskId || null,
      streamText: '',
      reasoningText: '',
      transcript: ConversationControl.createTranscript(),
      liveTokens: null,
    };
    const submittedConversation = pendingConversation;
    const submission: NavigationSubmission = {
      location: navigationLocation,
      draft: navigationDraft,
      keepOriginal: true,
      accepted: false,
    };
    navigationSubmissions.set(requestId, submission);
    const isCurrentSubmission = () =>
      pendingConversation === submittedConversation &&
      shell.dataset.view === 'chat' &&
      windowNavigation.isCurrent(submission.location);
    const conversationId = activeConversationId;
    const hadPendingInput = Boolean(pendingPermissionAsk || pendingAskInput);
    const permissionChoice = pendingPermissionChoice || undefined;
    const permissionPreset = navigationDraft.permissionPreset;
    const effort = composerEffort;
    syncConversationPendingInput([]);
    renderConversationProgress({phase: 'runtime_boot', fields: {}});
    try {
      const workspace = await prepareComposerWorktree();
      submission.workspace = workspace;
      if (
        pendingConversation !== submittedConversation ||
        workspace.projectId !== activeProjectId
      ) {
        return;
      }
      const response = await Data.sendConversation({
        conversationId,
        workMode: productMode === 'design' ? 'work' : 'code',
        question,
        permissionPreset,
        requestId,
        workspaceRoot: workspace.projectRoot,
        effort,
        permissionGrant: permissionChoice?.grant,
        permissionDeny: permissionChoice?.deny,
        permissionGrantOnce: permissionChoice?.once,
        attachments: attachmentPaths,
        taskInput,
        executionWorkspaceRoot: workspace.executionWorkspaceRoot,
        projectId: workspace.projectId,
        additionalFolders: navigationDraft.additionalFolders,
        modelSelection: navigationDraft.modelSelection,
        branch: navigationDraft.branch,
        worktree: navigationDraft.worktree,
      });
      if (response?.conversationId) {
        acceptSubmissionNavigation(requestId, String(response.conversationId));
      }
      const selectedByCommand =
        response?.command?.type === 'model'
          ? (response.command.modelSelection as
              MagicPointerModelSelection | undefined)
          : undefined;
      if (selectedByCommand) {
        if (windowNavigation.isCurrent(submission.location)) {
          captureComposerDraft();
        }
        const draft = windowNavigation.draft(submission.location);
        if (
          !draft ||
          sameModelSelection(
            draft.modelSelection,
            submission.draft.modelSelection,
          )
        ) {
          windowNavigation.saveDraft(submission.location, {
            ...submission.draft,
            text: '',
            attachments: [],
            sourceIds: [],
            ...draft,
            modelSelection: {...selectedByCommand},
          });
          if (windowNavigation.isCurrent(submission.location)) {
            composerModelSelection = {...selectedByCommand};
            renderComposerModel();
          }
        }
      }
      if (!response?.ok && !windowNavigation.draft(submission.location)?.text) {
        windowNavigation.saveDraft(submission.location, submission.draft);
      }
      if (
        (!response?.ok || !response.conversationId) &&
        !submission.accepted &&
        submission.draft.returnToProject
      ) {
        throw new Error(
          response?.error || 'Could not create the conversation.',
        );
      }
      if (!isCurrentSubmission()) {
        await renderSidebar();
        return;
      }
      pendingPermissionChoice = null;
      if (response?.conversationId) {
        activeConversationId = String(response.conversationId);
        adoptComposerWorktreeConversation(
          workspace.contextKey,
          workspace.projectRoot,
          activeConversationId,
        );
      }
      if (!response?.ok || !response.conversationId) {
        if (response?.conversationId) {
          await openConversation(String(response.conversationId));
          await renderSidebar();
        }
        throw new Error(response?.error || studioT('chat.incomplete'));
      }
      renderComposerAttachments();
      renderComposerMaterials();
      const command = (
        response as {
          command?: {
            type?: string;
            preset?: string;
            modelSelection?: MagicPointerModelSelection;
          };
        }
      ).command;
      if (command?.type === 'model') {
        await refreshComposerModel();
        if (!isCurrentSubmission()) {
          return;
        }
      } else if (
        (response as {plan?: unknown}).plan &&
        typeof (response as {plan?: unknown}).plan === 'object'
      ) {
        composerPlan = PlanList.project([
          {plan: (response as {plan: unknown}).plan},
        ]);
        renderPlanCard();
      }
      const awaiting = response as {
        awaitingUserInput?: boolean;
        pendingInput?: NonNullable<MagicPointerTurn['pendingInput']>;
      };
      if (awaiting.awaitingUserInput && awaiting.pendingInput) {
        syncConversationPendingInput([{pendingInput: awaiting.pendingInput}]);
      }
      await openConversation(String(response.conversationId));
      await renderSidebar();
      if (!isCurrentSubmission()) {
        return;
      }
      setComposerSettledState(awaiting.awaitingUserInput ? 'idle' : 'success');
      if (!awaiting.awaitingUserInput) {
        void refreshComposerSuggestion(
          activeConversationTurns,
          activeConversationObject,
        );
      }
    } catch (error) {
      if (!windowNavigation.draft(submission.location)?.text) {
        windowNavigation.saveDraft(submission.location, submission.draft);
      }
      const returnToProject = submission.draft.returnToProject;
      if (!submission.accepted && returnToProject) {
        const location: StudioLocation = {kind: 'project', id: returnToProject};
        if (!windowNavigation.draft(location)?.text) {
          windowNavigation.saveDraft(location, submission.draft);
        }
        libraryUi.setProjectSubmissionError(
          returnToProject,
          error instanceof Error ? error.message : String(error),
        );
        if (!isCurrentSubmission()) {
          return;
        }
        if (
          !textarea.value.trim() ||
          textarea.value === submission.draft.text
        ) {
          windowNavigation.replace(location);
          show('projects', returnToProject);
          return;
        }
      }
      if (!isCurrentSubmission()) {
        return;
      }
      if (hadPendingInput && conversationId) {
        const durable = await Data.conversation(conversationId).catch(
          () => undefined,
        );
        if (!isCurrentSubmission() || activeConversationId !== conversationId) {
          return;
        }
        if (durable) {
          syncConversationPendingInput(durable.turns || []);
        }
      }
      pending.replaceChildren(
        ChatView.turnErrorNode(
          error instanceof Error ? error.message : String(error),
        ),
      );
      if (!textarea.value.trim()) {
        composerAttachments = [...submission.draft.attachments];
        renderComposerAttachments();
      }
      textarea.value = ConversationControl.failedDraftValue(
        textarea.value,
        question,
      );
      fitComposer(textarea);
      setComposerSettledState('error');
    } finally {
      navigationSubmissions.delete(requestId);
      if (pendingConversation === submittedConversation) {
        detachPendingConversation();
        void renderSidebar();
      }
    }
  });
});

async function boot(initialView: string) {
  const generation = conversationOpenGeneration;
  void refreshComposerModel();
  await renderSidebar();
  if (generation !== conversationOpenGeneration) {
    return;
  }
  if (initialView !== 'chat') {
    show(initialView);
    return;
  }
  if (shell.dataset.view !== 'chat') {
    return;
  }
  startNewChat();
}

function detachPendingConversation() {
  if (pendingRenderTimer !== null) {
    window.clearTimeout(pendingRenderTimer);
  }
  pendingRenderTimer = null;
  pendingConversation = null;
  externalConversationRun = null;
  studioComposerBusy = false;
  stopPendingClock();
  document.getElementById('composer-form')?.removeAttribute('aria-busy');
  setComposerRunningState(false);
}

function startNewChat(draftId?: string) {
  captureComposerDraft();
  const saved = draftId
    ? windowNavigation.draft({kind: 'draft', id: draftId})
    : undefined;
  conversationOpenGeneration += 1;
  detachPendingConversation();
  clearWorkspaceResources();
  if (inspectorState.open) {
    setInspector(false);
  }
  if (artifactEditor.state().artifactId) {
    artifactEditor.clear();
    renderArtifactEditor();
    if (activeInspectorTab === 'artifact') {
      setInspector(false);
    }
  }
  activeConversationId = null;
  seedSessionPane('');
  newChatWorktreeId =
    draftId ||
    `new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  activeConversationView = null;
  activeConversationRecord = null;
  activeConversationTurns = [];
  activeConversationObject = {};
  conversationRefreshSequence += 1;
  recoveryRenderGeneration += 1;
  const recovery = document.getElementById('conversation-recovery');
  if (recovery) {
    recovery.replaceChildren();
    recovery.hidden = true;
  }
  const executionAttention = document.getElementById('execution-attention');
  if (executionAttention) {
    executionAttention.hidden = true;
  }
  renderConversationActivity();
  pendingPermissionChoice = null;
  syncConversationPendingInput([]);
  composerPlan = null;
  renderPlanCard();
  clearComposerSuggestion();
  renderProjectTasks();
  setActiveTaskContext(null, true);
  if (saved) {
    setActiveProject(saved.workspaceRoot, saved.projectId);
  }
  composerAttachments = [];
  renderComposerAttachments();
  void refreshFigmaConnection();
  activeConversationTurnCount = 0;
  activeConversationTab = 'chat';
  renderProjectContext();
  setStudioHomeVisible(true);
  document
    .querySelectorAll('#side-convos .side-item')
    .forEach(n => n.classList.remove('is-on'));
  const title = document.getElementById('chat-title');
  if (title) {
    title.textContent = 'New chat';
  }
  projectEnvironment = null;
  renderProjectContext();
  const preview = document.getElementById('chat-source-preview');
  if (preview) {
    preview.hidden = true;
  }
  const peek = document.getElementById('chat-peek');
  if (peek) {
    peek.hidden = true;
  }
  const stream = document.getElementById('stream');
  if (stream) {
    stream.innerHTML = '<div class="mpw-blank" aria-hidden="true"></div>';
  }
  renderUsageMeter([]);
  const trajectory = document.getElementById('trajectory');
  if (trajectory) {
    trajectory.replaceChildren();
  }
  setConversationTab('chat');
  void renderStudioHome();
  const card = document.querySelector<HTMLElement>('#composer-form .mpw-card');
  const textarea = document.querySelector<HTMLTextAreaElement>('.mpw-input');
  restoreComposerDraft({kind: 'draft', id: newChatWorktreeId});
  if (shell.dataset.view === 'chat') {
    recordWindowNavigation('chat');
  }
  if (card) {
    card.classList.remove('is-pulsed');
    void card.offsetWidth;
    card.classList.add('is-pulsed');
    window.setTimeout(() => card.classList.remove('is-pulsed'), 700);
  }
  textarea?.focus();
}

document.getElementById('nav-new-chat')?.addEventListener('click', () => {
  startNewChat();
  show('chat');
});

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
            <button type="button" class="icon-btn is-plain" id="stash-viewer-copy" title="${studioT('stash.copy_image')}"><svg><use href="#ic-clip"/></svg></button>
            <button type="button" class="icon-btn is-plain" id="stash-viewer-close" title="${studioT('common.close')}"><svg><use href="#ic-x"/></svg></button>
          </span>
        </div>
        <img class="stash-viewer-img" alt="" />
      </div>`;
    document.body.appendChild(viewer);
    viewer.addEventListener('click', ev => {
      if (ev.target === viewer) {
        closeStashViewer();
      }
    });
    viewer
      .querySelector('#stash-viewer-close')!
      .addEventListener('click', closeStashViewer);
    viewer
      .querySelector('#stash-viewer-copy')!
      .addEventListener('click', () => {
        const img = viewer!.querySelector(
          '.stash-viewer-img',
        ) as HTMLImageElement | null;
        if (!img || !img.src) {
          return;
        }
        fetch(img.src)
          .then(r => r.blob())
          .then(blob => {
            navigator.clipboard.write([new ClipboardItem({[blob.type]: blob})]);
          })
          .catch(() => {
            /* 剪贴板不可用时静默 */
          });
      });
  }
  const img = viewer.querySelector('.stash-viewer-img') as HTMLImageElement;
  img.src = 'file:///' + String(src).replace(/\\/g, '/');
  img.alt = desc || '';
  viewer.querySelector('.stash-viewer-title')!.textContent = desc || studioT('stash.image_default');
  viewer.classList.add('is-visible');
}

function closeStashViewer() {
  const viewer = document.getElementById('stash-viewer');
  if (viewer) {
    viewer.classList.remove('is-visible');
  }
}

document.addEventListener('mouseover', e => {
  const node = (e.target as Element | null)?.closest<HTMLElement>(
    '.node[data-src], .stash-row[data-src]',
  );
  if (!node || node === stashHoverTarget) {
    return;
  }
  if (stashHoverTimer) {
    clearTimeout(stashHoverTimer);
  }
  stashHoverTarget = node;
  const src = node.dataset.src || '';
  if (!src || !/\.(png|jpe?g|gif|webp|bmp)$/i.test(src)) {
    return;
  }
  stashHoverTimer = setTimeout(async () => {
    const el = stashSummaryEl();
    const rect = node.getBoundingClientRect();
    el.style.left = `${Math.min(rect.left, window.innerWidth - 340)}px`;
    el.style.top = `${rect.bottom + 10}px`;
    el.textContent = studioT('stash.viewing');
    el.classList.add('is-visible');
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
    if (stashHoverTarget === node) {
      el.textContent = summary;
    }
  }, 1000);
});

document.addEventListener('mouseout', e => {
  if (
    !(e.target as Element | null)?.closest(
      '.node[data-src], .stash-row[data-src]',
    )
  ) {
    return;
  }
  if (stashHoverTimer) {
    clearTimeout(stashHoverTimer);
  }
  stashHoverTarget = null;
  const el = document.getElementById('stash-summary');
  if (el) {
    el.classList.remove('is-visible');
  }
});

const initialView = studioShell.normalizeView(
  new URLSearchParams(location.search).get('view'),
);
void boot(initialView === 'design' ? 'chat' : initialView);

let conversationChangeRaf: number | null = null;
Data.onChange(change => {
  for (const record of change?.liveProgress?.records || []) {
    modulesProgress(change?.id, record);
  }
  if (change?.id) {
    conversationNotificationSequence += 1;
  }
  void refreshOpenConversation(change);
  if (change?.liveProgress) {
    return;
  }
  if (conversationChangeRaf !== null) {
    return;
  }
  conversationChangeRaf = window.requestAnimationFrame(() => {
    conversationChangeRaf = null;
    renderSidebar();
    if (document.getElementById('studio-home')?.hidden === false) {
      void renderStudioHome();
    }
    renderArtifacts(true);
    void libraryUi.render(shell.dataset.view || 'chat');
    refreshStashSummaries();
  });
});

function refreshStashSummaries() {
  const world = document.getElementById('canvas-world');
  if (!world) {
    return;
  }
  Data.stash()
    .then(bursts => {
      const bySrc = new Map();
      for (const b of bursts) {
        for (const it of b.items) {
          if (it.src && it.summary) {
            bySrc.set(it.src, it.summary);
          }
        }
      }
      world.querySelectorAll('.node[data-src]').forEach(node => {
        const nodeEl = node as HTMLElement;
        const summary = bySrc.get(nodeEl.dataset.src!);
        if (!summary) {
          return;
        }
        if (nodeEl.dataset.summary === summary) {
          return;
        }
        nodeEl.dataset.summary = summary;
        let el = node.querySelector('.node-summary') as HTMLElement | null;
        if (!el) {
          el = document.createElement('span');
          el.className = 'node-summary';
          nodeEl.appendChild(el);
        }
        el.textContent = summary;
      });
    })
    .catch(() => {});
}

window.magicPointerDashboard?.onShow?.(payload => {
  if (payload?.view === 'personal' && typeof payload.personalDate === 'string') {
    personalActivityUi?.setDate(payload.personalDate);
  }
  if (payload?.view) {
    show(String(payload.view));
  }
  if (payload?.conversationId) {
    const id = String(payload.conversationId);
    void openConversation(id).then(() => {
      if (activeConversationId === id && payload.artifactId) {
        void openArtifactEditor(id, String(payload.artifactId));
      }
    });
  }
});

if (window.magicPointerDashboard?.onCardPatch) {
  window.magicPointerDashboard.onCardPatch(payload => {
    if (!payload?.cardId) {
      return;
    }
    const updated = LiveCards.patch(payload.cardId, payload.patch || {});
    const host = chatCardNodes.get(payload.cardId);
    if (host && updated) {
      const replacement = renderChatCardNode(updated);
      host.replaceWith(replacement);
      chatCardNodes.set(payload.cardId, replacement);
    }
  });
}
