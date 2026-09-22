/* exported ChatView */

const ChatView = (() => {

  const markdownRenderer = typeof ChatMarkdown !== 'undefined'
    ? ChatMarkdown
    : (typeof require === 'function' ? require('./chat_markdown') : null);
  const exactIcons = typeof ChatIcons !== 'undefined'
    ? ChatIcons
    : (typeof require === 'function' ? require('./chat_icons') : null);

  interface ShimNode {
    tagName: string;
    ns: string | null;
    attrs: Record<string, string>;
    children: (string | ShimNode)[];
    dataset: Record<string, string>;
    setAttribute(k: string, v: string): void;
    removeAttribute(k: string): void;
    getAttribute(k: string): string | null;
    appendChild(child: string | ShimNode): unknown;
    readonly outerHTML: string;
  }

  type ChatNode = Element | ShimNode;
  type ChatChild = string | number | ShimNode | Node | null | undefined | false;

  const DOC = typeof document !== 'undefined' ? document : null;
  const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'use']);

  function shimNode(tag: string, ns: string | null): ShimNode {
    const node: ShimNode = {
      tagName: tag, ns, attrs: {}, children: [], dataset: {},
      setAttribute(k: string, v: string) {
        if (k.startsWith('data-')) node.dataset[k.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = String(v);
        node.attrs[k] = String(v);
      },
      removeAttribute(k: string) {
        if (k.startsWith('data-')) delete node.dataset[k.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())];
        delete node.attrs[k];
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

  function attach(parent: ChatNode, child: ChatChild): void {
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

  function h(tag: string, attrs: Record<string, string> = {}, ...children: ChatChild[]): ChatNode {
    const node = DOC ? DOC.createElement(tag) : shimNode(tag, null);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== '' && v !== null && v !== undefined) node.setAttribute(k, String(v));
    }
    for (const child of children.flat()) attach(node, child);
    return node;
  }

  function icon(name: string, size: number): ChatNode {
    return exactIcons.node(name, size) as ChatNode;
  }

  const MATRIX_CELLS: ReadonlyArray<readonly [number, number]> = [
    [0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4],
  ];

  function stateDot(state: 'done' | 'warning' | 'ongoing' | 'error', size = 10): ChatNode {
    if (state === 'ongoing') {
      const svg = h('svg', { class: 'mp-chat-matrix', width: String(size), height: String(size), viewBox: '0 0 10 10', 'aria-hidden': 'true' });
      svg.setAttribute('data-state', 'ongoing');
      MATRIX_CELLS.forEach(([x, y], index) => {
        const rect = h('rect', { class: 'mp-chat-cell', x: String(x), y: String(y), width: '2', height: '2' });
        rect.setAttribute('style', `animation-delay:${(index - MATRIX_CELLS.length) * 125}ms`);
        attach(svg, rect);
      });
      return svg;
    }
    const dot = h('span', { class: 'mp-chat-dot', 'aria-hidden': 'true' });
    dot.setAttribute('data-state', state);
    dot.setAttribute('style', `width:${size}px;height:${size}px`);
    return dot;
  }

  const ROW_EXPANSION = new Map<string, boolean>();
  const GROUP_EXPANSION = new Map<string, { open: boolean; members: string[] }>();
  let liveTurnSequence = 0;

  function rememberExpansion(store: Map<string, boolean>, id: string, open: boolean): void {
    if (!id) return;
    store.set(id, open);
  }

  function rememberGroupExpansion(id: string, open: boolean): void {
    if (!id) return;
    GROUP_EXPANSION.set(id, { open, members: GROUP_EXPANSION.get(id)?.members || [] });
  }

  function defaultOpenForTool(model: { name: string; state: ToolState }): boolean {
    return model.state === 'running' && isQuestionTool(model.name);
  }

  function isQuestionTool(name: string): boolean {
    return name === 'AskUser' || name === 'AskUserQuestion'
      || name === 'ask_user_question' || name === 'ask_user';
  }

  interface DisclosureOptions {
    iconName?: string;
    leadingOverride?: ChatNode;
    leadingClass?: string;
    title: string;
    collapsed?: ChatNode[];
    body?: ChatNode[] | null;
    expandable?: boolean;
    open?: boolean;
    rowId?: string;
  }

  function disclosureRow(opts: DisclosureOptions): { root: ChatNode; row: ChatNode; toggle(): void } {
    const remembered = opts.rowId ? ROW_EXPANSION.get(opts.rowId) : undefined;
    const open = remembered !== undefined ? remembered : Boolean(opts.open);
    const expandable = opts.expandable !== false && (opts.body !== null && opts.body !== undefined);
    const root = h('div', { class: 'mp-chat-disclosure' });
    root.setAttribute('data-open', open ? 'true' : 'false');
    if (opts.rowId) root.setAttribute('data-row-id', opts.rowId);

    const row = h('div', { class: 'mp-chat-row' });
    if (expandable) {
      row.setAttribute('data-expandable', 'true');
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    const leading = h('span', {
      class: opts.leadingClass ? `mp-chat-leading ${opts.leadingClass}` : 'mp-chat-leading',
    });
    if (opts.leadingOverride) {
      attach(leading, opts.leadingOverride);
    } else if (open) {
      attach(leading, icon('chev', 14));
      leading.setAttribute('class', 'mp-chat-leading mp-chat-chev');
    } else if (opts.iconName) {
      const idle = h('span', { class: 'mp-chat-icon-idle' });
      attach(idle, icon(opts.iconName, 14));
      attach(leading, idle);
      if (expandable) {
        const chev = h('span', { class: 'mp-chat-chev-hover' });
        attach(chev, icon('chev', 14));
        attach(leading, chev);
      }
    } else {
      attach(leading, icon('chev', 14));
    }
    attach(row, leading);

    const title = h('span', { class: 'mp-chat-title' });
    attach(title, String(opts.title));
    attach(row, title);

    for (const item of opts.collapsed || []) attach(row, item);

    attach(root, row);
    const bodyHost = h('div', { class: 'mp-chat-body-wrap' });
    if (opts.body) for (const item of opts.body) attach(bodyHost, item);
    attach(root, bodyHost);

    const toggle = () => {
      const next = root.getAttribute('data-open') !== 'true';
      root.setAttribute('data-open', next ? 'true' : 'false');
      if (expandable) row.setAttribute('aria-expanded', next ? 'true' : 'false');
      if (opts.rowId) rememberExpansion(ROW_EXPANSION, opts.rowId, next);
    };
    if (expandable) row.setAttribute('data-mp-chat-act', 'toggle');
    return { root, row, toggle };
  }

  type ToolVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'others';
  type ToolState = 'running' | 'ok' | 'error' | 'stopped';

  const VARIANT_TITLES: Record<ToolVariant, string> = {
    search: 'Searched', read: 'Read', bash: 'Ran',
    write: 'Wrote', edit: 'Edited', code: 'Used', others: 'Tool call',
  };

  const TOOL_TITLES: Record<string, string> = {
    Todo: 'Updated plan', TodoWrite: 'Updated plan', todo_write: 'Updated plan',
    AskUser: 'Asked user', AskUserQuestion: 'Asked user', ask_user_question: 'Asked user', ask_user: 'Asked user',
    Observe: 'Observed', get_app_state: 'Observed',
    ListApps: 'Listed windows', ListWindows: 'Listed windows',
    pwsh: 'Ran',
    search: 'Searched',
    list_dir: 'Listed files in working directory',
  };

  const SUBAGENT_TOOLS = new Set(['Agent', 'delegate_task']);
  const PLAN_TOOLS = new Set(['Todo', 'TodoWrite', 'todo_write']);

  const TOOL_VARIANTS: Record<string, ToolVariant> = {
    bash: 'bash', pwsh: 'bash', read: 'read', web_fetch: 'read',
    web_search: 'search', grep: 'search', glob: 'search',
    write: 'write', edit: 'edit', run_code: 'code',
    read_around: 'code', dump_subtree: 'code', get_focused: 'code', list_windows: 'code',
    find_in_window: 'search', look: 'code', propose: 'code', execute_plan: 'code',
    read_file: 'read', write_file: 'write', edit_file: 'edit',
    apply_patch: 'edit', run_command: 'bash', search: 'search',
    list_dir: 'read', delegate_task: 'code',
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

  function countLines(text: string): number {
    if (text === '') return 0;
    const parts = text.split('\n');
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    return parts.length;
  }

  function firstString(args: Record<string, unknown>, keys: readonly string[]): string {
    return pickString(args, keys) ?? '';
  }

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
    const title = isBlockedResult(result) ? 'Blocked' : SUBAGENT_TOOLS.has(name)
      ? state === 'running' ? 'Running subagent' : 'Subagent'
      : TOOL_TITLES[name] ?? (variant === 'others' ? name : VARIANT_TITLES[variant]);
    const summary = variant === 'others' || name === 'list_dir' || isQuestionTool(name) || ['Todo', 'TodoWrite', 'todo_write'].includes(name) ? '' : base;
    const output = result === undefined || !result.text ? null : result.text;
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

  function diffNode(diff: DiffView): ChatNode {
    const card = h('div', { class: 'mp-chat-diff' });
    for (const line of diff.lines) {
      const row = h('div', { class: 'mp-chat-diff-line' });
      row.setAttribute('data-kind', line.kind);
      attach(row, `${line.kind === 'del' ? '-' : '+'} ${line.text}`);
      attach(card, row);
    }
    if (diff.hidden > 0) {
      const more = h('div', { class: 'mp-chat-diff-more' });
      attach(more, `… 还有 ${diff.hidden} 行`);
      attach(card, more);
    }
    return card;
  }

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

  interface HighlightSpan { text: string; token: string }
  function highlightLines(text: string, lang: string): HighlightSpan[][] | null {
    const api = typeof globalThis !== 'undefined'
      ? (globalThis as unknown as { ChatHighlight?: { highlight?: (code: string, lang: string) => HighlightSpan[][] } }).ChatHighlight
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
      ? (globalThis as unknown as { ChatHighlight?: { langFor?: (name: string, command: string) => string } }).ChatHighlight
      : undefined;
    if (!api || typeof api.langFor !== 'function') return 'plain';
    try {
      return String(api.langFor(toolName, command) || 'plain');
    } catch {
      return 'plain';
    }
  }

  function codeLineNode(line: string, spans: HighlightSpan[] | undefined): ChatNode {
    const node = h('span', { class: 'mp-chat-code-line' });
    if (!spans || spans.length === 0) {
      attach(node, line);
      return node;
    }
    for (const span of spans) {
      const piece = h('span', { class: `mp-chat-tok-${String(span.token || 'plain')}` });
      attach(piece, String(span.text ?? ''));
      attach(node, piece);
    }
    return node;
  }

  function codeBodyNode(text: string, lang: string): ChatNode {
    const lines = text.split('\n');
    const highlighted = highlightLines(text, lang);
    const code = h('code');
    lines.forEach((line, index) => {
      if (index > 0) attach(code, '\n');
      attach(code, codeLineNode(line, highlighted ? highlighted[index] : undefined));
    });
    return code;
  }

  function commandCardNode(
    command: ToolCommand,
    prompt: string,
    copyText: string,
    options: { output?: string | null; error?: boolean; lang?: string; toolName?: string } = {},
  ): ChatNode {
    const lang = options.lang || highlightLang(String(options.toolName || ''), command.full);
    const card = h('div', { class: 'mp-chat-code' });
    const head = h('div', { class: 'mp-chat-code-head' });
    const line = h('span', { class: 'mp-chat-code-first' });
    if (prompt) {
      const mark = h('span', { class: 'mp-chat-code-prompt', 'aria-hidden': 'true' });
      attach(mark, prompt);
      attach(line, mark);
    }
    attach(line, codeLineNode(command.first, highlightLines(command.first, lang)?.[0]));
    const copy = h('button', {
      type: 'button',
      class: 'mp-chat-action mp-chat-code-copy',
      'aria-label': '复制命令',
      'data-mp-chat-act': 'copy',
      'data-mp-chat-copy': String(copyText || ''),
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
      const body = h('div', { class: 'mp-chat-code-body' });
      if (options.error) body.setAttribute('data-error', 'true');
      attach(body, codeBodyNode(String(options.output), 'plain'));
      attach(card, body);
    }
    return card;
  }

  function todoChecklist(model: ToolRowModel): ChatNode | null {
    if (!['Todo', 'TodoWrite', 'todo_write'].includes(model.name)) return null;
    let args: Record<string, unknown>;
    try { args = JSON.parse(model.argsRaw); } catch { return null; }
    if (!args || !Array.isArray(args.todos)) return null;
    const list = h('ul', { class: 'mp-chat-todo-list', 'aria-label': 'Plan update' });
    for (const value of args.todos) {
      if (!value || typeof value.content !== 'string') continue;
      const state = String(value.status || 'pending');
      const row = h('li', { class: 'mp-chat-todo-item', 'data-state': state });
      attach(row, h('span', { class: 'mp-chat-todo-check', 'aria-hidden': 'true' }, state === 'completed' ? '✓' : state === 'in_progress' ? '•' : ''));
      attach(row, h('span', { class: 'mp-chat-todo-label' }, value.content));
      attach(list, row);
    }
    return list;
  }

  function questionHistory(model: ToolRowModel): ChatNode | null {
    if (!isQuestionTool(model.name)) return null;
    let args: Record<string, unknown>;
    let result: Record<string, unknown> = {};
    try { args = JSON.parse(model.argsRaw); } catch { return null; }
    if (!args || typeof args !== 'object') return null;
    try { result = JSON.parse(model.output || '{}') || {}; } catch { /* A real error is rendered below. */ }
    const questions = Array.isArray(args.questions) ? args.questions : [args];
    const answers = result.answers && typeof result.answers === 'object' ? result.answers as Record<string, unknown> : {};
    const list = h('div', { class: 'mp-chat-question-history' });
    for (const question of questions) {
      if (!question || typeof question.question !== 'string') continue;
      const row = h('div', { class: 'mp-chat-question-answer' });
      attach(row, h('div', { class: 'mp-chat-question-label' }, question.question));
      const value = answers[question.question];
      const decision = result.decision === 'once' ? 'Allowed once' : result.decision === 'grant' ? 'Allowed for this session' : result.decision === 'deny' ? 'Denied' : '';
      const answer = Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : '';
      attach(row, h('div', { class: 'mp-chat-question-response' }, decision || answer || (result.answered ? 'No preference' : 'Waiting for your answer')));
      attach(list, row);
    }
    return list;
  }

  function toolRowNode(model: ToolRowModel, scope = ''): ChatNode {
    const root = h('div', { class: 'mp-chat-tool' });
    root.setAttribute('data-tool', '');
    root.setAttribute('data-state', model.state);
    if (model.callId) root.setAttribute('data-call-id', model.callId);

    const summaryText = model.summary;
    const status = model.state === 'running' ? '运行中' : model.state === 'error' ? '失败' : model.state === 'stopped' ? '已停止' : '';

    if (status) {
      const vh = h('span', { class: 'mp-chat-vh' });
      attach(vh, status);
      attach(root, vh);
    }

    const collapsed: ChatNode[] = [];
    if (summaryText !== '') {
      const sep = h('span', { class: 'mp-chat-tool-sep', 'aria-hidden': 'true' });
      attach(sep, ' ');
      collapsed.push(sep);
      const summary = h('span', { class: 'mp-chat-summary' });
      attach(summary, summaryText);
      collapsed.push(summary);
    }

    if (model.diffStat && (model.diffStat.added > 0 || model.diffStat.removed > 0)) {
      const stat = h('span', { class: 'mp-chat-diff-stat', 'aria-hidden': 'true' });
      if (model.diffStat.added > 0) {
        const add = h('span', { class: 'mp-chat-diff-add' });
        attach(add, `+${model.diffStat.added}`);
        attach(stat, add);
      }
      if (model.diffStat.removed > 0) {
        const del = h('span', { class: 'mp-chat-diff-del' });
        attach(del, `−${model.diffStat.removed}`);
        attach(stat, del);
      }
      collapsed.push(stat);
    }

    const body: ChatNode[] = [];
    const diff = deriveDiff(model.name, model.argsRaw ?? '');
    const command = toolCommandOf(model);
    const singleLine = command !== null && command.rest === '';
    let outputInCard = false;
    const checklist = todoChecklist(model) || questionHistory(model);
    if (checklist !== null) {
      body.push(checklist);
      outputInCard = model.state !== 'error';
    } else if (diff !== null && (model.body !== null || model.output !== null)) {
      body.push(diffNode(diff));
    } else if (command !== null) {
      if (singleLine) {
        const tag = h('div', { class: 'mp-chat-tool-tag' });
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
      const output = h('div', { class: 'mp-chat-tool-output' });
      if (model.state === 'error') output.setAttribute('data-error', 'true');
      attach(output, model.output);
      body.push(output);
    }

    const isSubagent = SUBAGENT_TOOLS.has(model.name) && Boolean(model.callId);
    const { root: disclosure, row: disclosureAction } = disclosureRow({
      iconName: undefined,
      leadingClass: 'mp-chat-tool-caret',
      title: model.title,
      collapsed,
      body: body.length ? body : null,
      expandable: !isSubagent && body.length > 0,
      open: defaultOpenForTool(model),
      rowId: model.callId ? `tool:${scope ? `${scope}:` : ''}${model.callId}` : undefined,
    });

    if (isSubagent) {
      disclosure.setAttribute('data-subagent-row', '');
      disclosureAction.setAttribute('data-mp-chat-act', 'open-subagent');
      disclosureAction.setAttribute('data-subagent-parent-call-id', model.callId);
      disclosureAction.setAttribute('role', 'button');
      disclosureAction.setAttribute('tabindex', '0');
    }

    attach(root, disclosure);
    return root;
  }

  function thinkNode(reasoning: string, running = false, thinkId = ''): ChatNode {
    const summaryText = running ? latestLine(reasoning) : firstLine(reasoning);
    const summary = h('span', { class: 'mp-chat-summary' });
    if (running) summary.setAttribute('data-follow-end', 'true');
    attach(summary, summaryText);

    const body = h('div', { class: 'mp-chat-think-body' });
    attach(body, reasoning);
    const viewport = h('div', { class: 'mp-chat-think-viewport' });
    attach(viewport, body);
    const isLong = !running && (reasoning.length > 420 || reasoning.split('\n').length > 8);
    attach(viewport, h('span', { class: 'mp-chat-think-fade', 'aria-hidden': 'true' }));
    const expandedBody: ChatNode[] = [viewport];
    {
      const more = h('button', { type: 'button', class: 'mp-chat-think-more' });
      more.setAttribute('data-mp-chat-act', 'think-more');
      attach(more, 'Show more');
      expandedBody.push(more);
    }

    const { root } = disclosureRow({
      iconName: 'think',
      title: running ? 'Thinking…' : 'Thought',
      collapsed: [h('span', { class: 'mp-chat-sep', 'aria-hidden': 'true' }), summary],
      body: expandedBody,
      expandable: true,
      open: false,
      rowId: thinkId ? `think:${thinkId}` : undefined,
    });
    root.setAttribute('data-state', running ? 'running' : 'ok');
    root.setAttribute('class', 'mp-chat-disclosure mp-chat-think');
    if (isLong) {
      root.setAttribute('data-long', 'true');
      root.setAttribute('data-expanded', 'false');
    }
    return root;
  }

  function updateThinkingState(node: HTMLElement, text: string, running: boolean): void {
    node.setAttribute('data-state', running ? 'running' : 'ok');
    node.querySelector('.mp-chat-title')!.textContent = running ? 'Thinking…' : 'Thought';
    const summary = node.querySelector('.mp-chat-summary')!;
    const preview = running ? latestLine(text) : firstLine(text);
    if (summary.textContent !== preview) summary.textContent = preview;
    if (running) summary.setAttribute('data-follow-end', 'true');
    else summary.removeAttribute('data-follow-end');
    node.setAttribute('data-long', String(!running && (text.length > 420 || text.split('\n').length > 8)));
    if (node.getAttribute('data-expanded') === null) node.setAttribute('data-expanded', 'false');
  }

  function formatClock(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

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

  function timeNode(ms: number | undefined): ChatNode | null {
    if (!ms || !Number.isFinite(ms)) return null;
    const label = relativeTime(ms);
    if (!label) return null;
    const node = h('span', { class: 'mp-chat-action-time', title: absoluteTime(ms) });
    attach(node, label);
    return node;
  }

  function messageActions(
    message: string,
    branch?: BranchTarget,
    timeMs?: number,
    options: { align?: 'user' | 'assistant'; retry?: boolean } = {},
  ): ChatNode {
    const actions = h('div', { class: 'mp-chat-actions' });
    actions.setAttribute('data-align', options.align === 'user' ? 'user' : 'assistant');
    const time = timeNode(timeMs);
    if (time && options.align === 'user') attach(actions, time);
    const copy = h('button', { type: 'button', class: 'mp-chat-action', 'aria-label': '复制' });
    copy.setAttribute('data-mp-chat-act', 'copy');
    copy.setAttribute('data-mp-chat-copy', String(message || ''));
    attach(copy, icon('copy', 16));
    attach(actions, copy);

    const retry = h('button', { type: 'button', class: 'mp-chat-action', 'aria-label': '重新发送' });
    retry.setAttribute('data-mp-chat-act', 'retry');
    retry.setAttribute('data-mp-chat-retry', String(message || ''));
    attach(retry, icon('retry', 16));
    attach(actions, retry);

    if (branch?.conversationId && Number.isInteger(branch.turnIndex)) {
      const fork = h('button', { type: 'button', class: 'mp-chat-action', 'aria-label': '从这里创建分支' });
      fork.setAttribute('data-mp-chat-act', 'branch');
      fork.setAttribute('data-mp-chat-branch-conversation', branch.conversationId);
      fork.setAttribute('data-mp-chat-branch-turn', String(branch.turnIndex));
      attach(fork, icon('branch', 16));
      attach(actions, fork);
    }
    if (time && options.align !== 'user') attach(actions, time);
    return actions;
  }

  function userNode(question: string, timeMs?: number, branch?: BranchTarget): ChatNode {
    const root = h('div', { class: 'mp-chat-user' });
    const stack = h('div', { class: 'mp-chat-user-stack' });
    const bubble = h('div', { class: 'mp-chat-bubble' });
    attach(bubble, question);
    attach(stack, bubble);
    attach(root, stack);
    attach(root, messageActions(question, branch, timeMs, { align: 'user' }));
    return root;
  }

  function permissionAnswerNode(answer: { decision?: string; rule?: string }): ChatNode {
    const decision = String(answer?.decision || '');
    const rule = String(answer?.rule || '');
    const root = h('div', { class: 'mp-chat-perm-receipt' });
    root.setAttribute('data-decision', decision);
    const label = h('span', { class: 'mp-chat-perm-receipt-label' });
    attach(label, decision === 'deny' ? '已拒绝' : decision === 'once' ? '允许一次' : '本会话允许');
    const target = h('code', { class: 'mp-chat-perm-receipt-rule' });
    attach(target, rule);
    attach(root, label);
    if (rule) attach(root, target);
    return root;
  }

  function artifactCardNode(items: Array<Record<string, unknown>>, conversationId: string): ChatNode | null {
    const usable = items.filter((item) => item && typeof item === 'object' && String(item.artifactId || ''));
    if (!usable.length) return null;
    const card = h('div', { class: 'mp-chat-artifact-card' });
    for (const item of usable) {
      const artifactId = String(item.artifactId || '');
      const name = String(item.title || item.name || '').trim() || '未命名草稿';
      const kind = String(item.kind || '').trim();
      const row = h('button', {
        type: 'button',
        class: 'mp-chat-artifact-row',
        'data-mp-chat-act': 'open-artifact',
        'data-artifact-id': artifactId,
        'data-artifact-conversation': conversationId,
        'aria-label': `打开 ${name}`,
      });
      const mark = h('span', { class: 'mp-chat-artifact-mark', 'aria-hidden': 'true' });
      attach(mark, icon('browse', 14));
      attach(row, mark);
      const copy = h('span', { class: 'mp-chat-artifact-copy' });
      const title = h('span', { class: 'mp-chat-artifact-label' });
      attach(title, name); attach(copy, title);
      const meta = h('span', { class: 'mp-chat-artifact-meta' });
      const kinds: Record<string, string> = { text: '文本', code: '代码', document_patch: '文档修改', image: '图片', file: '文件' };
      attach(meta, [kinds[kind] || kind || '草稿', item.state === 'edited' ? '已更新' : ''].filter(Boolean).join(' · '));
      attach(copy, meta); attach(row, copy);
      const chev = h('span', { class: 'mp-chat-artifact-chev', 'aria-hidden': 'true' });
      attach(chev, icon('chev', 14));
      attach(row, chev);
      attach(card, row);
    }
    return card;
  }

  function sparkMark(running = true): ChatNode {
    const root = h('span', { class: running ? 'mp-chat-thinking-mark' : 'mp-chat-run-meta-mark', 'aria-hidden': 'true' });
    const api = typeof globalThis !== 'undefined'
      ? (globalThis as unknown as { ActivityMarks?: { spark?: (state: 'thinking' | 'idle') => string } }).ActivityMarks
      : undefined;
    const markup = api && typeof api.spark === 'function' ? api.spark(running ? 'thinking' : 'idle') : '';
    if (markup && 'innerHTML' in root) {
      (root as unknown as HTMLElement).innerHTML = markup;
    }
    return root;
  }

  function turnStatusNode(label: string): ChatNode {
    const root = h('div', { class: 'mp-chat-turn-status', role: 'status', 'aria-label': label });
    attach(root, sparkMark());
    const copy = h('span', { class: 'mp-chat-turn-status-copy' });
    attach(copy, h('span', { class: 'mp-chat-turn-status-meta', 'data-turn-meta': 'true' }));
    const labelNode = h('span', { class: 'mp-chat-turn-status-label' });
    if (label === 'Thinking') labelNode.setAttribute('data-quiet', 'true');
    attach(labelNode, label);
    attach(copy, labelNode);
    attach(root, copy);
    return root;
  }

  function turnErrorNode(message: string, code?: string, tone: 'error' | 'warning' = 'error'): ChatNode {
    const root = h('div', { class: 'mp-chat-turn-error', role: 'status' });
    attach(root, stateDot(tone === 'error' ? 'error' : 'warning'));
    const copy = h('div', { class: 'mp-chat-turn-error-copy' });
    const title = h('span', { class: 'mp-chat-turn-error-title' });
    if (tone === 'warning') title.setAttribute('data-tone', 'warning');
    attach(title, tone === 'error' ? '这一轮没有完成。' : '注意');
    const body = h('span', { class: 'mp-chat-turn-error-message' });
    attach(body, message);
    attach(copy, title);
    attach(copy, body);
    attach(root, copy);
    if (code) {
      const c = h('code', { class: 'mp-chat-turn-error-code' });
      attach(c, code);
      attach(root, c);
    }
    return root;
  }

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

  interface TurnPresentation { taskPanel?: boolean }

  type FlowItem =
    | { type: 'narration'; text: string }
    | { type: 'reasoning'; text: string; id?: string }
    | { type: 'notice'; text: string }
    | { type: 'chip'; chip: TurnChip };

  function narrationNode(text: string): ChatNode {
    const root = h('div', { class: 'mp-chat-narration' });
    attach(root, markdownRenderer.render(text));
    return root;
  }

  function noticeNode(text: string): ChatNode {
    const root = h('div', { class: 'mp-chat-notice', role: 'status' });
    attach(root, stateDot('warning'));
    const copy = h('span', { class: 'mp-chat-notice-copy' });
    attach(copy, text);
    attach(root, copy);
    return root;
  }

  function chipNode(chip: TurnChip, scope = ''): ChatNode {
    const model = toolRowModel(chip.name, chip.argsRaw, chip.result, chip.callId);
    if (chip.displayLabel?.trim()) {
      model.title = chip.displayLabel.trim();
      model.summary = '';
    }
    const node = toolRowNode(model, scope);
    if (SUBAGENT_TOOLS.has(chip.name)) {
      attach(node, h('div', { class: 'mp-chat-subagent-heartbeat' }, subagentHeartbeat(chip.subagent)));
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

  function subagentEntryNode(chip: TurnChip, scope: string): ChatNode {
    const model = toolRowModel(chip.name, chip.argsRaw, chip.result, chip.callId);
    const status = String(chip.subagent?.status || '');
    if (status) model.state = status === 'running' ? 'running' : status === 'completed' ? 'ok'
      : ['stopped', 'cancelled', 'user_interrupt'].includes(status) ? 'stopped' : 'error';
    model.title = model.state === 'running' ? 'Running subagent' : model.state === 'error' ? 'Subagent failed'
      : model.state === 'stopped' ? 'Subagent stopped' : 'Subagent completed';
    return toolRowNode({ ...model, argsRaw: '', body: null, output: null }, scope);
  }

  function toolGroupNode(chips: TurnChip[], _running = false, work?: FlowItem[], scope = ''): ChatNode {
    const root = h('details', { class: 'mp-chat-tool-group' });
    const summary = h('summary', { class: 'mp-chat-tool-group-header' });
    const label = h('span', { class: 'mp-chat-tool-group-title' });
    const single = chips.length === 1 && !work?.some(item => item.type === 'reasoning');
    if (single) root.setAttribute('data-single', 'true');
    const model = single ? toolRowModel(chips[0].name, chips[0].argsRaw, chips[0].result, chips[0].callId) : null;
    attach(label, model ? (chips[0].displayLabel || [model.title, model.summary].filter(Boolean).join(' ')) : toolGroupLabel(chips));
    if (model?.diffStat) {
      const stat = h('span', { class: 'mp-chat-diff-stat', 'aria-hidden': 'true' });
      if (model.diffStat.added) attach(stat, h('span', { class: 'mp-chat-diff-add' }, `+${model.diffStat.added}`));
      if (model.diffStat.removed) attach(stat, h('span', { class: 'mp-chat-diff-del' }, `−${model.diffStat.removed}`));
      attach(label, stat);
    }
    const chev = h('span', { class: 'mp-chat-tool-group-chev', 'aria-hidden': 'true' });
    attach(chev, icon('chev', 14));
    attach(summary, label);
    attach(summary, chev);
    const body = h('div', { class: 'mp-chat-tool-group-body' });
    const entries: FlowItem[] = work || chips.map(chip => ({ type: 'chip', chip }));
    const groupId = `group:${scope ? `${scope}:` : ''}${chips[0]?.callId || ''}`;
    const previous = GROUP_EXPANSION.get(groupId);
    const members = entries.flatMap(entry => entry.type === 'chip'
      ? [`group:${scope ? `${scope}:` : ''}${entry.chip.callId || ''}`]
      : entry.type === 'reasoning' ? [`think:${scope}:r${entry.id ?? '0'}`] : []);
    const previousMembers = new Set(previous?.members || []);
    const open = previous?.open === true || members.some(id => !previousMembers.has(id)
      && (GROUP_EXPANSION.get(id)?.open === true || ROW_EXPANSION.get(id) === true));
    if (!single) {
      for (const id of members) {
        const source = GROUP_EXPANSION.get(id);
        if (source?.open && source.members.length === 1
          && (!previousMembers.has(id) || previousMembers.size === 1)) {
          rememberExpansion(ROW_EXPANSION, `tool:${id.slice('group:'.length)}`, true);
        }
      }
    }
    GROUP_EXPANSION.set(groupId, { open, members });
    if (open) root.setAttribute('open', '');
    summary.setAttribute('aria-expanded', open ? 'true' : 'false');
    summary.setAttribute('data-group-id', groupId);

    entries.forEach((entry) => {
      if (entry.type === 'reasoning') {
        attach(body, thinkNode(entry.text, false, `${scope}:r${entry.id ?? '0'}`));
        return;
      }
      if (entry.type !== 'chip') return;
      const chip = entry.chip;
      const node = chipNode(chip, scope);
      if (single) {
        const disclosure = DOC ? (node as Element).querySelector('.mp-chat-disclosure')
          : (node as ShimNode).children.find(child => typeof child !== 'string' && child.attrs.class === 'mp-chat-disclosure') as ShimNode | undefined;
        disclosure?.setAttribute('data-open', 'true');
        disclosure?.removeAttribute('data-row-id');
      }
      attach(body, node);
    });
    attach(root, summary);
    attach(root, body);
    return root;
  }

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

  function runMetaNode(meta: string): ChatNode {
    const root = h('div', { class: 'mp-chat-run-meta', role: 'status' });
    const mark = sparkMark(false);
    const copy = h('span', { class: 'mp-chat-run-meta-copy' });
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
    for (const [index, record] of usable.entries()) {
      if (record.kind === 'message') {
        const reasoning = String(record.reasoning || '').trim();
        if (reasoning) {
          items.push({
            type: 'reasoning',
            text: reasoning,
            id: String(record.callId || record.turn || index),
          });
        }
        const text = String(record.text || '').trim();
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

  function assistantTurnNode(
    turn: AssistantTurnInput,
    turnScope = `${turn.conversationId || ''}#${Number.isInteger(turn.turnIndex) ? turn.turnIndex : -1}`,
    options: TurnPresentation = {},
  ): ChatNode[] {
    const items: ChatNode[] = [];
    const root = h('div', { class: 'mp-chat-assistant' });
    const bodyHost = h('div', { class: 'mp-chat-assistant-body' });

    if (turn.thinking && !turn.trajectory?.some(record => record.reasoning)) {
      attach(bodyHost, thinkNode(turn.thinking, Boolean(turn.running), `${turnScope}:head`));
    }

    const flow = trajectoryFlowItems(turn) ?? eventFlowItems(turn);
    let chipRun: TurnChip[] = [];
    let workRun: FlowItem[] = [];
    const flushChips = () => {
      if (!chipRun.length) return;
      attach(bodyHost, toolGroupNode(chipRun, false, workRun, turnScope));
      chipRun = [];
      workRun = [];
    };
    for (const item of flow) {
      if (options.taskPanel && item.type === 'chip') {
        if (PLAN_TOOLS.has(item.chip.name)) {
          if (item.chip.result?.isError) {
            flushChips();
            attach(bodyHost, noticeNode(item.chip.result.text));
          }
          continue;
        }
        if (SUBAGENT_TOOLS.has(item.chip.name)) {
          flushChips();
          attach(bodyHost, subagentEntryNode(item.chip, turnScope));
          continue;
        }
      }
      if (item.type === 'reasoning') {
        if (chipRun.length) workRun.push(item);
        else attach(bodyHost, thinkNode(item.text, false, `${turnScope}:r${item.id ?? '0'}`));
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
    const artifacts = Array.isArray(turn.artifacts) ? turn.artifacts : [];
    const artifactCard = artifactCardNode(artifacts, String(turn.conversationId || ''));
    if (artifactCard) attach(root, artifactCard);
    items.push(root);
    return items;
  }

  function liveActivityNode(record: Record<string, unknown>, scope = '', options: TurnPresentation = {}): ChatNode {
    const phase = String(record.phase || '');
    const fields = record.fields && typeof record.fields === 'object'
      ? record.fields as Record<string, unknown> : {};
    if (phase === 'tool_call' || phase === 'tool_result') {
      const name = String(fields.name || 'tool');
      const done = phase === 'tool_result';
      const argsRaw = String(fields.args || '');
      if (options.taskPanel && PLAN_TOOLS.has(name)) return noticeNode(String(fields.result || 'Plan update failed'));
      if (options.taskPanel && SUBAGENT_TOOLS.has(name)) return subagentEntryNode({
        name, argsRaw, callId: String(fields.id || ''),
        result: done ? { text: String(fields.result || ''), isError: fields.state === 'error' } : undefined,
      }, scope);
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
      } : undefined, String(fields.id || '')), scope);
    }
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

  function createLiveTurn(host: HTMLElement, scope = `live-${++liveTurnSequence}`, options: TurnPresentation = {}) {
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
        if (!host.className.split(' ').includes('mp-chat-live-turn')) host.className += ' mp-chat-live-turn';
        if (snapshot.trajectory?.length) {
          const desired: HTMLElement[] = [];
          const render = (key: string, value: unknown, make: () => ChatNode) => {
            const signature = JSON.stringify(value);
            let entry = traceNodes.get(key);
            if (!entry) {
              entry = { node: make() as HTMLElement, signature };
              traceNodes.set(key, entry);
            } else if (entry.signature !== signature) {
              if (key.startsWith('message:') || key.startsWith('reasoning:')) {
                const target = key.startsWith('reasoning:') ? entry.node.querySelector<HTMLElement>('.mp-chat-think-body')! : entry.node;
                appendText(target, target.textContent || '', String(value));
                if (key.startsWith('reasoning:')) entry.node.querySelector('.mp-chat-summary')!.textContent = latestLine(String(value));
              } else {
                const replacement = make() as HTMLElement;
                entry.node.replaceChildren(...Array.from(replacement.childNodes));
                const state = replacement.getAttribute('data-state');
                if (state !== null) entry.node.setAttribute('data-state', state);
                if (replacement.getAttribute('data-single') === 'true') entry.node.setAttribute('data-single', 'true');
                else entry.node.removeAttribute('data-single');
              }
              entry.signature = signature;
            }
            desired.push(entry.node);
          };
          let chips: TurnChip[] = [];
          const flush = () => {
            if (!chips.length) return;
            const current = chips;
            render(`tools:${current[0].callId}`, current, () => toolGroupNode(current, true, undefined, scope));
            chips = [];
          };
          snapshot.trajectory.forEach((record, index) => {
            if (record.kind === 'tool') {
              if (options.taskPanel && PLAN_TOOLS.has(String(record.name))) {
                if (record.isError) {
                  flush();
                  render(`plan-error:${record.callId || index}`, record.result, () => noticeNode(String(record.result || 'Plan update failed')));
                }
                return;
              }
              const chip: TurnChip = { name: String(record.name || 'tool'), callId: String(record.callId || index), argsRaw: String(record.text || ''),
                result: record.result == null ? undefined : { text: String(record.result), isError: Boolean(record.isError) } };
              if (SUBAGENT_TOOLS.has(chip.name)) {
                flush();
                const key = `agent:${chip.callId}`;
                if (options.taskPanel) {
                  chip.subagent = { status: (record.subagent as Record<string, unknown> | undefined)?.status };
                  render(key, chip, () => subagentEntryNode(chip, scope));
                  return;
                }
                render(key, chip, () => chipNode(chip, scope));
                const child = record.subagent as Record<string, unknown> | undefined;
                const heartbeat = traceNodes.get(key)!.node.querySelector('.mp-chat-subagent-heartbeat')!;
                const text = subagentHeartbeat(child);
                if (heartbeat.textContent !== text) heartbeat.textContent = text;
              } else chips.push(chip);
            } else if (record.kind === 'message') {
              if (!record.text && !record.reasoning) return;
              flush();
              const key = String(record.turn || index);
              if (record.reasoning) {
                const running = record.state === 'running' && !record.text;
                const thinkId = `${scope}:r${record.callId || record.turn || index}`;
                render(`reasoning:${key}`, String(record.reasoning), () => thinkNode(String(record.reasoning), running, thinkId));
                updateThinkingState(traceNodes.get(`reasoning:${key}`)!.node, String(record.reasoning), running);
              }
              if (record.text) render(`message:${key}`, String(record.text), () => h('div', { class: 'mp-chat-stream-live' }, String(record.text)));
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
          const statusLabel = traceStatus.querySelector('.mp-chat-turn-status-label');
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
            if (options.taskPanel && PLAN_TOOLS.has(String(fields.name)) && fields.state !== 'error') continue;
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
            row = { node: liveActivityNode(record, scope, options) as HTMLElement, record: signature };
            rows.set(key, row);
          } else if (row.record !== signature) {
            if (key === 'status') {
              const label = liveStatusLabel(String(record.phase || ''), (record.fields || {}) as Record<string, unknown>);
              const copy = row.node.querySelector('.mp-chat-turn-status-label');
              if (copy && copy.textContent !== label) copy.textContent = label;
              row.node.setAttribute('aria-label', label);
            } else {
              const replacement = liveActivityNode(record, scope, options) as HTMLElement;
              row.node.setAttribute('data-state', replacement.getAttribute('data-state') || 'running');
              row.node.replaceChildren(...Array.from(replacement.childNodes));
            }
            row.record = signature;
          }
          desired.push(row.node);
        }
        const nextThinking = String(snapshot.thinking || '');
        if (nextThinking) {
          if (!thinking) thinking = thinkNode('', true, `${scope}:head`) as HTMLElement;
          const body = thinking.querySelector<HTMLElement>('.mp-chat-think-body')!;
          appendText(body, thinkingText, nextThinking);
          const summary = thinking.querySelector('.mp-chat-summary')!;
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
            answer.className = 'mp-chat-stream-live';
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
        host.className = host.className.split(' ').filter(name => name !== 'mp-chat-live-turn').join(' ');
        host.replaceChildren(...assistantTurnNode(turn, scope, options) as HTMLElement[]);
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
            host.className = 'mp-chat-flow-item';
            host.dataset.turnIndex = String(turnIndex);
            flow.appendChild(host);
            current = { host, live: createLiveTurn(host, `${conversation.id}#${turnIndex}`, { taskPanel: true }), final: null };
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
    const normalized = phase.replace(/[_-]turn[=_]\d+$/i, '');
    if (labels[normalized]) {
      const embedded = /turn[=_](\d+)$/i.exec(phase);
      return embedded ? `第 ${embedded[1]} 轮推理中` : labels[normalized];
    }
    return phase || '处理中';
  }

  function toggleDisclosure(act: HTMLElement): void {
    const row = act.closest<HTMLElement>('.mp-chat-row');
    const disclosure = act.closest<HTMLElement>('.mp-chat-disclosure');
    if (!row || !disclosure) return;
    const open = disclosure.getAttribute('data-open') === 'true';
    disclosure.setAttribute('data-open', open ? 'false' : 'true');
    row.setAttribute('aria-expanded', open ? 'false' : 'true');
    const rowId = disclosure.getAttribute('data-row-id');
    if (rowId) rememberExpansion(ROW_EXPANSION, rowId, !open);
  }

  function rememberGroupToggle(event: Event): void {
    const target = event.target as HTMLElement | null;
    if (!target || !target.classList || !target.classList.contains('mp-chat-tool-group')) return;
    const summary = target.querySelector(':scope > .mp-chat-tool-group-header');
    const groupId = summary?.getAttribute('data-group-id');
    if (!groupId) return;
    rememberGroupExpansion(groupId, target.hasAttribute('open'));
    summary?.setAttribute('aria-expanded', target.hasAttribute('open') ? 'true' : 'false');
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
    if ((host as unknown as { __mpChatBound?: boolean }).__mpChatBound) return;
    (host as unknown as { __mpChatBound?: boolean }).__mpChatBound = true;
    host.addEventListener('toggle', rememberGroupToggle, true);
    host.addEventListener('click', (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const act = target.closest<HTMLElement>('[data-mp-chat-act]');
      if (!act) return;
      const kind = act.getAttribute('data-mp-chat-act');
      if (kind === 'toggle') {
        toggleDisclosure(act);
      } else if (kind === 'open-subagent') {
        const parentCallId = act.getAttribute('data-subagent-parent-call-id') || '';
        if (!parentCallId) return;
        DOC.dispatchEvent(new CustomEvent('mp:open-subagent', {
          detail: { parentCallId },
        }));
      } else if (kind === 'think-more') {
        const disclosure = act.closest<HTMLElement>('.mp-chat-think');
        if (!disclosure) return;
        const expanded = disclosure.dataset.expanded === 'true';
        disclosure.dataset.expanded = expanded ? 'false' : 'true';
        act.textContent = expanded ? 'Show more' : 'Show less';
      } else if (kind === 'copy') {
        const text = act.getAttribute('data-mp-chat-copy') || '';
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
          }, 2000);  
        });
      } else if (kind === 'retry') {
        const question = act.getAttribute('data-mp-chat-retry') || '';
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
        const conversationId = act.getAttribute('data-mp-chat-branch-conversation') || '';
        const turnIndex = Number(act.getAttribute('data-mp-chat-branch-turn'));
        if (!conversationId || !Number.isInteger(turnIndex)) return;
        DOC.dispatchEvent(new CustomEvent('mp:branch-conversation', {
          detail: { conversationId, turnIndex },
        }));
      }
    });
    host.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const row = (event.target as HTMLElement | null)?.closest?.('.mp-chat-row[data-mp-chat-act]') as HTMLElement | null;
      if (!row) return;
      event.preventDefault();
      if (row.dataset.mpChatAct === 'toggle') toggleDisclosure(row);
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
    expansion: {
      row: (id: string) => ROW_EXPANSION.get(id),
      setRow: (id: string, open: boolean) => rememberExpansion(ROW_EXPANSION, id, open),
      group: (id: string) => GROUP_EXPANSION.get(id)?.open,
      setGroup: (id: string, open: boolean) => rememberGroupExpansion(id, open),
      clear: () => { ROW_EXPANSION.clear(); GROUP_EXPANSION.clear(); },
    },
    __test: { firstLine, latestLine, classifyTool, deriveSummary, deriveDiff, formatClock, relativeTime },
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ChatView;
}
