'use strict';

interface LearnDagNode {
  id: string;
  title: string;
  label?: string;
  subtitle?: string;
  summary?: string;
  status: string;
  prereqIds?: string[];
  kind?: string;
  sourcePath?: string;
  estimatedMinutes?: number;
  mastery?: number;
  [key: string]: unknown;
}

interface LearnDreamNudge {
  id: string;
  title?: string;
  label?: string;
  prompt?: string;
  launchPrompt?: string;
  rationale?: string;
  reason?: string;
  estimatedMinutes?: number;
  targetNodeId?: string;
  kind?: string;
  badge?: string;
  [key: string]: unknown;
}

interface LearnDreamBridge {
  from?: string;
  to?: string;
  fromTitle?: string;
  toTitle?: string;
  toPath?: string;
  insight?: string;
  label?: string;
  detail?: string;
  target?: string;
}

interface LearnDreamRecord {
  id: string;
  runAt: string | number;
  summary?: string;
  synthesizedInsights?: string[];
  insights?: string[];
  bridges?: Array<string | LearnDreamBridge>;
  crossBridges?: Array<string | LearnDreamBridge>;
  crossCourseBridges?: Array<string | LearnDreamBridge>;
  nudges?: LearnDreamNudge[];
  [key: string]: unknown;
}

interface LearnCourseMaterial {
  id: string;
  title: string;
  category?: string;
  kind?: string;
  path?: string;
  sourcePath?: string;
  url?: string;
  source?: string;
  summary?: string;
  nodeId?: string;
  [key: string]: unknown;
}

interface LearnAnnotationMark {
  id: string;
  quote?: string;
  text?: string;
  note?: string;
  comment?: string;
  section?: string;
  sectionId?: string;
  color?: string;
  kind?: string;
  createdAt?: string | number;
  [key: string]: unknown;
}

interface LearnCheckinRecord {
  id: string;
  prompt: string;
  selectedIndex: number | null;
  selectedLabel: string;
  unsure: boolean;
  reasoningNote: string;
  courseId?: string;
  submittedAt?: string | number;
}

interface LearnCourse {
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  livingArtifact: {
    title?: string;
    html: string;
    annotations: LearnAnnotationMark[];
    updatedAt?: string | number;
  };
  dag?: LearnDagNode[];
  dagNodes?: LearnDagNode[];
  nodes?: LearnDagNode[];
  dreamHistory?: LearnDreamRecord[];
  materials?: LearnCourseMaterial[];
  checkins?: LearnCheckinRecord[];
  updatedAt?: string | number;
}

