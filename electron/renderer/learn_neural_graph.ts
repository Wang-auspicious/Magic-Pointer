'use strict';

interface NeuralGraphNodeData {
  id: string;
  label: string;
  group: 'course' | 'vault' | 'concept' | 'code' | 'stuck';
  status?: 'mastered' | 'current' | 'stuck' | 'locked';
  degree: number;
  sourcePath?: string;
  excerpt?: string;
  courseId?: string;
}

interface NeuralGraphEdgeData {
  source: string;
  target: string;
  kind: 'prereq' | 'wikilink' | 'cross-bridge' | 'tag';
  label?: string;
}

interface NeuralGraphPayload {
  nodes: NeuralGraphNodeData[];
  edges: NeuralGraphEdgeData[];
  stats: {
    totalNodes: number;
    courseNodes: number;
    vaultNodes: number;
    stuckNodes: number;
    crossLinks: number;
  };
}

interface NeuralGraphMountOptions {
  initialFilter?: 'all' | 'course' | 'vault' | 'stuck';
  onFocusInChat?: (node: NeuralGraphNodeData) => void;
  onAskSideChat?: (node: NeuralGraphNodeData) => void;
  onSelectNode?: (node: NeuralGraphNodeData) => void;
}

interface LearnNeuralGraphApi {
  mount(
    hostEl: HTMLElement | null,
    data: NeuralGraphPayload | null | undefined,
    options?: NeuralGraphMountOptions,
  ): {
    setFilter: (filter: 'all' | 'course' | 'vault' | 'stuck') => void;
    focusNode: (nodeId: string) => void;
    destroy: () => void;
  };
}

declare global {
  var LearnNeuralGraph: LearnNeuralGraphApi | undefined;
}

