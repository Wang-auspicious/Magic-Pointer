'use strict';

declare global {
  interface DesignCanvasPage {
    id: string;
    name: string;
  }

  interface DesignArtboardManifest {
    x: number;
    y: number;
    w: number;
    h: number;
    title: string;
    page?: string;
    expand?: 'fill';
    is_interactive?: boolean;
    frameless?: boolean;
    radius?: number;
  }

  interface DesignCanvasNote {
    kind?: 'title1' | 'note' | 'rect' | 'oval' | 'pen' | 'line' | 'arrow' | 'image' | 'link';
    x: number;
    y: number;
    w?: number;
    maxW?: number;
    text?: string;
    fill?: string;
    page?: string;
  }

  interface DesignCanvasManifest {
    v: 3;
    title: string;
    pages?: DesignCanvasPage[];
    boards: Record<string, DesignArtboardManifest>;
    order: string[];
    notes?: Record<string, DesignCanvasNote>;
    designSystems?: Array<{title: string; namespace: string; folder?: string}>;
  }

  interface DesignViewport {
    x: number;
    y: number;
    zoom: number;
  }

  interface DesignDevicePreset {
    id: string;
    label: string;
    width: number;
    height: number;
  }

  interface DesignCommentAnnotation {
    pin: number;
    file: string;
    anchor?: string;
    area?: string;
    text: string;
    x?: number;
    y?: number;
    driftState?: 'anchored' | 'reanchored' | 'stale' | 'lost';
  }

  interface DesignLintFinding {
    severity: 'P0' | 'P1' | 'P2';
    rule: string;
    message: string;
  }

  interface DesignThemeTokens {
    color?: {
      tokens?:
        | Record<string, string>
        | Array<{name: string; value: string; role?: string}>;
    };
    type?: {families?: Record<string, string>};
    spacing?: {tokens?: Record<string, string | number>};
    radius?: {tokens?: Record<string, string | number>};
    shadow?: {tokens?: Record<string, string>};
  }

  interface DesignViewContextInput {
    mode: 'canvas' | 'focused';
    page: string;
    pageName?: string;
    visibleArtboards: string[];
    selectedArtboards: string[];
    selectedAnchors: string[];
    erroredArtboards: Array<{file: string; error: string}>;
    dirty: boolean;
    edits: number;
  }

  interface DesignStudioMountOptions {
    slug: string;
    manifest: DesignCanvasManifest;
    files: Record<string, string>;
    themeTokens?: DesignThemeTokens;
    lintFindings?: Record<string, DesignLintFinding[]>;
    sandboxUrl?: string;
    onSaveFile?: (file: string, content: string) => void;
    onAddArtboard?: (preset: DesignDevicePreset) => void;
    onAskAgentFix?: (file: string, error: string) => void;
    onSubmitAnnotation?: (annotationsXml: string, items: DesignCommentAnnotation[]) => void;
    onExport?: (format: 'html' | 'png' | 'pdf' | 'zip') => void;
    onViewContextChange?: (xml: string) => void;
  }

  interface DesignLruPool {
    touch(key: string): string[];
    has(key: string): boolean;
    size(): number;
    keys(): string[];
  }

  interface DesignStudioApi {
    readonly ZOOM_STEPS: readonly number[];
    readonly DEVICE_PRESETS: readonly DesignDevicePreset[];
    readonly IFRAME_POOL_CAP: number;
    clampZoom(z: number): number;
    nextZoomStep(current: number, dir: 'in' | 'out'): number;
    computeFitViewport(
      boards: Array<{x: number; y: number; w: number; h: number}>,
      containerW: number,
      containerH: number,
      padding?: number,
    ): DesignViewport;
    screenToCanvas(
      clientX: number,
      clientY: number,
      viewport: DesignViewport,
      rect: {left: number; top: number},
    ): {x: number; y: number};
    canvasToScreen(
      x: number,
      y: number,
      viewport: DesignViewport,
    ): {x: number; y: number};
    createLruPool(cap?: number): DesignLruPool;
    serializeDesignViewContext(ctx: DesignViewContextInput): string;
    serializeDesignAnnotations(
      annotations: DesignCommentAnnotation[],
      canvasSlug: string,
    ): string;
    mount(
      container: HTMLElement,
      options: DesignStudioMountOptions,
    ): {
      destroy(): void;
      setFiles(files: Record<string, string>): void;
      getViewContextXml(): string;
      getAnnotations(): DesignCommentAnnotation[];
      fitToScreen(): void;
      setLintFindings(findings: Record<string, DesignLintFinding[]>): void;
      focusBoard(file: string): void;
    };
  }

  var DesignStudio: DesignStudioApi | undefined;
}

