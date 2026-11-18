'use strict';

interface ConceptMapNode {
  id: string;
  turnIndex: number;
  blockIndex: number;
  role: string;
  title: string;
  summary: string;
  formula?: string;
  terms: Array<{term: string; gloss: string}>;
  highlights: string[];
  status: 'unseen' | 'explored' | 'questioned' | 'verified' | 'gap';
  branchIds: string[];
  priority: '' | 'P1' | 'P2' | 'P3';
  prereqLabels: string[];
  attempts: number;
  note?: string;
}

interface ConceptMapEdge {
  from?: string;
  to?: string;
  kind?: string;
  fromId?: string;
  toId?: string;
  relation?: string;
}

interface ConceptMapTopology {
  nodes: ConceptMapNode[];
  edges: ConceptMapEdge[];
  prereqChains: string[][];
  summary: {
    total: number;
    verified: number;
    questioned: number;
    gap: number;
    explored: number;
  };
}

interface LearnMapRenderOptions {
  activeFilter?: 'all' | 'unmastered' | 'p1';
  selectedNodeId?: string;
  onSelectNode?: (node: ConceptMapNode) => void;
  onJumpToBlock?: (node: ConceptMapNode) => void;
  onAskNode?: (node: ConceptMapNode) => void;
  onQuizNode?: (node: ConceptMapNode) => void;
  onSetMastery?: (node: ConceptMapNode, status: 'verified' | 'gap') => void;
}

interface LearnMapApi {
  layoutTopology(
    topology: ConceptMapTopology | null | undefined,
    filter?: 'all' | 'unmastered' | 'p1',
  ): {
    nodes: Array<
      ConceptMapNode & {
        layer: number;
        lane: number;
        x: number;
        y: number;
        w: number;
        h: number;
      }
    >;
    edges: Array<
      ConceptMapEdge & {
        d: string;
      }
    >;
    width: number;
    height: number;
  };
  renderMap(
    hostEl: HTMLElement | null,
    topology: ConceptMapTopology | null | undefined,
    options?: LearnMapRenderOptions,
  ): void;
}

declare global {
  var LearnMapView: LearnMapApi | undefined;
}