(() => {
  type FilterKind = 'all' | 'course' | 'vault' | 'stuck';

  interface SimNode {
    id: string;
    data: NeuralGraphNodeData;
    degree: number;
    radius: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    fx: number;
    fy: number;
  }

  interface SimEdge {
    sourceId: string;
    targetId: string;
    source: SimNode;
    target: SimNode;
    kind: NeuralGraphEdgeData['kind'];
    label?: string;
  }

  interface GraphPalette {
    bg: string;
    edgeNormal: string;
    edgeNormalRgb: string;
    edgeNormalBaseAlpha: number;
    edgeNormalHiAlpha: number;
    edgeCrossRgb: string;
    edgeCrossBaseAlpha: number;
    edgeCrossHiAlpha: number;
    masteredFill: string;
    currentFill: string;
    currentStroke: string;
    currentRing: string;
    stuckFill: string;
    stuckStroke: string;
    mutedFill: string;
    activeFill: string;
    selectRing: string;
    labelText: string;
    labelMuted: string;
    emptyText: string;
  }

  interface LabelBox {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }

  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  const REST_LENGTH = 95;
  const CROSS_REST_LENGTH = 110;
  const CENTER_GRAVITY = 0.018;
  const REPULSION = 2200;
  const MAX_REPULSION_DIST_SQ = 250000;
  const MIN_DIST_SQ = 64;
  const SPRING_K = 0.032;
  const DAMPING = 0.82;
  const MAX_STEP_SPEED = 18;
  const SLEEP_SPEED = 0.08;
  const MIN_SETTLE_TICKS = 10;
  const MAX_PHYSICS_TICKS = 160;
  const MIN_SCALE = 0.4;
  const MAX_SCALE = 2.5;
  const DRAG_CLICK_THRESHOLD = 4;
  const LABEL_FONT_BASE = '11.5px "anthropic-sans", "PingFang SC", sans-serif';
  const LABEL_FONT_STRONG =
    '600 11.5px "anthropic-sans", "PingFang SC", sans-serif';

  const FILTER_ITEMS: ReadonlyArray<{id: FilterKind; label: string}> = [
    {id: 'all', label: '全部'},
    {id: 'course', label: '当前课程'},
    {id: 'vault', label: 'Obsidian 库'},
    {id: 'stuck', label: '卡点'},
  ];

  const activeDestroyers = new WeakMap<HTMLElement, () => void>();

  function isDark(): boolean {
    if (typeof document === 'undefined') {
      return false;
    }
    const rootTheme = document.documentElement?.dataset?.theme;
    const bodyDark = document.body?.hasAttribute('data-ds-dark-theme') ?? false;
    return rootTheme === 'dark' || bodyDark;
  }

  function getPalette(dark: boolean): GraphPalette {
    if (dark) {
      return {
        bg: '#262624',
        edgeNormal: 'rgba(250,249,245,0.14)',
        edgeNormalRgb: '250,249,245',
        edgeNormalBaseAlpha: 0.14,
        edgeNormalHiAlpha: 0.65,
        edgeCrossRgb: '109,167,236',
        edgeCrossBaseAlpha: 0.45,
        edgeCrossHiAlpha: 0.9,
        masteredFill: '#FAF9F5',
        currentFill: '#262624',
        currentStroke: '#FAF9F5',
        currentRing: 'rgba(250,249,245,0.14)',
        stuckFill: '#30302E',
        stuckStroke: '#E06C6C',
        mutedFill: '#73726C',
        activeFill: '#FAF9F5',
        selectRing: 'rgba(250,249,245,0.48)',
        labelText: '#FAF9F5',
        labelMuted: '#C2C0B6',
        emptyText: '#9C9A92',
      };
    }
    return {
      bg: '#FAF9F5',
      edgeNormal: 'rgba(20,20,19,0.12)',
      edgeNormalRgb: '20,20,19',
      edgeNormalBaseAlpha: 0.12,
      edgeNormalHiAlpha: 0.62,
      edgeCrossRgb: '24,79,149',
      edgeCrossBaseAlpha: 0.42,
      edgeCrossHiAlpha: 0.9,
      masteredFill: '#141413',
      currentFill: '#FFFFFF',
      currentStroke: '#141413',
      currentRing: 'rgba(20,20,19,0.10)',
      stuckFill: '#FAF9F5',
      stuckStroke: '#991B1B',
      mutedFill: '#9E9C95',
      activeFill: '#141413',
      selectRing: 'rgba(20,20,19,0.42)',
      labelText: '#141413',
      labelMuted: '#3D3D3A',
      emptyText: '#73726C',
    };
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

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

  function matchesFilter(
    node: NeuralGraphNodeData,
    filter: FilterKind,
  ): boolean {
    if (filter === 'all') {
      return true;
    }
    if (filter === 'course') {
      return (
        node.group === 'course' ||
        node.group === 'concept' ||
        node.group === 'code' ||
        Boolean(node.courseId)
      );
    }
    if (filter === 'vault') {
      return node.group === 'vault';
    }
    return node.status === 'stuck' || node.group === 'stuck';
  }

  function getKindLabel(node: NeuralGraphNodeData): string {
    if (node.status === 'stuck' || node.group === 'stuck') {
      return '卡点';
    }
    if (node.status === 'current') {
      return '当前节点';
    }
    if (node.status === 'mastered') {
      return '已掌握';
    }
    if (node.group === 'vault') {
      return 'Obsidian 笔记';
    }
    return '课程资料';
  }

  function truncateLabel(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
      return text;
    }
    return `${text.slice(0, maxChars - 1)}…`;
  }

  function buildGraphModel(payload: NeuralGraphPayload | null | undefined): {
    nodes: SimNode[];
    edges: SimEdge[];
    nodeById: Map<string, SimNode>;
    neighbors: Map<string, Set<string>>;
    totalNodes: number;
    crossLinks: number;
  } {
    const rawNodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
    const rawEdges = Array.isArray(payload?.edges) ? payload.edges : [];
    const uniqueRawNodes: NeuralGraphNodeData[] = [];
    const seenIds = new Set<string>();

    for (const raw of rawNodes) {
      if (!raw || !raw.id || seenIds.has(raw.id)) {
        continue;
      }
      seenIds.add(raw.id);
      uniqueRawNodes.push(raw);
    }

    const neighbors = new Map<string, Set<string>>();
    for (const raw of uniqueRawNodes) {
      neighbors.set(raw.id, new Set<string>());
    }

    const validRawEdges: NeuralGraphEdgeData[] = [];
    let crossCount = 0;
    for (const edge of rawEdges) {
      if (!edge || !edge.source || !edge.target) {
        continue;
      }
      if (edge.source === edge.target) {
        continue;
      }
      if (!seenIds.has(edge.source) || !seenIds.has(edge.target)) {
        continue;
      }
      validRawEdges.push(edge);
      neighbors.get(edge.source)?.add(edge.target);
      neighbors.get(edge.target)?.add(edge.source);
      if (edge.kind === 'cross-bridge') {
        crossCount += 1;
      }
    }

    let hasVault = false;
    let hasNonVault = false;
    for (const raw of uniqueRawNodes) {
      if (raw.group === 'vault') {
        hasVault = true;
      } else {
        hasNonVault = true;
      }
    }
    const separateClusters = hasVault && hasNonVault;

    const simNodes: SimNode[] = [];
    const nodeById = new Map<string, SimNode>();
    let sumX = 0;
    let sumY = 0;

    for (let i = 0; i < uniqueRawNodes.length; i += 1) {
      const raw = uniqueRawNodes[i];
      const incidentCount = neighbors.get(raw.id)?.size ?? 0;
      const degree = Number.isFinite(raw.degree)
        ? Math.max(0, raw.degree)
        : incidentCount;
      const radius = 4.5 + Math.min(6, degree * 0.85);
      const angle = i * GOLDEN_ANGLE;
      const spiralDist = 22 + 26 * Math.sqrt(i + 1);
      const clusterShift = separateClusters
        ? raw.group === 'vault'
          ? 44
          : -28
        : 0;
      const x = Math.cos(angle) * spiralDist + clusterShift;
      const y = Math.sin(angle) * spiralDist;
      sumX += x;
      sumY += y;

      const simNode: SimNode = {
        id: raw.id,
        data: {...raw, degree},
        degree,
        radius,
        x,
        y,
        vx: 0,
        vy: 0,
        fx: 0,
        fy: 0,
      };
      simNodes.push(simNode);
      nodeById.set(raw.id, simNode);
    }

    if (simNodes.length > 0) {
      const meanX = sumX / simNodes.length;
      const meanY = sumY / simNodes.length;
      for (const node of simNodes) {
        node.x -= meanX;
        node.y -= meanY;
      }
    }

    const simEdges: SimEdge[] = [];
    for (const rawEdge of validRawEdges) {
      const source = nodeById.get(rawEdge.source);
      const target = nodeById.get(rawEdge.target);
      if (!source || !target) {
        continue;
      }
      simEdges.push({
        sourceId: rawEdge.source,
        targetId: rawEdge.target,
        source,
        target,
        kind: rawEdge.kind,
        label: rawEdge.label,
      });
    }

    const totalNodes =
      typeof payload?.stats?.totalNodes === 'number'
        ? payload.stats.totalNodes
        : simNodes.length;
    const crossLinks =
      typeof payload?.stats?.crossLinks === 'number'
        ? payload.stats.crossLinks
        : crossCount;

    return {
      nodes: simNodes,
      edges: simEdges,
      nodeById,
      neighbors,
      totalNodes,
      crossLinks,
    };
  }

  function mount(
    hostEl: HTMLElement | null,
    data: NeuralGraphPayload | null | undefined,
    options: NeuralGraphMountOptions = {},
  ): {
    setFilter: (filter: FilterKind) => void;
    focusNode: (nodeId: string) => void;
    destroy: () => void;
  } {
    if (!hostEl) {
      return {
        setFilter: () => {},
        focusNode: () => {},
        destroy: () => {},
      };
    }

    const prevDestroy = activeDestroyers.get(hostEl);
    if (prevDestroy) {
      prevDestroy();
    }

    const graph = buildGraphModel(data);
    const rawInitFilter = options.initialFilter;
    let currentFilter: FilterKind =
      rawInitFilter === 'course' ||
      rawInitFilter === 'vault' ||
      rawInitFilter === 'stuck' ||
      rawInitFilter === 'all'
        ? rawInitFilter
        : 'all';
    let visibleNodes: SimNode[] = [];
    let visibleEdges: SimEdge[] = [];
    let visibleSet = new Set<string>();
    let hubIds = new Set<string>();

    let selectedNodeId: string | null = null;
    let hoveredNodeId: string | null = null;
    let activeHoverId: string | null = null;
    let hoverBlend = 0;

    let panX = 0;
    let panY = 0;
    let scale = 1;
    let cssWidth = 0;
    let cssHeight = 0;
    let dpr = 1;

    let physicsTicks = 0;
    let physicsSleeping = false;
    let rafId: number | null = null;
    let destroyed = false;

    let dragMode: 'none' | 'pan' | 'node' = 'none';
    let dragNodeId: string | null = null;
    let downClientX = 0;
    let downClientY = 0;
    let panStartX = 0;
    let panStartY = 0;
    let hasDragged = false;

    const shell = el('div', 'mp-ng-shell');
    shell.style.position = 'relative';
    shell.style.width = '100%';
    shell.style.height = '100%';
    shell.style.minHeight = '420px';
    shell.style.overflow = 'hidden';

    const toolbar = el('div', 'mp-ng-toolbar');
    const filterButtons = new Map<FilterKind, HTMLButtonElement>();
    for (const item of FILTER_ITEMS) {
      const btn = el('button', 'mp-ng-filter', item.label);
      btn.type = 'button';
      btn.dataset.filter = item.id;
      btn.setAttribute('aria-pressed', item.id === currentFilter ? 'true' : 'false');
      if (item.id === currentFilter) {
        btn.classList.add('is-on');
      }
      btn.addEventListener('click', () => {
        setFilter(item.id);
      });
      filterButtons.set(item.id, btn);
      toolbar.appendChild(btn);
    }
    const statsEl = el('span', 'mp-ng-stats');
    toolbar.appendChild(statsEl);

    const zoomBar = el('div', 'mp-ng-zoom');
    const zoomInBtn = el('button', 'mp-ng-zoom-btn', '+');
    zoomInBtn.type = 'button';
    zoomInBtn.setAttribute('aria-label', '放大图谱');
    const zoomOutBtn = el('button', 'mp-ng-zoom-btn', '−');
    zoomOutBtn.type = 'button';
    zoomOutBtn.setAttribute('aria-label', '缩小图谱');
    const zoomResetBtn = el('button', 'mp-ng-zoom-btn', '重置');
    zoomResetBtn.type = 'button';
    zoomResetBtn.setAttribute('aria-label', '重置视图');
    zoomBar.append(zoomInBtn, zoomOutBtn, zoomResetBtn);

    const canvas = el('canvas', 'mp-ng-canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.cursor = 'grab';

    const inspectorEl = el('div', 'mp-ng-inspector');
    inspectorEl.hidden = true;
    inspectorEl.style.display = 'none';

    shell.append(canvas, toolbar, zoomBar, inspectorEl);
    hostEl.innerHTML = '';
    hostEl.appendChild(shell);

    const ctx = canvas.getContext('2d');

    function updateStatsText(): void {
      if (currentFilter === 'all') {
        statsEl.textContent = `${graph.totalNodes} 节点 · ${graph.crossLinks} 跨库连线`;
      } else {
        statsEl.textContent = `${visibleNodes.length}/${graph.totalNodes} 节点 · ${graph.crossLinks} 跨库连线`;
      }
    }

    function recomputeVisibleGraph(): void {
      visibleNodes = [];
      visibleSet = new Set<string>();
      for (const node of graph.nodes) {
        if (matchesFilter(node.data, currentFilter)) {
          visibleNodes.push(node);
          visibleSet.add(node.id);
        }
      }

      visibleEdges = [];
      for (const edge of graph.edges) {
        if (visibleSet.has(edge.sourceId) && visibleSet.has(edge.targetId)) {
          visibleEdges.push(edge);
        }
      }

      const sortedByDegree = [...visibleNodes].sort(
        (a, b) => b.degree - a.degree,
      );
      const maxHubs = Math.min(
        8,
        Math.max(3, Math.ceil(visibleNodes.length * 0.2)),
      );
      hubIds = new Set<string>();
      for (let i = 0; i < sortedByDegree.length && hubIds.size < maxHubs; i += 1) {
        if (sortedByDegree[i].degree >= 2 || sortedByDegree.length <= 6) {
          hubIds.add(sortedByDegree[i].id);
        }
      }

      if (selectedNodeId && !visibleSet.has(selectedNodeId)) {
        selectedNodeId = null;
        renderInspector(null);
      }
      if (hoveredNodeId && !visibleSet.has(hoveredNodeId)) {
        hoveredNodeId = null;
      }
      if (activeHoverId && !visibleSet.has(activeHoverId)) {
        activeHoverId = null;
        hoverBlend = 0;
      }

      updateStatsText();
    }

    function renderInspector(node: SimNode | null): void {
      inspectorEl.innerHTML = '';
      if (!node) {
        inspectorEl.hidden = true;
        inspectorEl.classList.remove('is-open');
        inspectorEl.style.display = 'none';
        return;
      }

      inspectorEl.hidden = false;
      inspectorEl.classList.add('is-open');
      inspectorEl.style.display = '';

      const head = el('div', 'mp-ng-insp-head');
      const titleWrap = el('div', 'mp-ng-insp-title-row');
      const titleEl = el('span', 'mp-ng-insp-title', node.data.label);
      const kindEl = el('span', 'mp-ng-insp-kind', getKindLabel(node.data));
      kindEl.dataset.kind =
        node.data.status === 'stuck' || node.data.group === 'stuck'
          ? 'stuck'
          : node.data.status === 'current'
            ? 'current'
            : node.data.status === 'mastered'
              ? 'mastered'
              : node.data.group;
      titleWrap.append(titleEl, kindEl);

      const closeBtn = el('button', 'mp-ng-insp-close', '×');
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', '关闭节点详情');
      closeBtn.addEventListener('click', () => {
        selectedNodeId = null;
        renderInspector(null);
        ensureAnimating();
      });
      head.append(titleWrap, closeBtn);
      inspectorEl.appendChild(head);

      if (node.data.sourcePath) {
        const pathEl = el('div', 'mp-ng-insp-path', node.data.sourcePath);
        pathEl.title = node.data.sourcePath;
        inspectorEl.appendChild(pathEl);
      }

      if (node.data.excerpt) {
        const excerptEl = el('p', 'mp-ng-insp-excerpt', node.data.excerpt);
        inspectorEl.appendChild(excerptEl);
      }

      const neighborIds = Array.from(graph.neighbors.get(node.id) ?? []);
      if (neighborIds.length > 0) {
        const neighborRow = el('div', 'mp-ng-insp-neighbors');
        const prefix = el('span', 'mp-ng-insp-neighbors-label', '关联节点');
        neighborRow.appendChild(prefix);

        const maxShown = Math.min(neighborIds.length, 8);
        for (let i = 0; i < maxShown; i += 1) {
          const neighbor = graph.nodeById.get(neighborIds[i]);
          if (!neighbor) {
            continue;
          }
          const pill = el('button', 'mp-ng-insp-neighbor', neighbor.data.label);
          pill.type = 'button';
          pill.addEventListener('click', () => {
            focusNode(neighbor.id);
          });
          neighborRow.appendChild(pill);
        }
        inspectorEl.appendChild(neighborRow);
      }

      const actions = el('div', 'mp-ng-insp-actions');
      const primaryBtn = el('button', 'mp-ng-act-primary', '带入主对话深学');
      primaryBtn.type = 'button';
      primaryBtn.addEventListener('click', () => {
        options.onFocusInChat?.(node.data);
      });

      const ghostBtn = el('button', 'mp-ng-act-ghost', '并排探讨追问');
      ghostBtn.type = 'button';
      ghostBtn.addEventListener('click', () => {
        options.onAskSideChat?.(node.data);
      });

      actions.append(primaryBtn, ghostBtn);
      inspectorEl.appendChild(actions);
    }

    function worldToScreen(wx: number, wy: number): {sx: number; sy: number} {
      return {
        sx: cssWidth / 2 + panX + wx * scale,
        sy: cssHeight / 2 + panY + wy * scale,
      };
    }

    function screenToWorld(sx: number, sy: number): {wx: number; wy: number} {
      return {
        wx: (sx - cssWidth / 2 - panX) / scale,
        wy: (sy - cssHeight / 2 - panY) / scale,
      };
    }

    function hitTest(wx: number, wy: number): SimNode | null {
      const scaleCompensation = 1 / Math.min(scale, 1);
      let bestNode: SimNode | null = null;
      let bestDistSq = Infinity;

      for (let i = visibleNodes.length - 1; i >= 0; i -= 1) {
        const node = visibleNodes[i];
        const hitR = Math.max(10, node.radius + 5) * scaleCompensation;
        const dx = wx - node.x;
        const dy = wy - node.y;
        const distSq = dx * dx + dy * dy;
        if (distSq <= hitR * hitR && distSq < bestDistSq) {
          bestDistSq = distSq;
          bestNode = node;
        }
      }
      return bestNode;
    }

    function syncCanvasSize(): boolean {
      const rect = shell.getBoundingClientRect();
      const rawW = rect.width || hostEl?.clientWidth || 0;
      const rawH = rect.height || hostEl?.clientHeight || 0;
      if (rawW <= 0 || rawH <= 0) {
        return false;
      }

      const nextW = Math.floor(rawW);
      const nextH = Math.floor(rawH);
      const nextDpr = clamp(window.devicePixelRatio || 1, 1, 3);
      const targetPixelW = Math.max(1, Math.floor(nextW * nextDpr));
      const targetPixelH = Math.max(1, Math.floor(nextH * nextDpr));

      cssWidth = nextW;
      cssHeight = nextH;
      dpr = nextDpr;

      if (canvas.width !== targetPixelW || canvas.height !== targetPixelH) {
        canvas.width = targetPixelW;
        canvas.height = targetPixelH;
      }
      return true;
    }

    function stepPhysics(): void {
      if (physicsSleeping || visibleNodes.length === 0) {
        return;
      }

      for (const node of visibleNodes) {
        node.fx = -node.x * CENTER_GRAVITY;
        node.fy = -node.y * CENTER_GRAVITY;
      }

      const count = visibleNodes.length;
      for (let i = 0; i < count; i += 1) {
        const a = visibleNodes[i];
        for (let j = i + 1; j < count; j += 1) {
          const b = visibleNodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const rawDistSq = dx * dx + dy * dy;
          if (rawDistSq > MAX_REPULSION_DIST_SQ) {
            continue;
          }
          const distSq = Math.max(rawDistSq, MIN_DIST_SQ);
          const dist = Math.sqrt(distSq);
          const force = REPULSION / distSq;
          const ux = dx / dist;
          const uy = dy / dist;
          const fx = ux * force;
          const fy = uy * force;
          a.fx -= fx;
          a.fy -= fy;
          b.fx += fx;
          b.fy += fy;
        }
      }

      for (const edge of visibleEdges) {
        const a = edge.source;
        const b = edge.target;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(0.01, Math.hypot(dx, dy));
        const rest =
          edge.kind === 'cross-bridge' ? CROSS_REST_LENGTH : REST_LENGTH;
        const force = (dist - rest) * SPRING_K;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.fx += fx;
        a.fy += fy;
        b.fx -= fx;
        b.fy -= fy;
      }

      let maxSpeed = 0;
      for (const node of visibleNodes) {
        if (dragMode === 'node' && dragNodeId === node.id) {
          node.vx = 0;
          node.vy = 0;
          continue;
        }
        let vx = (node.vx + node.fx) * DAMPING;
        let vy = (node.vy + node.fy) * DAMPING;
        const speed = Math.hypot(vx, vy);
        if (speed > MAX_STEP_SPEED) {
          const factor = MAX_STEP_SPEED / speed;
          vx *= factor;
          vy *= factor;
        }
        node.vx = vx;
        node.vy = vy;
        node.x += vx;
        node.y += vy;
        if (speed > maxSpeed) {
          maxSpeed = speed;
        }
      }

      physicsTicks += 1;
      if (
        physicsTicks >= MAX_PHYSICS_TICKS ||
        (physicsTicks >= MIN_SETTLE_TICKS && maxSpeed < SLEEP_SPEED)
      ) {
        physicsSleeping = true;
      }
    }

    function stepHoverAnimation(): boolean {
      if (hoveredNodeId !== null) {
        activeHoverId = hoveredNodeId;
      }
      const target = hoveredNodeId !== null ? 1 : 0;
      const diff = target - hoverBlend;
      if (Math.abs(diff) <= 0.01) {
        hoverBlend = target;
        if (hoverBlend === 0 && hoveredNodeId === null) {
          activeHoverId = null;
        }
        return false;
      }
      hoverBlend += diff * 0.25;
      return true;
    }

    function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
      const pad = 4;
      return !(
        a.x2 + pad < b.x1 ||
        a.x1 - pad > b.x2 ||
        a.y2 + pad < b.y1 ||
        a.y1 - pad > b.y2
      );
    }

    function draw(): void {
      if (!ctx) {
        return;
      }
      if (cssWidth <= 0 || cssHeight <= 0) {
        if (!syncCanvasSize()) {
          return;
        }
      }

      const palette = getPalette(isDark());
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      ctx.fillStyle = palette.bg;
      ctx.fillRect(0, 0, cssWidth, cssHeight);

      if (visibleNodes.length === 0) {
        ctx.font = LABEL_FONT_BASE;
        ctx.fillStyle = palette.emptyText;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const emptyMsg =
          graph.nodes.length === 0
            ? '暂无知识图谱节点'
            : '当前筛选下暂无节点';
        ctx.fillText(emptyMsg, cssWidth / 2, cssHeight / 2);
        return;
      }

      const hoverActive = activeHoverId !== null && hoverBlend > 0.005;
      const hoverNeighborSet = new Set<string>();
      if (activeHoverId) {
        hoverNeighborSet.add(activeHoverId);
        const adj = graph.neighbors.get(activeHoverId);
        if (adj) {
          for (const nid of adj) {
            hoverNeighborSet.add(nid);
          }
        }
      }

      for (const edge of visibleEdges) {
        const isOneHop =
          hoverActive &&
          (edge.sourceId === activeHoverId || edge.targetId === activeHoverId);
        const p1 = worldToScreen(edge.source.x, edge.source.y);
        const p2 = worldToScreen(edge.target.x, edge.target.y);

        ctx.beginPath();
        ctx.moveTo(p1.sx, p1.sy);
        ctx.lineTo(p2.sx, p2.sy);

        if (hoverActive && !isOneHop) {
          ctx.globalAlpha = lerp(1, 0.12, hoverBlend);
        } else {
          ctx.globalAlpha = 1;
        }

        if (edge.kind === 'cross-bridge') {
          const alpha = isOneHop
            ? lerp(
                palette.edgeCrossBaseAlpha,
                palette.edgeCrossHiAlpha,
                hoverBlend,
              )
            : palette.edgeCrossBaseAlpha;
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = isOneHop ? 1.4 : 1.1;
          ctx.strokeStyle = `rgba(${palette.edgeCrossRgb},${alpha.toFixed(3)})`;
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          const alpha = isOneHop
            ? lerp(
                palette.edgeNormalBaseAlpha,
                palette.edgeNormalHiAlpha,
                hoverBlend,
              )
            : palette.edgeNormalBaseAlpha;
          ctx.lineWidth = isOneHop ? 1.25 : 1;
          ctx.strokeStyle = `rgba(${palette.edgeNormalRgb},${alpha.toFixed(3)})`;
          ctx.stroke();
        }
      }

      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      for (const node of visibleNodes) {
        const {sx, sy} = worldToScreen(node.x, node.y);
        const r = node.radius * clamp(Math.sqrt(scale), 0.78, 1.35);
        const isHovered = node.id === hoveredNodeId;
        const isSelected = node.id === selectedNodeId;
        const isInHoverCluster = !hoverActive || hoverNeighborSet.has(node.id);
        const status = node.data.status;
        const group = node.data.group;

        ctx.globalAlpha = isInHoverCluster ? 1 : lerp(1, 0.18, hoverBlend);

        if (status === 'current') {
          ctx.beginPath();
          ctx.arc(sx, sy, r + 4.5, 0, Math.PI * 2);
          ctx.fillStyle = palette.currentRing;
          ctx.fill();

          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          ctx.fillStyle = palette.currentFill;
          ctx.fill();
          ctx.lineWidth = 2.2;
          ctx.strokeStyle = palette.currentStroke;
          ctx.stroke();
        } else if (status === 'stuck' || group === 'stuck') {
          ctx.save();
          ctx.beginPath();
          ctx.setLineDash([3, 2.5]);
          ctx.arc(sx, sy, r + 4.2, 0, Math.PI * 2);
          ctx.lineWidth = 1.1;
          ctx.strokeStyle = palette.stuckStroke;
          ctx.stroke();
          ctx.restore();

          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          ctx.fillStyle = palette.stuckFill;
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = palette.stuckStroke;
          ctx.stroke();
        } else if (status === 'mastered') {
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          ctx.fillStyle = palette.masteredFill;
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          ctx.fillStyle =
            isHovered || isSelected ? palette.activeFill : palette.mutedFill;
          ctx.fill();
        }

        if (isSelected || isHovered) {
          ctx.beginPath();
          ctx.arc(sx, sy, r + 3.2, 0, Math.PI * 2);
          ctx.lineWidth = isSelected ? 1.4 : 1.1;
          ctx.strokeStyle = palette.selectRing;
          ctx.stroke();
        }
      }

      const drawnBoxes: LabelBox[] = [];
      const hubZoomFade = scale > 0.75 ? clamp((scale - 0.75) / 0.35, 0, 1) : 0;
      const prioritized: Array<{node: SimNode; priority: number; fade: number}> =
        [];

      for (const node of visibleNodes) {
        const isHovered = node.id === hoveredNodeId;
        const isSelected = node.id === selectedNodeId;
        const isHoverNeighbor =
          hoverActive &&
          node.id !== activeHoverId &&
          hoverNeighborSet.has(node.id);
        const isCurrentOrStuck =
          node.data.status === 'current' ||
          node.data.status === 'stuck' ||
          node.data.group === 'stuck';
        const isHub = hubIds.has(node.id) && hubZoomFade > 0.02;

        if (isHovered) {
          prioritized.push({node, priority: 4, fade: 1});
        } else if (isSelected) {
          prioritized.push({node, priority: 3, fade: 1});
        } else if (isHoverNeighbor) {
          prioritized.push({node, priority: 2, fade: hoverBlend});
        } else if (isCurrentOrStuck) {
          const dimFade = hoverActive ? lerp(1, 0.18, hoverBlend) : 1;
          prioritized.push({node, priority: 1, fade: dimFade});
        } else if (isHub) {
          const dimFade = hoverActive
            ? lerp(hubZoomFade, 0.15, hoverBlend)
            : hubZoomFade;
          prioritized.push({node, priority: 0, fade: dimFade});
        }
      }

      prioritized.sort((a, b) => {
        if (b.priority !== a.priority) {
          return b.priority - a.priority;
        }
        return b.node.degree - a.node.degree;
      });

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      for (const entry of prioritized) {
        if (entry.fade <= 0.03) {
          continue;
        }
        const node = entry.node;
        const {sx, sy} = worldToScreen(node.x, node.y);
        const r = node.radius * clamp(Math.sqrt(scale), 0.78, 1.35);
        const text = truncateLabel(node.data.label, 20);
        const isStrong = entry.priority >= 2;

        ctx.font = isStrong ? LABEL_FONT_STRONG : LABEL_FONT_BASE;
        const textW = ctx.measureText(text).width;
        const labelX = sx;
        const labelY = sy + r + 11;
        const box: LabelBox = {
          x1: labelX - textW / 2,
          y1: labelY - 7,
          x2: labelX + textW / 2,
          y2: labelY + 7,
        };

        if (entry.priority < 2) {
          let overlaps = false;
          for (const prev of drawnBoxes) {
            if (boxesOverlap(box, prev)) {
              overlaps = true;
              break;
            }
          }
          if (overlaps) {
            continue;
          }
        }
        drawnBoxes.push(box);

        ctx.globalAlpha = entry.fade;
        ctx.lineWidth = 3.2;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = palette.bg;
        ctx.strokeText(text, labelX, labelY);

        ctx.fillStyle = isStrong ? palette.labelText : palette.labelMuted;
        ctx.fillText(text, labelX, labelY);
      }

      ctx.globalAlpha = 1;
    }

    function frame(): void {
      rafId = null;
      if (destroyed) {
        return;
      }

      stepPhysics();
      const hoverAnimating = stepHoverAnimation();
      draw();

      if (!physicsSleeping || hoverAnimating) {
        scheduleFrame();
      }
    }

    function scheduleFrame(): void {
      if (destroyed || rafId !== null) {
        return;
      }
      if (typeof requestAnimationFrame === 'function') {
        rafId = requestAnimationFrame(frame);
      } else {
        draw();
      }
    }

    function ensureAnimating(): void {
      scheduleFrame();
    }

    function wakePhysics(): void {
      physicsSleeping = false;
      physicsTicks = 0;
      scheduleFrame();
    }

    function setFilter(filter: FilterKind): void {
      if (destroyed) {
        return;
      }
      currentFilter = filter;
      for (const [id, btn] of filterButtons.entries()) {
        const active = id === filter;
        btn.classList.toggle('is-on', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
      panX = 0;
      panY = 0;
      recomputeVisibleGraph();
      wakePhysics();
    }

    function focusNode(nodeId: string): void {
      if (destroyed) {
        return;
      }
      const target = graph.nodeById.get(nodeId);
      if (!target) {
        return;
      }
      if (!visibleSet.has(nodeId)) {
        setFilter('all');
      }
      if (scale < 1) {
        scale = 1.05;
      }
      panX = -target.x * scale;
      panY = -target.y * scale;
      selectedNodeId = target.id;
      renderInspector(target);
      options.onSelectNode?.(target.data);
      ensureAnimating();
    }

    function zoomAround(sx: number, sy: number, factor: number): void {
      if (cssWidth <= 0 || cssHeight <= 0) {
        syncCanvasSize();
      }
      const before = screenToWorld(sx, sy);
      const nextScale = clamp(scale * factor, MIN_SCALE, MAX_SCALE);
      if (nextScale === scale) {
        return;
      }
      scale = nextScale;
      panX = sx - cssWidth / 2 - before.wx * scale;
      panY = sy - cssHeight / 2 - before.wy * scale;
      ensureAnimating();
    }

    function getCanvasPoint(e: PointerEvent | WheelEvent): {
      sx: number;
      sy: number;
    } {
      const rect = canvas.getBoundingClientRect();
      return {
        sx: e.clientX - rect.left,
        sy: e.clientY - rect.top,
      };
    }

    function onPointerDown(e: PointerEvent): void {
      if (destroyed || e.button !== 0) {
        return;
      }
      if (cssWidth <= 0 || cssHeight <= 0) {
        syncCanvasSize();
      }
      const {sx, sy} = getCanvasPoint(e);
      const {wx, wy} = screenToWorld(sx, sy);
      const hit = hitTest(wx, wy);

      downClientX = e.clientX;
      downClientY = e.clientY;
      hasDragged = false;

      if (hit) {
        dragMode = 'node';
        dragNodeId = hit.id;
      } else {
        dragMode = 'pan';
        dragNodeId = null;
        panStartX = panX;
        panStartY = panY;
      }
      canvas.style.cursor = 'grabbing';
    }

    function onCanvasPointerMove(e: PointerEvent): void {
      if (destroyed || dragMode !== 'none') {
        return;
      }
      if (cssWidth <= 0 || cssHeight <= 0) {
        syncCanvasSize();
      }
      const {sx, sy} = getCanvasPoint(e);
      const {wx, wy} = screenToWorld(sx, sy);
      const hit = hitTest(wx, wy);
      const nextHoverId = hit ? hit.id : null;
      canvas.style.cursor = hit ? 'pointer' : 'grab';

      if (nextHoverId !== hoveredNodeId) {
        hoveredNodeId = nextHoverId;
        ensureAnimating();
      }
    }

    function onWindowPointerMove(e: PointerEvent): void {
      if (destroyed || dragMode === 'none') {
        return;
      }
      const dx = e.clientX - downClientX;
      const dy = e.clientY - downClientY;
      if (!hasDragged && Math.hypot(dx, dy) >= DRAG_CLICK_THRESHOLD) {
        hasDragged = true;
      }

      if (dragMode === 'node' && dragNodeId) {
        if (!hasDragged) {
          return;
        }
        const dragged = graph.nodeById.get(dragNodeId);
        if (!dragged) {
          return;
        }
        const {sx, sy} = getCanvasPoint(e);
        const {wx, wy} = screenToWorld(sx, sy);
        dragged.x = wx;
        dragged.y = wy;
        dragged.vx = 0;
        dragged.vy = 0;
        wakePhysics();
        return;
      }

      if (dragMode === 'pan' && hasDragged) {
        panX = panStartX + dx;
        panY = panStartY + dy;
        ensureAnimating();
      }
    }

    function onWindowPointerUp(): void {
      if (destroyed || dragMode === 'none') {
        return;
      }
      const finishedMode = dragMode;
      const finishedNodeId = dragNodeId;
      const wasDrag = hasDragged;

      dragMode = 'none';
      dragNodeId = null;
      hasDragged = false;
      canvas.style.cursor = hoveredNodeId ? 'pointer' : 'grab';

      if (finishedMode === 'node' && finishedNodeId) {
        const node = graph.nodeById.get(finishedNodeId) ?? null;
        if (!wasDrag && node) {
          selectedNodeId = node.id;
          renderInspector(node);
          options.onSelectNode?.(node.data);
          ensureAnimating();
        } else if (wasDrag) {
          wakePhysics();
        }
      } else if (finishedMode === 'pan' && !wasDrag) {
        if (selectedNodeId !== null) {
          selectedNodeId = null;
          renderInspector(null);
          ensureAnimating();
        }
      }
    }

    function onPointerLeave(): void {
      if (destroyed || dragMode !== 'none') {
        return;
      }
      if (hoveredNodeId !== null) {
        hoveredNodeId = null;
        canvas.style.cursor = 'grab';
        ensureAnimating();
      }
    }

    function onWheel(e: WheelEvent): void {
      if (destroyed) {
        return;
      }
      e.preventDefault();
      const {sx, sy} = getCanvasPoint(e);
      const factor = Math.exp(-e.deltaY * 0.0014);
      zoomAround(sx, sy, factor);
    }

    function onZoomIn(): void {
      if (cssWidth <= 0 || cssHeight <= 0) {
        syncCanvasSize();
      }
      zoomAround(cssWidth / 2, cssHeight / 2, 1.22);
    }

    function onZoomOut(): void {
      if (cssWidth <= 0 || cssHeight <= 0) {
        syncCanvasSize();
      }
      zoomAround(cssWidth / 2, cssHeight / 2, 1 / 1.22);
    }

    function onZoomReset(): void {
      panX = 0;
      panY = 0;
      scale = 1;
      ensureAnimating();
    }

    function onResize(): void {
      if (destroyed) {
        return;
      }
      if (syncCanvasSize()) {
        ensureAnimating();
      }
    }

    zoomInBtn.addEventListener('click', onZoomIn);
    zoomOutBtn.addEventListener('click', onZoomOut);
    zoomResetBtn.addEventListener('click', onZoomReset);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onCanvasPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, {passive: false});
    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerUp);

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        onResize();
      });
      resizeObserver.observe(shell);
    } else {
      window.addEventListener('resize', onResize);
    }

    let themeObserver: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined') {
      themeObserver = new MutationObserver(() => {
        if (!destroyed) {
          ensureAnimating();
        }
      });
      if (document.documentElement) {
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-theme'],
        });
      }
      if (document.body) {
        themeObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['data-ds-dark-theme'],
        });
      }
    }

    function destroy(): void {
      if (destroyed) {
        return;
      }
      destroyed = true;
      if (rafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      if (!resizeObserver) {
        window.removeEventListener('resize', onResize);
      }
      zoomInBtn.removeEventListener('click', onZoomIn);
      zoomOutBtn.removeEventListener('click', onZoomOut);
      zoomResetBtn.removeEventListener('click', onZoomReset);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onCanvasPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowPointerUp);
      if (shell.parentNode === hostEl) {
        hostEl?.removeChild(shell);
      }
      if (hostEl && activeDestroyers.get(hostEl) === destroy) {
        activeDestroyers.delete(hostEl);
      }
    }

    activeDestroyers.set(hostEl, destroy);
    recomputeVisibleGraph();
    const defaultNode =
      visibleNodes.find(n => n.data.status === 'stuck' || n.data.group === 'stuck') ||
      visibleNodes.find(n => n.data.status === 'current') ||
      visibleNodes[0] ||
      null;
    if (defaultNode) {
      selectedNodeId = defaultNode.id;
      renderInspector(defaultNode);
    }
    syncCanvasSize();
    wakePhysics();

    return {
      setFilter,
      focusNode,
      destroy,
    };
  }

  const api: LearnNeuralGraphApi = {
    mount,
  };

  globalThis.LearnNeuralGraph = api;
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})();
