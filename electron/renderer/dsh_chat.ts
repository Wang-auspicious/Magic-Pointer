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

  const markdownRenderer = typeof DshMarkdown !== 'undefined'
    ? DshMarkdown
    : (typeof require === 'function' ? require('./dsh_markdown') : null);
  const exactIcons = typeof DshIcons !== 'undefined'
    ? DshIcons
    : (typeof require === 'function' ? require('./dsh_icons') : null);

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

  /* Exact fill glyphs from deepseek-harness ui-primitives. */
  function icon(name: string, size: number): DshNode {
    return exactIcons.node(name, size) as DshNode;
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
    search: 'search', read: 'browse', bash: 'api',
    write: 'edit', edit: 'edit', code: 'code', others: 'sparkle',
  };

  const TOOL_TITLES: Record<string, string> = {
    pwsh: 'Pwsh',
  };

  const TOOL_VARIANTS: Record<string, ToolVariant> = {
    bash: 'bash', pwsh: 'bash', read: 'read', web_fetch: 'read',
    web_search: 'search', grep: 'search', glob: 'search',
    write: 'write', edit: 'edit', run_code: 'code',
    read_around: 'read', dump_subtree: 'read', get_focused: 'read', list_windows: 'read',
    find_in_window: 'search', look: 'read', propose: 'code', execute_plan: 'code',
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

  /* ---- 编辑工具 diff 卡（DSH DiffBlock 的简化同构：红删绿加） ----
     不做 LCS 对齐——编辑工具的 old/new 本身就是完整的删/加两列，
     直接列出即可；行数封顶防 DOM 爆炸。 */
  interface DiffLine { kind: 'del' | 'add'; text: string }
  interface DiffView { lines: DiffLine[]; hidden: number }

  const DIFF_MAX_LINES = 40;

  function diffLinesFrom(text: string, kind: DiffLine['kind'], out: DiffLine[]): number {
    const parts = String(text || '').split('\n');
    let hidden = 0;
    for (let i = 0; i < parts.length; i += 1) {
      if (out.length >= DIFF_MAX_LINES) { hidden += parts.length - i; break; }
      out.push({ kind, text: parts[i] });
    }
    return hidden;
  }

  function deriveDiff(name: string, argsRaw: string): DiffView | null {
    if (!argsRaw) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(argsRaw); } catch { return null; }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const args = parsed as Record<string, unknown>;
    const view: DiffView = { lines: [], hidden: 0 };
    if (name === 'edit_file') {
      const oldText = typeof args.old_string === 'string' ? args.old_string : '';
      const newText = typeof args.new_string === 'string' ? args.new_string : '';
      if (!oldText && !newText) return null;
      view.hidden += diffLinesFrom(oldText, 'del', view.lines);
      view.hidden += diffLinesFrom(newText, 'add', view.lines);
      return view;
    }
    if (name === 'write_file') {
      const content = typeof args.content === 'string' ? args.content : '';
      if (!content) return null;
      view.hidden += diffLinesFrom(content, 'add', view.lines);
      return view;
    }
    return null;
  }

  interface ToolRowModel {
    variant: ToolVariant;
    name: string;
    argsRaw: string;
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
      name,
      argsRaw,
      title: TOOL_TITLES[name] ?? VARIANT_TITLES[variant],
      summary,
      filePath: deriveFilePath(variant, argsRaw),
      body: deriveBody(variant, argsRaw),
      output,
      errorSummary,
      state,
    };
  }

  /* ---- 工具调用行（ToolRow） ---- */
  function diffNode(diff: DiffView): DshNode {
    const card = h('div', { class: 'dsh-diff' });
    for (const line of diff.lines) {
      const row = h('div', { class: 'dsh-diff-line' });
      row.setAttribute('data-kind', line.kind);
      attach(row, `${line.kind === 'del' ? '-' : '+'} ${line.text}`);
      attach(card, row);
    }
    if (diff.hidden > 0) {
      const more = h('div', { class: 'dsh-diff-more' });
      attach(more, `… 还有 ${diff.hidden} 行`);
      attach(card, more);
    }
    return card;
  }

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
    const diff = deriveDiff(model.name, model.argsRaw ?? '');
    if (diff !== null && (model.body !== null || model.output !== null)) {
      body.push(diffNode(diff));
    } else if (model.body !== null || model.output !== null) {
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
    activities?: Array<Record<string, unknown>>;
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

    if (!turn.thinking) {
      for (const activity of turn.activities || []) {
        if (activity?.kind !== 'model') continue;
        const turnNumber = Number(activity.turn) || 1;
        const latency = Number(activity.latencyMs) || 0;
        const summary = `模型请求 · 第 ${turnNumber} 轮${latency ? ` · ${(latency / 1000).toFixed(2)}s` : ''}`;
        attach(bodyHost, thinkNode(summary, activity.state === 'running'));
      }
    }

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
      attach(bodyHost, markdownRenderer.render(turn.answer));
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

  function liveActivityNode(record: Record<string, unknown>): DshNode {
    const phase = String(record.phase || '');
    const fields = record.fields && typeof record.fields === 'object'
      ? record.fields as Record<string, unknown> : {};
    if (phase === 'tool_call' || phase === 'tool_result') {
      const name = String(fields.name || 'tool');
      const done = phase === 'tool_result';
      const detail = done
        ? [fields.backend && fields.backend !== '-' ? fields.backend : '', fields.latency_ms ? `${fields.latency_ms}ms` : '']
          .filter(Boolean).join(' · ')
        : '';
      return toolRowNode(toolRowModel(name, '', done ? {
        text: detail,
        isError: fields.state === 'error',
      } : undefined));
    }
    const labels: Record<string, string> = {
      runtime_boot: '准备 Agent 运行环境',
      runtime_ready: 'Agent 运行环境已就绪',
      agent_start: '开始处理本轮任务',
      model_request: `模型请求 · 第 ${String(fields.turn || 1)} 轮`,
      model_first_chunk: '模型开始响应',
      model_response: '模型响应完成',
      budget_renewed: '继续执行下一轮',
      total: '本轮处理完成',
    };
    const running = !['model_response', 'total'].includes(phase);
    return thinkNode(labels[phase] || phase || '处理中', running);
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

  function copyToClipboard(text: string): Promise<boolean> {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopyText(text));
    }
    return Promise.resolve(fallbackCopyText(text));
  }

  function fallbackCopyText(text: string): boolean {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch (_) {
      return false;
    }
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
        const button = act;
        void copyToClipboard(text).then((ok: boolean) => {
          const original = button.querySelector('svg');
          if (original) original.remove();
          button.appendChild(icon(ok ? 'check' : 'copy', 16) as Element);
          if (!ok) button.setAttribute('aria-label', '复制失败');
          window.setTimeout(() => {
            const check = button.querySelector('svg');
            if (check) check.remove();
            button.appendChild(icon('copy', 16) as Element);
            button.setAttribute('aria-label', '复制');
          }, 1000);
        });
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
    liveActivityNode,
    stateDot,
    bindDelegation,
    __test: { firstLine, latestLine, classifyTool, deriveSummary, deriveDiff, formatClock },
  };
})();

// 渲染层直接用全局 DshChat；主进程/测试 require 这个模块。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DshChat;
}
