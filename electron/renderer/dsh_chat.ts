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

  const TOOL_TITLES: Record<string, string> = {
    pwsh: 'Pwsh',
  };

  const TOOL_VARIANTS: Record<string, ToolVariant> = {
    bash: 'bash', pwsh: 'bash', read: 'read', web_fetch: 'read',
    web_search: 'search', grep: 'search', glob: 'search',
    write: 'write', edit: 'edit', run_code: 'code',
    read_around: 'read', dump_subtree: 'read', get_focused: 'read', list_windows: 'read',
    find_in_window: 'search', look: 'read', propose: 'code', execute_plan: 'code',
    // 生产 coding/delegate 工具名（图1 里模型真实调用的那些）。
    read_file: 'read', write_file: 'write', edit_file: 'edit',
    apply_patch: 'edit', run_command: 'bash', search: 'search',
    list_dir: 'read', delegate_task: 'code',
    // B5 改名后的规范名（旧名保留渲染历史会话的 replay）。
    Read: 'read', Write: 'write', Edit: 'edit', Patch: 'edit',
    Grep: 'search', Glob: 'search', Bash: 'bash', BashRead: 'bash',
    Search: 'search', Fetch: 'read', Agent: 'code', Wait: 'read',
    Observe: 'read', Look: 'read', Tree: 'read', Around: 'read',
    Find: 'search', ListApps: 'read', ListWindows: 'read', GetFocus: 'read',
    Launch: 'code', Focus: 'code', Click: 'code', Type: 'code',
    Key: 'code', Scroll: 'code', Drag: 'code', SetValue: 'code',
    Act: 'code', Select: 'code', AskUser: 'read', Todo: 'read',
    Recall: 'search', SaveSkill: 'write', Tools: 'search',
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

  /* 机器 id 不是人能读的摘要：长十六进制（任务/会话/计划 id）、空对象、
     空串一律不配上芯片行。参考（Claude Desktop）的芯片行只有「动词 + 人话」。 */
  function isJunkSummary(value: string): boolean {
    const v = value.trim();
    if (v === '' || v === '{}' || v === 'null' || v === 'undefined') return true;
    if (/^[0-9a-f]{16,}$/i.test(v.replace(/[-_\s]/g, ''))) return true;
    return false;
  }

  function deriveSummary(variant: ToolVariant, argsRaw: string): string {
    const candidates: string[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsRaw);
    } catch {
      candidates.push(firstLine(argsRaw));
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const args = parsed as Record<string, unknown>;
      const picked = pickString(args, SUMMARY_KEYS[variant]);
      if (picked !== undefined) candidates.push(firstLine(picked));
      for (const v of Object.values(args)) {
        if (typeof v === 'string' && v !== '') candidates.push(firstLine(v));
      }
      candidates.push(firstLine(argsRaw));
    }
    return candidates.find((c) => !isJunkSummary(c)) ?? '';
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
    // 认不出的工具直接用自己的名字当标题——「Tool call ·」这种前缀和
    // 「· {}」这种尾巴都不提供任何信息，只是把行撑长。
    const title = TOOL_TITLES[name] ?? (variant === 'others' ? name : VARIANT_TITLES[variant]);
    const summary = variant === 'others' ? '' : base;
    const output = result === undefined || !result.text ? null : result.text;
    // 报错只露一行短的：完整原文在折叠体里，展开才见。整段红字倾倒会把
    // 流变成事故现场。
    const rawError = state === 'error' && output !== null ? firstLine(output) : null;
    const errorSummary = rawError !== null && rawError.length > 60 ? `${rawError.slice(0, 60)}…` : rawError;
    return {
      variant,
      name,
      argsRaw,
      title,
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
      iconName: undefined,
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
      iconName: undefined,
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

  /* ---- 消息动作行（悬停后才出现：分支 + 复制） ---- */
  function formatClock(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  interface BranchTarget { conversationId: string; turnIndex: number }

  function messageActions(message: string, branch?: BranchTarget): DshNode {
    const actions = h('div', { class: 'dsh-actions' });
    if (branch?.conversationId && Number.isInteger(branch.turnIndex)) {
      const fork = h('button', { type: 'button', class: 'dsh-action', 'aria-label': '从这里创建分支' });
      fork.setAttribute('data-dsh-act', 'branch');
      fork.setAttribute('data-dsh-branch-conversation', branch.conversationId);
      fork.setAttribute('data-dsh-branch-turn', String(branch.turnIndex));
      attach(fork, icon('branch', 16));
      attach(actions, fork);
    }
    const copy = h('button', { type: 'button', class: 'dsh-action', 'aria-label': '复制' });
    copy.setAttribute('data-dsh-act', 'copy');
    copy.setAttribute('data-dsh-copy', String(message || ''));
    attach(copy, icon('copy', 16));
    attach(actions, copy);
    return actions;
  }

  /* ---- 用户消息节点（UserMessageNodeView） ---- */
  function userNode(question: string, _timeMs?: number, branch?: BranchTarget): DshNode {
    const root = h('div', { class: 'dsh-user' });
    const stack = h('div', { class: 'dsh-user-stack' });
    const bubble = h('div', { class: 'dsh-bubble' });
    attach(bubble, question);
    attach(stack, bubble);
    attach(root, stack);
    attach(root, messageActions(question, branch));
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

  /* ---- 助手回合节点：叙述段 + 单行工具芯片 + 证据展开 ---- */
  interface AssistantTurnInput {
    answer?: string;
    thinking?: string;
    trace?: Array<string | { label?: string; note?: string; state?: string; name?: string; arguments?: string; result?: string; isError?: boolean }>;
    events?: Array<Record<string, unknown>>;
    activities?: Array<Record<string, unknown>>;
    trajectory?: Array<Record<string, unknown>>;
    modelUsage?: Record<string, unknown> | null;
    failed?: boolean;
    running?: boolean;
    at?: number;
    conversationId?: string;
    turnIndex?: number;
  }

  interface TurnChip {
    name: string;
    argsRaw: string;
    result?: { text: string; isError: boolean; interrupted?: boolean };
  }

  type FlowItem =
    | { type: 'narration'; text: string }
    | { type: 'notice'; text: string }
    | { type: 'chip'; chip: TurnChip };

  function narrationNode(text: string): DshNode {
    const root = h('div', { class: 'dsh-narration' });
    attach(root, text);
    return root;
  }

  function noticeNode(text: string): DshNode {
    const root = h('div', { class: 'dsh-notice', role: 'status' });
    attach(root, stateDot('warning'));
    const copy = h('span', { class: 'dsh-notice-copy' });
    attach(copy, text);
    attach(root, copy);
    return root;
  }

  function chipNode(chip: TurnChip): DshNode {
    return toolRowNode(toolRowModel(chip.name, chip.argsRaw, chip.result));
  }

  /* 连续同类读取/搜索折成一条组头（CC "Read 2 files" 契约）。 */
  /* 连续的一串工具调用 = 参考里那种「整合起来的条」：组头一行语义标签 +
     chevron，默认展开露出组内芯片，点击收起只留组头。混合工具也成组——
     参考的 Found files, ran a command 就是一个混合串，按工具种类硬拆是
     上一版模仿不到位的原因。 */
  function toolGroupNode(chips: TurnChip[]): DshNode {
    const root = h('details', { class: 'dsh-tool-group' });
    root.setAttribute('open', '');
    const summary = h('summary', { class: 'dsh-tool-group-header' });
    const label = h('span', { class: 'dsh-tool-group-title' });
    attach(label, toolGroupLabel(chips));
    const chev = h('span', { class: 'dsh-tool-group-chev', 'aria-hidden': 'true' });
    attach(chev, icon('chev', 14));
    attach(summary, label);
    attach(summary, chev);
    const body = h('div', { class: 'dsh-tool-group-body' });
    chips.forEach((chip) => attach(body, chipNode(chip)));
    attach(root, summary);
    attach(root, body);
    return root;
  }

  function toolGroupLabel(chips: TurnChip[]): string {
    const n = chips.length;
    const variants = new Set(chips.map((chip) => classifyTool(chip.name)));
    if (variants.size === 1) {
      const variant = chips.length ? classifyTool(chips[0].name) : 'others';
      switch (variant) {
        case 'read': return `Read ${n} files`;
        case 'bash': return `Ran ${n} commands`;
        case 'search': return `Searched ${n} times`;
        case 'write': return `Wrote ${n} files`;
        case 'edit': return `Edited ${n} files`;
        default: break;
      }
    }
    return `Ran ${n} tools`;
  }

  function chipRunNode(chips: TurnChip[]): DshNode {
    if (chips.length < 2) return chipNode(chips[0]);
    return toolGroupNode(chips);
  }

  function formatRunMeta(ms: number, tokens: number | null): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    const time = seconds >= 60
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${seconds}s`;
    return tokens !== null && tokens > 0
      ? `${time} · ${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens`
      : time;
  }

  function runMetaNode(meta: string): DshNode {
    const root = h('div', { class: 'dsh-run-meta', role: 'status' });
    attach(root, meta);
    return root;
  }

  function trajectoryFlowItems(turn: AssistantTurnInput): FlowItem[] | null {
    const records = Array.isArray(turn.trajectory) ? turn.trajectory : [];
    const usable = records.filter((record) => record && typeof record === 'object'
      && (record.kind === 'message' || record.kind === 'notice' || record.kind === 'tool'));
    if (!usable.length) return null;
    const answerText = String(turn.answer || '').trim();
    const items: FlowItem[] = [];
    for (const record of usable) {
      if (record.kind === 'message') {
        const text = String(record.text || '').trim();
        // 最后一轮叙述通常就是最终答案：答案存在且相等时不重复渲染。
        if (!text || (answerText && text === answerText)) continue;
        items.push({ type: 'narration', text });
        continue;
      }
      if (record.kind === 'notice') {
        const text = String(record.text || '').trim();
        if (text) items.push({ type: 'notice', text });
        continue;
      }
      items.push({
        type: 'chip',
        chip: {
          name: String(record.name || 'tool'),
          argsRaw: String(record.text || ''),
          result: record.result !== undefined && record.result !== null
            ? { text: String(record.result || ''), isError: Boolean(record.isError) }
            : record.state === 'running' ? undefined : { text: '', isError: false },
        },
      });
    }
    return items;
  }

  function eventFlowItems(turn: AssistantTurnInput): FlowItem[] {
    const items: FlowItem[] = [];
    const events = Array.isArray(turn.events) ? turn.events : [];
    for (const event of events) {
      const argsRaw = typeof event.arguments === 'string'
        ? event.arguments
        : event.arguments !== undefined && event.arguments !== null ? JSON.stringify(event.arguments) : '';
      items.push({
        type: 'chip',
        chip: {
          name: String(event.name || event.tool || ''),
          argsRaw,
          result: event.result !== undefined
            ? {
              text: String(event.result || ''),
              isError: Boolean(event.isError),
              interrupted: event.interrupted === true,
            }
            : undefined,
        },
      });
    }
    return items;
  }

  function assistantTurnNode(turn: AssistantTurnInput): DshNode[] {
    const items: DshNode[] = [];
    const root = h('div', { class: 'dsh-assistant' });
    const bodyHost = h('div', { class: 'dsh-assistant-body' });

    if (turn.thinking) attach(bodyHost, thinkNode(turn.thinking, Boolean(turn.running)));

    /* CC 折叠协议：模型的轮间叙述是可见的散文，工具调用是单行可扫描的
       芯片（动词 + 最有辨识度的参数），证据保留在展开体里。没有内容的
       "模型轮次"不再画成行——耗时与 token 进尾部 meta。 */
    const flow = trajectoryFlowItems(turn) ?? eventFlowItems(turn);
    let chipRun: TurnChip[] = [];
    const flushChips = () => {
      if (!chipRun.length) return;
      attach(bodyHost, chipRunNode(chipRun));
      chipRun = [];
    };
    for (const item of flow) {
      if (item.type === 'narration') {
        flushChips();
        attach(bodyHost, narrationNode(item.text));
      } else if (item.type === 'notice') {
        flushChips();
        attach(bodyHost, noticeNode(item.text));
      } else {
        chipRun.push(item.chip);
      }
    }
    flushChips();

    /* 运行 meta（耗时/token）——只有真实数据才画。 */
    const records = Array.isArray(turn.trajectory) ? turn.trajectory : [];
    const times = records
      .map((record) => Number(record.startedAt) || 0)
      .filter((value) => value > 0);
    const doneTimes = records
      .map((record) => Number(record.completedAt) || 0)
      .filter((value) => value > 0);
    const totalTokens = Number(turn.modelUsage?.totalTokens) || 0;
    if (times.length && doneTimes.length) {
      const elapsed = Math.max(0, Math.max(...doneTimes) - Math.min(...times));
      attach(bodyHost, runMetaNode(formatRunMeta(elapsed, totalTokens || null)));
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
    if (turn.answer) attach(root, messageActions(turn.answer,
      turn.conversationId && Number.isInteger(turn.turnIndex)
        ? { conversationId: turn.conversationId, turnIndex: Number(turn.turnIndex) }
        : undefined));
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
    /* 非工具阶段 = 单行运行状态(CC/DSH 金标准):StateDot 渐变字,原地更新,
       绝不逐条堆叠成 Think 行;内部管道细节在轨迹视图里看。 */
    return turnStatusNode(liveStatusLabel(phase, fields));
  }

  function liveStatusLabel(phase: string, fields: Record<string, unknown>): string {
    const turn = String(fields.turn || '');
    const labels: Record<string, string> = {
      runtime_boot: '准备 Agent 运行环境',
      runtime_ready: '运行环境已就绪',
      session_ready: '会话已就绪',
      agent_start: '开始处理本轮任务',
      agent_turn: turn ? `第 ${turn} 轮推理中` : '推理中',
      model_request: turn ? `第 ${turn} 轮推理中` : '推理中',
      model_first_chunk: '模型开始响应',
      model_response: '整理结果',
      budget_renewed: '继续执行下一轮',
      total: '本轮处理完成',
    };
    if (labels[phase]) return labels[phase];
    /* 桥的 keepalive 会把轮次拼进 phase 原文(如 agent_turn_turn=1),归一后再试一次。 */
    const normalized = phase.replace(/[_-]turn[=_]\d+$/i, '');
    if (labels[normalized]) {
      const embedded = /turn[=_](\d+)$/i.exec(phase);
      return embedded ? `第 ${embedded[1]} 轮推理中` : labels[normalized];
    }
    return phase || '处理中';
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
          }, 2000); /* sv-particles copy-with-feedback 的反馈时长(参数参考,无 LICENSE 不复制码) */
        });
      } else if (kind === 'branch') {
        const conversationId = act.getAttribute('data-dsh-branch-conversation') || '';
        const turnIndex = Number(act.getAttribute('data-dsh-branch-turn'));
        if (!conversationId || !Number.isInteger(turnIndex)) return;
        DOC.dispatchEvent(new CustomEvent('mp:branch-conversation', {
          detail: { conversationId, turnIndex },
        }));
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
