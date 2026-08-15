/* exported DshChat */
/* ============================================================================
   DSH 聊天渲染器（100% 移植 deepseek-harness 的 chat 视觉模型）
   ----------------------------------------------------------------------------
   对应源码（只移植视觉与交互模型，React → 原生 DOM）：

   - ui-conversation chat/MessageItem.tsx       用户气泡 + 动作行
   - ui-conversation chat/ReasoningRow.tsx      Think 思考展开行
   - ui-conversation chat/MessageIconActions    复制（1s 对勾）+ 时钟
   - ui-tool ToolRow.tsx + tool-call-model.ts   工具调用行 + IN/OUT 卡
   - ui-primitives DisclosureRow / StateDot     24px 行骨架 / 四态点
   - ui-conversation chat/ChatView.module.css   回合状态渐变字 / 错误行

   工程约束与本库一致：
   - 不拼 innerHTML，文本一律 createTextNode（舞台同款 XSS 结构防护）；
   - Node 侧 shim 节点可序列化，渲染层不用 DOM 也能测；
   - 事件用数据属性 + 一次委托（[data-dsh-act]），节点本身纯；
   - 整份包在 IIFE 里，只暴露 DshChat 一个全局名。
   ============================================================================ */

const DshChat = (() => {

  interface ShimNode {
    tagName: string;
    ns: string | null;
    attrs: Record<string, string>;
    children: (string | ShimNode)[];
    dataset: Record<string, string>;
    setAttribute(k: string, v: string): void;
    getAttribute(k: string): string | null;
    appendChild(child: string | ShimNode): unknown;
    readonly outerHTML: string;
  }

  type DshNode = Element | ShimNode;
  type DshChild = string | number | ShimNode | Node | null | undefined | false;

  const DOC = typeof document !== 'undefined' ? document : null;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'use']);

  /* ---- Node 侧最小节点：只为可测，不追求像 DOM。 ---- */
  function shimNode(tag: string, ns: string | null): ShimNode {
    const node: ShimNode = {
      tagName: tag, ns, attrs: {}, children: [], dataset: {},
      setAttribute(k: string, v: string) {
        if (k.startsWith('data-')) node.dataset[k.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = String(v);
        node.attrs[k] = String(v);
      },
      getAttribute(k: string): string | null {
        return Object.prototype.hasOwnProperty.call(node.attrs, k) ? node.attrs[k] : null;
      },
      appendChild(child: string | ShimNode): unknown {
        node.children.push(child);
        return child;
      },
      get outerHTML() {
        const escAttr = (value: string) => value.replace(/[&<>"]/g, (ch) => ESCAPES[ch]);
        const attr = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
        if (VOID_TAGS.has(tag)) return `<${tag}${attr}>`;
        const body = node.children.map((c) => (typeof c === 'string'
          ? String(c).replace(/[&<>"']/g, (ch) => ESCAPES[ch])
          : c.outerHTML)).join('');
        return `<${tag}${attr}>${body}</${tag}>`;
      },
    };
    return node;
  }

  /* 浏览器造真节点，Node 造 shim。文本一律走 createTextNode ——
     转义是结构性的，不靠记性。 */
  function attach(parent: DshNode, child: DshChild): void {
    if (child === null || child === undefined || child === false) return;
    if (DOC) {
      (parent as Element).appendChild(
        typeof child === 'string' || typeof child === 'number'
          ? DOC.createTextNode(String(child))
          : (child as Node),
      );
    } else {
      (parent as ShimNode).appendChild(
        typeof child === 'string' || typeof child === 'number'
          ? String(child)
          : (child as ShimNode),
      );
    }
  }

  function h(tag: string, attrs: Record<string, string> = {}, ...children: DshChild[]): DshNode {
    const node = DOC ? DOC.createElement(tag) : shimNode(tag, null);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== '' && v !== null && v !== undefined) node.setAttribute(k, String(v));
    }
    for (const child of children.flat()) attach(node, child);
    return node;
  }

  /* ---- 图标：NS 路径，1.5 描边 24 网格（与本库 icons.ts 同规） ---- */
  interface IconSpec { viewBox: string; paths: string[]; }

  const ICONS: Record<string, IconSpec> = {
    chev: { viewBox: '0 0 24 24', paths: ['M6 9.5 12 15l6-5.5'] },
    copy: { viewBox: '0 0 24 24', paths: ['M8.5 8.5h12v12h-12z', 'M15.5 5.5h-9a3 3 0 0 0-3 3v9'] },
    check: { viewBox: '0 0 24 24', paths: ['m5 12.5 4.5 4.5L19 7.5'] },
    search: { viewBox: '0 0 24 24', paths: ['M11 11m-6.5 0a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0-13 0', 'M16 16l4 4'] },
    browse: { viewBox: '0 0 24 24', paths: ['M2.5 13.5c3-4.3 6.2-6.5 9.5-6.5s6.5 2.2 9.5 6.5', 'M12 13m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0'] },
    terminal: { viewBox: '0 0 24 24', paths: ['M3 4.5h18v15H3z', 'M7.5 10 10 12.2l-2.5 2.2M12.5 15h4'] },
    edit: { viewBox: '0 0 24 24', paths: ['M15.5 4.5 19 8 9.5 17.5l-4.5 1 1-4.5z', 'M4 21h16'] },
    code: { viewBox: '0 0 24 24', paths: ['M9 8.5 5 12l4 3.5M15 8.5l4 3.5-4 3.5'] },
    sparkle: { viewBox: '0 0 24 24', paths: ['M12 3c.4 4.4 4.6 8.6 9 9-4.4.4-8.6 4.6-9 9-.4-4.4-4.6-8.6-9-9 4.4-.4 8.6-4.6 9-9Z'] },
    think: { viewBox: '0 0 24 24', paths: ['M5.5 13a4.5 4.5 0 0 1 2.1-3.8A4.8 4.8 0 0 1 12.5 6a4.8 4.8 0 0 1 4 2.5A4.5 4.5 0 0 1 17 17h-9.4A4.6 4.6 0 0 1 5.5 13Z', 'M9 19.5h7', 'M10 21.5h5'] },
  };

  function icon(name: string, size: number): DshNode {
    const spec = ICONS[name];
    const svg = DOC ? DOC.createElementNS(SVG_NS, 'svg') : shimNode('svg', SVG_NS);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', spec ? spec.viewBox : '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    for (const d of spec ? spec.paths : []) {
      const path = DOC ? DOC.createElementNS(SVG_NS, 'path') : shimNode('path', SVG_NS);
      path.setAttribute('d', d);
      attach(svg, path);
    }
    return svg;
  }

  /* ---- 状态点（StateDot：10px 光晕 + 6px 实心核 / 像素追逐） ---- */
  const MATRIX_CELLS: ReadonlyArray<readonly [number, number]> = [
    [0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4],
  ];

  function stateDot(state: 'done' | 'warning' | 'ongoing' | 'error', size = 10): DshNode {
    if (state === 'ongoing') {
      const svg = h('svg', { class: 'dsh-matrix', width: String(size), height: String(size), viewBox: '0 0 10 10', 'aria-hidden': 'true' });
      svg.setAttribute('data-state', 'ongoing');
      MATRIX_CELLS.forEach(([x, y], index) => {
        const rect = h('rect', { class: 'dsh-cell', x: String(x), y: String(y), width: '2', height: '2' });
        rect.setAttribute('style', `animation-delay:${(index - MATRIX_CELLS.length) * 125}ms`);
        attach(svg, rect);
      });
      return svg;
    }
    const dot = h('span', { class: 'dsh-dot', 'aria-hidden': 'true' });
    dot.setAttribute('data-state', state);
    dot.setAttribute('style', `width:${size}px;height:${size}px`);
    return dot;
  }

  /* ---- 24px 展开行骨架（DisclosureRow） ---- */
  interface DisclosureOptions {
    iconName?: string;
    leadingOverride?: DshNode;
    title: string;
    collapsed?: DshNode[];
    body?: DshNode[] | null;
    expandable?: boolean;
    open?: boolean;
  }

  function disclosureRow(opts: DisclosureOptions): { root: DshNode; toggle(): void } {
    const open = Boolean(opts.open);
    const expandable = opts.expandable !== false && (opts.body !== null && opts.body !== undefined);
    const root = h('div', { class: 'dsh-disclosure' });
    root.setAttribute('data-open', open ? 'true' : 'false');

    const row = h('div', { class: 'dsh-row' });
    if (expandable) {
      row.setAttribute('data-expandable', 'true');
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    const leading = h('span', { class: 'dsh-leading' });
    if (opts.leadingOverride) {
      attach(leading, opts.leadingOverride);
    } else if (open) {
      attach(leading, icon('chev', 14));
      leading.setAttribute('class', 'dsh-leading dsh-chev');
    } else if (opts.iconName) {
      const idle = h('span', { class: 'dsh-icon-idle' });
      attach(idle, icon(opts.iconName, 14));
      attach(leading, idle);
      if (expandable) {
        const chev = h('span', { class: 'dsh-chev-hover' });
        attach(chev, icon('chev', 14));
        attach(leading, chev);
      }
    } else {
      attach(leading, icon('chev', 14));
    }
    attach(row, leading);

    const title = h('span', { class: 'dsh-title' });
    attach(title, String(opts.title));
    attach(row, title);

    for (const item of opts.collapsed || []) attach(row, item);

    attach(root, row);
    /* 展开体总是构建进 body-wrap，闭合态由 CSS 隐藏（
       .dsh-disclosure:not([data-open='true']) > .dsh-body-wrap { display:none }）：
       事件委托翻转 data-open 即可，无需重建 DOM。 */
    const bodyHost = h('div', { class: 'dsh-body-wrap' });
    if (opts.body) for (const item of opts.body) attach(bodyHost, item);
    attach(root, bodyHost);

    const toggle = () => {
      const next = root.getAttribute('data-open') !== 'true';
      root.setAttribute('data-open', next ? 'true' : 'false');
      if (expandable) row.setAttribute('aria-expanded', next ? 'true' : 'false');
    };
    if (expandable) row.setAttribute('data-dsh-act', 'toggle');
    return { root, toggle };
  }

  /* ---- 工具调用行模型（tool-call-model.ts 移植） ---- */
  type ToolVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'others';
  type ToolState = 'running' | 'ok' | 'error' | 'stopped';

  const VARIANT_TITLES: Record<ToolVariant, string> = {
    search: 'Search', read: 'Read', bash: 'Bash',
    write: 'Write', edit: 'Edit', code: 'Code', others: 'Tool call',
  };

  const VARIANT_ICONS: Record<ToolVariant, string> = {
    search: 'search', read: 'browse', bash: 'terminal',
    write: 'edit', edit: 'edit', code: 'code', others: 'sparkle',
  };

  const TOOL_VARIANTS: Record<string, ToolVariant> = {
    bash: 'bash', pwsh: 'bash', read: 'read', web_fetch: 'read',
    web_search: 'search', grep: 'search', glob: 'search',
    write: 'write', edit: 'edit', run_code: 'code',
  };

  const SUMMARY_KEYS: Record<ToolVariant, readonly string[]> = {
    bash: ['description', 'command'],
    read: ['path', 'file_path', 'url'],
    search: ['query', 'pattern', 'url'],
    write: ['path', 'file_path'],
    edit: ['path', 'file_path'],
    code: ['description'],
    others: [],
  };

  const FILE_PATH_VARIANTS: ReadonlySet<ToolVariant> = new Set(['read', 'write', 'edit']);

  function firstLine(value: string): string {
    const nl = value.indexOf('\n');
    return nl === -1 ? value : value.slice(0, nl);
  }

  function latestLine(value: string): string {
    const visible = value.replace(/\s+$/u, '');
    const nl = visible.lastIndexOf('\n');
    return nl === -1 ? visible : visible.slice(nl + 1);
  }

  function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
    for (const key of keys) {
      const v = args[key];
      if (typeof v === 'string' && v !== '') return v;
    }
    return undefined;
  }

  function classifyTool(name: string): ToolVariant {
    return TOOL_VARIANTS[name] || 'others';
  }

  function deriveSummary(variant: ToolVariant, argsRaw: string): string {
    let parsed: unknown;
    try { parsed = JSON.parse(argsRaw); } catch { return firstLine(argsRaw); }
    if (typeof parsed !== 'object' || parsed === null) return firstLine(argsRaw);
    const args = parsed as Record<string, unknown>;
    const picked = pickString(args, SUMMARY_KEYS[variant]);
    if (picked !== undefined) return firstLine(picked);
    for (const v of Object.values(args)) {
      if (typeof v === 'string' && v !== '') return firstLine(v);
    }
    return firstLine(argsRaw);
  }

  function deriveFilePath(variant: ToolVariant, argsRaw: string): string | undefined {
    if (!FILE_PATH_VARIANTS.has(variant)) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(argsRaw); } catch { return undefined; }
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return pickString(parsed as Record<string, unknown>, ['path', 'file_path']);
  }

  function deriveBody(variant: ToolVariant, argsRaw: string): string | null {
    if (!argsRaw) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(argsRaw); } catch { return argsRaw; }
    if (variant === 'code' && typeof parsed === 'object' && parsed !== null) {
      const code = (parsed as Record<string, unknown>).code;
      if (typeof code === 'string' && code !== '') return code;
    }
    return JSON.stringify(parsed, null, 2);
  }

  interface ToolRowModel {
    variant: ToolVariant;
    title: string;
    summary: string;
    filePath?: string;
    body: string | null;
    output: string | null;
    errorSummary: string | null;
    state: ToolState;
  }

  function toolRowModel(name: string, argsRaw: string, result?: { text?: string; isError?: boolean; interrupted?: boolean }): ToolRowModel {
    const variant = classifyTool(name);
    const state: ToolState = result === undefined ? 'running'
      : result.interrupted ? 'stopped'
        : result.isError ? 'error' : 'ok';
    const base = argsRaw === '' ? name : deriveSummary(variant, argsRaw);
    const summary = variant === 'others' && name && argsRaw !== '' ? `${name} · ${base}` : base;
    const output = result === undefined || !result.text ? null : result.text;
    const errorSummary = state === 'error' && output !== null ? firstLine(output) : null;
    return {
      variant,
      title: VARIANT_TITLES[variant],
      summary,
      filePath: deriveFilePath(variant, argsRaw),
      body: deriveBody(variant, argsRaw),
      output,
      errorSummary,
      state,
    };
  }

  /* ---- 工具调用行（ToolRow） ---- */
  function toolRowNode(model: ToolRowModel): DshNode {
    const root = h('div', { class: 'dsh-tool' });
    root.setAttribute('data-tool', '');
    root.setAttribute('data-state', model.state);

    const failureLine = model.state === 'error' ? model.errorSummary : null;
    const summaryText = failureLine ?? model.summary;
    const status = model.state === 'running' ? '运行中' : model.state === 'error' ? '失败' : model.state === 'stopped' ? '已停止' : '';

    if (status) {
      const vh = h('span', { class: 'dsh-vh' });
      attach(vh, status);
      attach(root, vh);
    }

    const collapsed: DshNode[] = [];
    if (summaryText !== '') {
      const sep = h('span', { class: 'dsh-sep', 'aria-hidden': 'true' });
      collapsed.push(sep);
      const summary = h('span', { class: failureLine !== null ? 'dsh-summary dsh-error-summary' : 'dsh-summary' });
      attach(summary, summaryText);
      collapsed.push(summary);
    }

    const body: DshNode[] = [];
    if (model.body !== null || model.output !== null) {
      const ioCard = h('div', { class: 'dsh-io-card' });
      if (model.body !== null) {
        const section = h('div', { class: 'dsh-io-section' });
        const label = h('span', { class: 'dsh-io-label' });
        attach(label, 'IN');
        const payload = h('span', { class: 'dsh-io-text' });
        attach(payload, model.body);
        attach(section, label);
        attach(section, payload);
        attach(ioCard, section);
      }
      if (model.body !== null && model.output !== null) {
        attach(ioCard, h('span', { class: 'dsh-io-divider', 'aria-hidden': 'true' }));
      }
      if (model.output !== null) {
        const section = h('div', { class: 'dsh-io-section' });
        const label = h('span', { class: 'dsh-io-label' });
        attach(label, 'OUT');
        const payload = h('span', { class: 'dsh-io-text' });
        if (model.state === 'error') payload.setAttribute('data-error', 'true');
        attach(payload, model.output);
        attach(section, label);
        attach(section, payload);
        attach(ioCard, section);
      }
      body.push(ioCard);
    }

    const leadingOverride = model.state === 'error' ? stateDot('error')
      : model.state === 'stopped' ? stateDot('warning') : undefined;

    const { root: disclosure } = disclosureRow({
      iconName: VARIANT_ICONS[model.variant],
      leadingOverride,
      title: model.title,
      collapsed,
      body: body.length ? body : null,
      expandable: body.length > 0,
      open: false,
    });

    attach(root, disclosure);
    return root;
  }

  /* ---- Think 思考行（ReasoningRow） ---- */
  function thinkNode(reasoning: string, running = false): DshNode {
    const summaryText = running ? latestLine(reasoning) : firstLine(reasoning);
    const summary = h('span', { class: 'dsh-summary' });
    if (running) summary.setAttribute('data-follow-end', 'true');
    attach(summary, summaryText);

    const body = h('div', { class: 'dsh-think-body' });
    attach(body, reasoning);

    const { root } = disclosureRow({
      iconName: 'think',
      title: 'Think',
      collapsed: [h('span', { class: 'dsh-sep', 'aria-hidden': 'true' }), summary],
      body: [body],
      expandable: true,
      open: false,
    });
    root.setAttribute('data-state', running ? 'running' : 'ok');
    root.setAttribute('class', 'dsh-disclosure dsh-think');
    return root;
  }

  /* ---- 消息动作行（复制 + 时钟） ---- */
  function formatClock(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function messageActions(message: string, timeMs?: number): DshNode {
    const actions = h('div', { class: 'dsh-actions' });
    actions.setAttribute('data-dsh-time-root', 'true');
    if (timeMs !== undefined) {
      const clock = h('span', { class: 'dsh-time' });
      attach(clock, formatClock(timeMs));
      attach(actions, clock);
    }
    const copy = h('button', { type: 'button', class: 'dsh-action', 'aria-label': '复制' });
    copy.setAttribute('data-dsh-act', 'copy');
    copy.setAttribute('data-dsh-copy', String(message || ''));
    attach(copy, icon('copy', 16));
    attach(actions, copy);
    return actions;
  }

  /* ---- 用户消息节点（UserMessageNodeView） ---- */
  function userNode(question: string, timeMs?: number): DshNode {
    const root = h('div', { class: 'dsh-user' });
    root.setAttribute('data-dsh-time-root', 'true');
    const stack = h('div', { class: 'dsh-user-stack' });
    const bubble = h('div', { class: 'dsh-bubble' });
    attach(bubble, question);
    attach(stack, bubble);
    attach(root, stack);
    attach(root, messageActions(question, timeMs));
    return root;
  }

  /* ---- 回合状态行（turnStatus 渐变字） ---- */
  function turnStatusNode(label: string): DshNode {
    const root = h('div', { class: 'dsh-turn-status', role: 'status' });
    attach(root, label);
    return root;
  }

  /* ---- 回合错误行（TurnErrorItem） ---- */
  function turnErrorNode(message: string, code?: string, tone: 'error' | 'warning' = 'error'): DshNode {
    const root = h('div', { class: 'dsh-turn-error', role: 'status' });
    attach(root, stateDot(tone === 'error' ? 'error' : 'warning'));
    const copy = h('div', { class: 'dsh-turn-error-copy' });
    const title = h('span', { class: 'dsh-turn-error-title' });
    if (tone === 'warning') title.setAttribute('data-tone', 'warning');
    attach(title, tone === 'error' ? '这一轮没有完成。' : '注意');
    const body = h('span', { class: 'dsh-turn-error-message' });
    attach(body, message);
    attach(copy, title);
    attach(copy, body);
    attach(root, copy);
    if (code) {
      const c = h('code', { class: 'dsh-turn-error-code' });
      attach(c, code);
      attach(root, c);
    }
    return root;
  }

  /* ---- 助手回合节点：正文 + Think + 工具行 ---- */
  interface AssistantTurnInput {
    answer?: string;
    thinking?: string;
    trace?: Array<string | { label?: string; note?: string; state?: string; name?: string; arguments?: string; result?: string; isError?: boolean }>;
    events?: Array<Record<string, unknown>>;
    failed?: boolean;
    running?: boolean;
    at?: number;
  }

  function assistantTurnNode(turn: AssistantTurnInput): DshNode[] {
    const items: DshNode[] = [];
    const root = h('div', { class: 'dsh-assistant' });
    root.setAttribute('data-dsh-time-root', 'true');
    const bodyHost = h('div', { class: 'dsh-assistant-body' });

    if (turn.thinking) attach(bodyHost, thinkNode(turn.thinking, Boolean(turn.running)));

    /* 结构化事件优先：{name, arguments, result, isError} → DSH 工具行 */
    const events = Array.isArray(turn.events) ? turn.events : [];
    for (const event of events) {
      const name = String(event.name || event.tool || '');
      const argsRaw = typeof event.arguments === 'string'
        ? event.arguments
        : event.arguments !== undefined && event.arguments !== null ? JSON.stringify(event.arguments) : '';
      const result = event.result !== undefined
        ? { text: String(event.result || ''), isError: Boolean(event.isError), interrupted: event.interrupted === true }
        : undefined;
      attach(bodyHost, toolRowNode(toolRowModel(name, argsRaw, result)));
    }

    /* 老 trace 降级：{label, note} / 字符串 → 通用工具行 */
    if (!events.length) {
      for (const step of turn.trace || []) {
        if (typeof step === 'string') {
          attach(bodyHost, toolRowNode(toolRowModel('', step, undefined)));
        } else if (step && typeof step === 'object') {
          const label = String(step.label || step.name || '');
          const note = String(step.note || step.result || '');
          const state = String(step.state || (step.isError ? 'error' : 'ok'));
          const model = toolRowModel(label || 'step', note ? JSON.stringify({ note }) : '',
            note ? { text: note, isError: state === 'error' } : undefined);
          attach(bodyHost, toolRowNode(model));
        }
      }
    }

    if (turn.answer) {
      const md = h('div', { class: 'dsh-markdown' });
      attach(md, turn.answer);
      attach(bodyHost, md);
    }

    if (turn.failed && !turn.answer) {
      attach(bodyHost, turnErrorNode('这次没能完成。'));
    }

    if (turn.running && !turn.answer && !turn.thinking) {
      attach(bodyHost, turnStatusNode('Thinking'));
    }

    attach(root, bodyHost);
    if (turn.answer) attach(root, messageActions(turn.answer, turn.at));
    items.push(root);
    return items;
  }

  /* ---- 事件委托：copy / toggle（挂在 data-dsh-act 上） ---- */
  function toggleDisclosure(act: HTMLElement): void {
    const row = act.closest<HTMLElement>('.dsh-row');
    const disclosure = act.closest<HTMLElement>('.dsh-disclosure');
    if (!row || !disclosure) return;
    const open = disclosure.getAttribute('data-open') === 'true';
    disclosure.setAttribute('data-open', open ? 'false' : 'true');
    row.setAttribute('aria-expanded', open ? 'false' : 'true');
  }

  function bindDelegation(scope: Element | Document = DOC || ({} as Element)): void {
    if (!DOC) return;
    const host = scope as Document;
    if ((host as unknown as { __dshBound?: boolean }).__dshBound) return;
    (host as unknown as { __dshBound?: boolean }).__dshBound = true;
    host.addEventListener('click', (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const act = target.closest<HTMLElement>('[data-dsh-act]');
      if (!act) return;
      const kind = act.getAttribute('data-dsh-act');
      if (kind === 'toggle') {
        toggleDisclosure(act);
      } else if (kind === 'copy') {
        const text = act.getAttribute('data-dsh-copy') || '';
        void (navigator.clipboard?.writeText(text) || Promise.resolve());
        const original = act.querySelector('svg');
        if (original) original.remove();
        act.appendChild(icon('check', 16) as Element);
        window.setTimeout(() => {
          const check = act.querySelector('svg');
          if (check) check.remove();
          act.appendChild(icon('copy', 16) as Element);
        }, 1000);
      }
    });
    host.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const row = (event.target as HTMLElement | null)?.closest?.('.dsh-row[data-dsh-act="toggle"]') as HTMLElement | null;
      if (!row) return;
      event.preventDefault();
      toggleDisclosure(row);
    });
  }

  return {
    userNode,
    assistantTurnNode,
    turnStatusNode,
    turnErrorNode,
    thinkNode,
    toolRowNode,
    toolRowModel,
    stateDot,
    bindDelegation,
    __test: { firstLine, latestLine, classifyTool, deriveSummary, formatClock },
  };
})();

// 渲染层直接用全局 DshChat；主进程/测试 require 这个模块。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DshChat;
}
