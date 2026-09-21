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
    leadingClass?: string;
    title: string;
    collapsed?: DshNode[];
    body?: DshNode[] | null;
    expandable?: boolean;
    open?: boolean;
  }

  function disclosureRow(opts: DisclosureOptions): { root: DshNode; row: DshNode; toggle(): void } {
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

    const leading = h('span', {
      class: opts.leadingClass ? `dsh-leading ${opts.leadingClass}` : 'dsh-leading',
    });
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
    return { root, row, toggle };
  }

  /* ---- 工具调用行模型（tool-call-model.ts 移植） ---- */
  type ToolVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'others';
  type ToolState = 'running' | 'ok' | 'error' | 'stopped';

  /* 参考里的工具行是「已经做完的那件事」：动词用过去式，后面直接接最有
     辨识度的参数（`Read STATUS.md`、`Edited x.html +17 -5`）。用名词
     （`Bash`、`Read`）会把每一行都读成一个标签而不是一个动作。 */
  const VARIANT_TITLES: Record<ToolVariant, string> = {
    search: 'Searched', read: 'Read', bash: 'Ran',
    write: 'Wrote', edit: 'Edited', code: 'Used', others: 'Tool call',
  };

  const TOOL_TITLES: Record<string, string> = {
    Todo: 'Updated plan', todo_write: 'Updated plan',
    AskUser: 'Asked user', ask_user_question: 'Asked user',
    Observe: 'Observed', get_app_state: 'Observed',
    ListApps: 'Listed windows', ListWindows: 'Listed windows',
    pwsh: 'Ran',
    search: 'Searched',
    list_dir: 'Listed files in working directory',
  };

  const SUBAGENT_TOOLS = new Set(['Agent', 'delegate_task']);

  const TOOL_VARIANTS: Record<string, ToolVariant> = {
    bash: 'bash', pwsh: 'bash', read: 'read', web_fetch: 'read',
    web_search: 'search', grep: 'search', glob: 'search',
    write: 'write', edit: 'edit', run_code: 'code',
    read_around: 'code', dump_subtree: 'code', get_focused: 'code', list_windows: 'code',
    find_in_window: 'search', look: 'code', propose: 'code', execute_plan: 'code',
    // 生产 coding/delegate 工具名（图1 里模型真实调用的那些）。
    read_file: 'read', write_file: 'write', edit_file: 'edit',
    apply_patch: 'edit', run_command: 'bash', search: 'search',
    list_dir: 'read', delegate_task: 'code',
    // B5 改名后的规范名（旧名保留渲染历史会话的 replay）。
    Read: 'read', Write: 'write', Edit: 'edit', Patch: 'edit',
    Grep: 'search', Glob: 'search', Bash: 'bash', BashRead: 'bash',
    Search: 'search', Fetch: 'code', Agent: 'code', Wait: 'code',
    Observe: 'code', Look: 'code', Tree: 'code', Around: 'code',
    Find: 'search', ListApps: 'code', ListWindows: 'code', GetFocus: 'code',
    Launch: 'code', Focus: 'code', Click: 'code', Type: 'code',
    Key: 'code', Scroll: 'code', Drag: 'code', SetValue: 'code',
    Act: 'code', Select: 'code', AskUser: 'code', Todo: 'code',
    todo_write: 'code', ask_user_question: 'code', get_app_state: 'code',
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
    if (name === 'Edit' || name === 'edit_file' || name === 'edit') {
      const oldText = firstString(args, ['old_string', 'oldText', 'old_str']);
      const newText = firstString(args, ['new_string', 'newText', 'new_str']);
      if (!oldText && !newText) return null;
      view.hidden += diffLinesFrom(oldText, 'del', view.lines);
      view.hidden += diffLinesFrom(newText, 'add', view.lines);
      return view;
    }
    if (name === 'Write' || name === 'write_file' || name === 'write') {
      const content = firstString(args, ['content', 'text', 'new_string']);
      if (!content) return null;
      view.hidden += diffLinesFrom(content, 'add', view.lines);
      return view;
    }
    return null;
  }

  interface DiffStat { added: number; removed: number }

  /* 行数计——参考里的 `Edited x.html +17 -5`：加/删都算「行」，不数字符。
     尾部换行不算一行，否则每次编辑都会多出一个假的 +1。 */
  function countLines(text: string): number {
    if (text === '') return 0;
    const parts = text.split('\n');
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    return parts.length;
  }

  function firstString(args: Record<string, unknown>, keys: readonly string[]): string {
    return pickString(args, keys) ?? '';
  }

  /* 编辑类工具的行数增减。认不出的编辑形态返回 null——宁可不显示，
     也不给一个编出来的数字。 */
  function deriveDiffStat(name: string, argsRaw: string): DiffStat | null {
    if (!argsRaw) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(argsRaw); } catch { return null; }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const args = parsed as Record<string, unknown>;
    if (name === 'Edit' || name === 'edit_file' || name === 'edit') {
      const oldText = firstString(args, ['old_string', 'oldText', 'old_str']);
      const newText = firstString(args, ['new_string', 'newText', 'new_str']);
      if (!oldText && !newText) return null;
      return { added: countLines(newText), removed: countLines(oldText) };
    }
    if (name === 'Write' || name === 'write_file' || name === 'write') {
      const content = firstString(args, ['content', 'text', 'new_string']);
      if (!content) return null;
      return { added: countLines(content), removed: 0 };
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
    callId: string;
    diffStat: DiffStat | null;
  }

  function toolRowModel(
    name: string,
    argsRaw: string,
    result?: { text?: string; isError?: boolean; interrupted?: boolean },
    callId = '',
  ): ToolRowModel {
    const variant = classifyTool(name);
    const state: ToolState = result === undefined ? 'running'
      : result.interrupted ? 'stopped'
        : result.isError ? 'error' : 'ok';
    const base = argsRaw === '' ? name : deriveSummary(variant, argsRaw);
    // 认不出的工具直接用自己的名字当标题——「Tool call ·」这种前缀和
    // 「· {}」这种尾巴都不提供任何信息，只是把行撑长。
    const title = isBlockedResult(result) ? 'Blocked' : SUBAGENT_TOOLS.has(name)
      ? state === 'running' ? 'Running subagent' : 'Subagent'
      : TOOL_TITLES[name] ?? (variant === 'others' ? name : VARIANT_TITLES[variant]);
    const summary = variant === 'others' || name === 'list_dir' ? '' : base;
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
      callId,
      diffStat: deriveDiffStat(name, argsRaw),
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

  /* 命令类工具的那条命令：首行进卡头，其余进卡体。非命令类返回 null，
     调用方退回用参数 JSON 当卡体。 */
  interface ToolCommand { first: string; rest: string; full: string }

  function toolCommandOf(model: ToolRowModel): ToolCommand | null {
    if (!model.argsRaw) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(model.argsRaw); } catch { return null; }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const args = parsed as Record<string, unknown>;
    const raw = model.variant === 'bash'
      ? pickString(args, ['command', 'cmd'])
      : model.variant === 'code' ? pickString(args, ['code']) : undefined;
    if (!raw) return null;
    const lines = String(raw).split('\n');
    return { first: lines[0], rest: lines.slice(1).join('\n'), full: String(raw) };
  }

  function commandPrompt(model: ToolRowModel): string {
    return model.name === 'pwsh' ? '>' : '$';
  }

  /* 语法高亮来自 DshHighlight（自己的模块，也能被 Node 侧的 shim 测试加载）。
     加载不到、或者它抛了，都退回一整段纯文本——一张没上色的代码卡仍然可读，
     一张空的卡不是。 */
  interface HighlightSpan { text: string; token: string }
  function highlightLines(text: string, lang: string): HighlightSpan[][] | null {
    const api = typeof globalThis !== 'undefined'
      ? (globalThis as unknown as { DshHighlight?: { highlight?: (code: string, lang: string) => HighlightSpan[][] } }).DshHighlight
      : undefined;
    if (!api || typeof api.highlight !== 'function') return null;
    try {
      const lines = api.highlight(text, lang);
      return Array.isArray(lines) ? lines : null;
    } catch {
      return null;
    }
  }

  function highlightLang(toolName: string, command: string): string {
    const api = typeof globalThis !== 'undefined'
      ? (globalThis as unknown as { DshHighlight?: { langFor?: (name: string, command: string) => string } }).DshHighlight
      : undefined;
    if (!api || typeof api.langFor !== 'function') return 'plain';
    try {
      return String(api.langFor(toolName, command) || 'plain');
    } catch {
      return 'plain';
    }
  }

  /* 一行代码 → 若干带 token 类的 span。拼起来必须和原行一模一样，所以拿不到
     高亮时给的就是整行原文，不会少字符。 */
  function codeLineNode(line: string, spans: HighlightSpan[] | undefined): DshNode {
    const node = h('span', { class: 'dsh-code-line' });
    if (!spans || spans.length === 0) {
      attach(node, line);
      return node;
    }
    for (const span of spans) {
      const piece = h('span', { class: `dsh-tok-${String(span.token || 'plain')}` });
      attach(piece, String(span.text ?? ''));
      attach(node, piece);
    }
    return node;
  }

  function codeBodyNode(text: string, lang: string): DshNode {
    const lines = text.split('\n');
    const highlighted = highlightLines(text, lang);
    const code = h('code');
    lines.forEach((line, index) => {
      if (index > 0) attach(code, '\n');
      attach(code, codeLineNode(line, highlighted ? highlighted[index] : undefined));
    });
    return code;
  }

  /* 工具展开后的两种形态，参考里是分开的：
     - 单行命令 → 终端卡。`$ ls …` 的头和它的输出在同一张卡里，输出可滚。
     - 多行命令 → 代码卡。整段脚本带语法高亮进卡，输出在卡外当正文读。
     区别是有道理的：一条命令加它的输出本来就是一个终端会话；一段脚本是
     一份清单，它的回执不该长在清单里面。 */
  function commandCardNode(
    command: ToolCommand,
    prompt: string,
    copyText: string,
    options: { output?: string | null; error?: boolean; lang?: string; toolName?: string } = {},
  ): DshNode {
    const lang = options.lang || highlightLang(String(options.toolName || ''), command.full);
    const card = h('div', { class: 'dsh-code' });
    const head = h('div', { class: 'dsh-code-head' });
    const line = h('span', { class: 'dsh-code-first' });
    if (prompt) {
      const mark = h('span', { class: 'dsh-code-prompt', 'aria-hidden': 'true' });
      attach(mark, prompt);
      attach(line, mark);
    }
    attach(line, codeLineNode(command.first, highlightLines(command.first, lang)?.[0]));
    const copy = h('button', {
      type: 'button',
      class: 'dsh-action dsh-code-copy',
      'aria-label': '复制命令',
      'data-dsh-act': 'copy',
      'data-dsh-copy': String(copyText || ''),
    });
    attach(copy, icon('copy', 14));
    attach(head, line);
    attach(head, copy);
    attach(card, head);
    if (command.rest) {
      const pre = h('pre');
      attach(pre, codeBodyNode(command.rest, lang));
      attach(card, pre);
    }
    if (options.output) {
      const body = h('div', { class: 'dsh-code-body' });
      if (options.error) body.setAttribute('data-error', 'true');
      attach(body, codeBodyNode(String(options.output), 'plain'));
      attach(card, body);
    }
    return card;
  }

  function toolRowNode(model: ToolRowModel): DshNode {
    const root = h('div', { class: 'dsh-tool' });
    root.setAttribute('data-tool', '');
    root.setAttribute('data-state', model.state);

    const summaryText = model.summary;
    const status = model.state === 'running' ? '运行中' : model.state === 'error' ? '失败' : model.state === 'stopped' ? '已停止' : '';

    if (status) {
      const vh = h('span', { class: 'dsh-vh' });
      attach(vh, status);
      attach(root, vh);
    }

    const collapsed: DshNode[] = [];
    if (summaryText !== '') {
      /* Claude's tool rows read as a plain action phrase ("Read file.md"),
         not the dotted metadata grammar used by the thinking row. */
      const sep = h('span', { class: 'dsh-tool-sep', 'aria-hidden': 'true' });
      attach(sep, ' ');
      collapsed.push(sep);
      const summary = h('span', { class: 'dsh-summary' });
      attach(summary, summaryText);
      collapsed.push(summary);
    }

    /* 参考里编辑行的收尾是一对行数增减（绿加红删），只在行里露一眼，
       完整 diff 仍在展开体里。 */
    if (model.diffStat && (model.diffStat.added > 0 || model.diffStat.removed > 0)) {
      const stat = h('span', { class: 'dsh-diff-stat', 'aria-hidden': 'true' });
      if (model.diffStat.added > 0) {
        const add = h('span', { class: 'dsh-diff-add' });
        attach(add, `+${model.diffStat.added}`);
        attach(stat, add);
      }
      if (model.diffStat.removed > 0) {
        const del = h('span', { class: 'dsh-diff-del' });
        attach(del, `−${model.diffStat.removed}`);
        attach(stat, del);
      }
      collapsed.push(stat);
    }

    /* 参考里展开的工具行是「一张代码卡 + 卡下面的原文输出」：卡头是命令首行
       加提示符和复制钮，卡体是其余行；输出是普通正文，出错时红字。标签式的
       IN/OUT 分栏在参考里没有——它把「输入」和「输出」摆成两件事，而人读的
       其实是「跑了什么」和「回了什么」。 */
    const body: DshNode[] = [];
    const diff = deriveDiff(model.name, model.argsRaw ?? '');
    const command = toolCommandOf(model);
    /* 单行命令的输出进卡，多行命令的输出留在卡外——见 commandCardNode 上面
       那段注释。 */
    const singleLine = command !== null && command.rest === '';
    let outputInCard = false;
    if (diff !== null && (model.body !== null || model.output !== null)) {
      body.push(diffNode(diff));
    } else if (command !== null) {
      /* 参考里卡片上方另起一行写工具名（`Bash`，蓝色）。它回答的是「这是谁跑的」，
         和卡里的命令不是一回事，所以不并进卡头。 */
      if (singleLine) {
        const tag = h('div', { class: 'dsh-tool-tag' });
        attach(tag, model.name);
        body.push(tag);
      }
      body.push(commandCardNode(command, commandPrompt(model), command.full, {
        output: singleLine ? model.output : null,
        error: model.state === 'error',
        toolName: model.name,
      }));
      outputInCard = singleLine && model.output !== null;
    } else if (model.body !== null) {
      body.push(commandCardNode({ first: model.title, rest: model.body, full: model.body }, '', model.body));
    }
    if (model.output !== null && !outputInCard) {
      const output = h('div', { class: 'dsh-tool-output' });
      if (model.state === 'error') output.setAttribute('data-error', 'true');
      attach(output, model.output);
      body.push(output);
    }

    const isSubagent = SUBAGENT_TOOLS.has(model.name) && Boolean(model.callId);
    const { root: disclosure, row: disclosureAction } = disclosureRow({
      iconName: undefined,
      leadingClass: 'dsh-tool-caret',
      title: model.title,
      collapsed,
      body: body.length ? body : null,
      expandable: !isSubagent && body.length > 0,
      open: false,
    });

    if (isSubagent) {
      disclosure.setAttribute('data-subagent-row', '');
      disclosureAction.setAttribute('data-dsh-act', 'open-subagent');
      disclosureAction.setAttribute('data-subagent-parent-call-id', model.callId);
      disclosureAction.setAttribute('role', 'button');
      disclosureAction.setAttribute('tabindex', '0');
    }

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
    const viewport = h('div', { class: 'dsh-think-viewport' });
    attach(viewport, body);
    const isLong = !running && (reasoning.length > 420 || reasoning.split('\n').length > 8);
    attach(viewport, h('span', { class: 'dsh-think-fade', 'aria-hidden': 'true' }));
    const expandedBody: DshNode[] = [viewport];
    {
      const more = h('button', { type: 'button', class: 'dsh-think-more' });
      more.setAttribute('data-dsh-act', 'think-more');
      attach(more, 'Show more');
      expandedBody.push(more);
    }

    const { root } = disclosureRow({
      iconName: 'think',
      title: running ? 'Thinking…' : 'Thought',
      collapsed: [h('span', { class: 'dsh-sep', 'aria-hidden': 'true' }), summary],
      body: expandedBody,
      expandable: true,
      open: false,
    });
    root.setAttribute('data-state', running ? 'running' : 'ok');
    root.setAttribute('class', 'dsh-disclosure dsh-think');
    if (isLong) {
      root.setAttribute('data-long', 'true');
      root.setAttribute('data-expanded', 'false');
    }
    return root;
  }

  function updateThinkingState(node: HTMLElement, text: string, running: boolean): void {
    node.setAttribute('data-state', running ? 'running' : 'ok');
    node.querySelector('.dsh-title')!.textContent = running ? 'Thinking…' : 'Thought';
    const summary = node.querySelector('.dsh-summary')!;
    const preview = running ? latestLine(text) : firstLine(text);
    if (summary.textContent !== preview) summary.textContent = preview;
    if (running) summary.setAttribute('data-follow-end', 'true');
    else summary.removeAttribute('data-follow-end');
    node.setAttribute('data-long', String(!running && (text.length > 420 || text.split('\n').length > 8)));
    if (node.getAttribute('data-expanded') === null) node.setAttribute('data-expanded', 'false');
  }

  /* ---- 消息动作行（悬停后才出现：时间 + 分支 + 复制） ---- */
  function formatClock(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /* 参考里的悬停行给的是相对时间（`23 minutes ago`）：读的人想知道「多久
     以前」，不是「几点几分」。超过一周才退回绝对时间——「87 天前」没有人
     会去心算。 */
  const MINUTE_MS = 60_000;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;

  function relativeTime(ms: number, now = Date.now()): string {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const delta = Math.max(0, now - ms);
    if (delta < 45 * 1000) return '刚刚';
    if (delta < HOUR_MS) return `${Math.round(delta / MINUTE_MS)} 分钟前`;
    if (delta < DAY_MS) return `${Math.round(delta / HOUR_MS)} 小时前`;
    if (delta < 7 * DAY_MS) return `${Math.round(delta / DAY_MS)} 天前`;
    return formatClock(ms);
  }

  function absoluteTime(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatClock(ms)}`;
  }

  interface BranchTarget { conversationId: string; turnIndex: number }

  /* skip 用来排开空白时间戳，避免给横条多留一个 6px 的间隙。 */
  function timeNode(ms: number | undefined): DshNode | null {
    if (!ms || !Number.isFinite(ms)) return null;
    const label = relativeTime(ms);
    if (!label) return null;
    const node = h('span', { class: 'dsh-action-time', title: absoluteTime(ms) });
    attach(node, label);
    return node;
  }

  function messageActions(
    message: string,
    branch?: BranchTarget,
    timeMs?: number,
    options: { align?: 'user' | 'assistant'; retry?: boolean } = {},
  ): DshNode {
    const actions = h('div', { class: 'dsh-actions' });
    actions.setAttribute('data-align', options.align === 'user' ? 'user' : 'assistant');
    const time = timeNode(timeMs);
    /* 参考里用户气泡的时间在图标左边，助手回合的在图标右边。 */
    if (time && options.align === 'user') attach(actions, time);
    /* 三枚图标对应参考里的 ⧉ ↻ ⌥：复制、重发、从这里分支。参考还有一枚
       朗读——本机还没有把回答读出来的通道，所以那一枚先不放，不放一个按不动
       的按钮。 */
    const copy = h('button', { type: 'button', class: 'dsh-action', 'aria-label': '复制' });
    copy.setAttribute('data-dsh-act', 'copy');
    copy.setAttribute('data-dsh-copy', String(message || ''));
    attach(copy, icon('copy', 16));
    attach(actions, copy);

    const retry = h('button', { type: 'button', class: 'dsh-action', 'aria-label': '重新发送' });
    retry.setAttribute('data-dsh-act', 'retry');
    retry.setAttribute('data-dsh-retry', String(message || ''));
    attach(retry, icon('retry', 16));
    attach(actions, retry);

    if (branch?.conversationId && Number.isInteger(branch.turnIndex)) {
      const fork = h('button', { type: 'button', class: 'dsh-action', 'aria-label': '从这里创建分支' });
      fork.setAttribute('data-dsh-act', 'branch');
      fork.setAttribute('data-dsh-branch-conversation', branch.conversationId);
      fork.setAttribute('data-dsh-branch-turn', String(branch.turnIndex));
      attach(fork, icon('branch', 16));
      attach(actions, fork);
    }
    if (time && options.align !== 'user') attach(actions, time);
    return actions;
  }

  /* ---- 用户消息节点（UserMessageNodeView） ---- */
  function userNode(question: string, timeMs?: number, branch?: BranchTarget): DshNode {
    const root = h('div', { class: 'dsh-user' });
    const stack = h('div', { class: 'dsh-user-stack' });
    const bubble = h('div', { class: 'dsh-bubble' });
    attach(bubble, question);
    attach(stack, bubble);
    attach(root, stack);
    attach(root, messageActions(question, branch, timeMs, { align: 'user' }));
    return root;
  }

  /* ---- 权限回执（回答一道权限门的那一轮） ----
     用户点的是审批卡上的一个选项，不是发了一条消息。画成气泡会让它读起来像
     新起的一轮对话；这里画成一枚回执，说明「谁被授权了/被拒了」。 */
  function permissionAnswerNode(answer: { decision?: string; rule?: string }): DshNode {
    const decision = String(answer?.decision || '');
    const rule = String(answer?.rule || '');
    const root = h('div', { class: 'dsh-perm-receipt' });
    root.setAttribute('data-decision', decision);
    const label = h('span', { class: 'dsh-perm-receipt-label' });
    attach(label, decision === 'deny' ? '已拒绝' : decision === 'once' ? '允许一次' : '本会话允许');
    const target = h('code', { class: 'dsh-perm-receipt-rule' });
    attach(target, rule);
    attach(root, label);
    if (rule) attach(root, target);
    return root;
  }

  /* ---- 产物卡（Published artifact） ----
     参考里它有固定的两行：上行是「发布了什么」，右端一枚描边的 Open；下行是
     产物本体，右端一行增减和一个可以点进去的箭头。
     我们这边下行没有文件名的位置（产物是草稿，不是文件），所以放的是它的
     形态和修订号——都是真有的字段，不是照着形状补的。 */
  function artifactCardNode(items: Array<Record<string, unknown>>, conversationId: string): DshNode | null {
    const usable = items.filter((item) => item && typeof item === 'object' && String(item.artifactId || ''));
    if (!usable.length) return null;
    const card = h('div', { class: 'dsh-artifact-card' });
    for (const item of usable) {
      const artifactId = String(item.artifactId || '');
      const name = String(item.name || '').trim() || '未命名草稿';
      const kind = String(item.kind || '').trim();
      const revision = Number(item.revision);
      const head = h('div', { class: 'dsh-artifact-head' });
      const label = h('span', { class: 'dsh-artifact-label' });
      const prefix = h('span', { class: 'dsh-artifact-label-prefix' });
      attach(prefix, 'Published artifact');
      attach(label, prefix);
      attach(label, name);
      attach(head, label);
      const open = h('button', {
        type: 'button',
        class: 'dsh-artifact-open',
        'data-dsh-act': 'open-artifact',
        'data-artifact-id': artifactId,
        'data-artifact-conversation': conversationId,
      });
      attach(open, 'Open');
      attach(head, open);
      attach(card, head);

      const row = h('div', { class: 'dsh-artifact-row' });
      const mark = h('span', { class: 'dsh-artifact-mark', 'aria-hidden': 'true' });
      /* 参考里这一枚是个小小的「产物」记号。我们这边没有对应的原始图标，
         所以用现成的 browse（几行文字），而不是照着形状画一个新的。 */
      attach(mark, icon('browse', 14));
      attach(row, mark);
      const meta = h('span', { class: 'dsh-artifact-meta' });
      attach(meta, [kind, Number.isInteger(revision) && revision > 0 ? `修订 ${revision}` : ''].filter(Boolean).join(' · ') || '草稿');
      attach(row, meta);
      const chev = h('span', { class: 'dsh-artifact-chev', 'aria-hidden': 'true' });
      attach(chev, icon('chev', 14));
      attach(row, chev);
      row.setAttribute('data-dsh-act', 'open-artifact');
      row.setAttribute('data-artifact-id', artifactId);
      row.setAttribute('data-artifact-conversation', conversationId);
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      attach(card, row);
    }
    return card;
  }

  /* ---- 回合状态行（turnStatus 渐变字） ----
     参考里运行中的那一行是：橙色星芒 + `12m 59s · 3.6k tokens · Almost done
     thinking…`。计时是前缀，阶段名是句尾——所以这里给计时留一个空槽，
     由渲染层按秒原地写进去（写空槽不重建节点，星芒的旋转动画不会被打断）。 */
  /* 运行态那颗星芒用的是 Claude 自己的 Spark（claude_marks.ts 里原样收的
     spark.svg），不再是 CSS clip-path 拼出来的近似多边形——那个形状无论怎么
     调都差一口气，而参考里的这个是有原始路径的。
     取不到 ClaudeMarks 时留一个空壳：星芒是装饰，它缺席不该让整行塌掉。 */
  function sparkMark(running = true): DshNode {
    const root = h('span', { class: running ? 'dsh-thinking-mark' : 'dsh-run-meta-mark', 'aria-hidden': 'true' });
    const api = typeof globalThis !== 'undefined'
      ? (globalThis as unknown as { ClaudeMarks?: { spark?: (state: 'thinking' | 'idle') => string } }).ClaudeMarks
      : undefined;
    const markup = api && typeof api.spark === 'function' ? api.spark(running ? 'thinking' : 'idle') : '';
    if (markup && 'innerHTML' in root) {
      (root as unknown as HTMLElement).innerHTML = markup;
    }
    return root;
  }

  function turnStatusNode(label: string): DshNode {
    const root = h('div', { class: 'dsh-turn-status', role: 'status', 'aria-label': label });
    attach(root, sparkMark());
    /* 计时与阶段名是同一条句子的两段，中间的分隔符由 CSS 生成：
       计时为空时整段消失，不留下一个孤零零的「·」。 */
    const copy = h('span', { class: 'dsh-turn-status-copy' });
    /* h() 会丢掉空串属性，所以标记位给一个真值；计时槽本身仍以文本为空
       来表示「还没开始计时」。 */
    attach(copy, h('span', { class: 'dsh-turn-status-meta', 'data-turn-meta': 'true' }));
    const labelNode = h('span', { class: 'dsh-turn-status-label' });
    if (label === 'Thinking') labelNode.setAttribute('data-quiet', 'true');
    attach(labelNode, label);
    attach(copy, labelNode);
    attach(root, copy);
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
    error?: string;
    running?: boolean;
    at?: number;
    conversationId?: string;
    turnIndex?: number;
    artifacts?: Array<Record<string, unknown>>;
  }

  interface TurnChip {
    name: string;
    argsRaw: string;
    callId: string;
    groupLabel?: string;
    displayLabel?: string;
    result?: { text: string; isError: boolean; interrupted?: boolean };
    subagent?: Record<string, unknown>;
  }

  type FlowItem =
    | { type: 'narration'; text: string }
    | { type: 'reasoning'; text: string }
    | { type: 'notice'; text: string }
    | { type: 'chip'; chip: TurnChip };

  /* 叙述走 markdown，和最终答案同一条渲染路径。轮间叙述里模型一样会写
     `**加粗**` 和反引号——按纯文本画出来的就是字面上的星号，而它出现在
     用户判断「它在说什么」的那一句里。 */
  function narrationNode(text: string): DshNode {
    const root = h('div', { class: 'dsh-narration' });
    attach(root, markdownRenderer.render(text));
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
    const model = toolRowModel(chip.name, chip.argsRaw, chip.result, chip.callId);
    if (chip.displayLabel?.trim()) {
      model.title = chip.displayLabel.trim();
      model.summary = '';
    }
    const node = toolRowNode(model);
    if (SUBAGENT_TOOLS.has(chip.name)) {
      attach(node, h('div', { class: 'dsh-subagent-heartbeat' }, subagentHeartbeat(chip.subagent)));
    }
    return node;
  }

  function subagentHeartbeat(child?: Record<string, unknown>): string {
    if (!child) return '';
    const phase = child.status !== 'running' ? String(child.status || '')
      : child.currentTool ? String(child.currentTool) : child.phase === 'writing' ? 'Writing' : 'Thinking';
    const preview = child.phase === 'writing' ? child.answer : child.reasoning;
    return [phase, Number(child.stepCount) ? `${child.stepCount} tools` : '',
      Number(child.elapsedMs) >= 1000 ? `${Math.floor(Number(child.elapsedMs) / 1000)}s` : '',
      latestLine(String(preview || child.summary || ''))].filter(Boolean).join(' · ');
  }

  /* 连续同类读取/搜索折成一条组头（CC "Read 2 files" 契约）。 */
  /* 连续的一串工具调用 = 参考里那种「整合起来的条」：组头一行语义标签 +
     chevron，默认展开露出组内芯片，点击收起只留组头。混合工具也成组——
     参考的 Found files, ran a command 就是一个混合串，按工具种类硬拆是
     上一版模仿不到位的原因。 */
  function toolGroupNode(chips: TurnChip[], _running = false, work?: FlowItem[]): DshNode {
    const root = h('details', { class: 'dsh-tool-group' });
    const summary = h('summary', { class: 'dsh-tool-group-header' });
    const label = h('span', { class: 'dsh-tool-group-title' });
    const single = chips.length === 1 && !work?.some(item => item.type === 'reasoning');
    if (single) root.setAttribute('data-single', 'true');
    const model = single ? toolRowModel(chips[0].name, chips[0].argsRaw, chips[0].result, chips[0].callId) : null;
    attach(label, model ? (chips[0].displayLabel || [model.title, model.summary].filter(Boolean).join(' ')) : toolGroupLabel(chips));
    if (model?.diffStat) {
      const stat = h('span', { class: 'dsh-diff-stat', 'aria-hidden': 'true' });
      if (model.diffStat.added) attach(stat, h('span', { class: 'dsh-diff-add' }, `+${model.diffStat.added}`));
      if (model.diffStat.removed) attach(stat, h('span', { class: 'dsh-diff-del' }, `−${model.diffStat.removed}`));
      attach(label, stat);
    }
    const chev = h('span', { class: 'dsh-tool-group-chev', 'aria-hidden': 'true' });
    attach(chev, icon('chev', 14));
    attach(summary, label);
    attach(summary, chev);
    const body = h('div', { class: 'dsh-tool-group-body' });
    const entries: FlowItem[] = work || chips.map(chip => ({ type: 'chip', chip }));
    entries.forEach((entry) => {
      if (entry.type === 'reasoning') {
        attach(body, thinkNode(entry.text));
        return;
      }
      if (entry.type !== 'chip') return;
      const chip = entry.chip;
      const node = chipNode(chip);
      if (single) {
        const disclosure = DOC ? (node as Element).querySelector('.dsh-disclosure')
          : (node as ShimNode).children.find(child => typeof child !== 'string' && child.attrs.class === 'dsh-disclosure') as ShimNode | undefined;
        disclosure?.setAttribute('data-open', 'true');
      }
      attach(body, node);
    });
    attach(root, summary);
    attach(root, body);
    return root;
  }

  /* 组头是「这一串到底干了什么」的一句话：按动作种类分句，失败数跟在
     对应分句后面，最后一项用 and/逗号收尾——参考里的原文就是这样长出来的：
     `Ran 25 commands (1 failed), fetched 4 pages, browsed the web, used 2 tools`。 */
  const GROUP_CLAUSES: Record<ToolVariant, (n: number) => string> = {
    bash: (n) => `Ran ${n} command${n === 1 ? '' : 's'}`,
    read: (n) => `Read ${n} file${n === 1 ? '' : 's'}`,
    search: (n) => `Searched ${n} time${n === 1 ? '' : 's'}`,
    write: (n) => `Wrote ${n} file${n === 1 ? '' : 's'}`,
    edit: (n) => `Edited ${n} file${n === 1 ? '' : 's'}`,
    code: (n) => `Used ${n} tool${n === 1 ? '' : 's'}`,
    others: (n) => `Used ${n} tool${n === 1 ? '' : 's'}`,
  };

  const GROUP_ORDER: readonly ToolVariant[] = ['bash', 'read', 'search', 'edit', 'write', 'code', 'others'];

  function isBlockedResult(result?: { text?: string; isError?: boolean }): boolean {
    return result?.isError === true && /permission[_ ](?:denied|required)|source access denied|not allowed/i.test(result.text || '');
  }

  function failedCount(chips: TurnChip[]): number {
    return chips.filter((chip) => chip.result?.isError === true).length;
  }

  function toolGroupLabel(chips: TurnChip[]): string {
    const blocked = chips.filter(chip => isBlockedResult(chip.result));
    if (blocked.length) {
      const executed = chips.filter(chip => !isBlockedResult(chip.result));
      return `Blocked ${blocked.length} tool${blocked.length === 1 ? '' : 's'}`
        + (executed.length ? `, ${toolGroupLabel(executed)}` : '');
    }
    const explicit = chips.find((chip) => typeof chip.groupLabel === 'string' && chip.groupLabel.trim());
    if (explicit?.groupLabel) return explicit.groupLabel.trim();
    const counts = new Map<ToolVariant, number>();
    /* 失败数要挂在「真的失败的那一类」上，不是挂在最后一句上：参考里读到的
       是 `Ran 25 commands (1 failed), fetched 4 pages`——failed 跟着它属的
       那个动词。 */
    const failures = new Map<ToolVariant, number>();
    for (const chip of chips) {
      const variant = classifyTool(chip.name);
      counts.set(variant, (counts.get(variant) || 0) + 1);
      if (chip.result?.isError === true) failures.set(variant, (failures.get(variant) || 0) + 1);
    }
    const order = GROUP_ORDER.filter((variant) => counts.has(variant));
    const clauseFor = (variant: ToolVariant) => {
      const base = GROUP_CLAUSES[variant](counts.get(variant) as number);
      const failed = failures.get(variant) || 0;
      return failed > 0 ? `${base} (${failed} failed)` : base;
    };
    if (order.length === 1) return clauseFor(order[0]);
    if (!order.length) return `Ran ${chips.length} tools`;
    const failed = failedCount(chips);
    const placed = [...failures.keys()].some((variant) => order.includes(variant));
    const parts = order.map(clauseFor);
    /* 单个动作的组已经在 clauseFor 里标好了；只有「失败的那类不在分组里」
       这种对不上的情况，才退化到整句尾部标注，保证失败永远不会被吞掉。 */
    if (failed > 0 && !placed) parts[parts.length - 1] = `${parts[parts.length - 1]} (${failed} failed)`;
    return parts
      .map((part, index) => (index === 0 ? part : part.charAt(0).toLowerCase() + part.slice(1)))
      .join(', ');
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
    const mark = sparkMark(false);
    const copy = h('span', { class: 'dsh-run-meta-copy' });
    attach(copy, meta);
    attach(root, mark);
    attach(root, copy);
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
        const reasoning = String(record.reasoning || '').trim();
        if (reasoning) items.push({ type: 'reasoning', text: reasoning });
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
          callId: String(record.callId || ''),
          subagent: record.subagent as Record<string, unknown> | undefined,
          groupLabel: typeof record.groupLabel === 'string' ? record.groupLabel : undefined,
          displayLabel: typeof record.summary === 'string' ? record.summary : undefined,
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
          callId: String(event.callId || event.id || ''),
          groupLabel: typeof event.groupLabel === 'string' ? event.groupLabel : undefined,
          displayLabel: typeof event.summary === 'string' ? event.summary : undefined,
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

    if (turn.thinking && !turn.trajectory?.some(record => record.reasoning)) attach(bodyHost, thinkNode(turn.thinking, Boolean(turn.running)));

    /* CC 折叠协议：模型的轮间叙述是可见的散文，工具调用是单行可扫描的
       芯片（动词 + 最有辨识度的参数），证据保留在展开体里。没有内容的
       "模型轮次"不再画成行——耗时与 token 进尾部 meta。 */
    const flow = trajectoryFlowItems(turn) ?? eventFlowItems(turn);
    let chipRun: TurnChip[] = [];
    let workRun: FlowItem[] = [];
    const flushChips = () => {
      if (!chipRun.length) return;
      attach(bodyHost, toolGroupNode(chipRun, false, workRun));
      chipRun = [];
      workRun = [];
    };
    for (const item of flow) {
      if (item.type === 'reasoning') {
        if (chipRun.length) workRun.push(item);
        else attach(bodyHost, thinkNode(item.text));
      } else if (item.type === 'narration') {
        flushChips();
        attach(bodyHost, narrationNode(item.text));
      } else if (item.type === 'notice') {
        flushChips();
        attach(bodyHost, noticeNode(item.text));
      } else {
        chipRun.push(item.chip);
        workRun.push(item);
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
    if (turn.answer) {
      attach(bodyHost, markdownRenderer.render(turn.answer));
    }

    /* Claude places the compact run summary after the answer, so it reads as
       metadata for the completed turn rather than as another activity row. */
    if (times.length && doneTimes.length) {
      const elapsed = Math.max(0, Math.max(...doneTimes) - Math.min(...times));
      attach(bodyHost, runMetaNode(formatRunMeta(elapsed, totalTokens || null)));
    }

    if (turn.failed) {
      attach(bodyHost, turnErrorNode(turn.error || '这次没能完成。'));
    }

    if (turn.running && !turn.answer && !turn.thinking) {
      attach(bodyHost, turnStatusNode('Thinking'));
    }

    attach(root, bodyHost);
    if (turn.answer) attach(root, messageActions(
      turn.answer,
      turn.conversationId && Number.isInteger(turn.turnIndex)
        ? { conversationId: turn.conversationId, turnIndex: Number(turn.turnIndex) }
        : undefined,
      turn.at,
      { align: 'assistant' },
    ));
    /* 产物卡挂在这一轮的末尾：它是这一轮的产出，所以出现在下一条用户消息
       之前，也就是参考里那个位置。 */
    const artifacts = Array.isArray(turn.artifacts) ? turn.artifacts : [];
    const artifactCard = artifactCardNode(artifacts, String(turn.conversationId || ''));
    if (artifactCard) attach(root, artifactCard);
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
      /* 参数跟着结果回来（tool_call 那一刻运行时还没有参数），所以这一行在
         完成时才能写成「Ran curl -L -o x.pdf」。 */
      const argsRaw = String(fields.args || '');
      /* 后端是「它是怎么做到的」，对排障有用；耗时不是——参考的工具行不报
         毫秒，而且被权限门拦下的工具耗时是 0.0，写出来只是一行「0.0ms」。
         亚毫秒本来就量不出东西，一并丢掉。 */
      const latencyMs = Number(fields.latency_ms);
      const detail = done
        ? [
          fields.backend && fields.backend !== '-' ? String(fields.backend) : '',
          Number.isFinite(latencyMs) && latencyMs >= 1 ? `${Math.round(latencyMs)}ms` : '',
        ].filter(Boolean).join(' · ')
        : '';
      return toolRowNode(toolRowModel(name, argsRaw, done ? {
        text: fields.result !== undefined ? String(fields.result) : detail,
        isError: fields.state === 'error',
      } : undefined, String(fields.id || '')));
    }
    /* 非工具阶段 = 单行运行状态(CC/DSH 金标准):StateDot 渐变字,原地更新,
       绝不逐条堆叠成 Think 行;内部管道细节在轨迹视图里看。 */
    return turnStatusNode(liveStatusLabel(phase, fields));
  }

  interface LiveTurnSnapshot {
    answer?: string;
    thinking?: string;
    records?: Array<Record<string, unknown>>;
    requestId?: string;
    agentSessionId?: string;
    trajectory?: Array<Record<string, unknown>>;
  }

  /* Both task surfaces keep the same DOM for an active turn. Text growth never
     detaches disclosures, resets their scroll, or restarts status animations. */
  function createLiveTurn(host: HTMLElement) {
    const rows = new Map<string, { node: HTMLElement; record: string }>();
    let answer: HTMLElement | null = null;
    let thinking: HTMLElement | null = null;
    let answerText = '';
    let thinkingText = '';
    const traceNodes = new Map<string, { node: HTMLElement; signature: string }>();
    let traceStatus: HTMLElement | null = null;
    const appendText = (node: HTMLElement, previous: string, next: string) => {
      if (previous === next) return;
      if (next.startsWith(previous)) {
        node.appendChild(document.createTextNode(next.slice(previous.length)));
        if (node.childNodes.length > 32) node.textContent = next;
      } else node.textContent = next;
    };
    return {
      update(snapshot: LiveTurnSnapshot) {
        if (!host.className.split(' ').includes('dsh-live-turn')) host.className += ' dsh-live-turn';
        if (snapshot.trajectory?.length) {
          const desired: HTMLElement[] = [];
          const render = (key: string, value: unknown, make: () => DshNode) => {
            const signature = JSON.stringify(value);
            let entry = traceNodes.get(key);
            if (!entry) {
              entry = { node: make() as HTMLElement, signature };
              traceNodes.set(key, entry);
            } else if (entry.signature !== signature) {
              if (key.startsWith('message:') || key.startsWith('reasoning:')) {
                const target = key.startsWith('reasoning:') ? entry.node.querySelector<HTMLElement>('.dsh-think-body')! : entry.node;
                appendText(target, target.textContent || '', String(value));
                if (key.startsWith('reasoning:')) entry.node.querySelector('.dsh-summary')!.textContent = latestLine(String(value));
              } else {
                const open = entry.node.getAttribute('open') !== null;
                const expanded = Array.from(entry.node.querySelectorAll('.dsh-disclosure')).map(n => n.getAttribute('data-open'));
                const replacement = make() as HTMLElement;
                entry.node.replaceChildren(...Array.from(replacement.childNodes));
                if (replacement.getAttribute('data-single') === 'true') entry.node.setAttribute('data-single', 'true');
                else entry.node.removeAttribute('data-single');
                if (open) entry.node.setAttribute('open', '');
                else entry.node.removeAttribute('open');
                entry.node.querySelectorAll('.dsh-disclosure').forEach((n, i) => {
                  if (expanded[i] === 'true') {
                    n.setAttribute('data-open', 'true');
                    n.querySelector('.dsh-row')?.setAttribute('aria-expanded', 'true');
                  }
                });
              }
              entry.signature = signature;
            }
            desired.push(entry.node);
          };
          let chips: TurnChip[] = [];
          const flush = () => {
            if (!chips.length) return;
            const current = chips;
            render(`tools:${current[0].callId}`, current, () => toolGroupNode(current, true));
            chips = [];
          };
          snapshot.trajectory.forEach((record, index) => {
            if (record.kind === 'tool') {
              const chip: TurnChip = { name: String(record.name || 'tool'), callId: String(record.callId || index), argsRaw: String(record.text || ''),
                result: record.result == null ? undefined : { text: String(record.result), isError: Boolean(record.isError) } };
              if (SUBAGENT_TOOLS.has(chip.name)) {
                flush();
                const key = `agent:${chip.callId}`;
                render(key, chip, () => chipNode(chip));
                const child = record.subagent as Record<string, unknown> | undefined;
                const heartbeat = traceNodes.get(key)!.node.querySelector('.dsh-subagent-heartbeat')!;
                const text = subagentHeartbeat(child);
                if (heartbeat.textContent !== text) heartbeat.textContent = text;
              } else chips.push(chip);
            } else if (record.kind === 'message') {
              if (!record.text && !record.reasoning) return;
              flush();
              const key = String(record.turn || index);
              if (record.reasoning) {
                const running = record.state === 'running' && !record.text;
                render(`reasoning:${key}`, String(record.reasoning), () => thinkNode(String(record.reasoning), running));
                updateThinkingState(traceNodes.get(`reasoning:${key}`)!.node, String(record.reasoning), running);
              }
              if (record.text) render(`message:${key}`, String(record.text), () => h('div', { class: 'dsh-stream-live' }, String(record.text)));
            } else if (record.kind === 'notice') {
              flush();
              render(`notice:${index}`, record, () => noticeNode(String(record.text || '')));
            }
          });
          flush();
          if (!traceStatus) traceStatus = turnStatusNode('Thinking') as HTMLElement;
          const activeChildren = snapshot.trajectory.filter(r => r.kind === 'tool' && SUBAGENT_TOOLS.has(String(r.name)) && r.state === 'running').length;
          const activeTools = snapshot.trajectory.filter(r => r.kind === 'tool' && r.state === 'running').length;
          const statusText = activeChildren ? `${activeChildren} subagent${activeChildren === 1 ? '' : 's'} working`
            : activeTools ? 'Running tools' : snapshot.answer ? 'Writing' : 'Thinking';
          const statusLabel = traceStatus.querySelector('.dsh-turn-status-label');
          if (statusLabel && statusLabel.textContent !== statusText) statusLabel.textContent = statusText;
          desired.push(traceStatus);
          for (const child of Array.from(host.children)) if (!desired.includes(child as HTMLElement)) child.remove();
          desired.forEach((node, index) => { if (host.children[index] !== node) host.insertBefore(node, host.children[index] || null); });
          return;
        }
        const latest = new Map<string, Record<string, unknown>>();
        for (const record of snapshot.records || []) {
          const phase = String(record.phase || '');
          const fields = record.fields && typeof record.fields === 'object'
            ? record.fields as Record<string, unknown> : {};
          if (phase === 'tool_call' || phase === 'tool_result') {
            latest.set(`tool:${String(fields.id || fields.name || '')}`, record);
          } else if (['model_request', 'model_response', 'model_first_chunk', 'runtime_boot', 'agent_turn', 'agent_start', 'budget_renewed'].includes(phase)) {
            latest.set('status', record);
          }
        }
        if (!latest.has('status')) latest.set('status', { phase: 'model_request', fields: {} });
        const desired: HTMLElement[] = [];
        for (const [key, record] of latest) {
          const signature = JSON.stringify(record);
          let row = rows.get(key);
          if (!row) {
            row = { node: liveActivityNode(record) as HTMLElement, record: signature };
            rows.set(key, row);
          } else if (row.record !== signature) {
            if (key === 'status') {
              const label = liveStatusLabel(String(record.phase || ''), (record.fields || {}) as Record<string, unknown>);
              const copy = row.node.querySelector('.dsh-turn-status-label');
              if (copy && copy.textContent !== label) copy.textContent = label;
              row.node.setAttribute('aria-label', label);
            } else {
              const expanded = row.node.querySelector('.dsh-disclosure')?.getAttribute('data-open') === 'true';
              const replacement = liveActivityNode(record) as HTMLElement;
              row.node.setAttribute('data-state', replacement.getAttribute('data-state') || 'running');
              row.node.replaceChildren(...Array.from(replacement.childNodes));
              if (expanded) {
                row.node.querySelector('.dsh-disclosure')?.setAttribute('data-open', 'true');
                row.node.querySelector('.dsh-row')?.setAttribute('aria-expanded', 'true');
              }
            }
            row.record = signature;
          }
          desired.push(row.node);
        }
        const nextThinking = String(snapshot.thinking || '');
        if (nextThinking) {
          if (!thinking) thinking = thinkNode('', true) as HTMLElement;
          const body = thinking.querySelector<HTMLElement>('.dsh-think-body')!;
          appendText(body, thinkingText, nextThinking);
          const summary = thinking.querySelector('.dsh-summary')!;
          const latestSummary = latestLine(nextThinking);
          if (summary.textContent !== latestSummary) summary.textContent = latestSummary;
          thinkingText = nextThinking;
          updateThinkingState(thinking, nextThinking, !snapshot.answer);
          desired.push(thinking);
        }
        const nextAnswer = String(snapshot.answer || '');
        if (nextAnswer) {
          if (!answer) {
            answer = document.createElement('div');
            answer.className = 'dsh-stream-live';
            answer.setAttribute('aria-live', 'polite');
          }
          appendText(answer, answerText, nextAnswer);
          answerText = nextAnswer;
          desired.push(answer);
        }
        for (const child of Array.from(host.children)) {
          if (!desired.includes(child as HTMLElement)) child.remove();
        }
        desired.forEach((node, index) => {
          if (host.children[index] !== node) host.insertBefore(node, host.children[index] || null);
        });
      },
      finish(turn: AssistantTurnInput) {
        host.className = host.className.split(' ').filter(name => name !== 'dsh-live-turn').join(' ');
        host.replaceChildren(...assistantTurnNode(turn) as HTMLElement[]);
      },
    };
  }

  function createConversationView(flow: HTMLElement) {
    const turns = new Map<number, { host: HTMLElement; live: ReturnType<typeof createLiveTurn>; final: string | null }>();
    return {
      update(conversation: { id: string; turns?: Array<AssistantTurnInput & { question?: string; outcome?: string; liveProgress?: LiveTurnSnapshot; permissionAnswer?: { decision?: string; rule?: string } }> }) {
        for (const [turnIndex, turn] of (conversation.turns || []).entries()) {
          let current = turns.get(turnIndex);
          if (!current) {
            if (turn.permissionAnswer) flow.appendChild(permissionAnswerNode(turn.permissionAnswer) as HTMLElement);
            else if (turn.question) flow.appendChild(userNode(turn.question, turn.at, { conversationId: conversation.id, turnIndex }) as HTMLElement);
            const host = document.createElement('div');
            host.className = 'dsh-flow-item';
            host.dataset.turnIndex = String(turnIndex);
            flow.appendChild(host);
            current = { host, live: createLiveTurn(host), final: null };
            turns.set(turnIndex, current);
          }
          if (turn.liveProgress || turn.outcome === '进行中') {
            current.live.update(turn.liveProgress || { answer: turn.answer, thinking: turn.thinking });
            current.final = null;
          } else {
            const signature = JSON.stringify(turn);
            if (signature !== current.final) current.live.finish({ ...turn, conversationId: conversation.id, turnIndex });
            current.final = signature;
          }
        }
      },
    };
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
      } else if (kind === 'open-subagent') {
        const parentCallId = act.getAttribute('data-subagent-parent-call-id') || '';
        if (!parentCallId) return;
        DOC.dispatchEvent(new CustomEvent('mp:open-subagent', {
          detail: { parentCallId },
        }));
      } else if (kind === 'think-more') {
        const disclosure = act.closest<HTMLElement>('.dsh-think');
        if (!disclosure) return;
        const expanded = disclosure.dataset.expanded === 'true';
        disclosure.dataset.expanded = expanded ? 'false' : 'true';
        act.textContent = expanded ? 'Show more' : 'Show less';
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
          }, 2000); /* 给用户足够时间看清复制成功，再恢复原按钮。 */
        });
      } else if (kind === 'retry') {
        const question = act.getAttribute('data-dsh-retry') || '';
        if (!question) return;
        DOC.dispatchEvent(new CustomEvent('mp:retry-question', { detail: { question } }));
      } else if (kind === 'open-artifact') {
        const artifactId = act.getAttribute('data-artifact-id') || '';
        const conversationId = act.getAttribute('data-artifact-conversation') || '';
        if (!artifactId) return;
        DOC.dispatchEvent(new CustomEvent('mp:open-artifact', {
          detail: { artifactId, conversationId },
        }));
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
      const row = (event.target as HTMLElement | null)?.closest?.('.dsh-row[data-dsh-act]') as HTMLElement | null;
      if (!row) return;
      event.preventDefault();
      if (row.dataset.dshAct === 'toggle') toggleDisclosure(row);
      else row.click();
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
    createLiveTurn,
    createConversationView,
    permissionAnswerNode,
    artifactCardNode,
    formatRunMeta,
    stateDot,
    bindDelegation,
    __test: { firstLine, latestLine, classifyTool, deriveSummary, deriveDiff, formatClock, relativeTime },
  };
})();

// 渲染层直接用全局 DshChat；主进程/测试 require 这个模块。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DshChat;
}