(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';

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

  function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      node.setAttribute(k, String(v));
    }
    return node;
  }

  function statusLabel(status: ConceptMapNode['status']): string {
    switch (status) {
      case 'verified':
        return '已掌握';
      case 'gap':
        return '待补盲区';
      case 'questioned':
        return '追问中';
      case 'explored':
        return '已展开';
      default:
        return '未检查';
    }
  }

  function roleLabel(role: ConceptMapNode['role']): string {
    switch (role) {
      case 'prereq':
      case 'prerequisite':
        return '前置';
      case 'formula':
        return '公式';
      case 'lab':
        return '实验';
      case 'conclusion':
        return '结论';
      case 'concept':
        return '核心';
      case 'mechanism':
        return '推导';
      case 'compare':
        return '对比';
      case 'trap':
        return '陷阱';
      default:
        return '步骤';
    }
  }

  function normEdge(e: ConceptMapEdge): {from: string; to: string; kind: string} {
    return {
      from: String(e.fromId || e.from || ''),
      to: String(e.toId || e.to || ''),
      kind: String(e.relation || e.kind || 'follows'),
    };
  }

  function filterNodes(
    nodes: ConceptMapNode[],
    filter: 'all' | 'unmastered' | 'p1',
  ): ConceptMapNode[] {
    if (filter === 'unmastered') {
      return nodes.filter(n => n.status !== 'verified');
    }
    if (filter === 'p1') {
      return nodes.filter(
        n => n.priority === 'P1' || n.status === 'gap',
      );
    }
    return nodes;
  }

  function layoutTopology(
    topology: ConceptMapTopology | null | undefined,
    filter: 'all' | 'unmastered' | 'p1' = 'all',
  ) {
    const rawNodes = topology?.nodes || [];
    const nodes = filterNodes(rawNodes, filter);
    const visibleIds = new Set(nodes.map(n => n.id));
    const edges = (topology?.edges || [])
      .map(normEdge)
      .filter(e => visibleIds.has(e.from) && visibleIds.has(e.to));

    const layerById = new Map<string, number>();
    const incoming = new Map<string, string[]>();
    for (const n of nodes) {
      incoming.set(n.id, []);
      layerById.set(
        n.id,
        n.role === 'prereq' || n.role === 'prerequisite' ? 0 : 1,
      );
    }
    for (const e of edges) {
      incoming.get(e.to)?.push(e.from);
    }
    // Relax layers in topological direction (bounded passes prevent cycles).
    for (let pass = 0; pass < Math.max(1, nodes.length); pass++) {
      let changed = false;
      for (const e of edges) {
        const fromL = layerById.get(e.from) ?? 0;
        const toL = layerById.get(e.to) ?? 0;
        if (toL <= fromL) {
          layerById.set(e.to, fromL + 1);
          changed = true;
        }
      }
      if (!changed) {
        break;
      }
    }

    const byLayer = new Map<number, ConceptMapNode[]>();
    for (const n of nodes) {
      const l = layerById.get(n.id) ?? 0;
      if (!byLayer.has(l)) {
        byLayer.set(l, []);
      }
      byLayer.get(l)!.push(n);
    }
    const sortedLayers = [...byLayer.keys()].sort((a, b) => a - b);
    const nodeW = 148;
    const nodeH = 44;
    const colGap = 28;
    const rowGap = 24;
    const padX = 16;
    const padY = 14;
    const maxLanes = Math.max(
      1,
      ...sortedLayers.map(l => byLayer.get(l)!.length),
    );
    const canvasW = Math.max(
      340,
      padX * 2 + maxLanes * nodeW + Math.max(0, maxLanes - 1) * colGap,
    );

    const laidOut: Array<
      ConceptMapNode & {
        layer: number;
        lane: number;
        x: number;
        y: number;
        w: number;
        h: number;
      }
    > = [];
    const posById = new Map<string, {x: number; y: number; w: number; h: number}>();

    sortedLayers.forEach((layerNum, layerIdx) => {
      const group = byLayer.get(layerNum) || [];
      const rowWidth =
        group.length * nodeW + Math.max(0, group.length - 1) * colGap;
      const startX = Math.max(padX, Math.round((canvasW - rowWidth) / 2));
      const y = padY + layerIdx * (nodeH + rowGap);
      group.forEach((n, laneIdx) => {
        const x = startX + laneIdx * (nodeW + colGap);
        const rec = {
          ...n,
          layer: layerIdx,
          lane: laneIdx,
          x,
          y,
          w: nodeW,
          h: nodeH,
        };
        laidOut.push(rec);
        posById.set(n.id, rec);
      });
    });

    const laidOutEdges: Array<ConceptMapEdge & {d: string}> = [];
    for (const e of edges) {
      const fromPos = posById.get(e.from);
      const toPos = posById.get(e.to);
      if (!fromPos || !toPos) {
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
          : `M ${x1} ${y1} Q ${(x1 + x2) / 2 + 24} ${midY} ${x2} ${y2}`;
      laidOutEdges.push({...e, d});
    }

    const height = Math.max(
      140,
      padY * 2 +
        sortedLayers.length * nodeH +
        Math.max(0, sortedLayers.length - 1) * rowGap,
    );

    return {
      nodes: laidOut,
      edges: laidOutEdges,
      width: canvasW,
      height,
    };
  }

  function renderMap(
    hostEl: HTMLElement | null,
    topology: ConceptMapTopology | null | undefined,
    options: LearnMapRenderOptions = {},
  ): void {
    if (!hostEl) {
      return;
    }
    let activeFilter: 'all' | 'unmastered' | 'p1' =
      options.activeFilter || 'all';
    let selectedId =
      options.selectedNodeId || topology?.nodes?.[0]?.id || '';

    const paint = () => {
      hostEl.replaceChildren();
      const wrap = el('div', 'mp-learn-map');

      const allNodes = topology?.nodes || [];
      if (!allNodes.length) {
        wrap.appendChild(
          el(
            'div',
            'mp-learn-deck-empty',
            '当前会话尚无可提取的概念拓扑，发送一个学习问题后将自动生成依赖图谱。',
          ),
        );
        hostEl.appendChild(wrap);
        return;
      }

      const bar = el('div', 'mp-learn-map-toolbar');
      const filters: ReadonlyArray<{
        id: 'all' | 'unmastered' | 'p1';
        label: string;
      }> = [
        {id: 'all', label: `全部 (${allNodes.length})`},
        {
          id: 'unmastered',
          label: `未掌握 (${allNodes.filter(n => n.status !== 'verified').length})`,
        },
        {
          id: 'p1',
          label: `P1 优先 (${allNodes.filter(n => n.priority === 'P1' || n.status === 'gap').length})`,
        },
      ];
      for (const f of filters) {
        const btn = el('button', 'mp-learn-map-filter', f.label);
        btn.type = 'button';
        if (activeFilter === f.id) {
          btn.classList.add('is-on');
        }
        btn.setAttribute('aria-pressed', String(activeFilter === f.id));
        btn.addEventListener('click', () => {
          activeFilter = f.id;
          paint();
        });
        bar.appendChild(btn);
      }
      wrap.appendChild(bar);

      const layout = layoutTopology(topology, activeFilter);
      if (!layout.nodes.some(n => n.id === selectedId)) {
        selectedId = layout.nodes[0]?.id || '';
      }

      if (!layout.nodes.length) {
        wrap.appendChild(
          el(
            'div',
            'mp-learn-deck-empty',
            '当前筛选条件下暂无概念节点，试试切换回「全部」。',
          ),
        );
        hostEl.appendChild(wrap);
        return;
      }

      const stage = el('div', 'mp-learn-map-stage');
      if (stage.style) {
        stage.style.minHeight = `${layout.height}px`;
      }
      const svg = svgEl('svg', {
        class: 'mp-learn-map-svg',
        viewBox: `0 0 ${layout.width} ${layout.height}`,
        width: layout.width,
        height: layout.height,
        'aria-label': '概念依赖拓扑图',
      });
      const defs = svgEl('defs', {});
      const marker = svgEl('marker', {
        id: 'mp-dag-arrow',
        viewBox: '0 0 10 10',
        refX: '8',
        refY: '5',
        markerWidth: '6',
        markerHeight: '6',
        orient: 'auto-start-reverse',
      });
      marker.appendChild(
        svgEl('path', {
          d: 'M 0 1.5 L 8.5 5 L 0 8.5 z',
          fill: 'currentColor',
        }),
      );
      defs.appendChild(marker);
      svg.appendChild(defs);

      for (const edge of layout.edges) {
        const isHighlighted =
          selectedId && (edge.from === selectedId || edge.to === selectedId);
        svg.appendChild(
          svgEl('path', {
            class: `mp-learn-map-edge is-${edge.kind}${isHighlighted ? ' is-active' : ''}`,
            d: edge.d,
            fill: 'none',
            'stroke-width': isHighlighted ? '2' : '1.4',
            'marker-end': 'url(#mp-dag-arrow)',
          }),
        );
      }
      stage.appendChild(svg);

      const canvas = el('div', 'mp-learn-map-nodes');
      if (canvas.style) {
        canvas.style.width = `${layout.width}px`;
        canvas.style.height = `${layout.height}px`;
      }
      for (const node of layout.nodes) {
        const btn = el('button', `mp-learn-map-node is-status-${node.status}`);
        btn.type = 'button';
        btn.dataset.nodeId = node.id;
        if (node.id === selectedId) {
          btn.classList.add('is-selected');
        }
        if (btn.style) {
          btn.style.left = `${node.x}px`;
          btn.style.top = `${node.y}px`;
          btn.style.width = `${node.w}px`;
          btn.style.height = `${node.h}px`;
        }
        const topRow = el('span', 'mp-learn-map-node-meta');
        topRow.appendChild(el('span', 'mp-learn-map-node-role', roleLabel(node.role)));
        if (node.priority) {
          topRow.appendChild(
            el('span', `mp-learn-map-node-pri is-${node.priority.toLowerCase()}`, node.priority),
          );
        }
        const dot = el('span', 'mp-learn-map-node-dot');
        topRow.appendChild(dot);
        btn.appendChild(topRow);
        btn.appendChild(el('span', 'mp-learn-map-node-title', node.title));
        btn.addEventListener('click', () => {
          selectedId = node.id;
          options.onSelectNode?.(node);
          options.onJumpToBlock?.(node);
          paint();
        });
        canvas.appendChild(btn);
      }
      stage.appendChild(canvas);
      wrap.appendChild(stage);

      const selectedNode = layout.nodes.find(n => n.id === selectedId);
      if (selectedNode) {
        const detail = el('div', 'mp-learn-map-detail');
        const detailHead = el('div', 'mp-learn-map-detail-head');
        detailHead.appendChild(
          el('strong', 'mp-learn-map-detail-title', selectedNode.title),
        );
        detailHead.appendChild(
          el(
            'span',
            `mp-learn-map-detail-status is-status-${selectedNode.status}`,
            statusLabel(selectedNode.status),
          ),
        );
        detail.appendChild(detailHead);

        if (selectedNode.prereqLabels.length) {
          detail.appendChild(
            el(
              'div',
              'mp-learn-map-detail-line',
              `前置基础：${selectedNode.prereqLabels.join(' · ')}`,
            ),
          );
        }
        if (selectedNode.summary) {
          detail.appendChild(
            el('p', 'mp-learn-map-detail-summary', selectedNode.summary),
          );
        }

        const actions = el('div', 'mp-learn-map-detail-actions');
        const jumpBtn = el('button', 'mp-learn-map-act', '回原文');
        jumpBtn.type = 'button';
        jumpBtn.addEventListener('click', () =>
          options.onJumpToBlock?.(selectedNode),
        );

        const askBtn = el('button', 'mp-learn-map-act', '追问');
        askBtn.type = 'button';
        askBtn.addEventListener('click', () =>
          options.onAskNode?.(selectedNode),
        );

        const quizBtn = el('button', 'mp-learn-map-act', '防错测验');
        quizBtn.type = 'button';
        quizBtn.addEventListener('click', () =>
          options.onQuizNode?.(selectedNode),
        );

        const verifyBtn = el('button', 'mp-learn-map-act is-ok', '已掌握');
        verifyBtn.type = 'button';
        verifyBtn.addEventListener('click', () =>
          options.onSetMastery?.(selectedNode, 'verified'),
        );

        const gapBtn = el('button', 'mp-learn-map-act is-gap', '标为盲区');
        gapBtn.type = 'button';
        gapBtn.addEventListener('click', () =>
          options.onSetMastery?.(selectedNode, 'gap'),
        );

        actions.append(jumpBtn, askBtn, quizBtn, verifyBtn, gapBtn);
        detail.appendChild(actions);
        wrap.appendChild(detail);
      }

      hostEl.appendChild(wrap);
    };

    paint();
  }

  const api: LearnMapApi = {
    layoutTopology,
    renderMap,
  };

  globalThis.LearnMapView = api;
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})();