(() => {
  const ZOOM_STEPS: readonly number[] = Object.freeze([
    0.25, 0.5, 0.75, 1, 1.5, 2,
  ]);
  const IFRAME_POOL_CAP = 16;

  const DEVICE_PRESETS: readonly DesignDevicePreset[] = Object.freeze([
    {id: 'desktop', label: 'Desktop', width: 1440, height: 900},
    {id: 'tablet', label: 'Tablet', width: 820, height: 1180},
    {id: 'mobile', label: 'Mobile', width: 390, height: 844},
    {id: 'slide', label: 'Slide', width: 1920, height: 1080},
    {id: 'poster', label: 'Poster', width: 1080, height: 1350},
    {id: 'dashboard', label: 'Dashboard', width: 1280, height: 800},
  ]);

  function clampZoom(z: number): number {
    if (!Number.isFinite(z)) {
      return 1;
    }
    return Math.max(0.1, Math.min(4, z));
  }

  function nextZoomStep(current: number, dir: 'in' | 'out'): number {
    const cur = clampZoom(current);
    if (dir === 'in') {
      for (const step of ZOOM_STEPS) {
        if (step > cur + 0.001) {
          return step;
        }
      }
      return ZOOM_STEPS[ZOOM_STEPS.length - 1];
    }
    for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
      if (ZOOM_STEPS[i] < cur - 0.001) {
        return ZOOM_STEPS[i];
      }
    }
    return ZOOM_STEPS[0];
  }

  function computeFitViewport(
    boards: Array<{x: number; y: number; w: number; h: number}>,
    containerW: number,
    containerH: number,
    padding = 48,
  ): DesignViewport {
    if (boards.length === 0 || containerW <= 0 || containerH <= 0) {
      return {x: 40, y: 40, zoom: 1};
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const b of boards) {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    const spanW = Math.max(1, maxX - minX);
    const spanH = Math.max(1, maxY - minY);
    const availW = Math.max(40, containerW - padding * 2);
    const availH = Math.max(40, containerH - padding * 2);
    const zoom = clampZoom(Math.min(1, availW / spanW, availH / spanH));
    const x = (containerW - spanW * zoom) / 2 - minX * zoom;
    const y = (containerH - spanH * zoom) / 2 - minY * zoom;
    return {
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      zoom: Math.round(zoom * 1000) / 1000,
    };
  }

  function screenToCanvas(
    clientX: number,
    clientY: number,
    viewport: DesignViewport,
    rect: {left: number; top: number},
  ): {x: number; y: number} {
    const z = viewport.zoom || 1;
    return {
      x: Math.round(((clientX - rect.left - viewport.x) / z) * 100) / 100,
      y: Math.round(((clientY - rect.top - viewport.y) / z) * 100) / 100,
    };
  }

  function canvasToScreen(
    x: number,
    y: number,
    viewport: DesignViewport,
  ): {x: number; y: number} {
    return {
      x: x * viewport.zoom + viewport.x,
      y: y * viewport.zoom + viewport.y,
    };
  }

  function createLruPool(cap = IFRAME_POOL_CAP): DesignLruPool {
    const order: string[] = [];
    const maxCap = Math.max(1, cap);
    return {
      touch(key: string): string[] {
        const idx = order.indexOf(key);
        if (idx !== -1) {
          order.splice(idx, 1);
        }
        order.push(key);
        const evicted: string[] = [];
        while (order.length > maxCap) {
          const removed = order.shift();
          if (removed !== undefined) {
            evicted.push(removed);
          }
        }
        return evicted;
      },
      has(key: string): boolean {
        return order.includes(key);
      },
      size(): number {
        return order.length;
      },
      keys(): string[] {
        return [...order];
      },
    };
  }

  function escapeXmlAttr(val: string): string {
    return val
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function serializeDesignViewContext(ctx: DesignViewContextInput): string {
    const errSummary = ctx.erroredArtboards
      .map(e => `${e.file}: ${e.error}`)
      .join('; ')
      .slice(0, 1800);
    return [
      '<design_view_context',
      ` mode="${escapeXmlAttr(ctx.mode)}"`,
      ` page="${escapeXmlAttr(ctx.page)}"`,
      ctx.pageName ? ` page_name="${escapeXmlAttr(ctx.pageName)}"` : '',
      ` visible_artboards="${escapeXmlAttr(ctx.visibleArtboards.join(','))}"`,
      ` selected_artboards="${escapeXmlAttr(ctx.selectedArtboards.join(','))}"`,
      ` selected="${escapeXmlAttr(ctx.selectedAnchors.join(','))}"`,
      ` errored_artboards="${escapeXmlAttr(errSummary)}"`,
      ` dirty="${ctx.dirty ? 'true' : 'false'}"`,
      ` edits="${ctx.edits}"`,
      ' />',
    ].join('');
  }

  function serializeDesignAnnotations(
    annotations: DesignCommentAnnotation[],
    canvasSlug: string,
  ): string {
    const lines = annotations.map(a => {
      const target = a.anchor || a.area || a.file;
      return `  <comment pin="${a.pin}" file="${escapeXmlAttr(a.file)}" target="${escapeXmlAttr(target)}">${escapeXmlAttr(a.text)}</comment>`;
    });
    return [
      `<design_annotations canvas="${escapeXmlAttr(canvasSlug)}">`,
      '  <!-- Hard scope: modify only the referenced target(s); preserve sibling artboards and global tokens unless requested. -->',
      ...lines,
      '</design_annotations>',
    ].join('\n');
  }

  function iconHtml(name: string, size: 'xs' | 'sm' | 'md' = 'sm'): string {
    const icons = (globalThis as typeof globalThis & {
      CdsIcons?: {html(name: string, size?: string): string};
    }).CdsIcons;
    return icons ? icons.html(name, size) : '';
  }

  function mount(
    container: HTMLElement,
    options: DesignStudioMountOptions,
  ) {
    const manifest = options.manifest;
    let files = {...options.files};
    let activePage = manifest.pages?.[0]?.id || 'page-1';
    let activeTool: 'select' | 'hand' | 'frame' | 'text' | 'note' | 'comment' | 'play' =
      'select';
    let activeTab: 'pro' | 'outline' | 'tweaks' | 'theme' | 'code' = 'pro';
    let selectedBoard: string | null = manifest.order[0] || null;
    let selectedAnchor: string | null = null;
    let focusedFile: string | null = null;
    let dirty = false;
    let edits = 0;
    let pinSeq = 1;
    let spaceHeld = false;
    let panning: {startX: number; startY: number; origX: number; origY: number} | null =
      null;

    const annotations: DesignCommentAnnotation[] = [];
    const errorsByFile = new Map<string, string>();
    const propOverrides = new Map<string, Record<string, unknown>>();
    const iframeByFile = new Map<string, HTMLIFrameElement>();
    const pool = createLruPool(IFRAME_POOL_CAP);
    let lintFindings: Record<string, DesignLintFinding[]> = options.lintFindings
      ? {...options.lintFindings}
      : {};
    let destroyed = false;
    let fitRafId = 0;

    const root = document.createElement('div');
    root.className = 'mp-design-root';

    // Topbar (page switcher, zoom controls, + Add Artboard presets)
    const topbar = document.createElement('div');
    topbar.className = 'mp-design-topbar';
    const leftGroup = document.createElement('div');
    leftGroup.className = 'mp-design-topbar-group';

    const pageSelect = document.createElement('select');
    pageSelect.className = 'mp-design-select';
    pageSelect.setAttribute('aria-label', 'Select page');
    const pages = manifest.pages && manifest.pages.length > 0
      ? manifest.pages
      : [{id: 'page-1', name: 'Page 1'}];
    for (const p of pages) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      pageSelect.appendChild(opt);
    }
    pageSelect.value = activePage;
    leftGroup.appendChild(pageSelect);

    const rightGroup = document.createElement('div');
    rightGroup.className = 'mp-design-topbar-group';

    const zoomOutBtn = document.createElement('button');
    zoomOutBtn.type = 'button';
    zoomOutBtn.className = 'mp-design-btn';
    zoomOutBtn.setAttribute('aria-label', 'Zoom out');
    zoomOutBtn.textContent = '−';

    const zoomLabel = document.createElement('span');
    zoomLabel.className = 'mp-design-artboard-dims';
    zoomLabel.textContent = '100%';

    const zoomInBtn = document.createElement('button');
    zoomInBtn.type = 'button';
    zoomInBtn.className = 'mp-design-btn';
    zoomInBtn.setAttribute('aria-label', 'Zoom in');
    zoomInBtn.textContent = '+';

    const fitBtn = document.createElement('button');
    fitBtn.type = 'button';
    fitBtn.className = 'mp-design-btn';
    fitBtn.setAttribute('aria-label', 'Fit to screen');
    fitBtn.textContent = 'Fit';

    const addBoardSelect = document.createElement('select');
    addBoardSelect.className = 'mp-design-select';
    addBoardSelect.setAttribute('aria-label', 'Add artboard preset');
    const addPlaceholder = document.createElement('option');
    addPlaceholder.value = '';
    addPlaceholder.textContent = '+ Add Artboard';
    addBoardSelect.appendChild(addPlaceholder);
    for (const preset of DEVICE_PRESETS) {
      const opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = `${preset.label} ${preset.width}×${preset.height}`;
      addBoardSelect.appendChild(opt);
    }
    addBoardSelect.addEventListener('change', () => {
      const preset = DEVICE_PRESETS.find(p => p.id === addBoardSelect.value);
      if (preset && options.onAddArtboard) {
        options.onAddArtboard(preset);
      }
      addBoardSelect.value = '';
    });

    rightGroup.append(zoomOutBtn, zoomLabel, zoomInBtn, fitBtn, addBoardSelect);
    topbar.append(leftGroup, rightGroup);

    // Workspace split
    const workspace = document.createElement('div');
    workspace.className = 'mp-design-workspace';

    const viewportEl = document.createElement('div');
    viewportEl.className = 'mp-design-canvas-viewport';

    const worldEl = document.createElement('div');
    worldEl.className = 'mp-design-canvas-world';
    viewportEl.appendChild(worldEl);

    const minimapEl = document.createElement('div');
    minimapEl.className = 'mp-design-minimap';

    const toolPill = document.createElement('div');
    toolPill.className = 'mp-design-tool-pill';

    const inspector = document.createElement('aside');
    inspector.className = 'mp-design-inspector';
    const tabsBar = document.createElement('div');
    tabsBar.className = 'mp-design-inspector-tabs';
    const inspectorBody = document.createElement('div');
    inspectorBody.className = 'mp-design-inspector-body';
    inspector.append(tabsBar, inspectorBody);

    workspace.append(viewportEl, inspector);
    viewportEl.append(minimapEl, toolPill);
    root.append(topbar, workspace);
    container.innerHTML = '';
    container.appendChild(root);

    let viewport: DesignViewport = {x: 48, y: 48, zoom: 1};

    function visibleBoardKeys(): string[] {
      return manifest.order.filter(key => {
        const b = manifest.boards[key];
        if (!b) {
          return false;
        }
        return !b.page || b.page === activePage;
      });
    }

    function getViewContextXml(): string {
      const pageObj = pages.find(p => p.id === activePage);
      const errored: Array<{file: string; error: string}> = [];
      errorsByFile.forEach((error, file) => errored.push({file, error}));
      return serializeDesignViewContext({
        mode: focusedFile ? 'focused' : 'canvas',
        page: activePage,
        pageName: pageObj?.name,
        visibleArtboards: visibleBoardKeys(),
        selectedArtboards: selectedBoard ? [selectedBoard] : [],
        selectedAnchors: selectedAnchor ? [selectedAnchor] : [],
        erroredArtboards: errored,
        dirty,
        edits,
      });
    }

    function notifyViewContext(): void {
      if (options.onViewContextChange) {
        options.onViewContextChange(getViewContextXml());
      }
    }

    function applyTransform(): void {
      worldEl.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
      zoomLabel.textContent = `${Math.round(viewport.zoom * 100)}%`;
      renderMinimap();
    }

    function renderMinimap(): void {
      const keys = visibleBoardKeys();
      if (keys.length === 0) {
        minimapEl.innerHTML = '';
        return;
      }
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const k of keys) {
        const b = manifest.boards[k];
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.w);
        maxY = Math.max(maxY, b.y + b.h);
      }
      const pad = 120;
      const vb = `${minX - pad} ${minY - pad} ${Math.max(200, maxX - minX + pad * 2)} ${Math.max(200, maxY - minY + pad * 2)}`;
      const rects = keys
        .map(k => {
          const b = manifest.boards[k];
          const fill = k === selectedBoard ? '#d97757' : '#9b9990';
          return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="12" fill="${fill}" fill-opacity="0.35" stroke="${fill}" stroke-width="12" />`;
        })
        .join('');
      minimapEl.innerHTML = `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid meet">${rects}</svg>`;
    }

    function compileBoard(file: string): {renderedHtml: string; propsMeta: DesignTweakDef[]} {
      const raw = files[file] || '';
      const rt = globalThis.DesignDcRuntime;
      if (!rt) {
        return {renderedHtml: raw, propsMeta: []};
      }
      const res = rt.renderDcDocument(raw, propOverrides.get(file));
      return {renderedHtml: res.renderedHtml, propsMeta: res.propsMeta};
    }

    function syncPoolInert(): void {
      const activeSet = new Set(pool.keys());
      iframeByFile.forEach((frame, file) => {
        if (!activeSet.has(file) || file !== selectedBoard) {
          frame.setAttribute('inert', '');
        } else {
          frame.removeAttribute('inert');
        }
      });
    }

    function renderToolPill(): void {
      toolPill.innerHTML = '';
      const tools: Array<{id: typeof activeTool; label: string; icon: string}> = [
        {id: 'select', label: 'Select', icon: 'cursor'},
        {id: 'hand', label: 'Hand', icon: 'hand'},
        {id: 'frame', label: 'Frame', icon: 'layout-grid'},
        {id: 'text', label: 'Text', icon: 'edit'},
        {id: 'note', label: 'Note', icon: 'document'},
        {id: 'comment', label: 'Comment', icon: 'chat-simple'},
        {id: 'play', label: 'Play', icon: 'eye'},
      ];
      for (const t of tools) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `mp-design-tool-btn${activeTool === t.id ? ' is-active' : ''}`;
        btn.innerHTML = `${iconHtml(t.icon, 'sm')}<span>${t.label}</span>`;
        btn.addEventListener('click', () => {
          activeTool = t.id;
          viewportEl.classList.toggle('is-hand', activeTool === 'hand');
          if (activeTool === 'frame' && options.onAddArtboard) {
            options.onAddArtboard(DEVICE_PRESETS[0]);
          }
          if (activeTool === 'play' && selectedBoard) {
            openFocusedPlay(selectedBoard);
          }
          const iframeMode =
            activeTool === 'comment'
              ? 'comment'
              : activeTool === 'play'
                ? 'play'
                : activeTool === 'text'
                  ? 'edit'
                  : 'select';
          iframeByFile.forEach(f => {
            f.contentWindow?.postMessage({type: 'mp-design-mode', mode: iframeMode}, '*');
          });
          renderToolPill();
        });
        toolPill.appendChild(btn);
      }
    }

    function renderInspector(): void {
      tabsBar.innerHTML = '';
      const tabs: Array<{id: typeof activeTab; label: string}> = [
        {id: 'pro', label: 'Properties'},
        {id: 'outline', label: 'Outline'},
        {id: 'tweaks', label: 'Tweaks'},
        {id: 'theme', label: 'Theme'},
        {id: 'code', label: 'Code'},
      ];
      for (const tab of tabs) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.testid = `dc-mode-${tab.id}`;
        btn.className = `mp-design-tab-btn${activeTab === tab.id ? ' is-active' : ''}`;
        btn.textContent = tab.label;
        btn.addEventListener('click', () => {
          activeTab = tab.id;
          renderInspector();
        });
        tabsBar.appendChild(btn);
      }

      inspectorBody.innerHTML = '';
      const file = selectedBoard;
      if (!file) {
        inspectorBody.textContent = 'Select an artboard to inspect.';
        return;
      }

      if (activeTab === 'pro') {
        const fields: Array<[string, string, string]> = [
          ['display', 'Display', 'flex'],
          ['padding', 'Padding', '16px'],
          ['gap', 'Gap', '12px'],
          ['fontSize', 'Font Size', '14px'],
          ['color', 'Color', '#1f1f1d'],
          ['background', 'Background', '#ffffff'],
          ['borderRadius', 'Radius', '8px'],
          ['boxShadow', 'Shadow', 'none'],
        ];
        for (const [prop, label, placeholder] of fields) {
          const row = document.createElement('div');
          row.className = 'mp-design-prop-row';
          const lbl = document.createElement('label');
          lbl.className = 'mp-design-prop-label';
          lbl.textContent = label;
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.className = 'mp-design-prop-input';
          inp.placeholder = placeholder;
          inp.addEventListener('change', () => {
            const frame = iframeByFile.get(file);
            frame?.contentWindow?.postMessage(
              {type: 'mp-design-apply-style', styles: {[prop]: inp.value}},
              '*',
            );
          });
          row.append(lbl, inp);
          inspectorBody.appendChild(row);
        }
      } else if (activeTab === 'outline') {
        const rt = globalThis.DesignDcRuntime;
        const tree = rt ? rt.buildOutlineTree(files[file] || '') : [];
        const flat = rt ? rt.flattenOutline(tree) : [];
        for (const node of flat) {
          const item = document.createElement('div');
          item.style.padding = '4px 6px';
          item.style.cursor = 'pointer';
          item.style.paddingLeft = `${(node.path.split('/').length - 1) * 12 + 6}px`;
          item.textContent = `${node.tag}${node.id ? '#' + node.id : ''} (${node.tid}:${node.path})`;
          item.addEventListener('click', () => {
            selectedAnchor = rt ? rt.formatAnchorId(file, node.tid, node.path) : null;
            notifyViewContext();
          });
          inspectorBody.appendChild(item);
        }
      } else if (activeTab === 'tweaks') {
        const compiled = compileBoard(file);
        if (compiled.propsMeta.length === 0) {
          inspectorBody.textContent = 'No data-props tweaks declared.';
          return;
        }
        for (const def of compiled.propsMeta) {
          if (def.kind === 'null') {
            continue;
          }
          const row = document.createElement('div');
          row.className = 'mp-design-prop-row';
          const lbl = document.createElement('label');
          lbl.className = 'mp-design-prop-label';
          lbl.textContent = def.label;
          row.appendChild(lbl);

          if (def.kind === 'color' && def.options && def.options.length > 0) {
            const swatchRow = document.createElement('div');
            swatchRow.className = 'mp-design-swatch-row';
            for (const opt of def.options) {
              const color = typeof opt === 'string' ? opt : opt.value;
              const sw = document.createElement('button');
              sw.type = 'button';
              sw.className = 'mp-design-swatch';
              sw.style.background = color;
              sw.title = color;
              sw.addEventListener('click', () => applyTweak(file, def.key, color));
              swatchRow.appendChild(sw);
            }
            row.appendChild(swatchRow);
          } else if (def.kind === 'boolean') {
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'mp-design-btn';
            toggle.textContent = def.value ? 'On' : 'Off';
            toggle.addEventListener('click', () => applyTweak(file, def.key, !def.value));
            row.appendChild(toggle);
          } else if (def.kind === 'enum' && def.options) {
            const sel = document.createElement('select');
            sel.className = 'mp-design-select';
            for (const opt of def.options) {
              const o = document.createElement('option');
              o.value = typeof opt === 'string' ? opt : opt.value;
              o.textContent = typeof opt === 'string' ? opt : opt.label;
              sel.appendChild(o);
            }
            sel.value = String(def.value ?? '');
            sel.addEventListener('change', () => applyTweak(file, def.key, sel.value));
            row.appendChild(sel);
          } else {
            const inp = document.createElement('input');
            inp.className = 'mp-design-prop-input';
            inp.type = def.kind === 'range' ? 'range' : def.kind === 'int' || def.kind === 'float' ? 'number' : 'text';
            if (def.min !== undefined) {
              inp.min = String(def.min);
            }
            if (def.max !== undefined) {
              inp.max = String(def.max);
            }
            if (def.step !== undefined) {
              inp.step = String(def.step);
            }
            inp.value = String(def.value ?? '');
            inp.addEventListener('input', () => {
              const val =
                def.kind === 'int' || def.kind === 'float' || def.kind === 'range'
                  ? Number(inp.value)
                  : inp.value;
              applyTweak(file, def.key, val);
            });
            row.appendChild(inp);
          }
          inspectorBody.appendChild(row);
        }
      } else if (activeTab === 'theme') {
        const tokens = options.themeTokens;
        const rawColorTokens = tokens?.color?.tokens;
        if (!rawColorTokens) {
          inspectorBody.textContent = 'No Design System tokens loaded (ds/<folder>/tokens.json).';
          return;
        }
        const entries: Array<[string, string]> = Array.isArray(rawColorTokens)
          ? rawColorTokens.map(item => [item.name, item.value])
          : Object.entries(rawColorTokens);
        for (const [k, v] of entries) {
          const row = document.createElement('div');
          row.style.display = 'flex';
          row.style.alignItems = 'center';
          row.style.gap = '8px';
          row.style.marginBottom = '6px';
          const sw = document.createElement('span');
          sw.className = 'mp-design-swatch';
          sw.style.background = v;
          const txt = document.createElement('span');
          txt.textContent = `${k}: ${v}`;
          row.append(sw, txt);
          inspectorBody.appendChild(row);
        }
      } else if (activeTab === 'code') {
        const findings = lintFindings[file] || [];
        if (findings.length > 0) {
          const lintWrap = document.createElement('div');
          lintWrap.style.marginBottom = '8px';
          for (const f of findings) {
            const badge = document.createElement('span');
            badge.className = `mp-design-lint-badge is-${f.severity.toLowerCase()}`;
            badge.textContent = `${f.severity} ${f.rule}`;
            badge.title = f.message;
            lintWrap.appendChild(badge);
          }
          inspectorBody.appendChild(lintWrap);
        }
        const area = document.createElement('textarea');
        area.style.width = '100%';
        area.style.height = '360px';
        area.style.fontFamily = 'var(--cds-font-mono, monospace)';
        area.style.fontSize = '11.5px';
        area.value = files[file] || '';
        area.addEventListener('change', () => {
          files[file] = area.value;
          dirty = true;
          edits += 1;
          options.onSaveFile?.(file, area.value);
          renderCanvas();
          notifyViewContext();
        });
        inspectorBody.appendChild(area);
      }
    }

    function applyTweak(file: string, key: string, value: unknown): void {
      const cur = propOverrides.get(file) || {};
      propOverrides.set(file, {...cur, [key]: value});
      const rt = globalThis.DesignDcRuntime;
      if (rt && files[file]) {
        files[file] = rt.updateDataPropsInHtml(files[file], key, value);
      }
      dirty = true;
      edits += 1;
      const compiled = compileBoard(file);
      const frame = iframeByFile.get(file);
      frame?.contentWindow?.postMessage(
        {type: 'mp-design-set-props', renderedHtml: compiled.renderedHtml},
        '*',
      );
      renderInspector();
      notifyViewContext();
    }

    function openFocusedPlay(file: string): void {
      focusedFile = file;
      const overlay = document.createElement('div');
      overlay.className = 'mp-design-focused-overlay';

      const bar = document.createElement('div');
      bar.className = 'mp-design-focused-bar';
      const title = document.createElement('span');
      title.className = 'mp-design-title';
      title.textContent = `${manifest.boards[file]?.title || file} (Prototype)`;
      const backBtn = document.createElement('button');
      backBtn.type = 'button';
      backBtn.className = 'mp-design-btn';
      backBtn.textContent = 'Back to Canvas';
      backBtn.addEventListener('click', () => {
        focusedFile = null;
        overlay.remove();
        notifyViewContext();
      });
      bar.append(title, backBtn);

      const frame = document.createElement('iframe');
      frame.className = 'mp-design-focused-frame';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.src = options.sandboxUrl || 'design_sandbox.html';
      frame.addEventListener('load', () => {
        const compiled = compileBoard(file);
        frame.contentWindow?.postMessage(
          {
            type: 'mp-design-init',
            frameId: `focused:${file}`,
            file,
            mode: 'play',
            isInteractive: true,
            renderedHtml: compiled.renderedHtml,
          },
          '*',
        );
      });

      overlay.append(bar, frame);
      root.appendChild(overlay);
      notifyViewContext();
    }

    function renderCanvas(): void {
      worldEl.innerHTML = '';
      // Notes & section titles
      if (manifest.notes) {
        for (const note of Object.values(manifest.notes)) {
          if (note.page && note.page !== activePage) {
            continue;
          }
          const el = document.createElement('div');
          el.className =
            note.kind === 'title1'
              ? 'mp-design-section-title'
              : 'mp-design-sticky-note';
          el.style.left = `${note.x}px`;
          el.style.top = `${note.y}px`;
          if (note.w) {
            el.style.width = `${note.w}px`;
          }
          if (note.maxW) {
            el.style.maxWidth = `${note.maxW}px`;
          }
          el.textContent = note.text || '';
          worldEl.appendChild(el);
        }
      }

      for (const file of visibleBoardKeys()) {
        const b = manifest.boards[file];
        const card = document.createElement('div');
        card.className = `mp-design-artboard${selectedBoard === file ? ' is-selected' : ''}`;
        card.style.left = `${b.x}px`;
        card.style.top = `${b.y}px`;
        card.style.width = `${b.w}px`;
        card.style.height = `${b.h}px`;

        const header = document.createElement('div');
        header.className = 'mp-design-artboard-header';

        const meta = document.createElement('div');
        meta.className = 'mp-design-artboard-meta';
        const nameEl = document.createElement('span');
        nameEl.className = 'mp-design-artboard-name';
        nameEl.textContent = b.title || file;
        const dimsEl = document.createElement('span');
        dimsEl.className = 'mp-design-artboard-dims';
        dimsEl.textContent = `${b.w}×${b.h}`;
        meta.append(nameEl, dimsEl);

        if (b.is_interactive) {
          const playBtn = document.createElement('button');
          playBtn.type = 'button';
          playBtn.className = 'mp-design-play-badge';
          playBtn.textContent = 'Play';
          playBtn.addEventListener('click', ev => {
            ev.stopPropagation();
            openFocusedPlay(file);
          });
          meta.appendChild(playBtn);
        }

        const compiled = compileBoard(file);
        const tweaksBar = document.createElement('div');
        tweaksBar.className = 'mp-design-tweaks-bar';
        tweaksBar.dataset.megaChrome = 'tweaks';
        const visibleTweaks = compiled.propsMeta.filter(p => p.kind !== 'null');
        const maxChips = Math.max(1, Math.floor(b.w / 180));
        for (const t of visibleTweaks.slice(0, maxChips)) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'mp-design-tweak-chip';
          chip.textContent = `${t.label}: ${String(t.value ?? '')}`;
          chip.addEventListener('click', ev => {
            ev.stopPropagation();
            selectedBoard = file;
            activeTab = 'tweaks';
            renderInspector();
          });
          tweaksBar.appendChild(chip);
        }
        if (visibleTweaks.length > maxChips) {
          const more = document.createElement('button');
          more.type = 'button';
          more.className = 'mp-design-tweak-chip';
          more.textContent = `+${visibleTweaks.length - maxChips} tweaks`;
          more.addEventListener('click', ev => {
            ev.stopPropagation();
            selectedBoard = file;
            activeTab = 'tweaks';
            renderInspector();
          });
          tweaksBar.appendChild(more);
        }

        header.append(meta, tweaksBar);
        card.appendChild(header);

        const errMsg = errorsByFile.get(file);
        if (errMsg) {
          const errBanner = document.createElement('div');
          errBanner.className = 'mp-design-artboard-error';
          const errText = document.createElement('span');
          errText.textContent = errMsg;
          const fixBtn = document.createElement('button');
          fixBtn.type = 'button';
          fixBtn.className = 'mp-design-btn';
          fixBtn.textContent = 'Ask Agent to fix';
          fixBtn.addEventListener('click', ev => {
            ev.stopPropagation();
            options.onAskAgentFix?.(file, errMsg);
          });
          errBanner.append(errText, fixBtn);
          card.appendChild(errBanner);
        }

        pool.touch(file);
        let frame = iframeByFile.get(file);
        if (!frame) {
          frame = document.createElement('iframe');
          frame.className = 'mp-design-artboard-frame';
          frame.setAttribute('sandbox', 'allow-scripts');
          frame.src = options.sandboxUrl || 'design_sandbox.html';
          frame.addEventListener('load', () => {
            const c = compileBoard(file);
            frame?.contentWindow?.postMessage(
              {
                type: 'mp-design-init',
                frameId: file,
                file,
                mode: 'select',
                isInteractive: Boolean(b.is_interactive),
                renderedHtml: c.renderedHtml,
              },
              '*',
            );
          });
          iframeByFile.set(file, frame);
        }
        card.appendChild(frame);

        card.addEventListener('mousedown', () => {
          selectedBoard = file;
          pool.touch(file);
          syncPoolInert();
          renderInspector();
          notifyViewContext();
        });

        worldEl.appendChild(card);
      }

      for (const ann of annotations) {
        if (ann.x === undefined || ann.y === undefined) {
          continue;
        }
        const pinEl = document.createElement('button');
        pinEl.type = 'button';
        pinEl.className = `mp-design-comment-pin${ann.driftState === 'lost' ? ' is-lost' : ''}`;
        pinEl.style.left = `${ann.x}px`;
        pinEl.style.top = `${ann.y}px`;
        pinEl.textContent = String(ann.pin);
        pinEl.title = ann.text;
        worldEl.appendChild(pinEl);
      }

      syncPoolInert();
      applyTransform();
    }

    // Pan & zoom handlers
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as Record<string, unknown> | null;
      if (!data || typeof data !== 'object') {
        return;
      }
      const file = String(data.file || '');
      if (data.type === 'mp-design-error' && file) {
        errorsByFile.set(file, String(data.message || 'Runtime error'));
        renderCanvas();
        notifyViewContext();
      } else if (data.type === 'mp-design-element-selected') {
        const coord = data.coord as {anchor?: string} | undefined;
        selectedAnchor = coord?.anchor || null;
        notifyViewContext();
      } else if (data.type === 'mp-design-navigate' && focusedFile) {
        const target = String(data.targetFile || '');
        if (target && manifest.boards[target]) {
          root.querySelector('.mp-design-focused-overlay')?.remove();
          openFocusedPlay(target);
        }
      } else if (
        (data.type === 'mp-design-comment-target' ||
          data.type === 'mp-design-comment-area') &&
        file
      ) {
        const coord = data.coord as {anchor?: string; rect?: {x: number; y: number}} | undefined;
        const board = manifest.boards[file];
        const pin = pinSeq++;
        const ann: DesignCommentAnnotation = {
          pin,
          file,
          anchor: coord?.anchor,
          area: typeof data.area === 'string' ? data.area : undefined,
          text: `Review pin #${pin}`,
          x: (board?.x || 0) + (coord?.rect?.x || 24),
          y: (board?.y || 0) + (coord?.rect?.y || 24),
          driftState: 'anchored',
        };
        annotations.push(ann);
        renderCanvas();
        options.onSubmitAnnotation?.(
          serializeDesignAnnotations(annotations, options.slug),
          [...annotations],
        );
      }
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.code === 'Space') {
        spaceHeld = true;
      }
    };
    const onKeyUp = (ev: KeyboardEvent) => {
      if (ev.code === 'Space') {
        spaceHeld = false;
      }
    };

    function fitToScreen(): void {
      const boards = visibleBoardKeys()
        .map(k => manifest.boards[k])
        .filter((b): b is DesignArtboardManifest => Boolean(b));
      if (boards.length === 0) {
        return;
      }
      viewport = computeFitViewport(
        boards,
        viewportEl.clientWidth || 960,
        viewportEl.clientHeight || 640,
      );
      applyTransform();
    }

    function setLintFindings(
      findings: Record<string, DesignLintFinding[]>,
    ): void {
      lintFindings = findings ? {...findings} : {};
      renderInspector();
    }

    function focusBoard(file: string): void {
      const board = manifest.boards[file];
      if (!board) {
        return;
      }
      if (board.page && board.page !== activePage) {
        activePage = board.page;
        pageSelect.value = activePage;
      }
      selectedBoard = file;
      pool.touch(file);
      viewport = computeFitViewport(
        [board],
        viewportEl.clientWidth || 960,
        viewportEl.clientHeight || 640,
      );
      renderCanvas();
      renderInspector();
      notifyViewContext();
    }

    const onMouseMove = (ev: MouseEvent) => {
      if (!panning) {
        return;
      }
      viewport.x = panning.origX + (ev.clientX - panning.startX);
      viewport.y = panning.origY + (ev.clientY - panning.startY);
      applyTransform();
    };
    const onMouseUp = () => {
      if (panning) {
        panning = null;
        viewportEl.classList.remove('is-panning');
      }
    };

    viewportEl.addEventListener('mousedown', ev => {
      if (activeTool === 'hand' || spaceHeld || ev.button === 1) {
        panning = {
          startX: ev.clientX,
          startY: ev.clientY,
          origX: viewport.x,
          origY: viewport.y,
        };
        viewportEl.classList.add('is-panning');
      }
    });
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    viewportEl.addEventListener(
      'wheel',
      ev => {
        ev.preventDefault();
        if (ev.ctrlKey || ev.metaKey) {
          const factor = ev.deltaY < 0 ? 1.1 : 0.9;
          viewport.zoom = clampZoom(viewport.zoom * factor);
        } else {
          viewport.x -= ev.deltaX;
          viewport.y -= ev.deltaY;
        }
        applyTransform();
      },
      {passive: false},
    );

    zoomInBtn.addEventListener('click', () => {
      viewport.zoom = nextZoomStep(viewport.zoom, 'in');
      applyTransform();
    });
    zoomOutBtn.addEventListener('click', () => {
      viewport.zoom = nextZoomStep(viewport.zoom, 'out');
      applyTransform();
    });
    fitBtn.addEventListener('click', fitToScreen);
    pageSelect.addEventListener('change', () => {
      activePage = pageSelect.value;
      renderCanvas();
      notifyViewContext();
    });

    window.addEventListener('message', onMessage);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    renderToolPill();
    renderCanvas();
    renderInspector();
    notifyViewContext();
    if (visibleBoardKeys().length > 0) {
      if (typeof requestAnimationFrame === 'function') {
        fitRafId = requestAnimationFrame(() => {
          fitRafId = 0;
          if (!destroyed) {
            fitToScreen();
          }
        });
      } else {
        fitToScreen();
      }
    }

    return {
      destroy() {
        destroyed = true;
        if (fitRafId && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(fitRafId);
        }
        window.removeEventListener('message', onMessage);
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        container.innerHTML = '';
      },
      setFiles(nextFiles: Record<string, string>) {
        files = {...nextFiles};
        renderCanvas();
        renderInspector();
      },
      getViewContextXml,
      getAnnotations() {
        return [...annotations];
      },
      fitToScreen,
      setLintFindings,
      focusBoard,
    };
  }

  const api: DesignStudioApi = {
    ZOOM_STEPS,
    DEVICE_PRESETS,
    IFRAME_POOL_CAP,
    clampZoom,
    nextZoomStep,
    computeFitViewport,
    screenToCanvas,
    canvasToScreen,
    createLruPool,
    serializeDesignViewContext,
    serializeDesignAnnotations,
    mount,
  };

  globalThis.DesignStudio = api;
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})();