interface NeuralGraphPayload {
  nodes: Array<{
    id: string;
    label: string;
    kind?: string;
    group?: string;
    status?: string;
    sourcePath?: string;
    summary?: string;
    [key: string]: unknown;
  }>;
  edges: Array<{
    source?: string;
    target?: string;
    from?: string;
    to?: string;
    kind?: string;
    weight?: number;
    label?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

type LearnStudyCourseSummary = {
  id: string;
  title: string;
  subtitle?: string;
  masteredCount?: number;
  totalNodes?: number;
  stuckCount?: number;
};
type LearnStudyDagNode = LearnDagNode;
type LearnStudyDreamNudge = LearnDreamNudge;
type LearnStudyDreamBridge = LearnDreamBridge;
type LearnStudyDreamRecord = LearnDreamRecord;
type LearnStudyMaterial = LearnCourseMaterial;
type LearnStudyAnnotation = LearnAnnotationMark;
type LearnStudyCourse = LearnCourse;

interface LearnStudySessionArtifact {
  id: string;
  title: string;
  kind: string;
  content: string;
  language?: string;
}

interface LearnStudyArtifactHandlers {
  onSelectCourse: (courseId: string) => void | Promise<void>;
  onRunDream: (courseId: string) => void | Promise<void>;
  onStartNodeInChat: (node: LearnStudyDagNode, course: LearnStudyCourse) => void;
  onLaunchNudge: (nudge: LearnStudyDreamNudge, course: LearnStudyCourse) => void;
  onOpenMaterialInChat: (material: LearnStudyMaterial, course: LearnStudyCourse) => void;
  onAskSelectionSideChat: (payload: {
    quote: string;
    section: string;
    courseId: string;
  }) => void;
  onSubmitCheckin: (payload: {
    id: string;
    prompt: string;
    selectedIndex: number | null;
    selectedLabel: string;
    unsure: boolean;
    reasoningNote: string;
    courseId: string;
  }) => void;
  onAnnotationAdded: (mark: LearnStudyAnnotation, courseId: string) => void;
  onFocusNodeInChat: (node: {id: string; label: string; sourcePath?: string}) => void;
  onAskNodeSideChat: (node: {id: string; label: string; sourcePath?: string}) => void;
  onSaveToVault?: (course: LearnStudyCourse) => void | Promise<void>;
  onRequestGraph?: (courseId: string) => Promise<NeuralGraphPayload | null>;
}

interface LearnStudyArtifactApi {
  mount(
    hostEl: HTMLElement | null,
    state: {
      courses: LearnStudyCourseSummary[];
      activeCourse: LearnStudyCourse | null;
      graph?: NeuralGraphPayload | null;
      sessionArtifacts?: LearnStudySessionArtifact[];
      initialTab?: 'notes' | 'overview' | 'graph';
    },
    handlers: LearnStudyArtifactHandlers,
  ): void;
  setTab(tab: 'notes' | 'overview' | 'graph'): void;
  updateCourse(course: LearnStudyCourse, graph?: NeuralGraphPayload | null): void;
  togglePen(force?: boolean): boolean;
  getPenActive(): boolean;
}

declare global {
  var LearnStudyArtifact: LearnStudyArtifactApi | undefined;
}

(() => {
  type StudyTab = 'notes' | 'overview' | 'graph';
  type NormalizedNodeStatus = 'mastered' | 'in_progress' | 'stuck' | 'unseen';

  interface LearnNeuralGraphInstance {
    destroy?: () => void;
  }

  interface LearnNeuralGraphGlobal {
    mount?: (
      host: HTMLElement,
      graph: NeuralGraphPayload,
      handlers?: {
        onFocusInChat?: (node: {id: string; label: string; sourcePath?: string}) => void;
        onAskSideChat?: (node: {id: string; label: string; sourcePath?: string}) => void;
      },
    ) => LearnNeuralGraphInstance | void;
  }

  interface ChatMarkdownGlobal {
    render?: (markdown: unknown) => Node;
  }

  interface ChatHighlightSpan {
    text: string;
    token: string;
  }

  interface ChatHighlightGlobal {
    languageOf?: (lang: string) => string;
    langForPath?: (filePath: string) => {lang: string; label: string};
    highlight?: (code: string, lang: string) => ChatHighlightSpan[][];
  }

  interface StudyDocPayload {
    id: string;
    mode: 'study-doc';
    theme: 'light' | 'dark';
    themeCss: string;
    html: string;
    marks: LearnStudyAnnotation[];
    penActive: boolean;
  }

  interface ArtifactSandboxPayload {
    id: string;
    theme: 'light' | 'dark';
    themeCss: string;
    html: string;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MATERIALS_INITIAL_LIMIT = 16;

  let hostEl: HTMLElement | null = null;
  let courses: LearnStudyCourseSummary[] = [];
  let activeCourse: LearnStudyCourse | null = null;
  let currentGraph: NeuralGraphPayload | null = null;
  let graphCourseId = '';
  let sessionArtifacts: LearnStudySessionArtifact[] = [];
  let activeTab: StudyTab = 'notes';
  let activeArtifactId = '__living__';
  let penActive = false;
  let dreamRunning = false;
  let vaultSaving = false;
  let vaultSavedTimer: ReturnType<typeof setTimeout> | null = null;
  let vaultSaved = false;
  let materialsExpanded = false;
  let handlers: LearnStudyArtifactHandlers | null = null;

  let activeDocFrame: HTMLIFrameElement | null = null;
  let activeArtifactFrame: HTMLIFrameElement | null = null;
  let activeSandboxId = '';
  let activeArtifactSandboxId = '';
  let lastDocCourseId = '';
  let lastDocHtml = '';
  let sandboxSeq = 0;
  let graphSeq = 0;
  let graphInstance: LearnNeuralGraphInstance | null = null;

  let themeObserver: MutationObserver | null = null;
  let messageListenerBound = false;
  let lastObservedTheme: 'light' | 'dark' = 'light';

  let rootEl: HTMLElement | null = null;
  let tabButtons = new Map<StudyTab, HTMLButtonElement>();
  let penBtnEl: HTMLButtonElement | null = null;
  let dreamBtnEl: HTMLButtonElement | null = null;
  let vaultBtnEl: HTMLButtonElement | null = null;
  let subbarEl: HTMLElement | null = null;
  let bodyEl: HTMLElement | null = null;

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function svgEl(
    tag: string,
    attrs: Record<string, string | number>,
  ): SVGElement {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      node.setAttribute(k, String(v));
    }
    return node;
  }

  function isDarkTheme(): boolean {
    if (typeof document === 'undefined') {
      return false;
    }
    const docTheme = document.documentElement?.dataset?.theme;
    const docMode = document.documentElement?.dataset?.mode;
    const bodyDark = Boolean(document.body?.hasAttribute('data-ds-dark-theme'));
    return docTheme === 'dark' || docMode === 'dark' || bodyDark;
  }

  function currentThemeName(): 'light' | 'dark' {
    return isDarkTheme() ? 'dark' : 'light';
  }

  function buildStudyThemeCss(dark: boolean): string {
    return dark
      ? ':root{--bg:#212120;--surface:#262624;--surface-2:#30302E;--text:#FAF9F5;--ink:#FAF9F5;--ink-2:#C2C0B6;--muted:#9C9A92;--border:rgba(255,255,255,.10);--border-strong:rgba(255,255,255,.20);--hover:rgba(255,255,255,.075);--slider-track:rgba(255,255,255,.14);--blue:#6da7ec;--teal:#5eead4;--purple:#c4b5fd;--green:#86efac;--danger:#f87171;--in:#6da7ec;--in-bg:rgba(109,167,236,.15);--out:#2dd4bf;--out-bg:rgba(45,212,191,.14);--op:#6ee7b7;--op-bg:rgba(110,231,183,.14);--norm:#fcd34d;--norm-bg:rgba(252,211,77,.14);--loss:#f87171;--loss-bg:rgba(248,113,113,.15);--alt:#c4b5fd;--alt-bg:rgba(196,181,253,.15);--param:#f9a8d4;--wire:#8b8a82;--radius:8px;--radius-lg:12px;}'
      : ':root{--bg:#FFFFFF;--surface:#FAF9F5;--surface-2:#F3F3F0;--text:#141413;--ink:#141413;--ink-2:#3D3D3A;--muted:#73726C;--border:rgba(11,11,11,.09);--border-strong:rgba(11,11,11,.20);--hover:rgba(11,11,11,.04);--slider-track:rgba(11,11,11,.10);--blue:#2563eb;--teal:#0f766e;--purple:#7c3aed;--green:#15803d;--danger:#dc2626;--in:#2563eb;--in-bg:rgba(37,99,235,.09);--out:#0f766e;--out-bg:rgba(15,118,110,.09);--op:#15803d;--op-bg:rgba(21,128,61,.09);--norm:#b45309;--norm-bg:rgba(180,83,9,.10);--loss:#dc2626;--loss-bg:rgba(220,38,38,.09);--alt:#7c3aed;--alt-bg:rgba(124,58,237,.10);--param:#db2777;--wire:#71717a;--radius:8px;--radius-lg:12px;}';
  }

  function normalizeCourse(course: LearnStudyCourse): LearnStudyCourse {
    const rawLiving = course.livingArtifact || {html: '', annotations: []};
    const annotations = Array.isArray(rawLiving.annotations)
      ? rawLiving.annotations.map(item => ({...item}))
      : [];
    return {
      ...course,
      livingArtifact: {
        ...rawLiving,
        html: String(rawLiving.html || ''),
        annotations,
      },
      dagNodes: Array.isArray(course.dagNodes)
        ? course.dagNodes
        : Array.isArray(course.dag)
          ? course.dag
          : Array.isArray(course.nodes)
            ? course.nodes
            : [],
      dreamHistory: Array.isArray(course.dreamHistory)
        ? course.dreamHistory
        : [],
      materials: Array.isArray(course.materials) ? course.materials : [],
    };
  }

  function courseNodes(course: LearnStudyCourse | null): LearnStudyDagNode[] {
    if (!course) {
      return [];
    }
    if (Array.isArray(course.dagNodes) && course.dagNodes.length) {
      return course.dagNodes;
    }
    if (Array.isArray(course.dag) && course.dag.length) {
      return course.dag;
    }
    if (Array.isArray(course.nodes)) {
      return course.nodes;
    }
    return [];
  }

  function normalizeStatus(raw: string | undefined): NormalizedNodeStatus {
    const val = String(raw || '').trim().toLowerCase();
    if (val === 'mastered' || val === 'verified' || val === 'done') {
      return 'mastered';
    }
    if (
      val === 'current' ||
      val === 'in_progress' ||
      val === 'in-progress' ||
      val === 'active' ||
      val === 'learning' ||
      val === 'explored' ||
      val === 'questioned'
    ) {
      return 'in_progress';
    }
    if (val === 'stuck' || val === 'gap' || val === 'blocked') {
      return 'stuck';
    }
    return 'unseen';
  }

  function statusLabel(status: NormalizedNodeStatus): string {
    switch (status) {
      case 'mastered':
        return '已掌握';
      case 'in_progress':
        return '进行中';
      case 'stuck':
        return '卡点';
      default:
        return '待解锁';
    }
  }

  function formatTimestamp(raw: string | number | undefined): string {
    if (raw === undefined || raw === null || raw === '') {
      return '';
    }
    let dt: Date;
    if (typeof raw === 'number') {
      const ms = raw < 1e12 ? raw * 1000 : raw;
      dt = new Date(ms);
    } else {
      dt = new Date(String(raw));
    }
    if (Number.isNaN(dt.getTime())) {
      return String(raw);
    }
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  }

  function formatBridgeLabel(bridge: string | LearnStudyDreamBridge): string {
    if (typeof bridge === 'string') {
      return bridge.trim();
    }
    if (!bridge || typeof bridge !== 'object') {
      return '';
    }
    if (bridge.label) {
      return String(bridge.label).trim();
    }
    const left = String(bridge.fromTitle || bridge.from || '').trim();
    const right = String(
      bridge.toTitle || bridge.to || bridge.target || '',
    ).trim();
    const detail = String(bridge.insight || bridge.detail || '').trim();
    if (left && right) {
      return detail ? `${left} ↔ ${right} · ${detail}` : `${left} ↔ ${right}`;
    }
    return right || left || detail;
  }

  function pickLatestDream(
    history: LearnStudyDreamRecord[],
  ): LearnStudyDreamRecord | null {
    if (!history.length) {
      return null;
    }
    let best = history[history.length - 1];
    let bestTime = Date.parse(String(best.runAt ?? ''));
    if (typeof best.runAt === 'number') {
      bestTime = best.runAt < 1e12 ? best.runAt * 1000 : best.runAt;
    }
    for (const item of history) {
      let ts = Date.parse(String(item.runAt ?? ''));
      if (typeof item.runAt === 'number') {
        ts = item.runAt < 1e12 ? item.runAt * 1000 : item.runAt;
      }
      if (Number.isFinite(ts) && (!Number.isFinite(bestTime) || ts > bestTime)) {
        best = item;
        bestTime = ts;
      }
    }
    return best;
  }

  function buildStudyDocPayload(): StudyDocPayload | null {
    if (!activeCourse) {
      return null;
    }
    const theme = currentThemeName();
    return {
      id: activeSandboxId,
      mode: 'study-doc',
      theme,
      themeCss: buildStudyThemeCss(theme === 'dark'),
      html: activeCourse.livingArtifact?.html || '',
      marks: activeCourse.livingArtifact?.annotations || [],
      penActive,
    };
  }

  function postStudyDocInit(targetWin: Window | null | undefined): void {
    if (!targetWin) {
      return;
    }
    const payload = buildStudyDocPayload();
    if (!payload) {
      return;
    }
    lastObservedTheme = payload.theme;
    targetWin.postMessage({type: 'mp-iui-init', ...payload}, '*');
  }

  function buildArtifactPayload(
    artifact: LearnStudySessionArtifact,
    sandboxId: string,
  ): ArtifactSandboxPayload {
    const theme = currentThemeName();
    const kind = String(artifact.kind || '').toLowerCase();
    const html =
      kind === 'svg' || kind === 'diagram'
        ? `<div class="mp-svg-stage">${artifact.content}</div>`
        : String(artifact.content || '');
    return {
      id: sandboxId,
      theme,
      themeCss: buildStudyThemeCss(theme === 'dark'),
      html,
    };
  }

  function postPenStateToFrame(): void {
    if (!activeDocFrame?.contentWindow) {
      return;
    }
    activeDocFrame.contentWindow.postMessage(
      {type: 'mp-xray-set-pen', id: activeSandboxId, penActive},
      '*',
    );
  }

  function syncToolbarState(): void {
    for (const [tab, btn] of tabButtons.entries()) {
      const isOn = tab === activeTab;
      btn.classList.toggle('is-on', isOn);
      btn.setAttribute('aria-selected', isOn ? 'true' : 'false');
    }

    if (penBtnEl) {
      penBtnEl.classList.toggle('is-on', penActive);
      penBtnEl.setAttribute('aria-pressed', penActive ? 'true' : 'false');
      penBtnEl.disabled = !activeCourse;
    }

    if (dreamBtnEl) {
      dreamBtnEl.disabled = !activeCourse || dreamRunning;
      dreamBtnEl.classList.toggle('is-running', dreamRunning);
      dreamBtnEl.setAttribute('aria-busy', dreamRunning ? 'true' : 'false');
      dreamBtnEl.textContent = dreamRunning ? '反刍中…' : 'Dream · 反刍';
    }

    if (vaultBtnEl) {
      vaultBtnEl.disabled = !activeCourse || vaultSaving;
      vaultBtnEl.classList.toggle('is-on', vaultSaved);
      vaultBtnEl.textContent = vaultSaving
        ? '存入中…'
        : vaultSaved
          ? '已存入'
          : '存入库';
    }
  }

  function renderSubbar(): void {
    if (!subbarEl) {
      return;
    }
    if (activeTab !== 'notes' || !activeCourse) {
      subbarEl.hidden = true;
      subbarEl.replaceChildren();
      return;
    }
    const annotations = activeCourse.livingArtifact?.annotations || [];
    const hasExtra = sessionArtifacts.length > 0;
    const shouldShow = hasExtra || annotations.length > 0 || penActive;
    if (!shouldShow) {
      subbarEl.hidden = true;
      subbarEl.replaceChildren();
      return;
    }

    subbarEl.hidden = false;
    subbarEl.replaceChildren();

    const tabsWrap = el('div', 'mp-lsa-subtabs');
    tabsWrap.setAttribute('role', 'tablist');
    tabsWrap.setAttribute('aria-label', '笔记文档视图');

    const livingBtn = el(
      'button',
      `mp-lsa-subtab${activeArtifactId === '__living__' ? ' is-on' : ''}`,
      '活笔记总稿',
    );
    livingBtn.type = 'button';
    livingBtn.dataset.artifactId = '__living__';
    livingBtn.setAttribute('role', 'tab');
    livingBtn.setAttribute(
      'aria-selected',
      activeArtifactId === '__living__' ? 'true' : 'false',
    );
    livingBtn.addEventListener('click', () => {
      if (activeArtifactId !== '__living__') {
        activeArtifactId = '__living__';
        renderSubbar();
        renderNotesTab();
      }
    });
    tabsWrap.appendChild(livingBtn);

    for (const art of sessionArtifacts) {
      const isOn = activeArtifactId === art.id;
      const btn = el(
        'button',
        `mp-lsa-subtab${isOn ? ' is-on' : ''}`,
      );
      btn.type = 'button';
      btn.dataset.artifactId = art.id;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', isOn ? 'true' : 'false');
      btn.appendChild(el('span', 'mp-lsa-subtab-label', art.title || art.id));
      const extLabel = (art.language || art.kind || '').trim();
      if (extLabel) {
        btn.appendChild(el('span', 'mp-lsa-subtab-kind', extLabel));
      }
      btn.addEventListener('click', () => {
        if (activeArtifactId !== art.id) {
          activeArtifactId = art.id;
          renderSubbar();
          renderNotesTab();
        }
      });
      tabsWrap.appendChild(btn);
    }

    const readoutText =
      annotations.length > 0
        ? `${annotations.length} 条标注已同步`
        : penActive
          ? '标注模式已开启 · 划词即可标注'
          : '未开启标注';
    const readout = el('span', 'mp-lsa-sync-status', readoutText);

    subbarEl.append(tabsWrap, readout);
  }

  function destroyGraphInstance(): void {
    graphSeq += 1;
    if (graphInstance && typeof graphInstance.destroy === 'function') {
      try {
        graphInstance.destroy();
      } catch {
        /* ignore teardown failure */
      }
    }
    graphInstance = null;
  }

  function clearIframeRefs(): void {
    activeDocFrame = null;
    activeArtifactFrame = null;
    lastDocCourseId = '';
    lastDocHtml = '';
  }

  function renderEmptyState(
    title: string,
    description: string,
  ): HTMLElement {
    const box = el('div', 'mp-lsa-empty');
    box.appendChild(el('strong', 'mp-lsa-empty-title', title));
    box.appendChild(el('p', 'mp-lsa-empty-desc', description));
    if (courses.length > 0 && !activeCourse) {
      const quickList = el('div', 'mp-lsa-empty-courses');
      for (const item of courses.slice(0, 6)) {
        const btn = el('button', 'mp-lsa-btn', item.title);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          void handlers?.onSelectCourse(item.id);
        });
        quickList.appendChild(btn);
      }
      box.appendChild(quickList);
    }
    return box;
  }

  function renderCodeArtifact(artifact: LearnStudySessionArtifact): HTMLElement {
    const wrap = el('div', 'mp-lsa-code-view');
    const head = el('header', 'mp-lsa-code-head');
    const titleSpan = el('span', 'mp-lsa-code-title', artifact.title || '代码片段');

    const g = globalThis as unknown as {ChatHighlight?: ChatHighlightGlobal};
    const highlighter = g.ChatHighlight;
    const resolvedLang = artifact.language
      ? highlighter?.languageOf?.(artifact.language) || artifact.language
      : highlighter?.langForPath?.(artifact.title || '')?.lang || 'plain';

    const metaWrap = el('div', 'mp-lsa-code-meta');
    if (resolvedLang && resolvedLang !== 'plain') {
      metaWrap.appendChild(el('span', 'mp-lsa-code-lang', resolvedLang));
    }
    const copyBtn = el('button', 'mp-lsa-btn', '复制');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(artifact.content || '').then(() => {
          copyBtn.textContent = '已复制';
          setTimeout(() => {
            copyBtn.textContent = '复制';
          }, 1400);
        });
      }
    });
    metaWrap.appendChild(copyBtn);
    head.append(titleSpan, metaWrap);

    const scroller = el('div', 'mp-lsa-code-scroll mp-selectable');
    const lines = String(artifact.content || '').split('\n');
    const tokenized =
      highlighter && typeof highlighter.highlight === 'function'
        ? highlighter.highlight(String(artifact.content || ''), resolvedLang)
        : null;

    const table = el('div', 'mp-lsa-code-lines');
    lines.forEach((rawLine, idx) => {
      const row = el('div', 'mp-lsa-code-row');
      const numCell = el('span', 'mp-lsa-code-num', String(idx + 1));
      const codeCell = el('code', 'mp-lsa-code-text');
      const spans = tokenized?.[idx];
      if (spans && spans.length > 0) {
        for (const span of spans) {
          const tokEl = el(
            'span',
            `mp-chat-tok-${String(span.token || 'plain')}`,
            span.text,
          );
          codeCell.appendChild(tokEl);
        }
      } else {
        codeCell.textContent = rawLine.length > 0 ? rawLine : ' ';
      }
      row.append(numCell, codeCell);
      table.appendChild(row);
    });

    scroller.appendChild(table);
    wrap.append(head, scroller);
    return wrap;
  }

  function renderMarkdownArtifact(
    artifact: LearnStudySessionArtifact,
  ): HTMLElement {
    const wrap = el('div', 'mp-lsa-markdown-view mp-selectable');
    const g = globalThis as unknown as {ChatMarkdown?: ChatMarkdownGlobal};
    if (g.ChatMarkdown && typeof g.ChatMarkdown.render === 'function') {
      wrap.appendChild(g.ChatMarkdown.render(artifact.content || ''));
    } else {
      const pre = el('pre', 'mp-lsa-markdown-fallback', artifact.content || '');
      wrap.appendChild(pre);
    }
    return wrap;
  }

  function renderExtraArtifactFrame(
    artifact: LearnStudySessionArtifact,
  ): HTMLElement {
    const sandboxId = `lsa-art-${++sandboxSeq}`;
    activeArtifactSandboxId = sandboxId;
    const frame = el('iframe', 'mp-lsa-doc-frame');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = artifact.title || 'Session artifact';
    frame.addEventListener('load', () => {
      if (frame !== activeArtifactFrame) {
        return;
      }
      const payload = buildArtifactPayload(artifact, sandboxId);
      lastObservedTheme = payload.theme;
      frame.contentWindow?.postMessage({type: 'mp-iui-init', ...payload}, '*');
    });
    frame.src = 'iui_sandbox.html';
    activeArtifactFrame = frame;
    return frame;
  }

  function renderNotesTab(): void {
    if (!bodyEl) {
      return;
    }
    destroyGraphInstance();

    if (!activeCourse) {
      clearIframeRefs();
      bodyEl.replaceChildren(
        renderEmptyState('暂无已选课程', '从左侧或课程总览选择一门课程开始精读。'),
      );
      return;
    }

    if (activeArtifactId !== '__living__') {
      const extra = sessionArtifacts.find(a => a.id === activeArtifactId);
      if (extra) {
        activeDocFrame = null;
        lastDocCourseId = '';
        lastDocHtml = '';
        const kind = String(extra.kind || '').toLowerCase();
        if (kind === 'html' || kind === 'svg' || kind === 'diagram') {
          bodyEl.replaceChildren(renderExtraArtifactFrame(extra));
        } else if (kind === 'markdown' || kind === 'md') {
          activeArtifactFrame = null;
          bodyEl.replaceChildren(renderMarkdownArtifact(extra));
        } else {
          activeArtifactFrame = null;
          bodyEl.replaceChildren(renderCodeArtifact(extra));
        }
        return;
      }
      activeArtifactId = '__living__';
      renderSubbar();
    }

    activeArtifactFrame = null;
    activeArtifactSandboxId = '';

    const html = activeCourse.livingArtifact?.html || '';
    if (
      activeDocFrame &&
      activeDocFrame.isConnected &&
      lastDocCourseId === activeCourse.id &&
      lastDocHtml === html
    ) {
      return;
    }

    const sandboxId = `lsa-doc-${++sandboxSeq}`;
    activeSandboxId = sandboxId;
    lastDocCourseId = activeCourse.id;
    lastDocHtml = html;

    const frame = el('iframe', 'mp-lsa-doc-frame');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = activeCourse.livingArtifact?.title || activeCourse.title || 'Living study notes';
    frame.addEventListener('load', () => {
      if (frame !== activeDocFrame) {
        return;
      }
      postStudyDocInit(frame.contentWindow);
    });
    frame.src = 'iui_sandbox.html';
    activeDocFrame = frame;
    bodyEl.replaceChildren(frame);
  }

  function truncateSvgLabel(text: string, maxUnits: number): string {
    let units = 0;
    let out = '';
    for (const ch of text) {
      const step = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)
        ? 1.75
        : 1;
      if (units + step > maxUnits) {
        return `${out.trimEnd()}…`;
      }
      out += ch;
      units += step;
    }
    return out;
  }

  function buildDagSection(course: LearnStudyCourse): HTMLElement {
    const section = el('section', 'mp-lsa-dag-section');
    const secHead = el('div', 'mp-lsa-section-head');
    secHead.appendChild(el('h3', 'mp-lsa-section-title', '课程知识依赖图'));

    const legend = el('div', 'mp-lsa-dag-legend');
    const legendItems: Array<{status: NormalizedNodeStatus; label: string}> = [
      {status: 'mastered', label: '已掌握'},
      {status: 'in_progress', label: '进行中'},
      {status: 'stuck', label: '卡点'},
      {status: 'unseen', label: '待解锁'},
    ];
    for (const item of legendItems) {
      const entry = el('span', 'mp-lsa-legend-item');
      entry.dataset.status = item.status;
      entry.appendChild(el('i', 'mp-lsa-legend-dot'));
      entry.appendChild(document.createTextNode(item.label));
      legend.appendChild(entry);
    }
    secHead.appendChild(legend);
    section.appendChild(secHead);

    const nodes = courseNodes(course);
    if (!nodes.length) {
      section.appendChild(
        el('p', 'mp-lsa-muted-note', '当前课程尚未生成知识依赖节点。'),
      );
      return section;
    }

    const nodeById = new Map<string, LearnStudyDagNode>();
    for (const n of nodes) {
      nodeById.set(n.id, n);
    }

    const layerById = new Map<string, number>();
    for (const n of nodes) {
      layerById.set(n.id, 0);
    }
    for (let pass = 0; pass < nodes.length; pass++) {
      let changed = false;
      for (const n of nodes) {
        const prereqs = Array.isArray(n.prereqIds) ? n.prereqIds : [];
        let maxPrereq = -1;
        for (const pid of prereqs) {
          if (pid !== n.id && nodeById.has(pid)) {
            const pLayer = layerById.get(pid) ?? 0;
            if (pLayer > maxPrereq) {
              maxPrereq = pLayer;
            }
          }
        }
        const nextLayer = maxPrereq + 1;
        if (nextLayer > (layerById.get(n.id) ?? 0)) {
          layerById.set(n.id, nextLayer);
          changed = true;
        }
      }
      if (!changed) {
        break;
      }
    }

    const rawByLayer = new Map<number, LearnStudyDagNode[]>();
    for (const n of nodes) {
      const l = layerById.get(n.id) ?? 0;
      const bucket = rawByLayer.get(l);
      if (bucket) {
        bucket.push(n);
      } else {
        rawByLayer.set(l, [n]);
      }
    }

    const rows: LearnStudyDagNode[][] = [];
    const sortedLayerKeys = [...rawByLayer.keys()].sort((a, b) => a - b);
    for (const key of sortedLayerKeys) {
      const group = rawByLayer.get(key) || [];
      for (let i = 0; i < group.length; i += 3) {
        rows.push(group.slice(i, i + 3));
      }
    }

    const nodeW = 166;
    const nodeH = 56;
    const colGap = 22;
    const rowGap = 28;
    const padX = 12;
    const padY = 12;
    const maxCols = Math.max(1, ...rows.map(r => r.length));
    const viewW = Math.max(
      380,
      padX * 2 + maxCols * nodeW + Math.max(0, maxCols - 1) * colGap,
    );
    const viewH = Math.max(
      96,
      padY * 2 + rows.length * nodeH + Math.max(0, rows.length - 1) * rowGap,
    );

    const posById = new Map<
      string,
      {x: number; y: number; w: number; h: number; node: LearnStudyDagNode}
    >();

    rows.forEach((row, rowIdx) => {
      const rowW = row.length * nodeW + Math.max(0, row.length - 1) * colGap;
      const startX = Math.max(padX, Math.round((viewW - rowW) / 2));
      const y = padY + rowIdx * (nodeH + rowGap);
      row.forEach((n, colIdx) => {
        const x = startX + colIdx * (nodeW + colGap);
        posById.set(n.id, {x, y, w: nodeW, h: nodeH, node: n});
      });
    });

    const svgWrap = el('div', 'mp-lsa-dag-wrap');
    const svg = svgEl('svg', {
      class: 'mp-lsa-dag-svg',
      viewBox: `0 0 ${viewW} ${viewH}`,
      role: 'img',
      'aria-label': `${course.title} 课程依赖图`,
    });

    const edgesLayer = svgEl('g', {class: 'mp-lsa-dag-edges'});
    for (const n of nodes) {
      const toPos = posById.get(n.id);
      if (!toPos) {
        continue;
      }
      const prereqs = Array.isArray(n.prereqIds) ? n.prereqIds : [];
      for (const pid of prereqs) {
        const fromPos = posById.get(pid);
        if (!fromPos || pid === n.id) {
          continue;
        }
        const x1 = Math.round(fromPos.x + fromPos.w / 2);
        const y1 = Math.round(fromPos.y + fromPos.h);
        const x2 = Math.round(toPos.x + toPos.w / 2);
        const y2 = Math.round(toPos.y);
        const midY = Math.round((y1 + y2) / 2);
        const d =
          y2 >= y1
            ? `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`
            : `M ${x1} ${y1} Q ${Math.round((x1 + x2) / 2) + 28} ${midY} ${x2} ${y2}`;
        edgesLayer.appendChild(svgEl('path', {class: 'mp-lsa-dag-edge', d}));
        edgesLayer.appendChild(
          svgEl('circle', {
            class: 'mp-lsa-dag-edge-dot',
            cx: x2,
            cy: y2,
            r: 2.2,
          }),
        );
      }
    }
    svg.appendChild(edgesLayer);

    const nodesLayer = svgEl('g', {class: 'mp-lsa-dag-nodes'});
    for (const pos of posById.values()) {
      const node = pos.node;
      const norm = normalizeStatus(node.status);
      const label = statusLabel(norm);
      const displayTitle = String(node.title || node.label || node.id);

      const group = svgEl('g', {
        class: 'mp-lsa-dag-node',
        'data-status': norm,
        'data-node-id': node.id,
        role: 'button',
        tabindex: '0',
        'aria-label': `${displayTitle}（${label}），点击开始探讨`,
      });
      const titleTag = svgEl('title', {});
      titleTag.textContent = `${displayTitle} · ${label}`;
      group.appendChild(titleTag);

      group.appendChild(
        svgEl('rect', {
          class: 'mp-lsa-dag-node-box',
          x: pos.x,
          y: pos.y,
          width: pos.w,
          height: pos.h,
          rx: 8,
        }),
      );

      group.appendChild(
        svgEl('circle', {
          class: 'mp-lsa-dag-status-dot',
          cx: pos.x + 13,
          cy: pos.y + 16,
          r: 3.2,
        }),
      );

      const statusEl = svgEl('text', {
        class: 'mp-lsa-dag-status-text',
        x: pos.x + 21,
        y: pos.y + 19,
      });
      statusEl.textContent = label;
      group.appendChild(statusEl);

      const titleText = svgEl('text', {
        class: 'mp-lsa-dag-node-title',
        x: pos.x + 11,
        y: pos.y + 40,
      });
      titleText.textContent = truncateSvgLabel(displayTitle, 17);
      group.appendChild(titleText);

      const activate = () => {
        handlers?.onStartNodeInChat(node, course);
      };
      group.addEventListener('click', activate);
      group.addEventListener('keydown', (ev: Event) => {
        const keyEvent = ev as KeyboardEvent;
        if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
          keyEvent.preventDefault();
          activate();
        }
      });

      nodesLayer.appendChild(group);
    }

    svg.appendChild(nodesLayer);
    svgWrap.appendChild(svg);
    section.appendChild(svgWrap);
    return section;
  }

  function triggerDreamRun(courseId: string): void {
    if (dreamRunning) {
      return;
    }
    dreamRunning = true;
    syncToolbarState();
    if (activeTab === 'overview') {
      renderOverviewTab();
    }
    Promise.resolve(handlers?.onRunDream(courseId))
      .catch(() => {
        /* caller handles dream failure UI */
      })
      .finally(() => {
        dreamRunning = false;
        syncToolbarState();
        if (activeTab === 'overview') {
          renderOverviewTab();
        }
      });
  }

  function buildDreamCard(course: LearnStudyCourse): HTMLElement {
    const card = el('section', 'mp-lsa-dream-card');
    const history = Array.isArray(course.dreamHistory)
      ? course.dreamHistory
      : [];
    const latest = pickLatestDream(history);

    const head = el('div', 'mp-lsa-dream-head');
    const titleGroup = el('div', 'mp-lsa-dream-title-wrap');
    titleGroup.appendChild(el('strong', 'mp-lsa-dream-title', 'Dream · 记忆反刍'));
    if (latest) {
      const ts = formatTimestamp(latest.runAt);
      if (ts) {
        titleGroup.appendChild(el('span', 'mp-lsa-dream-time', ts));
      }
    }
    head.appendChild(titleGroup);

    const runBtn = el(
      'button',
      'mp-lsa-btn',
      dreamRunning
        ? '反刍中…'
        : latest
          ? '立即反刍'
          : '运行首次 Dream 反刍',
    );
    runBtn.type = 'button';
    runBtn.disabled = dreamRunning;
    runBtn.addEventListener('click', () => triggerDreamRun(course.id));
    head.appendChild(runBtn);
    card.appendChild(head);

    if (!latest) {
      card.appendChild(
        el(
          'p',
          'mp-lsa-dream-empty',
          '尚未运行 Dream 反刍；反刍会凝练学习卡点并建立跨课程记忆桥接。',
        ),
      );
      return card;
    }

    const insightLines: string[] = [];
    const rawInsights = Array.isArray(latest.synthesizedInsights)
      ? latest.synthesizedInsights
      : Array.isArray(latest.insights)
        ? latest.insights
        : [];
    for (const line of rawInsights) {
      const clean = String(line || '').trim();
      if (clean) {
        insightLines.push(clean);
      }
    }
    if (insightLines.length === 0 && latest.summary) {
      insightLines.push(String(latest.summary).trim());
    }
    if (insightLines.length > 0) {
      const insightsBox = el('div', 'mp-lsa-dream-insights');
      for (const line of insightLines.slice(0, 2)) {
        insightsBox.appendChild(el('p', 'mp-lsa-dream-insight', line));
      }
      card.appendChild(insightsBox);
    }

    const rawBridges = [
      ...(Array.isArray(latest.crossBridges) ? latest.crossBridges : []),
      ...(Array.isArray(latest.bridges) ? latest.bridges : []),
      ...(Array.isArray(latest.crossCourseBridges)
        ? latest.crossCourseBridges
        : []),
    ];
    const bridges = rawBridges.map(formatBridgeLabel).filter(Boolean);
    if (bridges.length > 0) {
      const bridgeRow = el('div', 'mp-lsa-dream-bridges');
      bridgeRow.appendChild(el('span', 'mp-lsa-dream-sublabel', '跨课程关联'));
      const bridgeList = el('div', 'mp-lsa-bridge-list');
      for (const label of bridges.slice(0, 4)) {
        bridgeList.appendChild(el('span', 'mp-lsa-bridge-item', label));
      }
      bridgeRow.appendChild(bridgeList);
      card.appendChild(bridgeRow);
    }

    const nudges = Array.isArray(latest.nudges) ? latest.nudges : [];
    if (nudges.length > 0) {
      const nudgeList = el('div', 'mp-lsa-nudge-list');
      for (const nudge of nudges.slice(0, 4)) {
        const btn = el('button', 'mp-lsa-nudge-row');
        btn.type = 'button';
        const left = el('div', 'mp-lsa-nudge-main');
        left.appendChild(
          el(
            'span',
            'mp-lsa-nudge-title',
            String(
              nudge.title ||
                nudge.label ||
                nudge.launchPrompt ||
                nudge.prompt ||
                '开始复习建议',
            ),
          ),
        );
        const nudgeDetail = String(
          nudge.rationale || nudge.reason || '',
        ).trim();
        if (nudgeDetail) {
          left.appendChild(el('span', 'mp-lsa-nudge-reason', nudgeDetail));
        }
        const arrow = el('span', 'mp-lsa-nudge-arrow', '→');
        btn.append(left, arrow);
        btn.addEventListener('click', () => {
          handlers?.onLaunchNudge(nudge, course);
        });
        nudgeList.appendChild(btn);
      }
      card.appendChild(nudgeList);
    }

    return card;
  }

  function buildMaterialsSection(course: LearnStudyCourse): HTMLElement {
    const section = el('section', 'mp-lsa-materials-section');
    const materials = Array.isArray(course.materials) ? course.materials : [];
    const head = el('div', 'mp-lsa-section-head');
    head.appendChild(
      el(
        'h3',
        'mp-lsa-section-title',
        `课程材料 · Athenaeum & Persistence (${materials.length})`,
      ),
    );
    section.appendChild(head);

    if (!materials.length) {
      section.appendChild(
        el('p', 'mp-lsa-muted-note', '暂未关联课程讲义、作业或代码材料。'),
      );
      return section;
    }

    const list = el('div', 'mp-lsa-materials');
    const visible = materialsExpanded
      ? materials
      : materials.slice(0, MATERIALS_INITIAL_LIMIT);

    for (const mat of visible) {
      const row = el('button', 'mp-lsa-material-row');
      row.type = 'button';

      const cat = String(mat.category || mat.kind || 'Note').trim() || 'Note';
      row.appendChild(el('span', 'mp-lsa-material-cat', cat));

      const body = el('span', 'mp-lsa-material-main');
      body.appendChild(el('span', 'mp-lsa-material-title', mat.title || mat.id));
      const subText = [mat.source, mat.path || mat.sourcePath]
        .filter(Boolean)
        .join(' · ');
      if (subText) {
        body.appendChild(el('span', 'mp-lsa-material-sub', subText));
      }
      row.appendChild(body);
      row.appendChild(el('span', 'mp-lsa-material-arrow', '打开'));

      row.addEventListener('click', () => {
        handlers?.onOpenMaterialInChat(mat, course);
      });
      list.appendChild(row);
    }

    section.appendChild(list);

    if (materials.length > MATERIALS_INITIAL_LIMIT) {
      const toggleBtn = el(
        'button',
        'mp-lsa-btn mp-lsa-materials-toggle',
        materialsExpanded
          ? '收起材料列表'
          : `展开全部 ${materials.length} 项材料`,
      );
      toggleBtn.type = 'button';
      toggleBtn.addEventListener('click', () => {
        materialsExpanded = !materialsExpanded;
        renderOverviewTab();
      });
      section.appendChild(toggleBtn);
    }

    return section;
  }

  function renderOverviewTab(): void {
    if (!bodyEl) {
      return;
    }
    destroyGraphInstance();
    clearIframeRefs();

    if (!activeCourse) {
      bodyEl.replaceChildren(
        renderEmptyState('暂无课程总览', '选择或导入课程后，这里会展示知识依赖图、Dream 反刍与材料列表。'),
      );
      return;
    }

    const course = activeCourse;
    const container = el('div', 'mp-lsa-overview');

    const header = el('header', 'mp-lsa-overview-head');
    const topMeta = el('div', 'mp-lsa-overview-top');
    topMeta.appendChild(el('span', 'mp-lsa-kicker', 'COURSE WORKSPACE'));
    if (courses.length > 1) {
      const select = el('select', 'mp-lsa-course-select');
      select.setAttribute('aria-label', '切换课程');
      for (const item of courses) {
        const opt = el('option', '', item.title);
        opt.value = item.id;
        opt.selected = item.id === course.id;
        select.appendChild(opt);
      }
      select.addEventListener('change', () => {
        const nextId = select.value;
        if (nextId && nextId !== course.id) {
          void handlers?.onSelectCourse(nextId);
        }
      });
      topMeta.appendChild(select);
    }
    header.appendChild(topMeta);

    header.appendChild(el('h2', 'mp-lsa-overview-title', course.title));
    if (course.subtitle) {
      header.appendChild(el('p', 'mp-lsa-overview-subtitle', course.subtitle));
    }

    const nodes = courseNodes(course);
    let masteredCount = 0;
    let stuckCount = 0;
    for (const n of nodes) {
      const norm = normalizeStatus(n.status);
      if (norm === 'mastered') {
        masteredCount += 1;
      } else if (norm === 'stuck') {
        stuckCount += 1;
      }
    }
    const total = nodes.length;
    const pct = total > 0 ? Math.round((masteredCount / total) * 100) : 0;

    const masteryBox = el('div', 'mp-lsa-mastery');
    const track = el('div', 'mp-lsa-progress-track');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(Math.max(1, total)));
    track.setAttribute('aria-valuenow', String(masteredCount));
    const fill = el('div', 'mp-lsa-progress-fill');
    fill.style.width = `${pct}%`;
    track.appendChild(fill);
    masteryBox.appendChild(track);
    masteryBox.appendChild(
      el(
        'div',
        'mp-lsa-mastery-text',
        `${masteredCount}/${total} 节点已掌握 · ${stuckCount} 个卡点`,
      ),
    );
    header.appendChild(masteryBox);

    container.appendChild(header);
    container.appendChild(buildDagSection(course));
    container.appendChild(buildDreamCard(course));
    container.appendChild(buildMaterialsSection(course));

    bodyEl.replaceChildren(container);
  }

  function mountGraphPayload(
    host: HTMLElement,
    payload: NeuralGraphPayload | null,
  ): void {
    const g = globalThis as unknown as {
      LearnNeuralGraph?: LearnNeuralGraphGlobal;
    };
    if (!payload || !Array.isArray(payload.nodes) || payload.nodes.length === 0) {
      host.replaceChildren(
        renderEmptyState('暂无图谱节点', '当前课程还没有可展示的知识概念与关联边。'),
      );
      return;
    }
    if (!g.LearnNeuralGraph || typeof g.LearnNeuralGraph.mount !== 'function') {
      host.replaceChildren(
        renderEmptyState('神经图谱未加载', `当前包含 ${payload.nodes.length} 个知识节点。`),
      );
      return;
    }
    host.replaceChildren();
    const instance = g.LearnNeuralGraph.mount(host, payload, {
      onFocusInChat: node => handlers?.onFocusNodeInChat(node),
      onAskSideChat: node => handlers?.onAskNodeSideChat(node),
    });
    if (instance && typeof instance === 'object') {
      graphInstance = instance;
    }
  }

  function renderGraphTab(): void {
    if (!bodyEl) {
      return;
    }
    destroyGraphInstance();
    clearIframeRefs();

    const host = el('div', 'mp-lsa-graph-host');
    bodyEl.replaceChildren(host);

    if (!activeCourse) {
      host.replaceChildren(
        renderEmptyState('未选择课程', '选择课程后可查看课程与跨库神经图谱。'),
      );
      return;
    }

    const courseId = activeCourse.id;
    if (currentGraph && graphCourseId === courseId) {
      mountGraphPayload(host, currentGraph);
      return;
    }

    if (!handlers?.onRequestGraph) {
      mountGraphPayload(host, currentGraph);
      return;
    }

    const reqId = ++graphSeq;
    host.replaceChildren(
      el('div', 'mp-lsa-loading', '正在加载神经图谱…'),
    );
    void handlers
      .onRequestGraph(courseId)
      .then(loaded => {
        if (
          reqId !== graphSeq ||
          activeTab !== 'graph' ||
          activeCourse?.id !== courseId ||
          !host.isConnected
        ) {
          return;
        }
        currentGraph = loaded ?? null;
        graphCourseId = courseId;
        mountGraphPayload(host, currentGraph);
      })
      .catch(() => {
        if (reqId !== graphSeq || activeTab !== 'graph' || !host.isConnected) {
          return;
        }
        host.replaceChildren(
          renderEmptyState('图谱加载失败', '请稍后重试或切换回课程总览。'),
        );
      });
  }

  function renderActiveTab(): void {
    syncToolbarState();
    renderSubbar();
    if (activeTab === 'notes') {
      renderNotesTab();
    } else if (activeTab === 'overview') {
      renderOverviewTab();
    } else {
      renderGraphTab();
    }
  }

  function onWindowMessage(event: MessageEvent): void {
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') {
      return;
    }
    const msgType = String(data.type || '');
    if (!msgType) {
      return;
    }

    if (
      activeArtifactFrame &&
      activeArtifactFrame.contentWindow &&
      event.source === activeArtifactFrame.contentWindow
    ) {
      if (msgType === 'mp-iui-ready') {
        const extra = sessionArtifacts.find(a => a.id === activeArtifactId);
        if (extra) {
          const payload = buildArtifactPayload(extra, activeArtifactSandboxId);
          lastObservedTheme = payload.theme;
          activeArtifactFrame.contentWindow.postMessage(
            {type: 'mp-iui-init', ...payload},
            '*',
          );
        }
      }
      return;
    }

    if (
      !activeDocFrame ||
      !activeDocFrame.contentWindow ||
      event.source !== activeDocFrame.contentWindow
    ) {
      return;
    }

    if (msgType === 'mp-iui-ready') {
      postStudyDocInit(activeDocFrame.contentWindow);
      return;
    }

    if (!activeCourse) {
      return;
    }

    if (msgType === 'mp-xray-annotation') {
      const rawMark = (
        data.mark && typeof data.mark === 'object'
          ? data.mark
          : data.annotation && typeof data.annotation === 'object'
            ? data.annotation
            : data
      ) as Record<string, unknown>;
      const markId = String(rawMark.id || `mark-${Date.now()}`);
      const markType =
        rawMark.type && rawMark.type !== 'mp-xray-annotation'
          ? String(rawMark.type)
          : String(rawMark.kind || 'hl');
      const mark: LearnStudyAnnotation = {
        ...rawMark,
        id: markId,
        type: markType,
      };

      const list = activeCourse.livingArtifact.annotations;
      const existingIdx = list.findIndex(item => item.id === markId);
      if (existingIdx >= 0) {
        list[existingIdx] = mark;
      } else {
        list.push(mark);
      }
      renderSubbar();
      handlers?.onAnnotationAdded(mark, activeCourse.id);
      return;
    }

    if (msgType === 'mp-xray-sidechat') {
      const quote = String(
        data.quote || data.text || data.selection || '',
      ).trim();
      const section = String(
        data.section || data.sectionTitle || data.heading || '',
      ).trim();
      handlers?.onAskSelectionSideChat({
        quote,
        section,
        courseId: activeCourse.id,
      });
      return;
    }

    if (msgType === 'mp-xray-checkin-submit') {
      const raw = (
        data.payload && typeof data.payload === 'object' ? data.payload : data
      ) as Record<string, unknown>;
      const idxRaw = raw.selectedIndex;
      const selectedIndex =
        typeof idxRaw === 'number' && Number.isFinite(idxRaw) ? idxRaw : null;
      handlers?.onSubmitCheckin({
        id: String(raw.id || ''),
        prompt: String(raw.prompt || ''),
        selectedIndex,
        selectedLabel: String(raw.selectedLabel || ''),
        unsure: Boolean(raw.unsure),
        reasoningNote: String(raw.reasoningNote || ''),
        courseId: activeCourse.id,
      });
    }
  }

  function ensureMessageListener(): void {
    if (messageListenerBound || typeof window === 'undefined') {
      return;
    }
    messageListenerBound = true;
    window.addEventListener('message', onWindowMessage);
  }

  function handleThemeMutation(): void {
    if (!hostEl || !hostEl.isConnected) {
      themeObserver?.disconnect();
      return;
    }
    const nextTheme = currentThemeName();
    if (nextTheme === lastObservedTheme) {
      return;
    }
    lastObservedTheme = nextTheme;
    if (activeTab === 'notes' && activeDocFrame?.contentWindow) {
      postStudyDocInit(activeDocFrame.contentWindow);
    } else if (activeTab === 'notes' && activeArtifactFrame?.contentWindow) {
      const extra = sessionArtifacts.find(a => a.id === activeArtifactId);
      if (extra) {
        const payload = buildArtifactPayload(extra, activeArtifactSandboxId);
        activeArtifactFrame.contentWindow.postMessage(
          {type: 'mp-iui-init', ...payload},
          '*',
        );
      }
    }
  }

  function ensureThemeObserver(): void {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') {
      return;
    }
    if (!themeObserver) {
      themeObserver = new MutationObserver(() => handleThemeMutation());
    } else {
      themeObserver.disconnect();
    }
    if (document.documentElement) {
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-mode'],
      });
    }
    if (document.body) {
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-ds-dark-theme'],
      });
    }
  }

  function buildChrome(): void {
    if (!hostEl) {
      return;
    }
    rootEl = el('div', 'mp-lsa-root');

    const topbar = el('header', 'mp-lsa-topbar');
    const tabs = el('div', 'mp-lsa-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '学习台视图');

    tabButtons = new Map<StudyTab, HTMLButtonElement>();
    const defs: Array<{id: StudyTab; label: string}> = [
      {id: 'notes', label: '精读笔记'},
      {id: 'overview', label: '课程总览'},
      {id: 'graph', label: '神经图谱'},
    ];
    for (const def of defs) {
      const btn = el('button', 'mp-lsa-tab', def.label);
      btn.type = 'button';
      btn.dataset.tab = def.id;
      btn.setAttribute('role', 'tab');
      btn.addEventListener('click', () => setTab(def.id));
      tabButtons.set(def.id, btn);
      tabs.appendChild(btn);
    }

    const actions = el('div', 'mp-lsa-actions');

    penBtnEl = el('button', 'mp-lsa-btn', '✎ 标注');
    penBtnEl.type = 'button';
    penBtnEl.setAttribute('aria-pressed', penActive ? 'true' : 'false');
    penBtnEl.addEventListener('click', () => {
      togglePen();
    });

    dreamBtnEl = el('button', 'mp-lsa-btn', 'Dream · 反刍');
    dreamBtnEl.type = 'button';
    dreamBtnEl.addEventListener('click', () => {
      if (activeCourse) {
        triggerDreamRun(activeCourse.id);
      }
    });

    vaultBtnEl = el('button', 'mp-lsa-btn', '存入库');
    vaultBtnEl.type = 'button';
    vaultBtnEl.addEventListener('click', () => {
      if (!activeCourse || vaultSaving) {
        return;
      }
      vaultSaving = true;
      vaultSaved = false;
      syncToolbarState();
      Promise.resolve(handlers?.onSaveToVault?.(activeCourse))
        .then(() => {
          vaultSaved = true;
          if (vaultSavedTimer !== null) {
            clearTimeout(vaultSavedTimer);
          }
          vaultSavedTimer = setTimeout(() => {
            vaultSaved = false;
            syncToolbarState();
          }, 1800);
        })
        .catch(() => {
          /* caller handles save error */
        })
        .finally(() => {
          vaultSaving = false;
          syncToolbarState();
        });
    });

    actions.append(penBtnEl, dreamBtnEl, vaultBtnEl);
    topbar.append(tabs, actions);

    subbarEl = el('div', 'mp-lsa-subbar');
    subbarEl.hidden = true;

    bodyEl = el('div', 'mp-lsa-body');

    rootEl.append(topbar, subbarEl, bodyEl);
    hostEl.replaceChildren(rootEl);
  }

  function mount(
    nextHostEl: HTMLElement | null,
    state: {
      courses: LearnStudyCourseSummary[];
      activeCourse: LearnStudyCourse | null;
      graph?: NeuralGraphPayload | null;
      sessionArtifacts?: LearnStudySessionArtifact[];
      initialTab?: StudyTab;
    },
    nextHandlers: LearnStudyArtifactHandlers,
  ): void {
    destroyGraphInstance();
    clearIframeRefs();

    if (!nextHostEl) {
      hostEl = null;
      themeObserver?.disconnect();
      return;
    }

    hostEl = nextHostEl;
    handlers = nextHandlers;
    courses = Array.isArray(state.courses) ? [...state.courses] : [];
    activeCourse = state.activeCourse
      ? normalizeCourse(state.activeCourse)
      : null;
    currentGraph = state.graph ?? null;
    graphCourseId = state.graph && activeCourse ? activeCourse.id : '';
    sessionArtifacts = Array.isArray(state.sessionArtifacts)
      ? [...state.sessionArtifacts]
      : [];
    activeTab = state.initialTab || 'notes';
    activeArtifactId = '__living__';
    materialsExpanded = false;
    dreamRunning = false;
    vaultSaving = false;
    vaultSaved = false;
    lastObservedTheme = currentThemeName();

    ensureMessageListener();
    ensureThemeObserver();
    buildChrome();
    renderActiveTab();
  }

  function setTab(tab: StudyTab): void {
    if (tab !== 'notes' && tab !== 'overview' && tab !== 'graph') {
      return;
    }
    if (activeTab === tab && bodyEl && bodyEl.childElementCount > 0) {
      return;
    }
    activeTab = tab;
    renderActiveTab();
  }

  function updateCourse(
    course: LearnStudyCourse,
    graph?: NeuralGraphPayload | null,
  ): void {
    const prevCourseId = activeCourse?.id || '';
    const nextCourse = normalizeCourse(course);
    activeCourse = nextCourse;

    const summaryIdx = courses.findIndex(item => item.id === nextCourse.id);
    if (summaryIdx >= 0) {
      courses[summaryIdx] = {
        ...courses[summaryIdx],
        title: nextCourse.title,
        subtitle: nextCourse.subtitle,
      };
    }

    if (graph !== undefined) {
      currentGraph = graph;
      graphCourseId = nextCourse.id;
    } else if (prevCourseId !== nextCourse.id) {
      currentGraph = null;
      graphCourseId = '';
    }

    if (!hostEl) {
      return;
    }

    syncToolbarState();
    renderSubbar();

    if (activeTab === 'notes') {
      const htmlChanged =
        prevCourseId !== nextCourse.id ||
        lastDocHtml !== nextCourse.livingArtifact.html;
      if (activeArtifactId === '__living__' && !htmlChanged && activeDocFrame) {
        return;
      }
      renderNotesTab();
    } else if (activeTab === 'overview') {
      renderOverviewTab();
    } else {
      renderGraphTab();
    }
  }

  function togglePen(force?: boolean): boolean {
    const next = typeof force === 'boolean' ? force : !penActive;
    penActive = next;
    syncToolbarState();
    renderSubbar();
    postPenStateToFrame();
    return penActive;
  }

  function getPenActive(): boolean {
    return penActive;
  }

  const api: LearnStudyArtifactApi = {
    mount,
    setTab,
    updateCourse,
    togglePen,
    getPenActive,
  };

  globalThis.LearnStudyArtifact = api;
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})();
