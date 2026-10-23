/* exported ChatView */

const ChatView = (() => {
  const markdownRenderer =
    typeof ChatMarkdown !== 'undefined'
      ? ChatMarkdown
      : typeof require === 'function'
        ? require('./chat_markdown')
        : null;
  const exactIcons =
    typeof ChatIcons !== 'undefined'
      ? ChatIcons
      : typeof require === 'function'
        ? require('./chat_icons')
        : null;
  const diffRows: typeof import('./chat_diff_rows') =
    typeof ChatDiffRows !== 'undefined'
      ? ChatDiffRows : require('./chat_diff_rows');
  const fileIcons: typeof import('./chat_file_icons') =
    typeof ChatFileIcons !== 'undefined'
      ? ChatFileIcons : require('./chat_file_icons');
  const toolSummary: typeof import('./chat_tool_summary') =
    typeof ChatToolSummary !== 'undefined'
      ? ChatToolSummary : require('./chat_tool_summary');
  const StudioLocaleApi =
    typeof require === 'function' ? require('./locale') : null;
  const compaction: typeof import('../compaction_status') =
    typeof CompactionStatus !== 'undefined'
      ? CompactionStatus
      : require('../compaction_status');
  function lt(id: string, params?: Record<string, string | number>): string {
    if (typeof studioT === 'function') {
      return studioT(id, params);
    }
    if (StudioLocaleApi && typeof StudioLocaleApi.studioT === 'function') {
      return StudioLocaleApi.studioT(id, params);
    }
    return id;
  }
  interface ShimNode {
    tagName: string;
    ns: string | null;
    attrs: Record<string, string>;
    children: Array<string | ShimNode>;
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
  const COPY_RESET_TIMERS = new WeakMap<HTMLElement, number>();
  const ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'use']);

  function shimNode(tag: string, ns: string | null): ShimNode {
    const node: ShimNode = {
      tagName: tag,
      ns,
      attrs: {},
      children: [],
      dataset: {},
      setAttribute(k: string, v: string) {
        if (k.startsWith('data-')) {
          node.dataset[
            k.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
          ] = String(v);
        }
        node.attrs[k] = String(v);
      },
      removeAttribute(k: string) {
        if (k.startsWith('data-')) {
          delete node.dataset[
            k.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
          ];
        }
        delete node.attrs[k];
      },
      getAttribute(k: string): string | null {
        return Object.prototype.hasOwnProperty.call(node.attrs, k)
          ? node.attrs[k]
          : null;
      },
      appendChild(child: string | ShimNode): unknown {
        node.children.push(child);
        return child;
      },
      get outerHTML() {
        const escAttr = (value: string) =>
          value.replace(/[&<>"]/g, ch => ESCAPES[ch]);
        const attr = Object.entries(node.attrs)
          .map(([k, v]) => ` ${k}="${escAttr(v)}"`)
          .join('');
        if (VOID_TAGS.has(tag)) {
          return `<${tag}${attr}>`;
        }
        const body = node.children
          .map(c =>
            typeof c === 'string'
              ? String(c).replace(/[&<>"']/g, ch => ESCAPES[ch])
              : c.outerHTML,
          )
          .join('');
        return `<${tag}${attr}>${body}</${tag}>`;
      },
    };
    return node;
  }

  function attach(parent: ChatNode, child: ChatChild): void {
    if (child === null || child === undefined || child === false) {
      return;
    }
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

  function h(
    tag: string,
    attrs: Record<string, string> = {},
    ...children: ChatChild[]
  ): ChatNode {
    const node = DOC ? DOC.createElement(tag) : shimNode(tag, null);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== '' && v !== null && v !== undefined) {
        node.setAttribute(k, String(v));
      }
    }
    for (const child of children.flat()) {
      attach(node, child);
    }
    return node;
  }

  function icon(name: string, size: number): ChatNode {
    return exactIcons.node(name, size) as ChatNode;
  }

  function stateDot(
    state: 'done' | 'warning' | 'ongoing' | 'error',
    size = 10,
  ): ChatNode {
    if (state === 'ongoing') {
      const namespace = 'http://www.w3.org/2000/svg';
      const svg = DOC
        ? DOC.createElementNS(namespace, 'svg')
        : shimNode('svg', namespace);
      const attrs = {
        class: 'mp-chat-status-spinner',
        width: String(size),
        height: String(size),
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1',
        'stroke-linecap': 'round',
        'aria-hidden': 'true',
      };
      for (const [key, value] of Object.entries(attrs)) {
        svg.setAttribute(key, value);
      }
      svg.setAttribute('data-state', 'ongoing');
      const path = DOC
        ? DOC.createElementNS(namespace, 'path')
        : shimNode('path', namespace);
      // Claude Desktop's shipped Spinner master16, extracted via local REA.
      path.setAttribute(
        'd',
        'M13.5 8C13.5 11.038 11.038 13.5 8 13.5C4.962 13.5 2.5 11.038 2.5 8C2.5 4.962 4.962 2.5 8 2.5',
      );
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      attach(svg, path);
      return svg;
    }
    const dot = h('span', {class: 'mp-chat-dot', 'aria-hidden': 'true'});
    dot.setAttribute('data-state', state);
    dot.setAttribute('style', `width:${size}px;height:${size}px`);
    return dot;
  }

  const ROW_EXPANSION = new Map<string, boolean>();
  const GROUP_EXPANSION = new Map<
    string,
    {open: boolean; members: string[]; single?: boolean}
  >();
  let liveTurnSequence = 0;

  function rememberExpansion(
    store: Map<string, boolean>,
    id: string,
    open: boolean,
  ): void {
    if (!id) {
      return;
    }
    store.set(id, open);
  }

  function rememberGroupExpansion(id: string, open: boolean): void {
    if (!id) {
      return;
    }
    GROUP_EXPANSION.set(id, {
      open,
      members: GROUP_EXPANSION.get(id)?.members || [],
      single: GROUP_EXPANSION.get(id)?.single,
    });
  }

  function defaultOpenForTool(model: {
    name: string;
    state: ToolState;
  }): boolean {
    return model.state === 'running' && isQuestionTool(model.name);
  }

  function isQuestionTool(name: string): boolean {
    return (
      name === 'AskUser' ||
      name === 'AskUserQuestion' ||
      name === 'ask_user_question' ||
      name === 'ask_user'
    );
  }

  interface DisclosureOptions {
    leadingOverride?: ChatNode;
    title: string;
    collapsed?: ChatNode[];
    body?: ChatNode[] | null;
    expandable?: boolean;
    open?: boolean;
    rowId?: string;
  }

  function disclosureRow(opts: DisclosureOptions): {
    root: ChatNode;
    row: ChatNode;
  } {
    const remembered = opts.rowId ? ROW_EXPANSION.get(opts.rowId) : undefined;
    const open = remembered !== undefined ? remembered : Boolean(opts.open);
    const expandable =
      opts.expandable !== false &&
      opts.body !== null &&
      opts.body !== undefined;
    const root = h('div', {class: 'mp-chat-disclosure'});
    root.setAttribute('data-open', open ? 'true' : 'false');
    if (opts.rowId) {
      root.setAttribute('data-row-id', opts.rowId);
    }

    const row = h('div', {class: 'mp-chat-row'});
    if (expandable) {
      row.setAttribute('data-expandable', 'true');
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    if (opts.leadingOverride) {
      attach(row, h('span', {class: 'mp-chat-leading'}, opts.leadingOverride));
    }

    const title = h('span', {class: 'mp-chat-title'});
    attach(title, String(opts.title));
    attach(row, title);

    for (const item of opts.collapsed || []) {
      attach(row, item);
    }

    attach(root, row);
    const bodyHost = h('div', {class: 'mp-chat-body-wrap'});
    if (opts.body) {
      for (const item of opts.body) {
        attach(bodyHost, item);
      }
    }
    attach(root, bodyHost);

    if (expandable) {
      row.setAttribute('data-mp-chat-act', 'toggle');
    }
    return {root, row};
  }

  type ToolVariant =
    'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'others';
  type ToolState = 'running' | 'ok' | 'error' | 'stopped';

  const VARIANT_TITLES: Record<ToolVariant, string> = {
    search: 'Searched',
    read: 'Read',
    bash: 'Ran',
    // The reference past-tenses `write` as "Created a file", not "Wrote".
    write: 'Created',
    edit: 'Edited',
    code: 'Used',
    others: 'Tool call',
  };

  /**
   * In-flight verbs.
   *
   * The reference names a gerund beside every completed verb and picks between
   * them by status: "Reading src/app.ts" while it runs, "Read src/app.ts" once
   * it lands. Its gerunds are not mechanical — Write runs as "Creating", not
   * "Writing" — so this is a lookup, not a suffix rule.
   *
   * A tool with no entry keeps its completed verb mid-flight rather than
   * having a tense invented for it.
   */
  const RUNNING_TITLES: Record<string, string> = {
    read: 'Reading',
    Read: 'Reading',
    read_around: 'Reading',
    'ToolResult.read': 'Reading',
    write: 'Creating',
    Write: 'Creating',
    SaveSkill: 'Saving a skill',
    edit: 'Editing',
    Edit: 'Editing',
    edit_file: 'Editing',
    Patch: 'Editing',
    bash: 'Running',
    Bash: 'Running',
    BashRead: 'Running',
    pwsh: 'Running',
    run_code: 'Running code',
    grep: 'Searching',
    Grep: 'Searching',
    glob: 'Searching',
    Glob: 'Searching',
    search: 'Searching',
    Search: 'Searching',
    web_search: 'Searching the web',
    find_in_window: 'Searching',
    find_roots: 'Finding windows',
    search_ui: 'Searching controls',
    Recall: 'Recalling',
    web_fetch: 'Fetching',
    Fetch: 'Fetching',
    list_dir: 'Listing files',
    Tools: 'Loading tools',
    look: 'Looking',
    Look: 'Looking',
    'Browser.navigate': 'Opening page',
    turn_ended: 'Finishing turn',
  };

  const VARIANT_RUNNING_TITLES: Record<ToolVariant, string> = {
    search: 'Searching',
    read: 'Reading',
    bash: 'Running',
    write: 'Creating',
    edit: 'Editing',
    code: 'Using',
    others: '',
  };

  const TOOL_TITLES: Record<string, string> = {
    Todo: 'Updated plan',
    TodoWrite: 'Updated plan',
    todo_write: 'Updated plan',
    AskUser: 'Asked user',
    AskUserQuestion: 'Asked user',
    ask_user_question: 'Asked user',
    ask_user: 'Asked user',
    Observe: 'Observed',
    ListApps: 'Listed windows',
    ListWindows: 'Listed windows',
    pwsh: 'Ran',
    search: 'Searched',
    list_dir: 'Listed files in working directory',
    Tools: 'Loaded tools',
    'ToolResult.read': 'Read execution detail',
    'Browser.navigate': 'Opened page',
    list_apps: 'Found app windows',
    list_windows: 'Listed windows',
    get_focused: 'Checked current window',
    launch_app: 'Launched app',
    activate_window: 'Switched window',
    get_app_state: 'Observed window',
    observe_ui: 'Observed interface',
    find_roots: 'Found windows',
    search_ui: 'Searched controls',
    inspect_ui: 'Inspected control',
    expand_ui: 'Expanded control',
    read_text: 'Read interface text',
    click: 'Clicked control',
    type_text: 'Typed text',
    press_key: 'Pressed key',
    scroll: 'Scrolled',
    drag: 'Dragged',
    set_value: 'Filled control',
    select_text: 'Selected text',
    perform_secondary_action: 'Ran control action',
    act_ui: 'Ran desktop step',
    wait_for: 'Waited for interface',
    turn_ended: 'Ended desktop turn',
  };
  const DESKTOP_TOOLS = new Set([
    'list_apps',
    'list_windows',
    'get_focused',
    'launch_app',
    'activate_window',
    'get_app_state',
    'observe_ui',
    'find_roots',
    'search_ui',
    'inspect_ui',
    'expand_ui',
    'read_text',
    'click',
    'type_text',
    'press_key',
    'scroll',
    'drag',
    'set_value',
    'select_text',
    'perform_secondary_action',
    'act_ui',
    'wait_for',
    'turn_ended',
    'Browser.navigate',
  ]);

  const SUBAGENT_TOOLS = new Set(['Agent', 'delegate_task']);
  const PLAN_TOOLS = new Set(['Todo', 'TodoWrite', 'todo_write']);
  const EXTENDED_THINKING_GLYPH = String.fromCodePoint(0xe068);
  const AGENTS_SIMPLE_GLYPH = String.fromCodePoint(0xe11c);

  const TOOL_VARIANTS: Record<string, ToolVariant> = {
    bash: 'bash',
    pwsh: 'bash',
    read: 'read',
    web_fetch: 'read',
    web_search: 'search',
    grep: 'search',
    glob: 'search',
    write: 'write',
    edit: 'edit',
    run_code: 'code',
    read_around: 'code',
    dump_subtree: 'code',
    get_focused: 'code',
    list_windows: 'code',
    find_in_window: 'search',
    look: 'code',
    propose: 'code',
    execute_plan: 'code',
    read_file: 'read',
    write_file: 'write',
    edit_file: 'edit',
    apply_patch: 'edit',
    run_command: 'bash',
    search: 'search',
    list_dir: 'read',
    delegate_task: 'code',
    Read: 'read',
    Write: 'write',
    Edit: 'edit',
    MultiEdit: 'edit',
    Patch: 'edit',
    Grep: 'search',
    Glob: 'search',
    Bash: 'bash',
    BashRead: 'bash',
    Search: 'search',
    Fetch: 'code',
    Agent: 'code',
    Wait: 'code',
    Observe: 'code',
    Look: 'code',
    Tree: 'code',
    Around: 'code',
    Find: 'search',
    ListApps: 'code',
    ListWindows: 'code',
    GetFocus: 'code',
    Launch: 'code',
    Focus: 'code',
    Click: 'code',
    Type: 'code',
    Key: 'code',
    Scroll: 'code',
    Drag: 'code',
    SetValue: 'code',
    Act: 'code',
    Select: 'code',
    AskUser: 'code',
    Todo: 'code',
    todo_write: 'code',
    ask_user_question: 'code',
    get_app_state: 'code',
    Recall: 'search',
    SaveSkill: 'write',
    Tools: 'search',
  };

  const SUMMARY_KEYS: Record<ToolVariant, readonly string[]> = {
    bash: ['description', 'command'],
    read: ['path', 'file_path', 'url'],
    search: ['query', 'pattern', 'url'],
    write: ['path', 'file_path'],
    edit: ['path', 'file_path'],
    code: ['description', 'app', 'url', 'text', 'keys', 'window_id', 'ref'],
    others: [],
  };

  const FILE_PATH_VARIANTS: ReadonlySet<ToolVariant> = new Set([
    'read',
    'write',
    'edit',
  ]);

  function firstLine(value: string): string {
    const nl = value.indexOf('\n');
    return nl === -1 ? value : value.slice(0, nl);
  }

  function latestLine(value: string): string {
    const visible = value.replace(/\s+$/u, '');
    const nl = visible.lastIndexOf('\n');
    return nl === -1 ? visible : visible.slice(nl + 1);
  }

  function pickString(
    args: Record<string, unknown>,
    keys: readonly string[],
  ): string | undefined {
    for (const key of keys) {
      const v = args[key];
      if (typeof v === 'string' && v !== '') {
        return v;
      }
    }
    return undefined;
  }

  // -------------------------------------------------------------------
  // Claude tool-presentation port.
  //
  // Transcribed from claude.ai's own tool-card code (Claude desktop reverse
  // engineering reports 31, 32 and 33). The tables are literal on purpose:
  // the reference selects wording by lookup and never by a suffix rule, so
  // `Write` runs as "Creating a file" rather than "Writing a file", and
  // `PowerShell` normalises to `power_shell` while its alias separately lands
  // on `powershell`. Each table names the reference symbol it came from.
  // -------------------------------------------------------------------

  type ToolCategory =
    | 'read'
    | 'view'
    | 'write'
    | 'edit'
    | 'notebook_edit'
    | 'delete_file'
    | 'glob'
    | 'grep'
    | 'web'
    | 'web_fetch'
    | 'bash'
    | 'kill_bash'
    | 'tmux'
    | 'task'
    | 'skill'
    | 'share'
    | 'past_chats'
    | 'project_knowledge'
    | 'drive_search'
    | 'plan'
    | 'todo'
    | 'code'
    | 'preview'
    | 'screenshot'
    | 'browser'
    | 'tool_search'
    | 'exit_plan_mode'
    | 'enter_plan_mode'
    | 'ask_user_question'
    | 'bash_output'
    | 'artifact';

  /**
   * Claude's `wR`. camelCase splits to snake_case, then everything lowercases:
   * `Bash` to `bash`, `BashTool` to `bash_tool`, `PowerShell` to `power_shell`.
   */
  function normaliseToolName(raw: string): string {
    return raw.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  }

  /**
   * Claude's `kR` is `{Bash: "bash", BashTool: "bash", PowerShell: "powershell"}`
   * and it maps a PascalCase spelling to a *category* -- `jR` in the same file
   * is just the set of those keys passed through `wR`. It is deliberately not
   * substituted for the normalised name below, because doing so would key
   * `PowerShell` under `powershell`, a spelling no table in the reference has;
   * all three of its entries already normalise into `NR` unaided
   * (`Bash` -> `bash`, `BashTool` -> `bash_tool`, `PowerShell` -> `power_shell`).
   * The only entry that changes an answer is MP's own `AskUser`.
   */
  const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
    AskUser: 'ask_user_question',
    // MP spells the reference's `web_search` as `Search` (its runtime also
    // accepts the `web_search` spelling). Both resolve to the reference's web
    // tables, so the row reads "Searched the web" and the rich results path
    // below reaches it through `toolCategory`.
    Search: 'web_search',
  };

  function aliasToolName(raw: string): string {
    return normaliseToolName(TOOL_NAME_ALIASES[raw] ?? raw);
  }

  /** Claude's `NR`. Normalised tool name to presentation category. */
  const TOOL_CATEGORY_BY_NAME: Readonly<Record<string, ToolCategory>> = {
    read: 'read',
    view: 'view',
    write: 'write',
    create_file: 'write',
    edit: 'edit',
    multi_edit: 'edit',
    str_replace: 'edit',
    str_replace_editor: 'edit',
    update_file: 'edit',
    notebook_edit: 'notebook_edit',
    open_file: 'read',
    close_file: 'read',
    delete_file: 'delete_file',
    file_search: 'glob',
    present_files: 'share',
    send_user_file: 'share',
    recent_chats: 'past_chats',
    conversation_search: 'past_chats',
    project_knowledge_search: 'project_knowledge',
    drive_search: 'drive_search',
    web_fetch: 'web_fetch',
    web_search: 'web',
    web_search_fast: 'web',
    bash: 'bash',
    bash_tool: 'bash',
    power_shell: 'bash',
    // `kR` spells PowerShell's normalised name `powershell`; `NR` spells it
    // `power_shell`. Both spellings are the same category.
    powershell: 'bash',
    task: 'task',
    agent: 'task',
    skill: 'skill',
    todo_write: 'plan',
    kill_bash: 'kill_bash',
    tmux: 'tmux',
    exit_plan_mode: 'exit_plan_mode',
    enter_plan_mode: 'enter_plan_mode',
    ask_user_question: 'ask_user_question',
    bash_output: 'bash_output',
    tool_search: 'tool_search',
    repl: 'code',
    java_script: 'code',
    glob: 'glob',
    grep: 'grep',
    preview_start: 'preview',
    preview_stop: 'preview',
    preview_list: 'preview',
    preview_screenshot: 'preview',
    preview_snapshot: 'preview',
    preview_click: 'preview',
    preview_type: 'preview',
    preview_fill: 'preview',
    preview_scroll: 'preview',
    preview_select: 'preview',
    preview_eval: 'preview',
    preview_resize: 'preview',
    preview_logs: 'preview',
    preview_console_logs: 'preview',
    preview_network: 'preview',
    preview_inspect: 'preview',
  };

  /**
   * Claude's `PR`. A tool in these categories stops being its own card once it
   * is reached through a namespace (`mcp__server__tool`, a prefixed name, or a
   * `:` path) — the connector card represents it instead.
   */
  const NAMESPACED_SUPPRESSED_CATEGORIES: ReadonlySet<ToolCategory> = new Set([
    'tool_search',
    'share',
    'code',
    'past_chats',
    'project_knowledge',
    'drive_search',
    'skill',
  ]);

  /**
   * Standing in for Claude's `VP`, which strips a namespace prefix and lives
   * in an uncaptured chunk. `__` and `:` are the only namespace shapes MP
   * produces, so this is the same test the reference ends up making.
   */
  function isNamespacedToolName(raw: string): boolean {
    return raw.startsWith('mcp__') || raw.includes('__') || raw.includes(':');
  }

  /**
   * Claude's `zR`, minus its two uncaptured predicates. `IF(e)` (the
   * Chrome-extension test) is not reproduced, so a namespaced `browser_*`
   * name is not folded into the `browser` category; `oL(e)` guards the one
   * `present_files` exception and is read as false. The screenshot rule is
   * kept verbatim.
   */
  function toolCategory(raw: string): ToolCategory | undefined {
    const alias = aliasToolName(raw);
    const named = TOOL_CATEGORY_BY_NAME[alias];
    if (named !== undefined) {
      if (
        NAMESPACED_SUPPRESSED_CATEGORIES.has(named) &&
        isNamespacedToolName(raw)
      ) {
        return undefined;
      }
      return named;
    }
    if (
      alias.includes('screenshot') &&
      (raw.includes('computer-use') ||
        raw.includes('remote-devices__computer_'))
    ) {
      return 'screenshot';
    }
    return undefined;
  }

  /**
   * Claude's `qT`. The connector name for a namespaced call.
   *
   * Adapted: both shapes put the server left of the double underscore, but
   * Claude writes `mcp__<server>__<tool>` while MP writes
   * `mcp_<server>__<tool>`, so the server is the second segment there and the
   * first here. Reading the reference's index verbatim would name the tool
   * instead of the server.
   */
  function connectorDisplayName(raw: string): string {
    const parts = raw.split('__');
    if (parts.length < 2) {
      return 'connector';
    }
    const server = raw.startsWith('mcp__') ? parts[1] : parts[0];
    if (server === undefined || server === '') {
      return 'connector';
    }
    return server.replace(/^mcp_/, '').replace(/_/g, ' ');
  }

  /**
   * Claude names a namespaced call after its server (`Used {name}`, id
   * `Nj4ZbS6pT4`) rather than showing the raw `mcp__server__tool` id.
   */
  function connectorTitle(raw: string): string | undefined {
    return isNamespacedToolName(raw)
      ? `Used ${connectorDisplayName(raw)}`
      : undefined;
  }

  /** Claude's `fA` combined with the wider test report 31 section 1.4 uses. */
  const COMMAND_TOOL_NAMES: ReadonlySet<string> = new Set([
    'bash',
    'bash_tool',
    'power_shell',
    'powershell',
    'kill_bash',
    'tmux',
  ]);

  function isCommandTool(raw: string): boolean {
    return COMMAND_TOOL_NAMES.has(aliasToolName(raw));
  }

  const CATEGORY_VARIANTS: Readonly<Record<ToolCategory, ToolVariant>> = {
    read: 'read',
    view: 'read',
    write: 'write',
    edit: 'edit',
    notebook_edit: 'edit',
    delete_file: 'write',
    glob: 'search',
    grep: 'search',
    web: 'search',
    web_fetch: 'read',
    bash: 'bash',
    kill_bash: 'bash',
    tmux: 'bash',
    task: 'code',
    skill: 'code',
    share: 'write',
    past_chats: 'search',
    project_knowledge: 'search',
    drive_search: 'search',
    plan: 'code',
    todo: 'code',
    code: 'code',
    preview: 'code',
    screenshot: 'code',
    browser: 'code',
    tool_search: 'search',
    exit_plan_mode: 'code',
    enter_plan_mode: 'code',
    ask_user_question: 'code',
    bash_output: 'code',
    artifact: 'write',
  };

  function classifyTool(name: string): ToolVariant {
    if (DESKTOP_TOOLS.has(name)) {
      return 'code';
    }
    const category = toolCategory(name);
    if (category !== undefined) {
      return CATEGORY_VARIANTS[category];
    }
    return TOOL_VARIANTS[name] || 'others';
  }

  /**
   * Claude's `BD`. The in-flight verb for every name it can spell, keyed by
   * normalised tool name. This is a lookup and not a suffix rule: `Write` is
   * "Creating a file", `str_replace` is "Editing a file".
   */
  const RUNNING_LABELS_BY_NAME: Readonly<Record<string, string>> = {
    read: 'Reading a file',
    view: 'Reading a file',
    write: 'Creating a file',
    create_file: 'Creating a file',
    edit: 'Editing a file',
    str_replace: 'Editing a file',
    str_replace_editor: 'Editing a file',
    multi_edit: 'Editing files',
    notebook_edit: 'Editing a notebook',
    open_file: 'Opening file',
    update_file: 'Updating file',
    close_file: 'Closing file',
    delete_file: 'Deleting a file',
    file_search: 'Searching files',
    grep: 'Searching files',
    glob: 'Looking for files',
    ls: 'Listing files',
    present_files: 'Sharing files',
    send_user_file: 'Sharing files',
    send_user_message: 'Sending message',
    push_notification: 'Sending notification',
    repl: 'Running code',
    java_script: 'Running code',
    recent_chats: 'Searching past chats',
    conversation_search: 'Searching past chats',
    project_knowledge_search: 'Searching project knowledge',
    drive_search: 'Searching Google Drive',
    web_fetch: 'Reading a page',
    web_search: 'Searching the web',
    web_search_fast: 'Searching the web',
    task: 'Running an agent',
    agent: 'Running an agent',
    skill: 'Running skill',
    tool_search: 'Loading tools',
    exit_plan_mode: 'Proposing a plan',
    enter_plan_mode: 'Starting a plan',
    todo_write: 'Updating the plan',
    ask_user_question: 'Asking a question',
    bash_output: 'Checking command output',
    list_mcp_resources: 'Listing resources',
    list_mcp_resources_tool: 'Listing resources',
    read_resource_link: 'Reading resource',
    read_mcp_resource_tool: 'Reading resource',
    read_widget_context: 'Reading widget context',
  };

  /**
   * The command-class table report 32 section 2 records alongside `BD`. It
   * takes precedence for the CLI tool names and is the only running table
   * whose labels carry a trailing ellipsis.
   */
  const CLI_RUNNING_LABELS: Readonly<Record<string, string>> = {
    glob: 'Looking for files\u2026',
    grep: 'Searching files\u2026',
    read: 'Reading a file\u2026',
    write: 'Creating a file\u2026',
    edit: 'Editing a file\u2026',
    bash: 'Running a command\u2026',
    bash_tool: 'Running a command\u2026',
    power_shell: 'Running a command\u2026',
    powershell: 'Running a command\u2026',
    web_fetch: 'Reading a page\u2026',
    web_search: 'Searching the web\u2026',
    task: 'Multitasking\u2026',
    agent: 'Multitasking\u2026',
    send_message: 'Multitasking\u2026',
    task_get: 'Reading task\u2026',
    task_list: 'Listing tasks\u2026',
    task_create: 'Updating tasks\u2026',
    task_update: 'Updating tasks\u2026',
    task_stop: 'Updating tasks\u2026',
    todo_write: 'Updating the plan\u2026',
    tool_search: 'Loading tools\u2026',
    ask_user_question: 'Asking a question\u2026',
    skill: 'Using a skill\u2026',
    send_user_message: 'Sending message\u2026',
    send_user_file: 'Sharing files\u2026',
    push_notification: 'Sending notification\u2026',
    fetch_inbox_message: 'Reading the thread\u2026',
    bash_output: 'Checking command output\u2026',
    kill_bash: 'Stopping a command\u2026',
    ls: 'Listing files\u2026',
    multi_edit: 'Editing files\u2026',
    notebook_edit: 'Editing notebook\u2026',
    enter_plan_mode: 'Starting a plan\u2026',
    exit_plan_mode: 'Proposing a plan\u2026',
    workflow: 'Running workflow\u2026',
    repl: 'Running code\u2026',
    java_script: 'Running code\u2026',
    appifact_repl: 'Running code\u2026',
    poll: 'Waiting for results\u2026',
    tmux: 'Running terminal\u2026',
  };

  /**
   * Claude's `YI`. Only the verbs whose past tense is not "+ed" are listed;
   * everything else falls through to the category table below.
   */
  const DONE_LABELS_BY_NAME: Readonly<Record<string, string>> = {
    ask_user_question: 'Asked a question',
    bash_output: 'Checked command output',
    enter_plan_mode: 'Started a plan',
    exit_plan_mode: 'Proposed a plan',
    java_script: 'Ran code',
    repl: 'Ran code',
    ls: 'Listed files',
    push_notification: 'Sent notification',
    present_files: 'Shared files',
    send_user_file: 'Shared files',
    send_user_message: 'Sent message',
    skill: 'Ran skill',
    tool_search: 'Loaded tools',
  };

  /** Claude's `XI`. Keyed by normalised name, exactly as the reference keys it. */
  const CANCELLED_LABELS_BY_NAME: Readonly<Record<string, string>> = {
    read: 'Stopped reading file',
    write: 'Stopped creating file',
    recent_chats: 'Stopped searching past chats',
    conversation_search: 'Stopped searching past chats',
    project_knowledge_search: 'Stopped searching project knowledge',
    tool_search: 'Stopped loading tools',
    bash: 'Stopped running the command',
    bash_tool: 'Stopped running the command',
    power_shell: 'Stopped running the command',
    web_search: 'Stopped searching the web',
    web_search_fast: 'Stopped searching the web',
  };

  /**
   * Claude's `QI`. Cancelled wording never applies to these, however the call
   * was spelt.
   */
  const NEVER_CANCELLED_LABELS: ReadonlySet<string> = new Set([
    'ask_user_question',
    'bash_output',
    'enter_plan_mode',
    'hub_workspace_setup',
    'java_script',
    'ls',
    'present_files',
    'push_notification',
    'read_widget_context',
    'send_user_file',
    'send_user_message',
    'tool_search',
  ]);

  /** Claude's `$I`. Done wording never applies to these. */
  const NEVER_DONE_LABELS: ReadonlySet<string> = new Set([
    'exit_plan_mode',
    'repl',
    'skill',
  ]);

  /**
   * Claude's `eL`. The command family keeps its cancelled wording even when
   * reached through an MCP wrapper.
   */
  const CANCELLED_THROUGH_MCP: ReadonlySet<string> = new Set([
    'bash',
    'bash_tool',
    'power_shell',
    'powershell',
  ]);

  /**
   * Claude's `BR`. Category wording with a count: `[singular, plural]`. A
   * single entry means the reference has no plural form for that category.
   */
  const CATEGORY_DONE_LABELS: Readonly<
    Record<ToolCategory, readonly [string, string?]>
  > = {
    read: ['Read a file', 'Read {count} files'],
    view: ['Read a file', 'Read {count} files'],
    write: ['Created a file', 'Created {count} files'],
    edit: ['Edited a file', 'Edited {count} files'],
    notebook_edit: ['Edited a notebook', 'Edited {count} notebooks'],
    delete_file: ['Deleted a file', 'Deleted {count} files'],
    glob: ['Looked for files'],
    grep: ['Searched files'],
    web: ['Searched the web'],
    web_fetch: ['Read a page', 'Read {count} pages'],
    bash: ['Ran a command', 'Ran {count} commands'],
    kill_bash: ['Stopped a command', 'Stopped {count} commands'],
    tmux: ['Ran terminal'],
    task: ['Ran an agent', 'Ran {count} agents'],
    skill: ['Loaded a skill', 'Loaded {count} skills'],
    share: ['Shared files'],
    past_chats: ['Searched past chats'],
    project_knowledge: ['Searched project knowledge'],
    drive_search: ['Searched Google Drive'],
    plan: ['Updated the plan'],
    todo: ['Updated tasks'],
    code: ['Ran code', 'Ran code {count} times'],
    preview: ['Used the browser'],
    screenshot: ['Desktop screenshot', 'Desktop screenshots'],
    browser: ['Used Claude in Chrome'],
    tool_search: ['Loaded tools'],
    exit_plan_mode: ['Proposed a plan'],
    enter_plan_mode: ['Started a plan'],
    ask_user_question: ['Asked a question'],
    bash_output: ['Checked command output'],
    artifact: ['Used artifacts'],
  };

  /**
   * Claude's `bE`. The category-level gerund, used when the name-level table
   * has nothing. The reference writes these as singular/plural pairs.
   */
  const CATEGORY_RUNNING_LABELS: Readonly<Record<ToolCategory, string>> = {
    read: 'Reading a file',
    view: 'Reading a file',
    write: 'Creating a file',
    edit: 'Editing a file',
    notebook_edit: 'Editing a notebook',
    delete_file: 'Deleting a file',
    glob: 'Looking for files',
    grep: 'Searching files',
    web: 'Searching the web',
    web_fetch: 'Reading a page',
    bash: 'Running a command',
    kill_bash: 'Stopping a command',
    tmux: 'Running terminal',
    task: 'Running an agent',
    skill: 'Loading skill',
    share: 'Sharing files',
    past_chats: 'Searching past chats',
    project_knowledge: 'Searching project knowledge',
    drive_search: 'Searching Google Drive',
    plan: 'Updating the plan',
    todo: 'Updating tasks',
    code: 'Running code',
    preview: 'Taking screenshot',
    screenshot: 'Taking screenshot',
    browser: 'Browsing',
    tool_search: 'Loading tools',
    exit_plan_mode: 'Proposing a plan',
    enter_plan_mode: 'Starting a plan',
    ask_user_question: 'Asking a question',
    bash_output: 'Checking command output',
    artifact: 'Using artifacts',
  };

  /**
   * Claude's task-status (`uR`), computer-action (`bR`) and project-method
   * (`bR`) switches are deliberately not ported: MP has no tool that takes a
   * `status`, a computer-use `action` or a project `method`, so those strings
   * would have no row to land on.
   */

  /**
   * Claude's `VI`. The eight fixed remote-device tool ids. Each entry is the
   * running form; the done form is the same sentence in the past tense and the
   * cancelled form is generated mechanically as `Stopped <lowercased first
   * word><rest>`.
   */
  const REMOTE_DEVICE_LABELS: Readonly<
    Record<string, readonly [string, string]>
  > = {
    'mcp__remote-devices__device_stage_files': [
      'Reading files on your computer',
      'Read files on your computer',
    ],
    'mcp__remote-devices__device_commit_files': [
      'Saving files to your computer',
      'Saved files to your computer',
    ],
    'mcp__remote-devices__device_list_dir': [
      'Listing files on your computer',
      'Listed files on your computer',
    ],
    'mcp__remote-devices__device_request_folder_access': [
      'Requesting access to a folder on your computer',
      'Requested access to a folder on your computer',
    ],
    'mcp__remote-devices__device_request_delete_permission': [
      'Requesting permission to delete files on your computer',
      'Requested permission to delete files on your computer',
    ],
    'mcp__remote-devices__list_devices': [
      'Listing connected computers',
      'Listed connected computers',
    ],
    'mcp__remote-devices__get_device_info': [
      'Checking computer status',
      'Checked computer status',
    ],
    'mcp__remote-devices__device_bash': [
      'Running a command on your computer',
      'Ran a command on your computer',
    ],
  };

  /**
   * Claude's `dR`. Artifact actions, each `[running, done]`. The action is
   * `input.action`, or `"publish"` when the tool is an artifact tool and the
   * input carries one of the publish keys without an explicit action.
   */
  const ARTIFACT_ACTION_LABELS: Readonly<
    Record<string, readonly [string, string]>
  > = {
    publish: ['Publishing an artifact', 'Published an artifact'],
    // MP names the creation tool `Artifact.create`; the reference spells the
    // same action `create_artifact` in its cowork table, where it reads
    // "Creating artifact" / "Created artifact". `dR` has no `create` entry.
    create: ['Creating artifact', 'Created artifact'],
    upload_asset: ['Adding artifact files', 'Added artifact files'],
    copy_from: ['Adding artifact files', 'Added artifact files'],
    share: ['Sharing an artifact', 'Shared an artifact'],
    read: ['Reading an artifact', 'Read an artifact'],
    read_file: ['Reading an artifact', 'Read an artifact'],
    read_asset: ['Reading an artifact', 'Read an artifact'],
    read_page_data: ['Reading artifact data', 'Read artifact data'],
    read_db: ['Reading artifact data', 'Read artifact data'],
    list_files: ['Listing artifact files', 'Listed artifact files'],
    list_assets: ['Listing artifact files', 'Listed artifact files'],
    delete_asset: ['Deleting an artifact file', 'Deleted an artifact file'],
    open: ['Opening an artifact', 'Opened an artifact'],
    update: ['Updating an artifact', 'Updated an artifact'],
    sync: ['Syncing an artifact', 'Synced an artifact'],
    version: ['Saving an artifact version', 'Saved an artifact version'],
    list: ['Listing artifacts', 'Listed artifacts'],
    list_types: ['Checking artifact types', 'Checked artifact types'],
    describe_type: ['Checking an artifact type', 'Checked an artifact type'],
    quickstart: [
      'Checking how to start an artifact',
      'Checked how to start an artifact',
    ],
    delete: ['Deleting an artifact', 'Deleted an artifact'],
    pin: ['Pinning an artifact', 'Pinned an artifact'],
    unpin: ['Unpinning an artifact', 'Unpinned an artifact'],
    comments: ['Reading artifact comments', 'Read artifact comments'],
    reply: [
      'Replying to an artifact comment',
      'Replied to an artifact comment',
    ],
    resolve: ['Resolving an artifact comment', 'Resolved an artifact comment'],
    watch: ['Watching an artifact', 'Watching an artifact'],
    unwatch: ['Stopping an artifact watch', 'Stopped watching an artifact'],
    status: ['Listing artifact watches', 'Listed artifact watches'],
    resume_replies: [
      'Resuming artifact comment replies',
      'Resumed artifact comment replies',
    ],
    write_db: ['Updating artifact data', 'Updated artifact data'],
    preview: ['Previewing an artifact', 'Previewed an artifact'],
    verify: ['Checking an artifact', 'Checked an artifact'],
  };

  /** Claude's `hR`. Input keys that imply `publish` when no action is given. */
  const ARTIFACT_PUBLISH_KEYS: readonly string[] = [
    'file_path',
    'files',
    'root',
    'type_url',
    'capabilities',
    'contract',
  ];

  const ARTIFACT_TOOL_NAMES: ReadonlySet<string> = new Set([
    'artifact',
    'artifacts',
    'artifacts_v0',
  ]);

  /** Claude's `lR`. Keeps the last two path segments. */
  function shortenPath(path: string): string {
    const parts = path.split('/');
    return parts.length > 2
      ? parts.slice(-2).join('/')
      : parts[parts.length - 1] || path;
  }

  /** Claude's `J`. Read a string field, or nothing. */
  function inputString(
    input: Record<string, unknown>,
    key: string,
  ): string | undefined {
    const value = input[key];
    return typeof value === 'string' ? value : undefined;
  }

  /** The three states the reference words differently. */
  type ToolPhase = 'running' | 'done' | 'cancelled';

  /**
   * Claude's `TA`. Summaries lose their trailing punctuation.
   */
  function stripTrailingPunctuation(value: string): string {
    return value.trim().replace(/[.!?;:,]+$/, '');
  }

  /**
   * Claude's `Fs`/`rr` pair, both of which live in uncaptured chunks. The
   * reference applies `Fs(value).trim()` as a general normalise-then-trim, so
   * a whitespace collapse followed by a trim is what the caller observes.
   */
  function normaliseText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  /**
   * Claude's `mA`. The model-written `description` for a command tool, or
   * nothing. Four rejections, in the reference's order.
   *
   * The fourth is the one that matters: a description containing a newline is
   * refused outright, which is what makes the row a single line instead of a
   * truncated one. A multi-line description therefore falls back rather than
   * being cut.
   */
  function commandDescription(
    input: Record<string, unknown>,
  ): string | undefined {
    const raw = input.description;
    if (typeof raw !== 'string') {
      return undefined;
    }
    if (raw.includes('<cc-memory') || raw.includes('</cc-memory')) {
      return undefined;
    }
    const normalised = normaliseText(raw);
    if (normalised === '') {
      return undefined;
    }
    // The newline test runs on the *raw* value, not the collapsed one: the
    // reference collapses whitespace only to ask whether anything is left,
    // and checks for a line break on the untouched string. Testing the
    // collapsed value would make this branch unreachable.
    if (/[\n\r]/.test(raw.trim())) {
      return undefined;
    }
    return normalised;
  }

  /**
   * Claude's `gA`. True when the description merely restates the command.
   *
   * Both sides are whitespace-collapsed and lower-cased, and the description
   * must be a *prefix* of the command followed by a character outside
   * `[a-z0-9_]` — so `ls` is suppressed above `ls -la` but survives above
   * `lsof`.
   */
  function descriptionRestatesCommand(
    description: string,
    input: Record<string, unknown>,
  ): boolean {
    const command = input.command;
    if (typeof command !== 'string') {
      return false;
    }
    const flatten = (value: string) =>
      normaliseText(value).replace(/\s+/g, ' ').toLowerCase();
    const described = flatten(description);
    const executed = flatten(command);
    if (executed === '' || !executed.startsWith(described)) {
      return false;
    }
    return (
      executed.length === described.length ||
      /[^a-z0-9_]/.test(executed.charAt(described.length))
    );
  }

  /**
   * Claude's `hA`. The bash one-line summary: the model's description when it
   * survives all four rejections and is not a restatement of the command.
   * Returns nothing when it does not, which is what sends the row to the
   * fallback chain.
   */
  function commandSummary(input: Record<string, unknown>): string | undefined {
    const description = commandDescription(input);
    if (description === undefined) {
      return undefined;
    }
    return descriptionRestatesCommand(description, input)
      ? undefined
      : description;
  }

  /**
   * The fallback chain report 31 section 1.4 records, in its order:
   * description, then the raw command, then the state verb.
   *
   * Step two has no truncation in the reference — a long command is shown
   * whole at this layer and any clamping is the row's `text-overflow`, which
   * is why `firstLine` is the only shaping done here.
   */
  function commandSummaryLine(input: Record<string, unknown>): string {
    const description = commandSummary(input);
    if (description !== undefined) {
      return description;
    }
    return firstLine(
      inputString(input, 'command') ?? inputString(input, 'cmd') ?? '',
    );
  }

  /**
   * Claude's `WP`. How a file-writing call can be previewed.
   *
   * Two adaptations, both forced by MP's tool shapes: the reference reads
   * `file_path` where MP writes `path`, and the reference takes an `Edit`'s
   * top-level `old_string`/`new_string` *before* looking at `edits`, so an
   * `Edit` carrying only `edits` resolves to nothing there while MP's Edit
   * accepts exactly that shape. The pair is therefore read from either place.
   * The 200000-character ceiling is the reference's own number.
   */
  function fileChangeMode(
    name: string,
    input: Record<string, unknown>,
  ): 'preview' | 'too_large' | undefined {
    const path = input.file_path ?? input.path;
    if (typeof path !== 'string') {
      return undefined;
    }
    const alias = aliasToolName(name);
    let parts: unknown[];
    if (alias === 'write' || alias === 'create_file') {
      parts = [input.content];
    } else if (
      typeof input.old_string === 'string' ||
      typeof input.new_string === 'string'
    ) {
      parts = [input.old_string, input.new_string];
    } else if (Array.isArray(input.edits) && input.edits.length > 0) {
      parts = input.edits.flatMap(edit =>
        typeof edit === 'object' && edit !== null
          ? [
              (edit as Record<string, unknown>).old_string,
              (edit as Record<string, unknown>).new_string,
            ]
          : [undefined],
      );
    } else {
      return undefined;
    }
    if (!parts.every(part => typeof part === 'string')) {
      return undefined;
    }
    return (parts as string[]).every(part => part.length <= 200000)
      ? 'preview'
      : 'too_large';
  }

  /**
   * Claude's `fN`. Thinking duration wording. The reference rounds to whole
   * seconds first and renders nothing at or below zero.
   */
  function thinkingDuration(ms: number): string | undefined {
    const seconds = Math.round(ms / 1000);
    if (seconds <= 0) {
      return undefined;
    }
    if (seconds < 60) {
      return `Thought for ${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    if (minutes < 60) {
      return rest > 0
        ? `Thought for ${minutes}m ${rest}s`
        : `Thought for ${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const minutesRest = minutes % 60;
    return minutesRest > 0
      ? `Thought for ${hours}h ${minutesRest}m`
      : `Thought for ${hours}h`;
  }

  /**
   * Elapsed-time wording for a row that is still running. Same rounding
   * as the thinking duration, without its past-tense prefix.
   */
  function runningDuration(ms: number): string | undefined {
    const seconds = Math.round(ms / 1000);
    if (seconds <= 0) {
      return undefined;
    }
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    if (minutes < 60) {
      return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const minutesRest = minutes % 60;
    return minutesRest > 0 ? `${hours}h ${minutesRest}m` : `${hours}h`;
  }

  /**
   * The elapsed span for an in-flight row. Chips carry the trajectory
   * record's start time when the backend sent one; without it there is
   * nothing truthful to count from, so the row renders with no timer
   * instead of a fabricated one.
   */
  function runningElapsedNode(chips: TurnChip[]): ChatNode | null {
    const starts = chips
      .filter(chip => chip.result === undefined)
      .map(chip => Number(chip.startedAtMs) || 0)
      .filter(value => value > 0);
    if (!starts.length) {
      return null;
    }
    const wording = runningDuration(Date.now() - Math.min(...starts));
    if (!wording) {
      return null;
    }
    const sep = h('span', {class: 'mp-chat-tool-sep', 'aria-hidden': 'true'});
    attach(sep, ' · ');
    const span = h('span', {class: 'mp-chat-tool-elapsed'});
    attach(span, wording);
    const wrap = h('span', {class: 'mp-chat-tool-elapsed-wrap'});
    attach(wrap, sep);
    attach(wrap, span);
    return wrap;
  }

  /**
   * The category-level done wording with a count, from Claude's `BR`. A
   * single-entry row means the reference has no plural form, so the singular
   * stands for any count.
   */
  function categoryDoneLabel(
    category: ToolCategory | undefined,
    count: number,
  ): string | undefined {
    if (category === undefined) {
      return undefined;
    }
    const pair = CATEGORY_DONE_LABELS[category];
    const chosen = count === 1 ? pair[0] : (pair[1] ?? pair[0]);
    return chosen.replace('{count}', String(count));
  }

  /**
   * Resolve the label a tool row shows, in the reference's precedence:
   * the running table, then the irregular past table, then the cancelled
   * table with its three gates, then the category tables.
   *
   * Returns nothing when the reference has no wording, which lets a caller
   * fall back to its own table instead of inventing a verb.
   */
  function toolLabel(
    rawName: string,
    input: Record<string, unknown>,
    phase: ToolPhase,
    count = 1,
  ): string | undefined {
    const name = aliasToolName(rawName);
    const namespaced = isNamespacedToolName(rawName);
    const category = toolCategory(rawName);

    const remote = REMOTE_DEVICE_LABELS[rawName];
    if (remote !== undefined) {
      if (phase === 'running') {
        return remote[0];
      }
      if (phase === 'cancelled') {
        return `Stopped ${remote[0].charAt(0).toLowerCase()}${remote[0].slice(1)}`;
      }
      return remote[1];
    }

    if (phase === 'running') {
      const cli = CLI_RUNNING_LABELS[name];
      if (cli !== undefined) {
        return cli;
      }
      const named = RUNNING_LABELS_BY_NAME[name];
      if (named !== undefined) {
        return named;
      }
      return categoryDoneOrRunning(category);
    }

    if (phase === 'cancelled') {
      const cancellable =
        !NEVER_CANCELLED_LABELS.has(name) &&
        (!namespaced || CANCELLED_THROUGH_MCP.has(name));
      if (cancellable) {
        const cancelled = CANCELLED_LABELS_BY_NAME[name];
        if (cancelled !== undefined) {
          return cancelled;
        }
      }
      return undefined;
    }

    if (!NEVER_DONE_LABELS.has(name)) {
      const irregular = DONE_LABELS_BY_NAME[name];
      if (irregular !== undefined) {
        return irregular;
      }
    }
    return categoryDoneLabel(category, count);
  }

  function categoryDoneOrRunning(
    category: ToolCategory | undefined,
  ): string | undefined {
    return category === undefined
      ? undefined
      : CATEGORY_RUNNING_LABELS[category];
  }

  /**
   * Claude's artifact action routing (`gR`): an explicit `input.action`, or
   * `publish` when an artifact tool carries a publish key and no action.
   *
   * MP spells these as `Artifact.create` / `Artifact.read` / `Artifact.update`
   * rather than a single `Artifact` tool with an `action` input, so the method
   * after the dot is read as the action and takes precedence over `input.action`.
   */
  function artifactActionLabel(
    rawName: string,
    input: Record<string, unknown>,
    phase: ToolPhase,
  ): string | undefined {
    const dot = rawName.indexOf('.');
    const head = aliasToolName(dot === -1 ? rawName : rawName.slice(0, dot));
    if (!ARTIFACT_TOOL_NAMES.has(head)) {
      return undefined;
    }
    const method =
      dot === -1 ? undefined : normaliseToolName(rawName.slice(dot + 1));
    const action =
      method ??
      inputString(input, 'action') ??
      (ARTIFACT_PUBLISH_KEYS.some(key => key in input) ? 'publish' : undefined);
    if (action === undefined) {
      return undefined;
    }
    const entry = ARTIFACT_ACTION_LABELS[action];
    if (entry === undefined) {
      return undefined;
    }
    return phase === 'running' ? entry[0] : entry[1];
  }

  function isJunkSummary(value: string): boolean {
    const v = value.trim();
    if (v === '' || v === '{}' || v === 'null' || v === 'undefined') {
      return true;
    }
    if (/^[0-9a-f]{16,}$/i.test(v.replace(/[-_\s]/g, ''))) {
      return true;
    }
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
      if (picked !== undefined) {
        candidates.push(firstLine(picked));
      }
      for (const v of Object.values(args)) {
        if (typeof v === 'string' && v !== '') {
          candidates.push(firstLine(v));
        }
      }
      candidates.push(firstLine(argsRaw));
    }
    return candidates.find(c => !isJunkSummary(c)) ?? '';
  }

  function parseArgs(argsRaw: string): Record<string, unknown> | null {
    if (argsRaw === '') {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(argsRaw);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  /**
   * The one-line summary for a settled or in-flight row.
   *
   * Command tools go through the reference's description filter chain; every
   * other tool keeps the existing first-useful-string rule. The two answer
   * different questions and the reference only replaces the first one, so the
   * generic path is left alone rather than being folded into it.
   */
  function summaryText(
    name: string,
    variant: ToolVariant,
    argsRaw: string,
  ): string {
    if (isCommandTool(name)) {
      const input = parseArgs(argsRaw);
      return input === null ? firstLine(argsRaw) : commandSummaryLine(input);
    }
    // Claude's `lR` under `shortenPaths`: the row names the file by its last two
    // segments (`src/app.ts`) instead of the whole resolved path.
    if (FILE_PATH_VARIANTS.has(variant)) {
      const input = parseArgs(argsRaw);
      const path =
        input === null ? undefined : pickString(input, ['path', 'file_path']);
      if (path !== undefined) {
        return shortenPath(path);
      }
    }
    return deriveSummary(variant, argsRaw);
  }

  function deriveFilePath(
    variant: ToolVariant,
    argsRaw: string,
  ): string | undefined {
    if (!FILE_PATH_VARIANTS.has(variant)) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsRaw);
    } catch {
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    // Deliberately the full path: this value is the delivered-file map key,
    // and shortening it would collide two files that share their last two
    // segments. The display form is shortened in `summaryText` instead.
    return pickString(parsed as Record<string, unknown>, ['path', 'file_path']);
  }

  function deriveBody(variant: ToolVariant, argsRaw: string): string | null {
    if (!argsRaw) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsRaw);
    } catch {
      return argsRaw;
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      Object.keys(parsed).length === 0
    ) {
      return null;
    }
    if (variant === 'code' && typeof parsed === 'object' && parsed !== null) {
      const code = (parsed as Record<string, unknown>).code;
      if (typeof code === 'string' && code !== '') {
        return code;
      }
    }
    return JSON.stringify(parsed, null, 2);
  }

  interface DiffBlock {
    kind: 'del' | 'add' | 'context' | 'notice';
    text: string;
  }
  interface DiffView {
    blocks: DiffBlock[];
    previews: Array<{blocks: DiffBlock[]; copyText?: string; numbered?: boolean}>;
  }

  function appendDiffBlock(
    text: string,
    kind: DiffBlock['kind'],
    out: DiffBlock[],
  ): void {
    if (text) {
      out.push({kind, text});
    }
  }

  function replacementDiff(before: string, after: string): DiffBlock[] | null {
    const oldLines = before.match(/[^\n]*\n|[^\n]+$/g) || [];
    const newLines = after.match(/[^\n]*\n|[^\n]+$/g) || [];
    let start = 0;
    let oldEnd = oldLines.length;
    let newEnd = newLines.length;
    while (
      start < oldEnd &&
      start < newEnd &&
      oldLines[start] === newLines[start]
    ) {
      start++;
    }
    while (
      oldEnd > start &&
      newEnd > start &&
      oldLines[oldEnd - 1] === newLines[newEnd - 1]
    ) {
      oldEnd--;
      newEnd--;
    }
    const groups: Array<{kind: DiffBlock['kind']; parts: string[]}> = [];
    const push = (kind: DiffBlock['kind'], text: string): void => {
      if (!text) {
        return;
      }
      const last = groups.at(-1);
      if (last?.kind === kind) {
        last.parts.push(text);
      } else {
        groups.push({kind, parts: [text]});
      }
    };
    push('context', oldLines.slice(0, start).join(''));
    const oldCount = oldEnd - start;
    const newCount = newEnd - start;
    const oldSet = new Set(oldLines.slice(start, oldEnd));
    if (!newLines.slice(start, newEnd).some(line => oldSet.has(line))) {
      push('del', oldLines.slice(start, oldEnd).join(''));
      push('add', newLines.slice(start, newEnd).join(''));
    } else {
      // Optional inline comparisons must not stall the UI. At this budget the
      // table is under 2 MiB; larger comparisons retain separate full texts.
      if (oldCount * newCount > 200_000) {
        return null;
      }
      const width = newCount + 1;
      const lengths = new Uint32Array((oldCount + 1) * width);
      for (let i = oldCount - 1; i >= 0; i--) {
        for (let j = newCount - 1; j >= 0; j--) {
          lengths[i * width + j] =
            oldLines[start + i] === newLines[start + j]
              ? lengths[(i + 1) * width + j + 1] + 1
              : Math.max(
                  lengths[(i + 1) * width + j],
                  lengths[i * width + j + 1],
                );
        }
      }
      let i = 0;
      let j = 0;
      while (i < oldCount || j < newCount) {
        if (
          i < oldCount &&
          j < newCount &&
          oldLines[start + i] === newLines[start + j]
        ) {
          push('context', oldLines[start + i++]);
          j++;
        } else if (
          j === newCount ||
          (i < oldCount &&
            lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])
        ) {
          push('del', oldLines[start + i++]);
        } else {
          push('add', newLines[start + j++]);
        }
      }
    }
    push('context', oldLines.slice(oldEnd).join(''));
    return groups.map(group => ({
      kind: group.kind,
      text: group.parts.join(''),
    }));
  }

  function deriveDiff(
    name: string,
    argsRaw: string,
    presentation?: unknown,
  ): DiffView | null {
    const shown = typeof presentation === 'string'
      ? outputRecord(presentation) : recordOf(presentation);
    if (
      shown?.kind === 'file_diff' &&
      typeof shown.beforeText === 'string' &&
      typeof shown.afterText === 'string'
    ) {
      const before = shown.beforeText.replace(/\r\n/g, '\n');
      const after = shown.afterText.replace(/\r\n/g, '\n');
      let blocks = replacementDiff(before, after);
      if (!blocks) {
        blocks = [{kind: 'notice', text: lt('chat.diff_separate_text')}];
        appendDiffBlock(before, 'del', blocks);
        appendDiffBlock(after, 'add', blocks);
      }
      return {
        blocks,
        previews: [{blocks, copyText: shown.afterText || shown.beforeText, numbered: true}],
      };
    }
    if (shown?.kind === 'file_diff_unavailable') {
      const blocks: DiffBlock[] = [{
        kind: 'notice',
        text: lt(shown.reason === 'binary'
          ? 'chat.diff_unavailable_binary' : shown.reason === 'capture_failed'
            ? 'chat.diff_unavailable_capture' : shown.reason === 'previous'
              ? 'chat.diff_unavailable_previous' : 'chat.diff_unavailable_large'),
      }];
      return {blocks, previews: [{blocks}]};
    }
    if (!argsRaw) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsRaw);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const args = parsed as Record<string, unknown>;
    const view: DiffView = {blocks: [], previews: []};
    if (name === 'Edit' || name === 'edit_file' || name === 'edit') {
      for (const raw of Array.isArray(args.edits) ? args.edits : [args]) {
        const edit = recordOf(raw);
        if (!edit) {
          continue;
        }
        const beforeText = firstString(edit, [
          'old_string',
          'oldText',
          'old_str',
        ]);
        const afterText = firstString(edit, [
          'new_string',
          'newText',
          'new_str',
        ]);
        const before = beforeText.replace(/\r\n/g, '\n');
        const after = afterText.replace(/\r\n/g, '\n');
        let blocks = replacementDiff(before, after);
        if (!blocks) {
          blocks = [
            {
              kind: 'notice',
              text: lt('chat.diff_separate_text'),
            },
          ];
          appendDiffBlock(before, 'del', blocks);
          appendDiffBlock(after, 'add', blocks);
        }
        if (blocks.length) {
          view.blocks.push(...blocks);
          view.previews.push({blocks, copyText: afterText || beforeText});
        }
      }
      return view.blocks.length ? view : null;
    }
    if (name === 'Write' || name === 'write_file' || name === 'write') {
      const content = firstString(args, ['content', 'text', 'new_string']);
      if (!content) {
        return null;
      }
      appendDiffBlock(content.replace(/\r\n/g, '\n'), 'add', view.blocks);
      view.previews.push({blocks: view.blocks, copyText: content, numbered: true});
      return view;
    }
    return null;
  }

  interface DiffStat {
    added: number;
    removed: number;
  }

  function reportedDiffStat(
    output: string,
    field: 'diffStat' | 'turnDiffStat',
  ): DiffStat | null | undefined {
    const result = outputRecord(output);
    if (!result || !(field in result)) {
      return undefined;
    }
    const stat = recordOf(result[field]);
    const added = stat?.added;
    const removed = stat?.removed;
    return typeof added === 'number' &&
      Number.isInteger(added) &&
      added >= 0 &&
      typeof removed === 'number' &&
      Number.isInteger(removed) &&
      removed >= 0
      ? {added, removed}
      : null;
  }

  function countLines(text: string): number {
    if (text === '') {
      return 0;
    }
    const parts = text.split('\n');
    if (parts.length > 1 && parts[parts.length - 1] === '') {
      parts.pop();
    }
    return parts.length;
  }

  function firstString(
    args: Record<string, unknown>,
    keys: readonly string[],
  ): string {
    return pickString(args, keys) ?? '';
  }

  function deriveDiffStat(name: string, argsRaw: string): DiffStat | null {
    if (!argsRaw) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsRaw);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const args = parsed as Record<string, unknown>;
    if (name === 'Edit' || name === 'edit_file' || name === 'edit') {
      const oldText = firstString(args, ['old_string', 'oldText', 'old_str']);
      const newText = firstString(args, ['new_string', 'newText', 'new_str']);
      if (!oldText && !newText) {
        return null;
      }
      const blocks = replacementDiff(
        oldText.replace(/\r\n/g, '\n'),
        newText.replace(/\r\n/g, '\n'),
      );
      if (!blocks) {
        return null;
      }
      const stat = {added: 0, removed: 0};
      for (const block of blocks) {
        if (block.kind === 'add') {
          stat.added += countLines(block.text);
        } else if (block.kind === 'del') {
          stat.removed += countLines(block.text);
        }
      }
      return stat;
    }
    if (name === 'Write' || name === 'write_file' || name === 'write') {
      const content = firstString(args, ['content', 'text', 'new_string']);
      if (!content) {
        return null;
      }
      return {added: countLines(content), removed: 0};
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
    fileTarget?: string;
    filePreviewPath?: string;
    fileDiffReference?: {beforePath: string | null; afterPath: string};
    presentation?: unknown;
    body: string | null;
    output: string | null;
    errorSummary: string | null;
    errorTitle: boolean;
    state: ToolState;
    callId: string;
    diffStat: DiffStat | null;
    fileChange: 'preview' | 'too_large' | undefined;
  }

  function toolRowModel(
    name: string,
    argsRaw: string,
    result?: {text?: string; isError?: boolean; interrupted?: boolean; presentation?: unknown},
    callId = '',
    executionRoot = '',
  ): ToolRowModel {
    const variant = classifyTool(name);
    const state: ToolState =
      result === undefined
        ? 'running'
        : result.interrupted
          ? 'stopped'
          : result.isError
            ? 'error'
            : 'ok';
    const input = parseArgs(argsRaw) ?? {};
    const receipt = FILE_WRITE_TOOLS.has(name)
      ? outputRecord(result?.text || '')
      : null;
    const isWrite = ['Write', 'write_file', 'write'].includes(name);
    const phase: ToolPhase =
      state === 'running'
        ? 'running'
        : state === 'stopped'
          ? 'cancelled'
          : 'done';
    const errorUrl =
      state === 'error' && name === 'Browser.navigate'
        ? (() => {
            const url = input.url;
            return typeof url === 'string' ? url : '';
          })()
        : '';

    const descriptiveBase =
      argsRaw === '' ? name : summaryText(name, variant, argsRaw);
    let summary =
      name === 'list_dir' || isQuestionTool(name) || PLAN_TOOLS.has(name)
        ? ''
        : descriptiveBase;
    if (name === 'Tools' && Array.isArray(input.names)) {
      summary = input.names.join(', ');
    }

    // The reference's category labels are its *last resort*: "Ran a command"
    // only appears when there is no description and no command to show. This
    // row is `<title> <summary>`, so when a detail is on the line the short
    // verb stays -- "Read a file src/app.ts" would state the same thing twice.
    const detailSpliced = summary !== '';
    const sentence = (label: string | undefined) =>
      detailSpliced ? undefined : label;

    const mpCompleted =
      TOOL_TITLES[name] ??
      (variant === 'others' ? name : VARIANT_TITLES[variant]);
    const mpRunning =
      RUNNING_TITLES[name] || VARIANT_RUNNING_TITLES[variant] || mpCompleted;

    // A namespaced MCP call is named after its server rather than shown as its
    // raw id, and that name is not a sentence to append a detail to.
    const connector = connectorTitle(name);

    // Three of the reference's tables answer with a whole sentence rather than
    // a verb to pair with a detail: the artifact actions, the eight fixed
    // remote-device ids, and the cancelled verbs. Those replace the line
    // instead of being appended to it, so the detail is dropped. The cancelled
    // table only fires where it has an entry -- anything without one keeps its
    // completed label, which is the reference's own gate.
    const sentenceTitle =
      artifactActionLabel(name, input, phase) ??
      (REMOTE_DEVICE_LABELS[name] === undefined
        ? undefined
        : toolLabel(name, input, phase)) ??
      (phase === 'cancelled'
        ? toolLabel(isWrite ? 'Write' : name, input, 'cancelled')
        : undefined);
    if (sentenceTitle !== undefined) {
      summary = '';
    }

    // The reference replaces a failed search's whole header with its own
    // wording, so the query the row was carrying goes away with it.
    const webFailed =
      state === 'error' && !isBlockedResult(result) && webSearchTool(name)
        ? 'Couldn\u2019t complete this search.'
        : null;
    if (webFailed !== null) {
      summary = '';
    }

    const completedTitle = isBlockedResult(result)
      ? 'Blocked'
      : (webFailed ??
        (errorUrl
          ? 'Failed to fetch'
          : SUBAGENT_TOOLS.has(name)
            ? 'Subagent'
            : isWrite && state === 'error'
              ? 'Failed to write'
              : isWrite && state === 'ok' && receipt?.created === false
                ? 'Updated'
                : (connector ??
                  sentence(toolLabel(name, input, 'done')) ??
                  mpCompleted)));
    // An unknown tool is shown by its raw name when settled, and keeps that
    // name mid-flight too — a wrong tense beats a wrong tool.
    // `||`, not `??`: an empty variant title means "no running form", and a
    // nullish chain would make that empty string the visible label.
    const runningTitle = SUBAGENT_TOOLS.has(name)
      ? 'Running subagent'
      : isQuestionTool(name)
        ? (connector ??
          sentence(toolLabel(name, input, 'running')) ??
          RUNNING_TITLES[name] ??
          'Asking a question')
        : (connector ??
          sentence(toolLabel(name, input, 'running')) ??
          mpRunning);

    // A stopped call previously rendered with the completed verb, which says
    // the opposite of what happened.
    const title =
      sentenceTitle ?? (phase === 'running' ? runningTitle : completedTitle);
    const shellResult =
      variant === 'bash' ? outputRecord(result?.text || '') : null;
    const terminal =
      shellResult !== null &&
      (typeof shellResult.stdout === 'string' ||
        typeof shellResult.stderr === 'string');
    const stdout = terminal ? firstString(shellResult, ['stdout']) : '';
    const stderr = terminal ? firstString(shellResult, ['stderr']) : '';
    const terminalText =
      stdout +
      (stdout && stderr && !stdout.endsWith('\n') ? '\n' : '') +
      stderr;
    let output = terminal
      ? terminalText || firstString(shellResult, ['error', 'error_message']) || null
      : result === undefined || !result.text
        ? null
        : result.text;
    if (output && !terminal) {
      try {
        const decoded = JSON.parse(output);
        if (decoded && typeof decoded.value === 'string') {
          try {
            decoded.value = JSON.parse(decoded.value);
          } catch {}
        }
        output = JSON.stringify(decoded, null, 2);
      } catch {}
    }
    if (output && !terminal) {
      output = output
        .split(/\r?\n/)
        .filter(
          line => !/的目标：(?:已执行，待核对|执行失败)\s*$/u.test(line.trim()),
        )
        .join('\n')
        .trim();
    }
    const partialError =
      state === 'error' && result?.text
        ? firstString(outputRecord(result.text) || {}, [
            'error',
            'error_message',
          ]) ||
          (terminal ? stderr.trim() : '') ||
          (terminal &&
          typeof shellResult.exit === 'number' &&
          shellResult.exit !== 0
            ? `Command exited with code ${shellResult.exit}`
            : '')
        : '';
    const rawError =
      state === 'error' && output !== null
        ? firstLine(partialError || output)
        : null;
    const errorSummary =
      rawError !== null && rawError.length > 60
        ? `${rawError.slice(0, 60)}…`
        : rawError;
    const actualStat = reportedDiffStat(result?.text || '', 'diffStat');
    const filePath = deriveFilePath(variant, argsRaw);
    const target = filePath
      ? firstString(receipt || {}, ['absolutePath']) ||
        executionFilePath(filePath, executionRoot)
      : '';
    const shown =
      typeof result?.presentation === 'string'
        ? outputRecord(result.presentation)
        : recordOf(result?.presentation);
    const fileDiffReference =
      FILE_WRITE_TOOLS.has(name) &&
      state === 'ok' &&
      shown?.kind === 'file_diff' &&
      (shown.beforePath === null || typeof shown.beforePath === 'string') &&
      typeof shown.afterPath === 'string'
        ? {beforePath: shown.beforePath, afterPath: shown.afterPath}
        : undefined;
    return {
      variant,
      name,
      argsRaw,
      title,
      summary,
      filePath,
      fileTarget: /^(?:[a-z]:[\\/]|[\\/])/i.test(target) ? target : undefined,
      fileDiffReference,
      presentation: result?.presentation,
      body: deriveBody(variant, argsRaw),
      output,
      errorSummary,
      errorTitle: Boolean(errorUrl),
      state,
      callId,
      diffStat:
        actualStat === undefined
          ? state === 'error' ||
            (isWrite && receipt?.created === false)
            ? null
            : deriveDiffStat(name, argsRaw)
          : actualStat,
      fileChange: fileChangeMode(name, input),
    };
  }

  function fileDiffNode(presentation: {
    kind: 'file_diff';
    beforeText: string;
    afterText: string;
  }): ChatNode {
    return diffPreviewNode(deriveDiff('', '', presentation)!, {});
  }

  function diffPreviewNode(
    diff: DiffView,
    model: Pick<ToolRowModel, 'filePath' | 'fileTarget' | 'filePreviewPath'>,
  ): ChatNode {
    const root = h('div', {class: 'mp-chat-diff-previews'});
    for (const preview of diff.previews) {
      const section = h('div', {class: 'mp-chat-diff-preview'});
      const header = h('div', {class: 'mp-chat-diff-header'});
      if (model.filePath) {
        const file = model.fileTarget
          ? h('button', {
              type: 'button',
              class: 'mp-chat-diff-path',
              title: model.filePath,
              'data-mp-chat-act': 'open-file',
              'data-file-path': model.filePath,
              'data-file-absolute-path': model.fileTarget,
              ...(model.filePreviewPath
                ? {'data-preview-path': model.filePreviewPath} : {}),
            })
          : h('span', {class: 'mp-chat-diff-path', title: model.filePath});
        attach(file, model.filePath);
        attach(header, file);
      }
      if (preview.copyText !== undefined) {
        const copy = h('button', {
          type: 'button',
          class: 'mp-chat-action mp-chat-diff-copy',
          'aria-label': lt('chat.copy'),
          'data-mp-chat-act': 'copy',
          'data-mp-chat-copy': preview.copyText,
        });
        attach(copy, h('span', {
          class: 'mp-chat-diff-copy-glyph',
          'aria-hidden': 'true',
          'data-glyph': '\ue056',
        }));
        attach(header, copy);
      }
      attach(section, header);
      attach(section, diffNode(preview));
      attach(root, section);
    }
    return root;
  }

  function deferredFileDiffNode(
    model: Pick<ToolRowModel, 'filePath' | 'fileTarget' | 'filePreviewPath'>,
    reference: Record<string, unknown>,
  ): ChatNode {
    const root = diffPreviewNode({blocks: [], previews: [{blocks: []}]}, model);
    root.setAttribute('data-file-diff-reference', JSON.stringify(reference));
    if (model.filePath) {
      root.setAttribute('data-file-path', model.filePath);
    }
    if (model.fileTarget) {
      root.setAttribute('data-file-absolute-path', model.fileTarget);
    }
    if (model.filePreviewPath) {
      root.setAttribute('data-preview-path', model.filePreviewPath);
    }
    const load = h('button', {
      type: 'button',
      class: 'mp-chat-diff-load',
      'data-mp-chat-act': 'load-file-diff',
    });
    attach(load, lt('chat.diff_show'));
    attach(root, load);
    return root;
  }

  async function loadFileDiff(button: HTMLElement): Promise<void> {
    const root = button.closest<HTMLElement>('[data-file-diff-reference]');
    if (!root || button.dataset.loading === 'true') {
      return;
    }
    const restoreFocus = DOC?.activeElement === button;
    button.dataset.loading = 'true';
    (button as HTMLButtonElement).disabled = true;
    button.textContent = lt('chat.diff_loading');
    try {
      const reference = JSON.parse(
        root.getAttribute('data-file-diff-reference') || '{}',
      );
      const reply = await window.magicPointer.readFileDiff(reference);
      if (root.isConnected === false) {
        return;
      }
      if (!reply.ok) {
        throw new Error(reply.error);
      }
      const diff = deriveDiff('', '', reply.presentation)!;
      const content = diffPreviewNode(diff, {
        filePath: root.getAttribute('data-file-path') || undefined,
        fileTarget: root.getAttribute('data-file-absolute-path') || undefined,
        filePreviewPath: root.getAttribute('data-preview-path') || undefined,
      }) as HTMLElement;
      root.replaceChildren(...Array.from(content.childNodes));
      root.removeAttribute('data-file-diff-reference');
      if (restoreFocus && DOC?.activeElement === button) {
        root
          .querySelector<HTMLElement>('[tabindex="0"]')
          ?.focus({preventScroll: true});
      }
    } catch (error) {
      if (root.isConnected === false) {
        return;
      }
      button.dataset.loading = 'false';
      (button as HTMLButtonElement).disabled = false;
      button.textContent = lt('chat.diff_retry');
      button.title = error instanceof Error ? error.message : String(error);
      if (restoreFocus && DOC?.activeElement === button) {
        button.focus({preventScroll: true});
      }
    }
  }

  function numberedDiffNode(blocks: DiffBlock[]): ChatNode {
    const index = diffRows.indexDiffRows(blocks.flatMap(block =>
      block.kind === 'notice' ? [] : [{kind: block.kind, text: block.text}],
    ));
    const pure = blocks.length && blocks.every(block => block.kind === blocks[0].kind)
      && (blocks[0].kind === 'add' || blocks[0].kind === 'del') ? blocks[0].kind : '';
    const card = h('div', {
      class: 'mp-chat-diff',
      'data-diff-numbered': 'true',
      'data-diff-pure-side': pure,
      'data-diff-total-rows': String(index.count),
      style: `--mp-chat-diff-number-width: max(3ch, ${index.digits + (pure ? 2 : 0)}ch)`,
      tabindex: '0',
      role: 'group',
      'aria-label': lt('artifact.kind.code'),
    });
    const render = (first: number, last: number, before: number, after: number): void => {
      const children: ChatNode[] = [];
      if (index.count > diffRows.INITIAL_DIFF_ROWS) {
        children.push(h('div', {
          class: 'mp-chat-diff-virtual-spacer', 'aria-hidden': 'true',
          style: `height: ${before}px`,
        }));
      }
      for (let i = first; i < last; i++) {
        const row = index.get(i);
        if (row.kind === 'separator') {
          children.push(h('div', {
            class: 'mp-chat-diff-hunk-separator mp-chat-diff-window-row',
            'data-diff-row': String(i),
            'aria-hidden': 'true',
          }));
          continue;
        }
        children.push(h('div', {
          class: 'mp-chat-diff-code-row mp-chat-diff-window-row',
          'data-kind': row.kind,
          'data-diff-row': String(i),
          'data-line-number': String(row.number),
        },
        h('span', {class: 'mp-chat-diff-number', 'aria-hidden': 'true'}, String(row.number)),
        h('pre', {class: 'mp-chat-diff-code-text'}, row.text)));
      }
      if (index.count > diffRows.INITIAL_DIFF_ROWS) {
        children.push(h('div', {
          class: 'mp-chat-diff-virtual-spacer', 'aria-hidden': 'true',
          style: `height: ${after}px`,
        }));
      }
      if (DOC) {
        (card as HTMLElement).replaceChildren(...children as HTMLElement[]);
      } else {
        (card as ShimNode).children = [];
        children.forEach(child => attach(card, child));
      }
    };
    const initial = Math.min(index.count, diffRows.INITIAL_DIFF_ROWS);
    const after = index.separators.reduce((height, i) =>
      i >= initial ? height - 13 : height, (index.count - initial) * 17);
    render(0, initial, 0, after);
    if (DOC) {
      diffRows.mountDiffRows(card as HTMLElement, index, render);
    }
    return card;
  }

  function diffNode(diff: Pick<DiffView, 'blocks'> & {numbered?: boolean}): ChatNode {
    if (diff.blocks.some(block => block.kind === 'notice')) {
      const root = h('div', {class: 'mp-chat-diffs'});
      let pending: DiffBlock[] = [];
      const flush = (): void => {
        if (pending.length) {
          attach(root, diffNode({blocks: pending}));
          pending = [];
        }
      };
      for (let i = 0; i < diff.blocks.length; i++) {
        const block = diff.blocks[i];
        if (block.kind !== 'notice') {
          pending.push(block);
          continue;
        }
        flush();
        const separate = h('div', {
          class: 'mp-chat-diff mp-chat-diff-separated',
        });
        attach(separate, h('p', {class: 'mp-chat-diff-notice'}, block.text));
        for (const side of diff.blocks.slice(i + 1, i + 3)) {
          const row = h('pre', {
            class: 'mp-chat-diff-line mp-chat-diff-side',
            'data-kind': side.kind,
            tabindex: '0',
            role: 'group',
            'aria-label': lt(
              side.kind === 'del'
                ? 'chat.diff_removed_text'
                : 'chat.diff_added_text',
            ),
          });
          const prefix = side.kind === 'del' ? '− ' : '+ ';
          attach(
            row,
            side.text.replace(/\n$/, '').replace(/(^|\n)/g, '$1' + prefix),
          );
          attach(separate, row);
        }
        i += 2;
        attach(root, separate);
      }
      flush();
      return root;
    }
    if (diff.numbered) {
      return numberedDiffNode(diff.blocks);
    }
    const card = h('div', {
      class: 'mp-chat-diff',
      tabindex: '0',
      role: 'group',
      'aria-label': lt('artifact.kind.code'),
    });
    for (const block of diff.blocks) {
      const row = h('pre', {class: 'mp-chat-diff-line'});
      row.setAttribute('data-kind', block.kind);
      const prefix =
        block.kind === 'del' ? '- ' : block.kind === 'add' ? '+ ' : '  ';
      const text = block.text.replace(/\r\n/g, '\n').replace(/\n$/, '');
      attach(row, text.replace(/(^|\n)/g, '$1' + prefix));
      attach(card, row);
    }
    return card;
  }

  function deletedFileNode(text: string): ChatNode {
    const content = text
      ? text
          .replace(/\n$/, '')
          .split('\n')
          .map(line => `- ${line}`)
          .join('\n')
      : '';
    return h(
      'pre',
      {class: 'mp-chat-diff mp-chat-diff-line', 'data-kind': 'del'},
      content,
    );
  }

  interface ToolCommand {
    first: string;
    rest: string;
    full: string;
  }

  function toolCommandOf(model: ToolRowModel): ToolCommand | null {
    if (!model.argsRaw) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(model.argsRaw);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const args = parsed as Record<string, unknown>;
    const raw =
      model.variant === 'bash'
        ? pickString(args, ['command', 'cmd'])
        : model.variant === 'code'
          ? pickString(args, ['code'])
          : undefined;
    if (!raw) {
      return null;
    }
    const lines = String(raw).split('\n');
    return {
      first: lines[0],
      rest: lines.slice(1).join('\n'),
      full: String(raw),
    };
  }

  function commandPrompt(model: ToolRowModel): string {
    return model.name === 'pwsh' ? '>' : '$';
  }

  interface HighlightSpan {
    text: string;
    token: string;
  }
  function highlightLines(
    text: string,
    lang: string,
  ): HighlightSpan[][] | null {
    const api =
      typeof globalThis !== 'undefined'
        ? (
            globalThis as unknown as {
              ChatHighlight?: {
                highlight?: (code: string, lang: string) => HighlightSpan[][];
              };
            }
          ).ChatHighlight
        : undefined;
    if (!api || typeof api.highlight !== 'function') {
      return null;
    }
    try {
      const lines = api.highlight(text, lang);
      return Array.isArray(lines) ? lines : null;
    } catch {
      return null;
    }
  }

  function highlightLang(toolName: string, command: string): string {
    const api =
      typeof globalThis !== 'undefined'
        ? (
            globalThis as unknown as {
              ChatHighlight?: {
                langFor?: (name: string, command: string) => string;
              };
            }
          ).ChatHighlight
        : undefined;
    if (!api || typeof api.langFor !== 'function') {
      return 'plain';
    }
    try {
      return String(api.langFor(toolName, command) || 'plain');
    } catch {
      return 'plain';
    }
  }

  function codeLineNode(
    line: string,
    spans: HighlightSpan[] | undefined,
  ): ChatNode {
    const node = h('span', {class: 'mp-chat-code-line'});
    if (!spans || spans.length === 0) {
      attach(node, line);
      return node;
    }
    for (const span of spans) {
      const piece = h('span', {
        class: `mp-chat-tok-${String(span.token || 'plain')}`,
      });
      attach(piece, String(span.text ?? ''));
      attach(node, piece);
    }
    return node;
  }

  function codeBodyNode(text: string, lang: string): ChatNode {
    const lines = text.split('\n');
    const trimmed = text.trimStart();
    const outputLang =
      lang === 'plain' &&
      (trimmed.startsWith('{') || trimmed.startsWith('[')) &&
      /["'][^"']+["']\s*:/u.test(trimmed)
        ? 'json'
        : lang;
    const highlighted = highlightLines(text, outputLang);
    const code = h('code');
    lines.forEach((line, index) => {
      if (index > 0) {
        attach(code, '\n');
      }
      attach(
        code,
        codeLineNode(line, highlighted ? highlighted[index] : undefined),
      );
    });
    return code;
  }

  function commandCardNode(
    command: ToolCommand,
    prompt: string,
    copyText: string,
    options: {
      label?: string;
      output?: string | null;
      error?: boolean;
      lang?: string;
      toolName?: string;
    } = {},
  ): ChatNode {
    const lang =
      options.lang ||
      highlightLang(String(options.toolName || ''), command.full);
    const card = h('div', {class: 'mp-chat-code'});
    // The panel header names the tool, so the row above it reads as an explanation.
    const head = h('div', {class: 'mp-chat-code-head'});
    if (options.label) {
      const label = h('span', {class: 'mp-chat-code-label'});
      attach(label, options.label);
      attach(head, label);
    }
    const copy = h('button', {
      type: 'button',
      class: 'mp-chat-action mp-chat-code-copy',
      'aria-label': 'Copy',
      'data-mp-chat-act': 'copy',
      'data-mp-chat-copy': String(copyText || ''),
    });
    attach(copy, icon('copy', 14));
    attach(head, copy);
    attach(card, head);
    if (command.first) {
      const line = h('div', {class: 'mp-chat-code-first'});
      if (prompt) {
        const mark = h('span', {
          class: 'mp-chat-code-prompt',
          'aria-hidden': 'true',
        });
        attach(mark, prompt);
        attach(line, mark);
      }
      attach(
        line,
        codeLineNode(command.first, highlightLines(command.first, lang)?.[0]),
      );
      attach(card, line);
    }
    if (command.rest) {
      const pre = h('pre');
      attach(pre, codeBodyNode(command.rest, lang));
      attach(card, pre);
    }
    if (options.output) {
      const body = h('div', {class: 'mp-chat-code-body'});
      if (options.error) {
        body.setAttribute('data-error', 'true');
      }
      attach(body, codeBodyNode(String(options.output), 'plain'));
      attach(card, body);
    }
    return card;
  }

  function todoChecklist(model: ToolRowModel): ChatNode | null {
    if (!['Todo', 'TodoWrite', 'todo_write'].includes(model.name)) {
      return null;
    }
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(model.argsRaw);
    } catch {
      return null;
    }
    if (!args || !Array.isArray(args.todos)) {
      return null;
    }
    const list = h('ul', {
      class: 'mp-chat-todo-list',
      'aria-label': 'Plan update',
    });
    for (const value of args.todos) {
      if (!value || typeof value.content !== 'string') {
        continue;
      }
      const state = String(value.status || 'pending');
      const row = h('li', {class: 'mp-chat-todo-item', 'data-state': state});
      attach(
        row,
        h(
          'span',
          {class: 'mp-chat-todo-check', 'aria-hidden': 'true'},
          state === 'completed' ? '✓' : state === 'in_progress' ? '•' : '',
        ),
      );
      attach(row, h('span', {class: 'mp-chat-todo-label'}, value.content));
      attach(list, row);
    }
    return list;
  }

  function questionHistory(model: ToolRowModel): ChatNode | null {
    if (!isQuestionTool(model.name)) {
      return null;
    }
    let args: Record<string, unknown>;
    let result: Record<string, unknown> = {};
    try {
      args = JSON.parse(model.argsRaw);
    } catch {
      return null;
    }
    if (!args || typeof args !== 'object') {
      return null;
    }
    try {
      result = JSON.parse(model.output || '{}') || {};
    } catch {
      /* A real error is rendered below. */
    }
    const questions = Array.isArray(args.questions) ? args.questions : [args];
    const answers =
      result.answers && typeof result.answers === 'object'
        ? (result.answers as Record<string, unknown>)
        : {};
    const list = h('div', {class: 'mp-chat-question-history'});
    for (const question of questions) {
      if (!question || typeof question.question !== 'string') {
        continue;
      }
      const row = h('div', {class: 'mp-chat-question-answer'});
      attach(
        row,
        h('div', {class: 'mp-chat-question-label'}, question.question),
      );
      const value = answers[question.question];
      const decision =
        result.decision === 'once'
          ? 'Allowed once'
          : result.decision === 'grant'
            ? 'Allowed for this session'
            : result.decision === 'deny'
              ? 'Denied'
              : '';
      const answer = Array.isArray(value)
        ? value.join(', ')
        : typeof value === 'string'
          ? value
          : '';
      attach(
        row,
        h(
          'div',
          {class: 'mp-chat-question-response'},
          decision ||
            answer ||
            (result.answered ? 'No preference' : 'Waiting for your answer'),
        ),
      );
      attach(list, row);
    }
    return list;
  }

  function browserErrorNode(model: ToolRowModel): ChatNode {
    const root = h('div', {class: 'mp-chat-browser-error'});
    const raw = String(model.output || '').trim();
    const lines = raw.split(/\r?\n/u);
    const messageLines = lines.filter(
      line => !/^(?:url|prompt):\s*/iu.test(line.trim()),
    );
    const message = h('div', {class: 'mp-chat-browser-error-message'});
    attach(message, messageLines.join('\n').trim());
    attach(root, message);

    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(model.argsRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      /* Keep the raw error when the tool arguments are unavailable. */
    }
    for (const key of ['url', 'prompt'] as const) {
      const fromArgs = typeof args[key] === 'string' ? args[key] : '';
      const fromOutput = lines.find(line =>
        line.trim().toLowerCase().startsWith(`${key}:`),
      );
      const value =
        fromArgs || (fromOutput ? fromOutput.slice(key.length + 1).trim() : '');
      if (!value) {
        continue;
      }
      const row = h('div', {class: 'mp-chat-browser-error-field'});
      attach(row, h('span', {class: 'mp-chat-browser-error-label'}, `${key}:`));
      attach(row, h('span', {class: 'mp-chat-browser-error-value'}, value));
      attach(root, row);
    }
    return root;
  }

  /*
   * Web results.
   *
   * The reference renders a search call as a header row plus a body. The body
   * holds the first three image results in a 3-column grid with a 3px gap and
   * `4/3` tiles, a source credit inside each tile, and a "Results from the
   * web" caption under the grid; fewer than three images renders no grid at
   * all. The field names read here are the payload's own -- `url`, `title`,
   * `source`, `page_url`, `thumbnail_url` -- not invented ones.
   *
   * MP's search backends return `{query, results: [{title, url, snippet}]}`
   * today and carry no images, so the mosaic waits for a backend that sends
   * them while the source list renders now. Every part is data-gated: no
   * payload, no card, and the raw JSON output row stays as it was.
   */

  interface WebResultImage {
    id: string;
    /** The thumbnail the tile paints, which the reference prefers to `url`. */
    url: string;
    title: string;
    source: string;
    pageUrl: string;
  }

  interface WebResultSource {
    title: string;
    url: string;
    snippet: string;
  }

  interface WebResultStep {
    title: string;
    body: string;
  }

  interface WebResultPlace {
    name: string;
    address: string;
    latitude: number;
    longitude: number;
  }

  interface WebResults {
    query: string;
    /** Server-reported result count; `null` when the payload carries none. */
    count: number | null;
    images: WebResultImage[];
    sources: WebResultSource[];
  }

  /** The reference's "Results from the web" caption, verbatim. */
  const WEB_RESULTS_CAPTION = 'Results from the web';
  const WEB_STEPS_ALL_LABEL = 'View all steps';
  const WEB_STEPS_NEXT_LABEL = 'Next';
  /** Claude refuses to build its grid below three images. */
  const WEB_MOSAIC_SIZE = 3;

  function listOf(value: unknown): unknown[] {
    return Array.isArray(value) ? (value as unknown[]) : [];
  }

  function recordOf(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  function textField(
    record: Record<string, unknown>,
    keys: readonly string[],
  ): string {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') {
        return value.trim();
      }
    }
    return '';
  }

  function numberField(
    record: Record<string, unknown>,
    keys: readonly string[],
  ): number | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
    }
    return null;
  }

  /** Search payloads are remote data, so only absolute http(s) is rendered. */
  function webUrl(raw: string): string | null {
    return /^https?:\/\//i.test(raw) ? raw : null;
  }

  function webHost(raw: string): string {
    const url = webUrl(raw);
    if (url === null) {
      return '';
    }
    try {
      return new URL(url).host.replace(/^www\./i, '');
    } catch {
      return '';
    }
  }

  function webImages(value: unknown): WebResultImage[] {
    const images: WebResultImage[] = [];
    const seen = new Set<string>();
    for (const entry of listOf(value)) {
      const record = recordOf(entry);
      if (record === null) {
        continue;
      }
      const full = webUrl(textField(record, ['url', 'image_url', 'imageUrl']));
      const thumb =
        webUrl(textField(record, ['thumbnail_url', 'thumbnailUrl'])) ?? full;
      if (thumb === null || seen.has(thumb)) {
        continue;
      }
      seen.add(thumb);
      images.push({
        id: textField(record, ['id']) || thumb,
        url: thumb,
        title: textField(record, ['title']),
        source: textField(record, ['source', 'domain']),
        pageUrl: textField(record, ['page_url', 'pageUrl']),
      });
    }
    return images;
  }

  function webSources(value: unknown): WebResultSource[] {
    const sources: WebResultSource[] = [];
    for (const entry of listOf(value)) {
      const record = recordOf(entry);
      if (record === null) {
        continue;
      }
      const url = webUrl(textField(record, ['url']));
      if (url === null) {
        continue;
      }
      sources.push({
        title: textField(record, ['title']) || webHost(url),
        url,
        snippet: textField(record, ['snippet']),
      });
    }
    return sources;
  }

  function webSteps(value: unknown): WebResultStep[] {
    const steps: WebResultStep[] = [];
    for (const entry of listOf(value)) {
      const record = recordOf(entry);
      if (record === null) {
        continue;
      }
      const step = {
        title: textField(record, ['title', 'name', 'label']),
        body: textField(record, ['body', 'text', 'detail']),
      };
      if (step.title !== '' || step.body !== '') {
        steps.push(step);
      }
    }
    return steps;
  }

  function webPlaceOf(value: unknown): WebResultPlace | null {
    const record = recordOf(value);
    if (record === null) {
      return null;
    }
    const latitude = numberField(record, ['latitude', 'lat']);
    const longitude = numberField(record, ['longitude', 'lng', 'lon']);
    if (latitude === null || longitude === null) {
      return null;
    }
    return {
      name:
        textField(record, ['name', 'title']) ||
        webHost(textField(record, ['url', 'page_url', 'pageUrl'])),
      address: textField(record, ['address', 'formatted_address']),
      latitude,
      longitude,
    };
  }

  function webPlaces(record: Record<string, unknown>): WebResultPlace[] {
    const found = [webPlaceOf(record.place), webPlaceOf(record.location)];
    for (const entry of listOf(record.places)) {
      found.push(webPlaceOf(entry));
    }
    return found.filter((place): place is WebResultPlace => place !== null);
  }

  /** `{count} result` / `{count} results`, the reference's own plural form. */
  function webCountLabel(count: number): string {
    return `${count} result${count === 1 ? '' : 's'}`;
  }

  function webSearchTool(name: string): boolean {
    return toolCategory(name) === 'web';
  }

  /** The parsed output record, with a `ToolResult` blob's own value unwrapped. */
  function outputRecord(output: string | null): Record<string, unknown> | null {
    if (output === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      return null;
    }
    const outer = recordOf(parsed);
    if (outer === null) {
      return null;
    }
    return recordOf(outer.value) ?? outer;
  }

  /**
   * The reference's image payload inside a search call's output.
   *
   * `null` for every other tool, and for a search output that is not a JSON
   * object -- a text-only result keeps its plain output row instead of
   * growing an empty card.
   */
  function webResults(
    name: string,
    payload: Record<string, unknown> | null,
  ): WebResults | null {
    if (payload === null || !webSearchTool(name)) {
      return null;
    }
    const rawImages = Array.isArray(payload.images) ? payload.images : null;
    const rawSources = Array.isArray(payload.results)
      ? payload.results
      : Array.isArray(payload.sources)
        ? payload.sources
        : null;
    const query = typeof payload.query === 'string' ? payload.query : '';
    if (rawImages === null && rawSources === null && query === '') {
      return null;
    }
    return {
      query,
      count:
        rawSources !== null
          ? rawSources.length
          : rawImages !== null
            ? rawImages.length
            : null,
      images: webImages(rawImages),
      sources: webSources(rawSources),
    };
  }

  /** Replace every child; the headless shim exposes no `replaceChildren`. */
  function setChildren(host: ChatNode, children: ChatChild[]): void {
    if (DOC) {
      (host as Element).replaceChildren();
    } else {
      (host as ShimNode).children.length = 0;
    }
    for (const child of children) {
      attach(host, child);
    }
  }

  function bindClick(node: ChatNode, handler: () => void): void {
    if (!DOC) {
      return;
    }
    (node as Element).addEventListener('click', (event: Event) => {
      event.preventDefault();
      handler();
    });
  }

  /** The credit the reference draws inside a tile: source, else the domain. */
  function webCredit(image: WebResultImage): string {
    return image.source || webHost(image.pageUrl) || webHost(image.url);
  }

  function webImageTile(
    image: WebResultImage,
    lead: boolean,
    alt: string,
  ): ChatNode {
    const tile = h('div', {class: 'mp-chat-web-image'});
    if (lead) {
      tile.setAttribute('data-lead', 'true');
    }
    const href = webUrl(image.pageUrl) ?? webUrl(image.url);
    const photo = h('img', {
      class: 'mp-chat-web-photo',
      src: image.url,
      alt: image.title || alt,
      loading: 'lazy',
      decoding: 'async',
      'data-mp-chat-act': 'view-image',
      role: 'button',
      tabindex: '0',
    });
    attach(
      tile,
      href === null
        ? photo
        : h(
            'a',
            {
              class: 'mp-chat-web-photo-link',
              href,
              target: '_blank',
              rel: 'noreferrer',
            },
            photo,
          ),
    );
    const credit = webCredit(image);
    if (credit !== '') {
      attach(tile, h('span', {class: 'mp-chat-web-credit'}, credit));
    }
    return tile;
  }

  function webImagesNode(payload: WebResults): ChatNode | null {
    if (payload.images.length === 0) {
      return null;
    }
    const shown = payload.images.slice(0, WEB_MOSAIC_SIZE);
    const mosaic = h('div', {class: 'mp-chat-web-images'});
    mosaic.setAttribute('data-count', String(shown.length));
    shown.forEach((image, index) => {
      const lead = index === 0 && shown.length === WEB_MOSAIC_SIZE;
      attach(mosaic, webImageTile(image, lead, payload.query));
    });
    const wrap = h('div', {class: 'mp-chat-web-media'});
    attach(wrap, mosaic);
    attach(wrap, h('div', {class: 'mp-chat-web-caption'}, WEB_RESULTS_CAPTION));
    return wrap;
  }

  function webSourcesNode(payload: WebResults): ChatNode | null {
    if (payload.sources.length === 0) {
      return null;
    }
    const list = h('div', {class: 'mp-chat-web-sources'});
    for (const source of payload.sources) {
      const row = h('div', {class: 'mp-chat-web-source'});
      attach(
        row,
        h('span', {class: 'mp-chat-web-domain'}, webHost(source.url)),
      );
      attach(
        row,
        h(
          'a',
          {
            class: 'mp-chat-web-link',
            href: source.url,
            target: '_blank',
            rel: 'noreferrer',
          },
          source.title,
        ),
      );
      if (source.snippet !== '') {
        attach(row, h('span', {class: 'mp-chat-web-snippet'}, source.snippet));
      }
      attach(list, row);
    }
    return list;
  }

  /**
   * Claude's step card: one step at a time, a numbered strip, "View all
   * steps", and "Next". Data-gated like the rest -- a payload without a
   * non-empty `steps` array renders nothing.
   */
  function stepCardNode(steps: WebResultStep[]): ChatNode | null {
    if (steps.length === 0) {
      return null;
    }
    const card = h('div', {class: 'mp-chat-steps'});
    const title = h('div', {class: 'mp-chat-steps-title'});
    const detail = h('div', {class: 'mp-chat-steps-detail'});
    const strip = h('div', {class: 'mp-chat-steps-strip'});
    const dots: ChatNode[] = [];
    for (let index = 0; index < steps.length; index += 1) {
      const dot = h(
        'button',
        {class: 'mp-chat-step-dot', type: 'button'},
        String(index + 1),
      );
      dot.setAttribute('aria-label', `Step ${index + 1}`);
      attach(strip, dot);
      dots.push(dot);
    }
    const foot = h('div', {class: 'mp-chat-steps-foot'});
    const all = h(
      'button',
      {class: 'mp-chat-steps-all', type: 'button'},
      WEB_STEPS_ALL_LABEL,
    );
    all.setAttribute('aria-expanded', 'false');
    const next = h(
      'button',
      {class: 'mp-chat-steps-next', type: 'button'},
      WEB_STEPS_NEXT_LABEL,
    );
    attach(foot, all);
    attach(foot, next);
    const list = h('div', {class: 'mp-chat-steps-list'});
    steps.forEach((step, index) => {
      const row = h('div', {class: 'mp-chat-step-row'});
      attach(row, h('span', {class: 'mp-chat-step-index'}, String(index + 1)));
      const copy = h('div', {class: 'mp-chat-step-copy'});
      attach(copy, h('div', {class: 'mp-chat-step-name'}, step.title));
      if (step.body !== '') {
        attach(copy, h('div', {class: 'mp-chat-step-text'}, step.body));
      }
      attach(row, copy);
      attach(list, row);
    });
    list.setAttribute('data-open', 'false');
    attach(card, title);
    attach(card, detail);
    attach(card, strip);
    attach(card, foot);
    attach(card, list);

    let active = 0;
    let open = false;
    const paint = () => {
      const step = steps[active];
      setChildren(title, [step.title || `Step ${active + 1}`]);
      setChildren(detail, step.body === '' ? [] : [step.body]);
      card.setAttribute('data-active', String(active + 1));
      if (active >= steps.length - 1) {
        next.setAttribute('hidden', 'true');
      } else {
        next.removeAttribute('hidden');
      }
      dots.forEach((dot, index) => {
        dot.setAttribute('aria-current', index === active ? 'true' : 'false');
      });
      list.setAttribute('data-open', open ? 'true' : 'false');
      all.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    dots.forEach((dot, index) => {
      bindClick(dot, () => {
        active = index;
        paint();
      });
    });
    bindClick(next, () => {
      active = Math.min(active + 1, steps.length - 1);
      paint();
    });
    bindClick(all, () => {
      open = !open;
      paint();
    });
    paint();
    return card;
  }

  /**
   * A searched place, drawn from coordinates only. The reference embeds an
   * interactive map; that needs a map provider and a `frame-src` the renderer
   * does not have, so this card links the coordinates out instead.
   */
  function placeCardNode(places: WebResultPlace[]): ChatNode | null {
    if (places.length === 0) {
      return null;
    }
    const list = h('div', {class: 'mp-chat-places'});
    for (const place of places) {
      const row = h('div', {class: 'mp-chat-place'});
      if (place.name !== '') {
        attach(row, h('span', {class: 'mp-chat-place-name'}, place.name));
      }
      if (place.address !== '') {
        attach(row, h('span', {class: 'mp-chat-place-address'}, place.address));
      }
      const href = `https://www.openstreetmap.org/?mlat=${place.latitude}&mlon=${place.longitude}`;
      attach(
        row,
        h(
          'a',
          {
            class: 'mp-chat-web-link',
            href,
            target: '_blank',
            rel: 'noreferrer',
          },
          `${place.latitude}, ${place.longitude}`,
        ),
      );
      attach(list, row);
    }
    return list;
  }

  /**
   * Everything the body of a result row can render from a tool's output.
   *
   * Returns `null` when the output carries neither web results nor a step or
   * place payload, which leaves the row's existing body and output dump in
   * place.
   */
  function resultBodyNode(
    name: string,
    payload: Record<string, unknown> | null,
  ): ChatNode | null {
    const web = webResults(name, payload);
    const wrap = h('div', {class: 'mp-chat-results'});
    let rendered = false;
    const media = web === null ? null : webImagesNode(web);
    if (media !== null) {
      attach(wrap, media);
      rendered = true;
    }
    const sources = web === null ? null : webSourcesNode(web);
    if (sources !== null) {
      attach(wrap, sources);
      rendered = true;
    }
    if (web === null && payload !== null) {
      const steps = stepCardNode(webSteps(payload.steps));
      if (steps !== null) {
        attach(wrap, steps);
        rendered = true;
      }
      const places = placeCardNode(webPlaces(payload));
      if (places !== null) {
        attach(wrap, places);
        rendered = true;
      }
    }
    return rendered ? wrap : null;
  }

  /**
   * Keep the shimmer clone's glyphs identical to the live label.
   *

   * A running label's text can be rewritten in place (a streaming summary, a
   * changing path), and the clone is a separate node — without this it would
   * freeze on the first frame's wording while the real text moved on.
   * Reading the label deliberately skips the clone, so writing the clone
   * cannot feed back into the next read.
   */
  function trackShimmerClone(host: ChatNode, clone: ChatNode): void {
    if (typeof MutationObserver === 'undefined' || !DOC) {
      return;
    }
    const target = host as Element;
    if (typeof target.nodeType !== 'number') {
      return;
    }
    // Test harnesses build stand-in nodes with no owner document; observing
    // those would throw, and there is nothing to keep in sync anyway.
    if (
      (target as unknown as {ownerDocument?: unknown}).ownerDocument !== DOC
    ) {
      return;
    }
    const cloneNode = clone as Element;
    const readLabel = (): string => {
      let out = '';
      for (const child of Array.from(target.childNodes)) {
        if (child === cloneNode) {
          continue;
        }
        out += child.textContent ?? '';
      }
      return out;
    };
    new MutationObserver(() => {
      const next = readLabel();
      if (cloneNode.textContent !== next) {
        cloneNode.textContent = next;
      }
    }).observe(target, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  /**
   * A label that lights up while its row is in flight.
   *
   * The text itself is never recoloured: a second copy of the glyphs is stacked
   * on top, punched out with `mask-clip: text`, and a 120deg band is swept
   * across that copy. When `shimmering` is false no clone is built at all, so
   * settled rows cost nothing.
   */
  function shimmerText(
    text: string,
    opts: {
      shimmering: boolean;
      paused?: boolean;
      delayMs?: number;
      className?: string;
    },
    content?: ChatNode[],
  ): ChatNode {
    const root = h('span', {
      class: opts.className ? `mp-shimmer ${opts.className}` : 'mp-shimmer',
    });
    root.setAttribute('data-shimmering', opts.shimmering ? 'true' : 'false');
    const vars: string[] = [];
    if (opts.shimmering && opts.delayMs) {
      vars.push(`--mp-shimmer-delay:${opts.delayMs}ms`);
    }
    if (opts.shimmering && opts.paused) {
      vars.push('--mp-shimmer-play-state:paused');
    }
    if (vars.length > 0) {
      root.setAttribute('style', `${vars.join(';')};`);
    }
    if (content) {
      content.forEach(node => attach(root, node));
    } else {
      attach(root, text);
    }
    if (opts.shimmering) {
      const clone = h('span', {
        class: 'mp-shimmer-clone',
        'aria-hidden': 'true',
      });
      attach(clone, text);
      attach(root, clone);
      trackShimmerClone(root, clone);
    }
    return root;
  }

  function combinedFileDiffReference(
    models: ToolRowModel[],
  ): ToolRowModel['fileDiffReference'] {
    const completed = models.filter(
      model => FILE_WRITE_TOOLS.has(model.name) && model.state === 'ok',
    );
    if (!completed.length || completed.some(model => !model.fileDiffReference)) {
      return undefined;
    }
    return {
      beforePath: completed[0].fileDiffReference!.beforePath,
      afterPath: completed[completed.length - 1].fileDiffReference!.afterPath,
    };
  }

  function toolFileSummaryNode(model: ToolRowModel): ChatNode {
    const reference = model.fileDiffReference;
    const file =
      model.filePath && model.fileTarget
        ? h(
            'button',
            {
              type: 'button',
              class: 'mp-chat-tool-file',
              title: model.filePath,
              'data-mp-chat-act': 'open-file',
              'data-file-path': model.filePath,
              'data-file-absolute-path': model.fileTarget,
              ...(reference
                ? {'data-file-open-diff': JSON.stringify(reference)}
                : {}),
            },
            model.summary,
          )
        : undefined;
    return shimmerText(
      model.summary,
      {
        shimmering: model.state === 'running',
        className: 'mp-chat-summary',
      },
      file ? [file] : undefined,
    );
  }

  function toolRowNode(
    model: ToolRowModel,
    scope = '',
    members?: ToolRowModel[],
  ): ChatNode {
    const root = h('div', {class: 'mp-chat-tool'});
    root.setAttribute('data-tool', '');
    root.setAttribute('data-state', model.state);
    if (model.errorTitle) {
      root.setAttribute('data-error-title', 'true');
    }
    if (model.callId) {
      root.setAttribute('data-call-id', model.callId);
    }

    const summaryText = model.summary;
    const status =
      model.state === 'running'
        ? 'Running'
        : model.state === 'error'
          ? 'Failed'
          : model.state === 'stopped'
            ? 'Stopped'
            : '';

    if (status) {
      const vh = h('span', {class: 'mp-chat-vh'});
      attach(vh, status);
      attach(root, vh);
    }

    const collapsed: ChatNode[] = [];
    if (summaryText !== '') {
      const sep = h('span', {class: 'mp-chat-tool-sep', 'aria-hidden': 'true'});
      attach(sep, ' ');
      collapsed.push(sep);
      collapsed.push(toolFileSummaryNode(model));
    }

    if (
      model.diffStat &&
      (model.diffStat.added > 0 || model.diffStat.removed > 0)
    ) {
      const stat = h('span', {
        class: 'mp-chat-diff-stat',
        'aria-hidden': 'true',
      });
      if (model.diffStat.added > 0) {
        const add = h('span', {class: 'mp-chat-diff-add'});
        attach(add, `+${model.diffStat.added}`);
        attach(stat, add);
      }
      if (model.diffStat.removed > 0) {
        const del = h('span', {class: 'mp-chat-diff-del'});
        attach(del, `−${model.diffStat.removed}`);
        attach(stat, del);
      }
      collapsed.push(stat);
    }

    const contents = (members ?? [model]).map(toolRowBody);
    const body = members
      ? contents.map((content, index) =>
          h(
            'div',
            {
              class: 'mp-chat-coalesced-result',
              'data-call-id': members[index].callId,
            },
            ...content.nodes,
          ),
        )
      : contents[0].nodes;
    const webCount = contents[0].webCount;
    if (webCount !== null) {
      const sep = h('span', {class: 'mp-chat-tool-sep', 'aria-hidden': 'true'});
      attach(sep, ' ');
      collapsed.push(sep);
      collapsed.push(
        h('span', {class: 'mp-chat-web-count'}, webCountLabel(webCount)),
      );
    }
    const isSubagent = SUBAGENT_TOOLS.has(model.name) && Boolean(model.callId);
    const {root: disclosure, row: disclosureAction} = disclosureRow({
      leadingOverride: isSubagent
        ? h(
            'span',
            {class: 'mp-chat-font-icon', 'aria-hidden': 'true'},
            AGENTS_SIMPLE_GLYPH,
          )
        : undefined,
      title: model.title,
      collapsed,
      body: body.length ? body : null,
      expandable: !isSubagent && body.length > 0,
      open:
        defaultOpenForTool(model) ||
        contents.some(content => content.hasResults),
      rowId: model.callId
        ? `tool:${scope ? `${scope}:` : ''}${model.callId}`
        : undefined,
    });
    if (isSubagent) {
      disclosure.setAttribute('data-subagent-row', '');
      disclosureAction.setAttribute('data-mp-chat-act', 'open-subagent');
      disclosureAction.setAttribute(
        'data-subagent-parent-call-id',
        model.callId,
      );
      disclosureAction.setAttribute('role', 'button');
      disclosureAction.setAttribute('tabindex', '0');
    }
    attach(root, disclosure);
    return root;
  }

  function toolRowBody(model: ToolRowModel): {
    nodes: ChatNode[];
    hasResults: boolean;
    webCount: number | null;
  } {
    const body: ChatNode[] = [];
    const payload = outputRecord(model.output);
    const reference =
      typeof model.presentation === 'string'
        ? outputRecord(model.presentation)
        : recordOf(model.presentation);
    const deferred =
      model.state === 'ok' &&
      reference?.kind === 'file_diff' &&
      typeof reference.afterPath === 'string';
    const fileDiffs =
      model.state === 'ok' &&
      reference?.kind === 'file_diffs' &&
      Array.isArray(reference.files)
        ? reference.files
        : null;
    // Verified snapshots take precedence over request snippets. Old overwrites
    // without a before-image cannot truthfully be shown as all additions.
    const legacyOverwrite =
      model.state === 'ok' &&
      !model.presentation &&
      ['Write', 'write_file', 'write'].includes(model.name) &&
      payload?.created === false;
    const presented =
      model.state === 'ok'
        ? deriveDiff(
            model.name,
            '',
            legacyOverwrite
              ? {kind: 'file_diff_unavailable', reason: 'previous'}
              : model.presentation,
          )
        : null;
    const diff =
      presented ??
      (model.state === 'error' || model.fileChange === 'too_large'
        ? null
        : deriveDiff(model.name, model.argsRaw ?? ''));
    const command = toolCommandOf(model);
    const singleLine = command !== null && command.rest === '';
    let outputInCard = false;
    // A search row is the one row whose body is content rather than a command,
    // a diff or a JSON dump: it renders the payload's own results, and the raw
    // output row is dropped when it does. The count lives on the row itself,
    // so an empty result set still reports "0 results".
    const results = resultBodyNode(model.name, payload);
    const webCount = webResults(model.name, payload)?.count ?? null;
    const checklist = todoChecklist(model) || questionHistory(model);
    if (fileDiffs) {
      for (const raw of fileDiffs) {
        const entry = recordOf(raw);
        if (!entry || typeof entry.path !== 'string') {
          continue;
        }
        const fileModel = {
          filePath: entry.path,
          fileTarget:
            (entry.exists !== false || entry.previewPath) &&
            typeof entry.absolutePath === 'string'
              ? entry.absolutePath
              : undefined,
          filePreviewPath:
            typeof entry.previewPath === 'string'
              ? entry.previewPath
              : undefined,
        };
        const view = recordOf(entry.presentation);
        if (view?.kind === 'file_diff' && typeof view.afterPath === 'string') {
          body.push(deferredFileDiffNode(fileModel, view));
        } else {
          const fileDiff = deriveDiff(model.name, '', view);
          if (fileDiff) {
            body.push(diffPreviewNode(fileDiff, fileModel));
          }
        }
      }
      outputInCard = body.length > 0;
    } else if (deferred) {
      body.push(deferredFileDiffNode(model, reference!));
      outputInCard = true;
    } else if (checklist !== null) {
      body.push(checklist);
      outputInCard = model.state !== 'error';
    } else if (results !== null) {
      body.push(results);
      outputInCard = true;
    } else if (
      diff !== null &&
      (model.body !== null || model.output !== null)
    ) {
      body.push(diffPreviewNode(diff, model));
      // The reference diff branch ends at the code view. Keep receipts in the
      // model/history; only unsuccessful or interrupted calls need raw detail.
      outputInCard = model.state === 'ok';
    } else if (command !== null) {
      body.push(
        commandCardNode(command, commandPrompt(model), command.full, {
          label:
            model.variant === 'bash'
              ? model.name === 'pwsh'
                ? 'PowerShell'
                : 'Bash'
              : singleLine
                ? model.name
                : model.title,
          output: model.output,
          error: model.state === 'error',
          toolName: model.name,
        }),
      );
      outputInCard = model.output !== null;
    } else if (model.errorTitle) {
      body.push(browserErrorNode(model));
      outputInCard = true;
    } else if (model.body !== null) {
      body.push(
        commandCardNode(
          {first: '', rest: model.body, full: model.body},
          '',
          model.body,
          {
            label:
              model.variant === 'code' && model.name === 'Browser.navigate'
                ? undefined
                : model.title,
          },
        ),
      );
    }
    if (model.output !== null && !outputInCard) {
      const output = h('div', {class: 'mp-chat-tool-output'});
      if (model.state === 'error') {
        output.setAttribute('data-error', 'true');
      }
      attach(output, model.output);
      body.push(output);
    }

    return {nodes: body, hasResults: results !== null, webCount};
  }

  function thinkingQuote(text: string): string {
    return `> **Thinking** (~${Math.round(text.length / 4)} tok)\n>\n${text
      .split(/\r\n?|[\n\u2028\u2029]/g)
      .map(line => (line.length ? `> ${line}` : '>'))
      .join('\n')}`;
  }

  function thinkNode(
    reasoning: string,
    running = false,
    thinkId = '',
  ): ChatNode {
    // Claude's `TA` trims a summary's trailing punctuation, and the bare word
    // "Thinking" is what the reference shows when it has no summary left to
    // derive -- it is the one case where the block renders text of its own.
    const derived = running ? latestLine(reasoning) : firstLine(reasoning);
    const summaryText =
      derived.trim() === '' ? 'Thinking' : stripTrailingPunctuation(derived);
    const summary = h('span', {class: 'mp-chat-summary'});
    if (running) {
      summary.setAttribute('data-follow-end', 'true');
    }
    attach(summary, summaryText);

    const body = h('div', {class: 'mp-chat-think-body'});
    attach(body, reasoning);
    const viewport = h('div', {class: 'mp-chat-think-viewport'});
    attach(viewport, body);
    attach(
      viewport,
      h(
        'button',
        {
          type: 'button',
          class: 'mp-chat-think-copy',
          'data-mp-chat-act': 'copy-thinking',
          'aria-label': lt('chat.copy_as_quote'),
          ...(!reasoning.trim() ? {hidden: 'true'} : {}),
        },
        h('span', {
          class: 'mp-chat-think-copy-glyph',
          'aria-hidden': 'true',
          'data-glyph': '\ue056',
        }),
      ),
    );
    const expandedBody: ChatNode[] = [viewport];

    const {root, row} = disclosureRow({
      leadingOverride: h(
        'span',
        {class: 'mp-chat-font-icon', 'aria-hidden': 'true'},
        EXTENDED_THINKING_GLYPH,
      ),
      title: running ? 'Thinking…' : 'Thought',
      collapsed: [
        h('span', {class: 'mp-chat-sep', 'aria-hidden': 'true'}),
        summary,
      ],
      body: expandedBody,
      expandable: true,
      open: false,
      rowId: thinkId ? `think:${thinkId}` : undefined,
    });
    root.setAttribute('data-state', running ? 'running' : 'ok');
    root.setAttribute('class', 'mp-chat-disclosure mp-chat-think');
    row.setAttribute('data-thought-row', '');
    return root;
  }

  function deliveryNode(text: string): ChatNode {
    return markdownRenderer.render(text);
  }

  function updateThinkingState(
    node: HTMLElement,
    text: string,
    running: boolean,
    durationMs?: number,
  ): void {
    node.setAttribute('data-state', running ? 'running' : 'ok');
    // Claude's `fN` wording ("Thought for 12s") replaces the bare verb once
    // the block settles and a real duration is known.
    const settled =
      durationMs === undefined ? undefined : thinkingDuration(durationMs);
    node.querySelector('.mp-chat-title')!.textContent = running
      ? 'Thinking…'
      : (settled ?? 'Thought');
    const summary = node.querySelector('.mp-chat-summary')!;
    const derived = running ? latestLine(text) : firstLine(text);
    const preview =
      derived.trim() === '' ? 'Thinking' : stripTrailingPunctuation(derived);
    if (summary.textContent !== preview) {
      summary.textContent = preview;
    }
    if (running) {
      summary.setAttribute('data-follow-end', 'true');
    } else {
      summary.removeAttribute('data-follow-end');
    }
    const copy = node.querySelector('.mp-chat-think-copy');
    if (text.trim()) {
      copy?.removeAttribute('hidden');
    } else {
      copy?.setAttribute('hidden', 'true');
    }
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
    if (!Number.isFinite(ms) || ms <= 0) {
      return '';
    }
    const delta = Math.max(0, now - ms);
    if (delta < 45 * 1000) {
      return lt('chat.time_just_now');
    }
    if (delta < HOUR_MS) {
      return lt('chat.time_minutes_ago', {n: Math.round(delta / MINUTE_MS)});
    }
    if (delta < DAY_MS) {
      return lt('chat.time_hours_ago', {n: Math.round(delta / HOUR_MS)});
    }
    if (delta < 7 * DAY_MS) {
      return lt('chat.time_days_ago', {n: Math.round(delta / DAY_MS)});
    }
    return formatClock(ms);
  }

  function absoluteTime(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatClock(ms)}`;
  }

  interface BranchTarget {
    conversationId: string;
    turnIndex: number;
  }

  function timeNode(ms: number | undefined): ChatNode | null {
    if (!ms || !Number.isFinite(ms)) {
      return null;
    }
    const label = relativeTime(ms);
    if (!label) {
      return null;
    }
    const node = h('span', {
      class: 'mp-chat-action-time',
      title: absoluteTime(ms),
    });
    attach(node, label);
    return node;
  }

  function messageActions(
    message: string,
    branch?: BranchTarget,
    timeMs?: number,
    options: {align?: 'user' | 'assistant'; retry?: boolean} = {},
  ): ChatNode {
    const actions = h('div', {class: 'mp-chat-actions'});
    actions.setAttribute(
      'data-align',
      options.align === 'user' ? 'user' : 'assistant',
    );
    const time = timeNode(timeMs);
    if (time && options.align === 'user') {
      attach(actions, time);
    }
    const copy = h('button', {
      type: 'button',
      class: 'mp-chat-action',
      'aria-label': lt('chat.copy'),
    });
    copy.setAttribute('data-mp-chat-act', 'copy');
    copy.setAttribute('data-mp-chat-copy', String(message || ''));
    attach(copy, icon('copy', 16));
    attach(actions, copy);

    const retry = h('button', {
      type: 'button',
      class: 'mp-chat-action',
      'aria-label': lt('chat.resend'),
    });
    retry.setAttribute('data-mp-chat-act', 'retry');
    retry.setAttribute('data-mp-chat-retry', String(message || ''));
    attach(retry, icon('retry', 16));
    attach(actions, retry);

    if (branch?.conversationId && Number.isInteger(branch.turnIndex)) {
      const fork = h('button', {
        type: 'button',
        class: 'mp-chat-action',
        'aria-label': lt('chat.fork_here'),
      });
      fork.setAttribute('data-mp-chat-act', 'branch');
      fork.setAttribute(
        'data-mp-chat-branch-conversation',
        branch.conversationId,
      );
      fork.setAttribute('data-mp-chat-branch-turn', String(branch.turnIndex));
      attach(fork, icon('branch', 16));
      attach(actions, fork);
    }
    if (time && options.align !== 'user') {
      attach(actions, time);
    }
    return actions;
  }

  function userNode(
    question: string,
    timeMs?: number,
    branch?: BranchTarget,
  ): ChatNode {
    const root = h('div', {class: 'mp-chat-user'});
    const stack = h('div', {class: 'mp-chat-user-stack'});
    const bubble = h('div', {class: 'mp-chat-bubble'});
    const interactive =
      /^([\s\S]+)\n\n\[Interactive response: [^\n]+\]\n([\s\S]+)$/.exec(
        question,
      );
    let values: unknown;
    if (interactive) {
      try {
        values = JSON.parse(interactive[2]);
      } catch {
        // Keep an ordinary user message intact if it only resembles a receipt.
      }
    }
    if (interactive && values && typeof values === 'object') {
      attach(bubble, interactive[1]);
      const details = h('details', {class: 'mp-chat-ui-receipt'});
      attach(
        details,
        h(
          'summary',
          {},
          DOC?.documentElement.lang.startsWith('zh')
            ? '已提交的选项'
            : 'Submitted values',
        ),
      );
      attach(details, h('pre', {}, JSON.stringify(values, null, 2)));
      attach(bubble, details);
    } else {
      attach(bubble, question);
    }
    attach(stack, bubble);
    attach(root, stack);
    attach(root, messageActions(question, branch, timeMs, {align: 'user'}));
    return root;
  }

  function permissionAnswerNode(answer: {
    decision?: string;
    rule?: string;
  }): ChatNode {
    const decision = String(answer?.decision || '');
    const rule = String(answer?.rule || '');
    const root = h('div', {class: 'mp-chat-perm-receipt'});
    root.setAttribute('data-decision', decision);
    const label = h('span', {class: 'mp-chat-perm-receipt-label'});
    attach(
      label,
      decision === 'deny'
        ? 'Denied'
        : decision === 'once'
          ? 'Allowed once'
          : 'Allowed for this session',
    );
    const target = h('code', {class: 'mp-chat-perm-receipt-rule'});
    attach(target, rule);
    attach(root, label);
    if (rule) {
      attach(root, target);
    }
    return root;
  }

  interface DeliveredFile {
    path: string;
    absolutePath?: string;
    name: string;
    added: number;
    removed: number;
    statKnown: boolean;
    created: boolean;
    deleted: boolean;
    previewPath?: string;
    sourceCalls: Set<string>;
  }

  const FILE_WRITE_TOOLS = new Set([
    'Write',
    'write_file',
    'write',
    'Edit',
    'edit_file',
    'edit',
    'MultiEdit',
  ]);
  const FILE_CHANGE_TOOLS = new Set([
    ...FILE_WRITE_TOOLS,
    'Patch',
    'patch',
    'apply_patch',
    'Rewind',
    'rewind',
    'restore_files',
  ]);

  function deliveredFileKey(path: string): string {
    return path.replace(/\\/g, '/');
  }

  function executionFilePath(file: string, root: string): string {
    if (!root || /^(?:[a-z]:[\\/]|[\\/])/i.test(file)) {
      return file;
    }
    return root.replace(/[\\/]+$/, '') + '/' + file.replace(/\\/g, '/');
  }

  // A result is a file the agent actually wrote, not a claim about one.
  function deliveredFiles(
    trajectory: Array<Record<string, unknown>> | undefined,
    executionRoot: string,
  ): DeliveredFile[] {
    const byPath = new Map<string, DeliveredFile>();
    const callsByPath = new Map<string, Set<string>>();
    for (const [index, record] of (trajectory || []).entries()) {
      if (
        record.kind !== 'tool' ||
        !FILE_CHANGE_TOOLS.has(String(record.name))
      ) {
        continue;
      }
      if (record.result == null) {
        continue;
      }
      const result = outputRecord(String(record.result));
      if (
        record.isError &&
        !Array.isArray(result?.fileChanges) &&
        !Array.isArray(result?.patches)
      ) {
        continue;
      }
      const changes: unknown[] = Array.isArray(result?.fileChanges)
        ? result.fileChanges
        : Array.isArray(result?.patches)
          ? result.patches.flatMap(patch => {
              const entry = recordOf(patch);
              return Array.isArray(entry?.fileChanges) ? entry.fileChanges : [];
            })
          : FILE_WRITE_TOOLS.has(String(record.name))
            ? [result || {}]
            : [];
      for (const raw of changes) {
        const change = recordOf(raw);
        if (!change) {
          continue;
        }
        const path =
          typeof change.path === 'string'
            ? change.path
            : toolRowModel(String(record.name), String(record.text || ''), {
                text: String(record.result),
              }).filePath || '';
        if (!path) {
          continue;
        }
        const key = deliveredFileKey(path);
        let sourceCalls = callsByPath.get(key);
        if (!sourceCalls) {
          sourceCalls = new Set();
          callsByPath.set(key, sourceCalls);
        }
        // A net-zero intermediate result still belongs to its earlier runs.
        sourceCalls.add(String(record.callId ?? index));
        if (change.unchanged === true) {
          byPath.delete(key);
          continue;
        }
        const previous = byPath.get(key);
        const stat = reportedDiffStat(JSON.stringify(change), 'turnDiffStat');
        const created =
          typeof change.turnCreated === 'boolean'
            ? change.turnCreated
            : (previous?.created ??
              (change.created === true ||
                (change.created !== false &&
                  ['Write', 'write_file', 'write'].includes(
                    String(record.name),
                  ))));
        byPath.set(key, {
          path,
          ...(typeof change.absolutePath === 'string'
            ? {absolutePath: change.absolutePath}
            : executionRoot
              ? {absolutePath: executionFilePath(path, executionRoot)}
              : {}),
          name: path.split(/[\\/]/).pop() || path,
          sourceCalls,
          added: stat ? stat.added : 0,
          removed: stat ? stat.removed : 0,
          statKnown: Boolean(stat),
          created,
          deleted: change.exists === false,
          ...(typeof change.previewPath === 'string'
            ? {previewPath: executionFilePath(change.previewPath, executionRoot)}
            : {}),
        });
      }
    }
    return [...byPath.values()];
  }

  function fileResultGlyph(glyph: string, className = ''): ChatNode {
    return h('span', {
      class: `mp-chat-file-glyph ${className}`.trim(),
      'aria-hidden': 'true', 'data-glyph': glyph,
    });
  }

  function fileTypeIcon(name: string): ChatNode {
    const namespace = 'http://www.w3.org/2000/svg';
    const selected = fileIcons.fileIconFor(name);
    if (selected.glyph) {
      return h('span', {
        class: 'mp-chat-file-type-icon mp-chat-file-glyph',
        'aria-hidden': 'true',
        'data-file-type-icon': selected.id,
        'data-glyph': selected.glyph,
      });
    }
    const svg = DOC ? DOC.createElementNS(namespace, 'svg') : shimNode('svg', namespace);
    svg.setAttribute('class', 'mp-chat-file-type-icon');
    svg.setAttribute('data-file-type-icon', selected.id);
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const append = (parent: ChatNode, nodes: typeof selected.nodes): void => {
      for (const [tag, attributes, children] of nodes) {
        const node = DOC ? DOC.createElementNS(namespace, tag) : shimNode(tag, namespace);
        for (const [key, value] of Object.entries(attributes)) {
          node.setAttribute(key, value);
        }
        if (children) {
          append(node, children);
        }
        attach(parent, node);
      }
    };
    append(svg, selected.nodes);
    return svg;
  }

  function fileFolderHints(files: DeliveredFile[]): Map<string, string> {
    const groups = new Map<string, DeliveredFile[]>();
    for (const file of files) {
      const group = groups.get(file.name) || [];
      group.push(file);
      groups.set(file.name, group);
    }
    const hints = new Map<string, string>();
    for (const group of groups.values()) {
      if (group.length < 2) {
        continue;
      }
      const folders = group.map(file => {
        const path = file.path.replace(/\\/g, '/');
        const folder = path.slice(0, path.lastIndexOf('/')) || (path.startsWith('/') ? '/' : '');
        const parts = folder.split('/').filter(Boolean);
        if (folder.startsWith('//')) {
          parts.unshift('/');
        } else if (folder.startsWith('/')) {
          parts.unshift('');
        }
        return {file, folder, parts};
      });
      for (const item of folders) {
        const others = folders.filter(other => other !== item);
        if (others.every(other => other.folder === item.folder)) {
          continue;
        }
        let hint = item.folder;
        for (let size = 1; size < item.parts.length; size++) {
          const tail = item.parts.slice(-size).join('/');
          if (others.every(other => other.parts.slice(-size).join('/') !== tail)) {
            const root = item.parts[0];
            if (!(size === item.parts.length - 1 && (root === '' || root === '/' || /^[a-z]:$/i.test(root)))) {
              hint = tail;
            }
            break;
          }
        }
        hints.set(item.file.path, hint);
      }
    }
    return hints;
  }

  function fileResultStat(added: number, removed: number): ChatNode {
    return h('span', {class: 'mp-chat-diff-stat'},
      h('span', {class: 'mp-chat-diff-add'}, `+${added}`),
      h('span', {class: 'mp-chat-diff-del'}, `−${removed}`));
  }

  function fileResultRow(options: {
    opener: ChatNode; label: string; mark: ChatNode; hint?: string;
    detail?: string; stat?: ChatNode | null; action?: ChatNode; chevron?: boolean;
  }): ChatNode {
    const item = h('li', {class: 'mp-chat-file-item'});
    const name = h('span', {class: 'mp-chat-file-name'}, options.label);
    if (options.hint !== undefined) {
      options.opener.setAttribute('aria-label', `${options.label}, ${options.hint}`);
      attach(name, h('span', {class: 'mp-chat-file-folder-hint'}, options.hint));
    }
    const labels = h('span', {class: 'mp-chat-file-labels'},
      h('span', {class: 'mp-chat-file-mark'}, options.mark), name);
    if (options.detail) {
      attach(labels, h('span', {class: 'mp-chat-file-detail'}, options.detail));
    }
    attach(options.opener, labels);
    attach(item, options.opener);
    const trailing = h('span', {class: 'mp-chat-file-trailing'});
    attach(trailing, options.action);
    attach(trailing, options.stat);
    if (options.chevron) {
      attach(trailing, fileResultGlyph('\ue02a', 'mp-chat-file-chev'));
    }
    attach(item, trailing);
    return item;
  }

  function fileResultsNode(
    files: DeliveredFile[],
    artifacts: Array<Record<string, unknown>>,
    conversationId: string,
    turnScope = conversationId,
    undo?: {conversationId: string; turnIndex: number},
  ): ChatNode | null {
    const artifact = artifacts.find(
      item => item && typeof item === 'object' && String(item.artifactId || ''),
    );
    if (!files.length && !artifact) {
      return null;
    }
    const card = h('div', {class: 'mp-chat-files'});
    const list = h('ul', {class: 'mp-chat-files-list', role: 'list'});
    attach(card, list);
    const artifactPath =
      typeof artifact?.path === 'string' ? artifact.path : '';
    const artifactFile = artifactPath
      ? files.find(
          file =>
            deliveredFileKey(file.path) === deliveredFileKey(artifactPath),
        )
      : undefined;
    const label = artifact
      ? String(artifact.title || artifact.name || '').trim()
      : '';
    const undoAction = !artifact && files.length && undo
      ? h('button', {
          type: 'button', class: 'mp-chat-files-undo',
          title: lt('chat.files_undo_hint'),
          'data-mp-chat-act': 'undo-files',
          'data-undo-conversation': undo.conversationId,
          'data-undo-turn': String(undo.turnIndex),
        }, lt('chat.files_undo'))
      : undefined;
    if (!artifact && files.length > 1) {
      const title = h('span', {class: 'mp-chat-files-title'},
        lt('chat.files_edited', {count: files.length}));
      const head = h('li', {class: 'mp-chat-files-head'},
        h('span', {class: 'mp-chat-files-heading'},
          fileResultGlyph('\ue02d'), title));
      const trailing = h('span', {class: 'mp-chat-file-trailing'});
      attach(trailing, undoAction);
      if (files.every(file => file.statKnown)) {
        const added = files.reduce((total, file) => total + file.added, 0);
        const removed = files.reduce((total, file) => total + file.removed, 0);
        attach(trailing, fileResultStat(added, removed));
      }
      attach(head, trailing);
      attach(list, head);
    }

    if (artifact) {
      const row = h('button', {
        type: 'button',
        class: 'mp-chat-file-row',
        'data-mp-chat-act': 'open-artifact',
        'data-artifact-id': String(artifact.artifactId || ''),
        'data-artifact-conversation': conversationId,
      });
      const artifactName = String(
        artifact.name || artifact.path || artifact.artifactId || 'artifact',
      );
      const added = artifactFile
        ? artifactFile.added
        : Number(artifact.added || 0);
      const removed = artifactFile
        ? artifactFile.removed
        : Number(artifact.removed || 0);
      const open = h('button', {
        type: 'button', class: 'mp-chat-files-open',
        'aria-label': lt('chat.files_open_artifact', {label: label || artifactName}),
        'data-mp-chat-act': 'open-artifact',
        'data-artifact-id': String(artifact.artifactId || ''),
        'data-artifact-conversation': conversationId,
      }, lt('chat.files_open'));
      const known = artifactFile ? artifactFile.statKnown
        : typeof artifact.added === 'number' || typeof artifact.removed === 'number';
      attach(list, fileResultRow({opener: row,
        label: label || artifactName.split(/[\\/]/).pop() || artifactName,
        mark: fileResultGlyph('\ue017'), detail: lt('chat.files_artifact'),
        stat: known ? fileResultStat(added, removed) : null, action: open}));
    }

    const visibleFiles = files.filter(
      item =>
        !artifactPath ||
        deliveredFileKey(item.path) !== deliveredFileKey(artifactPath),
    );
    const hints = fileFolderHints(visibleFiles);
    const fileRow = (file: DeliveredFile): ChatNode => {
      const target = file.previewPath || file.absolutePath || file.path;
      const row = h('button', {
        type: 'button',
        class: 'mp-chat-file-row',
        'data-mp-chat-act': 'open-file',
        'data-file-path': file.path,
        ...(file.absolutePath
          ? {'data-file-absolute-path': file.absolutePath}
          : {}),
        'data-file-state': file.deleted ? 'deleted' : 'present',
        'data-file-change': file.deleted ? 'deleted' : file.created ? 'created' : 'edited',
        ...(!/^(?:[a-z]:[\\/]|[\\/])/i.test(target)
          ? {'data-file-origin-unknown': 'true'}
          : {}),
        ...(file.previewPath ? {'data-preview-path': file.previewPath} : {}),
      });
      return fileResultRow({opener: row, label: file.name,
        mark: fileTypeIcon(file.name), hint: hints.get(file.path),
        stat: file.statKnown ? fileResultStat(file.added, file.removed) : null,
        action: files.length === 1 ? undoAction : undefined,
        chevron: true});
    };
    visibleFiles.slice(0, 3).forEach(file => attach(list, fileRow(file)));
    if (visibleFiles.length > 3) {
      const key = `files:${turnScope}:${deliveredFileKey(visibleFiles[0].path)}`;
      const expanded = ROW_EXPANSION.get(key) === true;
      const more = h('li', {class: 'mp-chat-files-more'});
      const rest = h('ul', {
        class: 'mp-chat-files-more-list',
        role: 'presentation',
        ...(!expanded ? {hidden: 'true'} : {}),
      });
      visibleFiles.slice(3).forEach(file => attach(rest, fileRow(file)));
      attach(more, rest);
      const collapsedLabel = lt('chat.files_show_more', {count: visibleFiles.length - 3});
      const toggle = h('button', {
        type: 'button',
        class: 'mp-chat-files-more-summary',
        'data-mp-chat-act': 'toggle-files',
        'data-files-expansion-key': key,
        'data-files-collapsed-label': collapsedLabel,
        'aria-expanded': String(expanded),
      });
      attach(toggle, h('span', {class: 'mp-chat-files-more-spacer', 'aria-hidden': 'true'}));
      attach(toggle, h('span', {class: 'mp-chat-files-more-label'},
        expanded ? lt('chat.files_show_less') : collapsedLabel));
      attach(toggle, fileResultGlyph('\ue02a', 'mp-chat-files-more-chevron'));
      attach(more, toggle);
      attach(list, more);
    }

    return card;
  }

  // Compatibility surface for the standalone draft preview and older callers.
  // The live conversation uses fileResultsNode so files and artifacts share one
  // delivery card, while a draft-only caller still gets one coherent target.
  function artifactCardNode(
    items: Array<Record<string, unknown>>,
    conversationId: string,
  ): ChatNode | null {
    const artifact = items.find(
      item => item && typeof item === 'object' && String(item.artifactId || ''),
    );
    if (!artifact) {
      return null;
    }
    return fileResultsNode([], [artifact], conversationId);
  }

  function sparkMark(running = true): ChatNode {
    const root = h('span', {
      class: running ? 'mp-chat-thinking-mark' : 'mp-chat-run-meta-mark',
      'aria-hidden': 'true',
    });
    const api =
      typeof globalThis !== 'undefined'
        ? (
            globalThis as unknown as {
              ActivityMarks?: {spark?: (state: 'thinking' | 'idle') => string};
            }
          ).ActivityMarks
        : undefined;
    const markup =
      api && typeof api.spark === 'function'
        ? api.spark(running ? 'thinking' : 'idle')
        : '';
    if (markup && 'innerHTML' in root) {
      (root as unknown as HTMLElement).innerHTML = markup;
    }
    return root;
  }

  function turnStatusNode(label: string): ChatNode {
    const root = h('div', {
      class: 'mp-chat-turn-status',
      role: 'status',
      'aria-label': label,
    });
    attach(root, sparkMark());
    const copy = h('span', {class: 'mp-chat-turn-status-copy'});
    attach(
      copy,
      h('span', {class: 'mp-chat-turn-status-meta', 'data-turn-meta': 'true'}),
    );
    const labelNode = h('span', {class: 'mp-chat-turn-status-label'});
    if (label === 'Thinking') {
      labelNode.setAttribute('data-quiet', 'true');
    }
    attach(labelNode, label);
    attach(copy, labelNode);
    attach(root, copy);
    return root;
  }

  function turnErrorNode(
    message: string,
    code?: string,
    tone: 'error' | 'warning' = 'error',
  ): ChatNode {
    const root = h('div', {class: 'mp-chat-turn-error', role: 'status'});
    attach(root, stateDot(tone === 'error' ? 'error' : 'warning'));
    const copy = h('div', {class: 'mp-chat-turn-error-copy'});
    const title = h('span', {class: 'mp-chat-turn-error-title'});
    if (tone === 'warning') {
      title.setAttribute('data-tone', 'warning');
    }
    attach(
      title,
      tone === 'error' ? lt('chat.round_failed') : lt('common.notice'),
    );
    const body = h('span', {class: 'mp-chat-turn-error-message'});
    attach(body, message);
    attach(copy, title);
    attach(copy, body);
    attach(root, copy);
    if (code) {
      const c = h('code', {class: 'mp-chat-turn-error-code'});
      attach(c, code);
      attach(root, c);
    }
    return root;
  }

  interface AssistantTurnInput {
    request?: Record<string, unknown>;
    answer?: string;
    thinking?: string;
    trace?: Array<
      | string
      | {
          label?: string;
          note?: string;
          state?: string;
          name?: string;
          arguments?: string;
          result?: string;
          isError?: boolean;
        }
    >;
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
    timingMs?: number;
    pendingInput?: unknown;
  }

  interface TurnChip {
    name: string;
    argsRaw: string;
    callId: string;
    groupLabel?: string;
    displayLabel?: string;
    startedAtMs?: number;
    executionRoot?: string;
    result?: {text: string; isError: boolean; interrupted?: boolean; presentation?: unknown};
    subagent?: Record<string, unknown>;
  }

  interface TurnPresentation {
    taskPanel?: boolean;
    undoFileChanges?: boolean;
  }

  type FlowItem =
    | {type: 'narration'; text: string; turn?: string}
    | {
        type: 'reasoning';
        text: string;
        id?: string;
        running?: boolean;
        turn?: string;
      }
    | {
        type: 'notice';
        text: string;
        turn?: string;
        compaction?: Record<string, unknown>;
      }
    | {type: 'chip'; chip: TurnChip; turn?: string};

  function trajectoryReasoning(
    record: Record<string, unknown>,
    index: number,
  ): Extract<FlowItem, {type: 'reasoning'}> | null {
    const text = String(
      record.reasoning || (record.kind === 'think' ? record.text : '') || '',
    ).trim();
    if (!text) {
      return null;
    }
    return {
      type: 'reasoning',
      text,
      id: String(record.callId ?? record.turn ?? index),
      running:
        record.state === 'running' && (record.kind === 'think' || !record.text),
      turn: record.turn == null ? undefined : String(record.turn),
    };
  }

  function trajectoryChip(
    record: Record<string, unknown>,
    index: number,
    settled: boolean,
  ): TurnChip {
    const interrupted =
      record.interrupted === true ||
      ['stopped', 'cancelled', 'interrupted'].includes(String(record.state));
    const hasResult =
      record.result != null ||
      interrupted ||
      record.state === 'error' ||
      (settled && record.state !== 'running');
    return {
      name: String(record.name || 'tool'),
      argsRaw: String(record.text || ''),
      callId: String(record.callId ?? index),
      groupLabel:
        typeof record.groupLabel === 'string' ? record.groupLabel : undefined,
      displayLabel:
        typeof record.summary === 'string' ? record.summary : undefined,
      startedAtMs: Number(record.startedAt) || undefined,
      subagent: record.subagent as Record<string, unknown> | undefined,
      result: hasResult
        ? {
            text: String(record.result ?? ''),
            isError: record.isError === true || record.state === 'error',
            interrupted,
            presentation: record.presentation,
          }
        : undefined,
    };
  }

  function narrationNode(text: string): ChatNode {
    const root = h('div', {class: 'mp-chat-narration'});
    attach(root, markdownRenderer.render(text));
    return root;
  }

  function noticeNode(text: string): ChatNode {
    const root = h('div', {class: 'mp-chat-notice', role: 'status'});
    attach(root, stateDot('warning'));
    const copy = h('span', {class: 'mp-chat-notice-copy'});
    attach(copy, text);
    attach(root, copy);
    return root;
  }

  function compactionNode(
    record: Record<string, unknown>,
    live = false,
  ): ChatNode {
    const language =
      typeof document !== 'undefined'
        ? document.documentElement.lang || 'en'
        : StudioLocaleApi?.getStudioLanguage() || 'en';
    const label = compaction.compactionLabel(record, language);
    const running = record.state === 'running';
    const root = h('div', {
      class: 'mp-chat-notice mp-chat-compaction',
      role: 'status',
      'aria-live': live ? 'polite' : 'off',
      'aria-atomic': 'true',
      'data-state': String(record.state),
      'data-compaction-id': String(record.compactionId),
    });
    attach(
      root,
      stateDot(
        running
          ? 'ongoing'
          : record.state === 'error'
            ? 'error'
            : record.state === 'done'
              ? 'done'
              : 'warning',
      ),
    );
    const copy = h('span', {class: 'mp-chat-notice-copy'});
    attach(copy, label);
    if (record.error) {
      const error = h('small', {class: 'mp-chat-compaction-error'});
      attach(error, String(record.error));
      attach(copy, error);
    }
    attach(root, copy);
    return root;
  }

  function chipModel(chip: TurnChip): ToolRowModel {
    const model = toolRowModel(
      chip.name,
      chip.argsRaw,
      chip.result,
      chip.callId,
      chip.executionRoot,
    );
    if (chip.displayLabel?.trim()) {
      model.title = chip.displayLabel.trim();
      model.summary = '';
    }
    return model;
  }

  function chipNode(chip: TurnChip, scope = ''): ChatNode {
    const node = toolRowNode(chipModel(chip), scope);
    if (SUBAGENT_TOOLS.has(chip.name)) {
      attach(
        node,
        h(
          'div',
          {class: 'mp-chat-subagent-heartbeat'},
          subagentHeartbeat(chip.subagent),
        ),
      );
    }
    return node;
  }

  function subagentHeartbeat(
    child?: Record<string, unknown>,
    includePreview = true,
  ): string {
    if (!child) {
      return '';
    }
    const phase =
      child.status !== 'running'
        ? String(child.status || '')
        : child.currentTool
          ? String(child.currentTool)
          : child.phase === 'writing'
            ? 'Writing'
            : 'Thinking';
    const preview = child.phase === 'writing' ? child.answer : child.reasoning;
    return [
      phase,
      Number(child.stepCount) ? `${child.stepCount} tools` : '',
      Number(child.elapsedMs) >= 1000
        ? `${Math.floor(Number(child.elapsedMs) / 1000)}s`
        : '',
      includePreview ? latestLine(String(preview || child.summary || '')) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function subagentEntryNode(chip: TurnChip, scope: string): ChatNode {
    const model = toolRowModel(
      chip.name,
      chip.argsRaw,
      chip.result,
      chip.callId,
    );
    const status = String(chip.subagent?.status || '');
    if (status) {
      model.state =
        status === 'running'
          ? 'running'
          : status === 'completed'
            ? 'ok'
            : ['stopped', 'cancelled', 'user_interrupt'].includes(status)
              ? 'stopped'
              : 'error';
    }
    let description = String(chip.subagent?.description || '').trim();
    if (!description) {
      try {
        const args = JSON.parse(chip.argsRaw) as Record<string, unknown>;
        description = String(args.description || args.task || '').trim();
      } catch {}
    }
    model.title = description || 'Subagent';
    model.summary = subagentHeartbeat(chip.subagent, false);
    return toolRowNode(
      {...model, argsRaw: '', body: null, output: null},
      scope,
    );
  }

  function fileRowKey(chip: TurnChip): string | null {
    const family = FILE_WRITE_TOOLS.has(chip.name)
      ? ['Write', 'write_file', 'write'].includes(chip.name)
        ? 'Write'
        : 'Edit'
      : ['Read', 'read', 'read_file'].includes(chip.name)
        ? 'Read'
        : null;
    const path = deriveFilePath(classifyTool(chip.name), chip.argsRaw);
    return family && path ? `${family} ${path}` : null;
  }

  function singleToolGroup(chips: TurnChip[], work?: FlowItem[]): boolean {
    if (!chips.length || work?.some(item => item.type !== 'chip')) {
      return false;
    }
    const key = fileRowKey(chips[0]);
    return (
      chips.length === 1 ||
      (key !== null && chips.every(chip => fileRowKey(chip) === key))
    );
  }

  function coalescedToolModel(
    chips: TurnChip[],
    models: ToolRowModel[],
  ): ToolRowModel {
    if (models.length === 1) {
      return models[0];
    }
    const first = chips[0];
    const state = models.some(model => model.state === 'running')
      ? 'running'
      : models[models.length - 1].state;
    const allFailed =
      state === 'error' && models.every(model => model.state === 'error');
    const header = toolRowModel(
      first.name,
      first.argsRaw,
      state === 'running'
        ? undefined
        : {
            ...first.result,
            isError: allFailed,
            interrupted: state === 'stopped',
          },
      first.callId,
      first.executionRoot,
    );
    header.state = state;
    header.fileDiffReference =
      state === 'ok' ? combinedFileDiffReference(models) : undefined;
    if (allFailed && !isBlockedResult(first.result)) {
      header.title = fileRowKey(first)?.startsWith('Write ')
        ? 'Failed to write'
        : fileRowKey(first)?.startsWith('Read ')
          ? 'Failed to read'
          : 'Failed to edit';
    }
    const completed = models.filter(model => model.state === 'ok');
    const write = ['Write', 'write_file', 'write'].includes(first.name);
    const stats = write ? completed.slice(-1) : completed;
    header.diffStat =
      stats.length && stats.every(model => model.diffStat !== null)
        ? stats.reduce(
            (total, model) => ({
              added: total.added + model.diffStat!.added,
              removed: total.removed + model.diffStat!.removed,
            }),
            {added: 0, removed: 0},
          )
        : null;
    if (fileRowKey(first)?.startsWith('Read ')) {
      header.diffStat = null;
      const ranges = chips.map(chip => {
        const input = parseArgs(chip.argsRaw) ?? {};
        const offset =
          typeof input.offset === 'number' ? input.offset : undefined;
        const limit = typeof input.limit === 'number' ? input.limit : undefined;
        if (offset === undefined && limit === undefined) {
          return null;
        }
        const start = offset ?? 1;
        return limit === undefined
          ? `${start}–`
          : `${start}–${start + limit - 1}`;
      });
      if (ranges.every(range => range !== null)) {
        header.summary += ` (${ranges.join(', ')})`;
      }
    }
    if (first.displayLabel?.trim()) {
      header.title = first.displayLabel.trim();
      header.summary = '';
    }
    return header;
  }

  function toolGroupNode(
    chips: TurnChip[],
    _running = false,
    work?: FlowItem[],
    scope = '',
    thoughtOnly = false,
  ): ChatNode {
    const root = h('details', {class: 'mp-chat-tool-group'});
    const summary = h('summary', {class: 'mp-chat-tool-group-header'});
    const label = h('span', {class: 'mp-chat-tool-group-title'});
    const single = singleToolGroup(chips, work);
    if (single) {
      root.setAttribute('data-single', 'true');
    }
    if (thoughtOnly) {
      root.setAttribute('data-thought-only', 'true');
    }
    const models = single ? chips.map(chipModel) : null;
    const model = models ? coalescedToolModel(chips, models) : null;
    if (model) {
      root.setAttribute('data-state', model.state);
    }
    if (model?.errorTitle || model?.state === 'error') {
      root.setAttribute('data-error-title', 'true');
    }
    if (!thoughtOnly) {
      if (model) {
        const displayLabel = chips[0].displayLabel?.trim();
        if (displayLabel) {
          attach(label, displayLabel);
        } else {
          attach(label, h('span', {class: 'mp-chat-title'}, model.title));
          if (model.summary) {
            attach(label, h('span', {class: 'mp-chat-tool-sep'}, ' '));
            attach(
              label,
              toolFileSummaryNode(model),
            );
          }
        }
        if (model.state === 'running') {
          const elapsed = runningElapsedNode(chips);
          if (elapsed) {
            attach(label, elapsed);
          }
        }
      } else {
        const inFlight = chips.some(chip => chip.result === undefined);
        attach(label, toolGroupSummaryNode(chips));
        if (inFlight) {
          const elapsed = runningElapsedNode(chips);
          if (elapsed) {
            attach(label, elapsed);
          }
        }
      }
    }
    if (model?.diffStat) {
      const stat = h('span', {
        class: 'mp-chat-diff-stat',
        'aria-hidden': 'true',
      });
      if (model.diffStat.added) {
        attach(
          stat,
          h('span', {class: 'mp-chat-diff-add'}, `+${model.diffStat.added}`),
        );
      }
      if (model.diffStat.removed) {
        attach(
          stat,
          h('span', {class: 'mp-chat-diff-del'}, `−${model.diffStat.removed}`),
        );
      }
      attach(label, stat);
    }
    if (model && model.state !== 'ok') {
      attach(
        summary,
        h(
          'span',
          {class: 'mp-chat-vh'},
          model.state === 'running'
            ? 'Running'
            : model.state === 'error'
              ? 'Failed'
              : 'Stopped',
        ),
      );
    }
    attach(summary, label);
    const body = h('div', {class: 'mp-chat-tool-group-body'});
    const entries: FlowItem[] =
      work || chips.map(chip => ({type: 'chip', chip}));
    const firstReasoning = entries.find(
      (entry): entry is Extract<FlowItem, {type: 'reasoning'}> =>
        entry.type === 'reasoning',
    );
    const reasoningId = (entry: {id?: string}): string =>
      entry.id === 'head' ? `${scope}:head` : `${scope}:r${entry.id ?? '0'}`;
    const fallbackId = firstReasoning
      ? `thought:${firstReasoning.id ?? '0'}`
      : 'thought';
    const groupId = `group:${scope ? `${scope}:` : ''}${chips[0]?.callId || fallbackId}`;
    const previous = GROUP_EXPANSION.get(groupId);
    const members = entries.flatMap(entry =>
      entry.type === 'chip'
        ? [`group:${scope ? `${scope}:` : ''}${entry.chip.callId || ''}`]
        : entry.type === 'reasoning'
          ? [`think:${reasoningId(entry)}`]
          : [],
    );
    const previousMembers = new Set(previous?.members || []);
    const open =
      thoughtOnly ||
      previous?.open === true ||
      (single &&
        previous?.single !== true &&
        ROW_EXPANSION.get(
          `tool:${scope ? `${scope}:` : ''}${chips[0]?.callId}`,
        ) === true) ||
      members.some(
        id =>
          !previousMembers.has(id) &&
          (GROUP_EXPANSION.get(id)?.open === true ||
            ROW_EXPANSION.get(id) === true),
      );
    if (!single) {
      for (const id of members) {
        const source = GROUP_EXPANSION.get(id);
        const childToolIds = source?.members.filter(memberId =>
          memberId.startsWith('group:'),
        );
        if (
          source?.open &&
          childToolIds?.length &&
          (source.single ||
            (childToolIds.length === 1 &&
              (!previousMembers.has(id) || previousMembers.size === 1)))
        ) {
          rememberExpansion(
            ROW_EXPANSION,
            `tool:${childToolIds[0].slice('group:'.length)}`,
            true,
          );
        }
      }
    }
    GROUP_EXPANSION.set(groupId, {open, members, single});
    if (open) {
      root.setAttribute('open', '');
    }
    summary.setAttribute('aria-expanded', open ? 'true' : 'false');
    summary.setAttribute('data-group-id', groupId);

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (entry.type === 'reasoning') {
        attach(
          body,
          thinkNode(entry.text, entry.running === true, reasoningId(entry)),
        );
        continue;
      }
      if (entry.type === 'narration') {
        attach(body, narrationNode(entry.text));
        continue;
      }
      if (entry.type !== 'chip') {
        continue;
      }
      const chip = entry.chip;
      const grouped = [chip];
      const key = fileRowKey(chip);
      while (key !== null && entries[index + 1]?.type === 'chip') {
        const next = entries[index + 1] as Extract<FlowItem, {type: 'chip'}>;
        if (fileRowKey(next.chip) !== key) {
          break;
        }
        grouped.push(next.chip);
        index++;
      }
      const groupedModels =
        grouped.length > 1 ? (models ?? grouped.map(chipModel)) : null;
      const node = groupedModels
        ? toolRowNode(
            coalescedToolModel(grouped, groupedModels),
            scope,
            groupedModels,
          )
        : chipNode(chip, scope);
      if (single) {
        const disclosure = DOC
          ? (node as Element).querySelector('.mp-chat-disclosure')
          : ((node as ShimNode).children.find(
              child =>
                typeof child !== 'string' &&
                child.attrs.class === 'mp-chat-disclosure',
            ) as ShimNode | undefined);
        disclosure?.setAttribute('data-open', 'true');
        disclosure?.removeAttribute('data-row-id');
      }
      attach(body, node);
    }
    attach(root, summary);
    attach(root, body);
    return root;
  }

  function isBlockedResult(result?: {
    text?: string;
    isError?: boolean;
  }): boolean {
    return (
      result?.isError === true &&
      /permission[_ ](?:denied|required)|source access denied|not allowed/i.test(
        result.text || '',
      )
    );
  }

  function groupSummaryCalls(
    chips: TurnChip[],
  ): Array<import('./chat_tool_summary').SummaryCall & {target?: string}> {
    return chips.map((chip, index) => {
      const input = parseArgs(chip.argsRaw) ?? {};
      const fileCategory = FILE_WRITE_TOOLS.has(chip.name)
        ? ['Write', 'write_file', 'write'].includes(chip.name)
          ? 'write'
          : 'edit'
        : ['Read', 'read_file', 'read'].includes(chip.name)
          ? 'read'
          : undefined;
      let category: string | undefined = PLAN_TOOLS.has(chip.name)
        ? 'plan'
        : (fileCategory ?? toolCategory(chip.name));
      const fileContract =
        fileCategory ||
        ['view', 'notebook_edit', 'delete_file'].includes(category || '');
      const path = fileContract
        ? pickString(input, ['path', 'file_path', 'notebook_path'])
        : undefined;
      const filePath = path === undefined ? undefined : deliveredFileKey(path);
      let key = filePath ?? (chip.callId || String(index));
      const method = chip.name.split('.');
      const artifact = ARTIFACT_TOOL_NAMES.has(aliasToolName(method[0]));
      // A Read result is file content, not a receipt carrying routing metadata.
      const receipt =
        FILE_WRITE_TOOLS.has(chip.name) || artifact
          ? outputRecord(chip.result?.text || '')
          : null;
      if (artifact) {
        const action = method[1] || firstString(input, ['action']);
        category =
          action === 'read'
            ? 'artifact_read'
            : ['create', 'update'].includes(action)
              ? 'artifact_write'
              : undefined;
        key =
          firstString(input, ['artifact_id', 'artifactId']) ||
          firstString(receipt || {}, ['artifactId', 'artifact_id']) ||
          key;
      }
      const interrupted = chip.result?.interrupted === true;
      const outcome: import('./chat_tool_summary').SummaryOutcome | undefined =
        interrupted
          ? undefined
          : !chip.result
            ? 'pending'
            : isBlockedResult(chip.result)
              ? 'blocked'
              : chip.result.isError
                ? 'failed'
                : 'succeeded';
      const write = ['Write', 'write_file', 'write'].includes(chip.name);
      const created =
        outcome === 'succeeded' && write ? receipt?.created : undefined;
      const target =
        (outcome === 'succeeded' && FILE_WRITE_TOOLS.has(chip.name)
          ? firstString(receipt || {}, ['absolutePath'])
          : '') ||
        (path ? executionFilePath(path, chip.executionRoot || '') : '');
      return {
        category,
        key,
        filePath,
        outcome,
        ...(typeof created === 'boolean'
          ? {writeAs: created ? ('create' as const) : ('update' as const)}
          : {}),
        canLinkFile:
          FILE_WRITE_TOOLS.has(chip.name) ||
          ['Read', 'read', 'read_file', 'NotebookEdit'].includes(chip.name),
        ...(/^(?:[a-z]:[\\/]|[\\/])/i.test(target) ? {target} : {}),
      };
    });
  }

  function toolGroupLabel(chips: TurnChip[]): string {
    const explicit = chips
      .find(chip => chip.groupLabel?.trim())
      ?.groupLabel?.trim();
    return (
      explicit ||
      toolSummary.summaryText(
        toolSummary.summarizeToolCalls(groupSummaryCalls(chips)),
      )
    );
  }

  function toolGroupSummaryNode(chips: TurnChip[]): ChatNode {
    const pending = chips.find(chip => chip.result === undefined);
    const busy = pending !== undefined;
    const explicit = chips
      .find(chip => chip.groupLabel?.trim())
      ?.groupLabel?.trim();
    if (explicit) {
      return shimmerText(explicit, {shimmering: busy});
    }
    if (pending) {
      const model = chipModel(pending);
      return shimmerText(
        model.summary ? model.title + ' ' + model.summary : model.title,
        {shimmering: true},
      );
    }
    const calls = groupSummaryCalls(chips);
    const parts = toolSummary.summarizeToolCalls(calls);
    const files = parts.some(part => part.file)
      ? deliveredFiles(
          chips.map(chip => ({
            kind: 'tool',
            name: chip.name,
            text: chip.argsRaw,
            result: chip.result?.text,
            isError: chip.result?.isError,
            callId: chip.callId,
          })),
          chips.find(chip => chip.executionRoot)?.executionRoot || '',
        )
      : [];
    const content: ChatNode[] = [];
    parts.forEach((part, index) => {
      const phrase = h('span', {
        class: 'mp-chat-group-phrase',
        ...(part.isError ? {'data-error': 'true'} : {}),
      });
      const verb =
        index === 0
          ? part.verb.charAt(0).toUpperCase() + part.verb.slice(1)
          : part.verb;
      attach(phrase, (index ? ', ' : '') + verb);
      if (part.meta) {
        attach(phrase, ' ');
        const file =
          part.file &&
          files.find(
            file =>
              deliveredFileKey(file.path) === deliveredFileKey(part.file!.path),
          );
        const target =
          file?.absolutePath ||
          calls.find(call => call.filePath === part.file?.path && call.target)
            ?.target;
        const canOpen =
          index === parts.length - 1 &&
          part.file &&
          target &&
          (!file?.deleted || file.previewPath);
        const reference = part.file?.preferDiff
          ? combinedFileDiffReference(
              chips.filter(chip => {
                if (!FILE_WRITE_TOOLS.has(chip.name)) {
                  return false;
                }
                const path = deriveFilePath(classifyTool(chip.name), chip.argsRaw);
                return path && deliveredFileKey(path) === deliveredFileKey(part.file!.path);
              }).map(chipModel),
            )
          : undefined;
        const meta = canOpen
          ? h(
              'button',
              {
                type: 'button',
                class: 'mp-chat-group-file',
                'data-mp-chat-act': 'open-file',
                'data-file-path': part.file!.path,
                'data-file-absolute-path': target,
                ...(reference
                  ? {'data-file-open-diff': JSON.stringify(reference)}
                  : {}),
                ...(file?.previewPath
                  ? {'data-preview-path': file.previewPath}
                  : {}),
              },
              part.meta,
            )
          : h('span', {class: 'mp-chat-group-meta'}, part.meta);
        attach(phrase, meta);
      }
      content.push(phrase);
    });
    return shimmerText(
      toolSummary.summaryText(parts),
      {shimmering: false},
      content,
    );
  }

  function formatRunMeta(ms: number, tokens: number | null): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    const time =
      seconds >= 60
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
        : `${seconds}s`;
    return tokens !== null && tokens > 0
      ? `${time} · ${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens`
      : time;
  }

  function cleanDeliveryText(value: string): string {
    let insideCode = false;
    const lines = value.split(/\r?\n/);
    const footer = lines.lastIndexOf('任务尚未全部完成：');
    if (
      footer >= 0 &&
      lines.slice(0, footer).filter(line => /^\s*```/.test(line)).length % 2 ===
        0 &&
      lines.slice(footer + 1).some(line => line.trim()) &&
      lines
        .slice(footer + 1)
        .every(
          line =>
            !line.trim() ||
            /^[\w.]+ 的目标：(?:已执行，待核对|执行失败|结果未知)\s*$/u.test(
              line.trim(),
            ),
        )
    ) {
      lines.splice(footer);
    }
    return lines
      .filter(line => {
        if (/^\s*```/.test(line)) {
          insideCode = !insideCode;
          return true;
        }
        return (
          insideCode ||
          !/视觉工具不可用|visual tool unavailable|我改用(?:文本|命令行|bash)/iu.test(
            line,
          )
        );
      })
      .join('\n')
      .trim();
  }

  function runMetaNode(meta: string): ChatNode {
    const root = h('div', {class: 'mp-chat-run-meta', role: 'status'});
    const mark = sparkMark(false);
    const copy = h('span', {class: 'mp-chat-run-meta-copy'});
    attach(copy, meta);
    attach(root, mark);
    attach(root, copy);
    return root;
  }

  function trajectoryFlowItems(turn: AssistantTurnInput): FlowItem[] | null {
    const records = Array.isArray(turn.trajectory) ? turn.trajectory : [];
    const usable = records
      .map((record, index) => ({record, index}))
      .filter(
        ({record}) =>
          record &&
          typeof record === 'object' &&
          (record.kind === 'message' ||
            record.kind === 'think' ||
            record.kind === 'notice' ||
            record.kind === 'tool'),
      );
    if (!usable.length) {
      return null;
    }
    const answerText = cleanDeliveryText(String(turn.answer || ''));
    const items: FlowItem[] = [];
    for (const {index, record} of usable) {
      const turn =
        record.turn === undefined || record.turn === null
          ? undefined
          : String(record.turn);
      const reasoning = trajectoryReasoning(record, index);
      if (reasoning) {
        items.push(reasoning);
      }
      if (record.kind === 'think') {
        continue;
      }
      if (record.kind === 'message') {
        const text = cleanDeliveryText(String(record.text || ''));
        if (!text || (answerText && text === answerText)) {
          continue;
        }
        items.push({
          type: 'narration',
          text,
          turn,
        });
        continue;
      }
      if (record.kind === 'notice') {
        const text = String(record.text || '').trim();
        if (text) {
          items.push({
            type: 'notice',
            text,
            ...(record.noticeType === 'compaction' ? {compaction: record} : {}),
          });
        }
        continue;
      }
      items.push({
        type: 'chip',
        chip: trajectoryChip(record, index, true),
        turn,
      });
    }
    return items;
  }

  function eventFlowItems(turn: AssistantTurnInput): FlowItem[] {
    const items: FlowItem[] = [];
    const events = Array.isArray(turn.events) ? turn.events : [];
    for (const event of events) {
      const argsRaw =
        typeof event.arguments === 'string'
          ? event.arguments
          : event.arguments !== undefined && event.arguments !== null
            ? JSON.stringify(event.arguments)
            : '';
      items.push({
        type: 'chip',
        chip: {
          name: String(event.name || event.tool || ''),
          argsRaw,
          callId: String(event.callId || event.id || ''),
          groupLabel:
            typeof event.groupLabel === 'string' ? event.groupLabel : undefined,
          displayLabel:
            typeof event.summary === 'string' ? event.summary : undefined,
          startedAtMs:
            Number(event.startedAt ?? event.at ?? event.time) || undefined,
          result:
            event.result !== undefined
              ? {
                  text: String(event.result || ''),
                  isError: Boolean(event.isError),
                  interrupted: event.interrupted === true,
                  presentation: event.presentation,
                }
              : undefined,
        },
        turn:
          event.turn === undefined || event.turn === null
            ? undefined
            : String(event.turn),
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
    const root = h('div', {class: 'mp-chat-assistant'});
    const bodyHost = h('div', {class: 'mp-chat-assistant-body'});

    if (
      turn.thinking &&
      !turn.trajectory?.some(
        record => record.reasoning || record.kind === 'think',
      )
    ) {
      attach(
        bodyHost,
        toolGroupNode(
          [],
          turn.running === true,
          [
            {
              type: 'reasoning',
              text: turn.thinking,
              id: 'head',
              running: turn.running === true,
            },
          ],
          turnScope,
          true,
        ),
      );
    }

    const flow = trajectoryFlowItems(turn) ?? eventFlowItems(turn);
    for (const item of flow) {
      if (item.type === 'chip') {
        item.chip.executionRoot = String(
          turn.request?.executionWorkspaceRoot || '',
        );
      }
    }
    let chipRun: TurnChip[] = [];
    let workRun: FlowItem[] = [];
    const fileRuns: Array<{callIds: string[]; bareEdit: boolean}> = [];
    const flushChips = () => {
      if (!chipRun.length) {
        const hasReasoning = workRun.some(entry => entry.type === 'reasoning');
        if (hasReasoning) {
          // A reasoning-only run still renders as a card, never as loose text.
          attach(bodyHost, toolGroupNode([], false, workRun, turnScope, true));
        } else {
          workRun
            .filter(
              (entry): entry is Extract<FlowItem, {type: 'narration'}> =>
                entry.type === 'narration',
            )
            .forEach(entry => attach(bodyHost, narrationNode(entry.text)));
        }
        workRun = [];
        return;
      }
      attach(bodyHost, toolGroupNode(chipRun, false, workRun, turnScope));
      const chip = chipRun[0];
      fileRuns.push({
        callIds: chipRun.map(chip => chip.callId),
        bareEdit:
          singleToolGroup(chipRun, workRun) &&
          FILE_WRITE_TOOLS.has(chip.name) &&
          Boolean(deriveFilePath(classifyTool(chip.name), chip.argsRaw)),
      });
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
        // A thought is a row in the same card as the tools around it.
        workRun.push(item);
      } else if (item.type === 'narration') {
        flushChips();
        attach(bodyHost, narrationNode(item.text));
      } else if (item.type === 'notice') {
        flushChips();
        attach(
          bodyHost,
          item.compaction
            ? compactionNode(item.compaction)
            : noticeNode(item.text),
        );
      } else {
        chipRun.push(item.chip);
        workRun.push(item);
      }
    }
    flushChips();

    const records = Array.isArray(turn.trajectory) ? turn.trajectory : [];
    const times = records
      .map(record => Number(record.startedAt) || 0)
      .filter(value => value > 0);
    const doneTimes = records
      .map(record => Number(record.completedAt) || 0)
      .filter(value => value > 0);
    const totalTokens = Number(turn.modelUsage?.totalTokens) || 0;
    const deliveryText = cleanDeliveryText(String(turn.answer || ''));
    if (deliveryText) {
      attach(bodyHost, deliveryNode(deliveryText));
    }

    // A turn waiting on the user has not finished; its footer comes with the reply.
    const timingMs = Number(turn.timingMs) || 0;
    if (
      !turn.pendingInput &&
      (timingMs > 0 || (times.length && doneTimes.length))
    ) {
      const elapsed =
        timingMs > 0
          ? timingMs
          : Math.max(0, Math.max(...doneTimes) - Math.min(...times));
      attach(
        bodyHost,
        runMetaNode(formatRunMeta(elapsed, totalTokens || null)),
      );
    }

    if (turn.failed) {
      attach(bodyHost, turnErrorNode(turn.error || lt('chat.turn_failed')));
    }

    if (turn.running && !turn.answer && !turn.thinking) {
      attach(bodyHost, turnStatusNode('Thinking'));
    }

    attach(root, bodyHost);
    if (deliveryText) {
      attach(
        root,
        messageActions(
          deliveryText,
          turn.conversationId && Number.isInteger(turn.turnIndex)
            ? {
                conversationId: turn.conversationId,
                turnIndex: Number(turn.turnIndex),
              }
            : undefined,
          turn.at,
          {align: 'assistant'},
        ),
      );
    }
    const artifacts = Array.isArray(turn.artifacts) ? turn.artifacts : [];
    const hasArtifact = artifacts.some(artifact => Boolean(artifact?.artifactId));
    const files = deliveredFiles(
      turn.trajectory,
      String(turn.request?.executionWorkspaceRoot || ''),
    );
    const editRuns =
      files.length === 1
        ? fileRuns.filter(run =>
            run.callIds.some(id => files[0].sourceCalls.has(id)),
          )
        : [];
    const soleVisibleEdit =
      files.length === 1 && editRuns.length === 1 && editRuns[0].bareEdit;
    const results = fileResultsNode(
      soleVisibleEdit && !hasArtifact ? [] : files,
      artifacts,
      String(turn.conversationId || ''),
      turnScope,
      options.undoFileChanges && !turn.running && !turn.pendingInput &&
      turn.conversationId && Number.isInteger(turn.turnIndex)
        ? {conversationId: turn.conversationId, turnIndex: Number(turn.turnIndex)}
        : undefined,
    );
    if (results) {
      attach(root, results);
    }
    items.push(root);
    return items;
  }

  function fileUndoQuestion(turn: AssistantTurnInput): string | undefined {
    if (turn.artifacts?.some(artifact => Boolean(artifact?.artifactId))) {
      return undefined;
    }
    const files = deliveredFiles(
      turn.trajectory,
      String(turn.request?.executionWorkspaceRoot || ''),
    );
    const paths = files.map(file => `\`${file.path}\``);
    if (!paths.length) {
      return undefined;
    }
    return paths.length === 1
      ? `Undo the changes you made to ${paths[0]} in your last turn and restore it to its previous state.`
      : [
          `Undo the changes you made to these ${paths.length} files in your last turn and restore them to their previous state:`,
          ...paths.map(path => `- ${path}`),
        ].join('\n');
  }

  function liveActivityNode(
    record: Record<string, unknown>,
    scope = '',
    options: TurnPresentation = {},
  ): ChatNode {
    const phase = String(record.phase || '');
    const fields =
      record.fields && typeof record.fields === 'object'
        ? (record.fields as Record<string, unknown>)
        : {};
    if (phase === 'tool_call' || phase === 'tool_result') {
      const name = String(fields.name || 'tool');
      const done = phase === 'tool_result';
      const argsRaw = String(fields.args || '');
      if (options.taskPanel && PLAN_TOOLS.has(name)) {
        return noticeNode(String(fields.result || 'Plan update failed'));
      }
      if (options.taskPanel && SUBAGENT_TOOLS.has(name)) {
        return subagentEntryNode(
          {
            name,
            argsRaw,
            callId: String(fields.id || ''),
            result: done
              ? {
                  text: String(fields.result || ''),
                  isError: fields.state === 'error',
                }
              : undefined,
          },
          scope,
        );
      }
      const latencyMs = Number(fields.latency_ms);
      const detail = done
        ? [
            fields.backend && fields.backend !== '-'
              ? String(fields.backend)
              : '',
            Number.isFinite(latencyMs) && latencyMs >= 1
              ? `${Math.round(latencyMs)}ms`
              : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : '';
      return toolRowNode(
        toolRowModel(
          name,
          argsRaw,
          done
            ? {
                text:
                  fields.result !== undefined ? String(fields.result) : detail,
                isError: fields.state === 'error',
                presentation: fields.presentation,
              }
            : undefined,
          String(fields.id || ''),
        ),
        scope,
      );
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

  function createLiveTurn(
    host: HTMLElement,
    scope = `live-${++liveTurnSequence}`,
    options: TurnPresentation = {},
  ) {
    const rows = new Map<string, {node: HTMLElement; record: string}>();
    let answer: HTMLElement | null = null;
    let thinking: HTMLElement | null = null;
    let thinkingText = '';
    // Claude's duration comes from the pair of timestamps on the thinking
    // block; the live snapshot carries none, so the span this row observed is
    // the clock instead of a fabricated number.
    let thinkingStartedAt = 0;
    const traceNodes = new Map<
      string,
      {node: HTMLElement; signature: string}
    >();
    let traceStatus: HTMLElement | null = null;
    const appendText = (node: HTMLElement, previous: string, next: string) => {
      if (previous === next) {
        return;
      }
      if (next.startsWith(previous)) {
        node.appendChild(document.createTextNode(next.slice(previous.length)));
        if (node.childNodes.length > 32) {
          node.textContent = next;
        }
      } else {
        node.textContent = next;
      }
    };
    const updateLiveMarkdown = (node: HTMLElement, text: string) => {
      const next = markdownRenderer.render(text) as HTMLElement;
      const current = node.querySelector<HTMLElement>('.mp-chat-markdown');
      if (!current) {
        node.replaceChildren(next);
        globalThis.OpenUIHost?.sync(node, scope, true);
        return;
      }
      const blocks = Array.from(next.childNodes);
      blocks.forEach((block, index) => {
        const existing = current.childNodes[index];
        if (!existing) {
          current.appendChild(block);
        } else if (
          existing instanceof HTMLElement &&
          block instanceof HTMLElement &&
          existing.hasAttribute('data-openui-source') &&
          block.hasAttribute('data-openui-source')
        ) {
          existing.dataset.openuiSource = block.dataset.openuiSource;
          existing.dataset.openuiComplete = block.dataset.openuiComplete;
        } else {
          const existingMarkup =
            (existing as Element).outerHTML ?? existing.textContent;
          const nextMarkup = (block as Element).outerHTML ?? block.textContent;
          if (
            existing.nodeType !== block.nodeType ||
            existingMarkup !== nextMarkup
          ) {
            current.insertBefore(block, existing);
            if (existing instanceof HTMLElement) {
              globalThis.OpenUIHost?.dispose(existing);
            }
            existing.remove();
          }
        }
      });
      while (current.childNodes.length > blocks.length) {
        const last = current.lastChild;
        if (last instanceof HTMLElement) {
          globalThis.OpenUIHost?.dispose(last);
        }
        last?.remove();
      }
      globalThis.OpenUIHost?.sync(node, scope, true);
    };
    const liveMarkdownNode = (text: string) => {
      const node = document.createElement('div');
      node.className = 'mp-chat-stream-live';
      updateLiveMarkdown(node, text);
      return node;
    };
    return {
      update(snapshot: LiveTurnSnapshot) {
        if (!host.className.split(' ').includes('mp-chat-live-turn')) {
          host.className += ' mp-chat-live-turn';
        }
        if (snapshot.trajectory?.length) {
          const desired: HTMLElement[] = [];
          const render = (
            key: string,
            value: unknown,
            make: () => ChatNode,
          ) => {
            const signature = JSON.stringify(value);
            let entry = traceNodes.get(key);
            if (!entry) {
              entry = {node: make() as HTMLElement, signature};
              traceNodes.set(key, entry);
            } else if (entry.signature !== signature) {
              if (key.startsWith('message:')) {
                updateLiveMarkdown(entry.node, String(value));
              } else if (key.startsWith('thought:')) {
                const currentThought =
                  entry.node.querySelector<HTMLElement>('.mp-chat-think');
                const nextWork = (value as {work?: FlowItem[]}).work?.find(
                  (item): item is Extract<FlowItem, {type: 'reasoning'}> =>
                    item.type === 'reasoning',
                );
                if (currentThought && nextWork) {
                  const target = currentThought.querySelector<HTMLElement>(
                    '.mp-chat-think-body',
                  );
                  if (target) {
                    appendText(target, target.textContent || '', nextWork.text);
                  }
                  updateThinkingState(
                    currentThought,
                    nextWork.text,
                    nextWork.running === true,
                  );
                } else {
                  const replacement = make() as HTMLElement;
                  entry.node.replaceChildren(
                    ...Array.from(replacement.childNodes),
                  );
                }
              } else {
                const replacement = make() as HTMLElement;
                entry.node.replaceChildren(
                  ...Array.from(replacement.childNodes),
                );
                for (const attribute of [
                  'data-state',
                  'data-single',
                  'data-thought-only',
                  'data-error-title',
                  'aria-live',
                ]) {
                  const value = replacement.getAttribute(attribute);
                  if (value === null) {
                    entry.node.removeAttribute(attribute);
                  } else {
                    entry.node.setAttribute(attribute, value);
                  }
                }
              }
              entry.signature = signature;
            }
            desired.push(entry.node);
          };
          let chips: TurnChip[] = [];
          let work: FlowItem[] = [];
          let workTurn: string | undefined;
          let runSequence = 0;
          const flush = () => {
            if (!chips.length && !work.length) {
              return;
            }
            const current = chips;
            const currentWork = work;
            const key = current.length
              ? `tools:${current[0].callId || workTurn || ++runSequence}`
              : `thought:${workTurn || ++runSequence}`;
            const hasReasoning = currentWork.some(
              item => item.type === 'reasoning',
            );
            if (current.length || hasReasoning) {
              render(key, {chips: current, work: currentWork}, () =>
                toolGroupNode(
                  current,
                  true,
                  currentWork,
                  scope,
                  !current.length,
                ),
              );
            } else {
              currentWork
                .filter(
                  (item): item is Extract<FlowItem, {type: 'narration'}> =>
                    item.type === 'narration',
                )
                .forEach((item, index) =>
                  render(
                    `message:${workTurn || runSequence}:${index}`,
                    item.text,
                    () => liveMarkdownNode(item.text),
                  ),
                );
            }
            chips = [];
            work = [];
            workTurn = undefined;
          };
          snapshot.trajectory.forEach((record, index) => {
            const turn =
              record.turn === undefined || record.turn === null
                ? undefined
                : String(record.turn);
            if (turn !== undefined && workTurn === undefined) {
              workTurn = turn;
            }
            if (record.kind === 'tool') {
              if (options.taskPanel && PLAN_TOOLS.has(String(record.name))) {
                if (record.isError) {
                  flush();
                  render(
                    `plan-error:${record.callId || index}`,
                    record.result,
                    () =>
                      noticeNode(String(record.result || 'Plan update failed')),
                  );
                }
                return;
              }
              const chip = trajectoryChip(record, index, false);
              if (SUBAGENT_TOOLS.has(chip.name)) {
                flush();
                const key = `agent:${chip.callId}`;
                if (options.taskPanel) {
                  chip.subagent = {
                    status: (
                      record.subagent as Record<string, unknown> | undefined
                    )?.status,
                  };
                  render(key, chip, () => subagentEntryNode(chip, scope));
                  return;
                }
                render(key, {...chip, subagent: undefined}, () =>
                  chipNode(chip, scope),
                );
                const child = record.subagent as
                  Record<string, unknown> | undefined;
                const heartbeat = traceNodes
                  .get(key)!
                  .node.querySelector('.mp-chat-subagent-heartbeat')!;
                const text = subagentHeartbeat(child);
                if (heartbeat.textContent !== text) {
                  heartbeat.textContent = text;
                }
              } else {
                chips.push(chip);
                work.push({type: 'chip', chip, turn});
              }
            } else if (record.kind === 'message' || record.kind === 'think') {
              if (!record.text && !record.reasoning) {
                return;
              }
              const reasoning = trajectoryReasoning(record, index);
              if (reasoning) {
                work.push(reasoning);
              }
              if (record.kind === 'message' && record.text) {
                flush();
                render(`message:${record.seq ?? index}`, record.text, () =>
                  liveMarkdownNode(String(record.text)),
                );
              }
            } else if (record.kind === 'notice') {
              flush();
              if (record.noticeType === 'compaction') {
                const signature = {
                  state: record.state,
                  pass: record.pass,
                  chunk: record.chunk,
                  chunks: record.chunks,
                  error: record.error,
                  beforeTokens: record.beforeTokens,
                  afterTokens: record.afterTokens,
                  language: document.documentElement.lang,
                };
                render(`compaction:${record.compactionId}`, signature, () =>
                  compactionNode(record, true),
                );
              } else {
                render(`notice:${index}`, record, () =>
                  noticeNode(String(record.text || '')),
                );
              }
            }
          });
          flush();
          if (!traceStatus) {
            traceStatus = turnStatusNode('Thinking') as HTMLElement;
          }
          const activeChildren = snapshot.trajectory.filter(
            r =>
              r.kind === 'tool' &&
              SUBAGENT_TOOLS.has(String(r.name)) &&
              r.state === 'running',
          ).length;
          const activeTools = snapshot.trajectory.filter(
            r => r.kind === 'tool' && r.state === 'running',
          ).length;
          const activeReview = [...snapshot.trajectory]
            .reverse()
            .find(
              row =>
                row.kind === 'permission-review' && row.state === 'running',
            );
          const activeCompaction = [...snapshot.trajectory]
            .reverse()
            .find(
              row => row.noticeType === 'compaction' && row.state === 'running',
            );
          const latestRecord = snapshot.trajectory.at(-1);
          const compactionSettled =
            latestRecord?.noticeType === 'compaction' &&
            latestRecord.state !== 'running' &&
            !activeReview &&
            !activeTools &&
            !snapshot.trajectory.some(
              row => row.kind === 'message' && row.state === 'running',
            );
          const statusText = activeCompaction
            ? compaction.compactionLabel(
                activeCompaction,
                document.documentElement.lang || 'en',
              )
            : activeReview
              ? liveStatusLabel('permission_review_started', {
                  name: activeReview.name,
                })
              : activeChildren
                ? `${activeChildren} subagent${activeChildren === 1 ? '' : 's'} working`
                : activeTools
                  ? 'Running tools'
                  : snapshot.answer
                    ? 'Writing'
                    : 'Thinking';
          const statusLabel = traceStatus.querySelector(
            '.mp-chat-turn-status-label',
          );
          if (statusLabel && statusLabel.textContent !== statusText) {
            statusLabel.textContent = statusText;
          }
          statusLabel?.setAttribute(
            'data-quiet',
            String(statusText === 'Thinking'),
          );
          traceStatus.setAttribute('aria-label', statusText);
          traceStatus.setAttribute(
            'aria-live',
            activeCompaction ? 'off' : 'polite',
          );
          if (!activeCompaction && !compactionSettled) {
            desired.push(traceStatus);
          }
          for (const child of Array.from(host.children)) {
            if (!desired.includes(child as HTMLElement)) {
              child.remove();
            }
          }
          desired.forEach((node, index) => {
            if (host.children[index] !== node) {
              host.insertBefore(node, host.children[index] || null);
            }
          });
          return;
        }
        const latest = new Map<string, Record<string, unknown>>();
        for (const record of snapshot.records || []) {
          const phase = String(record.phase || '');
          const fields =
            record.fields && typeof record.fields === 'object'
              ? (record.fields as Record<string, unknown>)
              : {};
          if (phase === 'tool_call' || phase === 'tool_result') {
            if (
              options.taskPanel &&
              PLAN_TOOLS.has(String(fields.name)) &&
              fields.state !== 'error'
            ) {
              continue;
            }
            latest.set(
              `tool:${String(fields.id || fields.name || '')}`,
              record,
            );
          } else if (
            [
              'model_request',
              'model_response',
              'model_first_chunk',
              'runtime_boot',
              'agent_turn',
              'agent_start',
              'budget_renewed',
              'permission_review_started',
              'permission_review_finished',
            ].includes(phase)
          ) {
            latest.set('status', record);
          }
        }
        if (!latest.has('status')) {
          latest.set('status', {phase: 'model_request', fields: {}});
        }
        const desired: HTMLElement[] = [];
        for (const [key, record] of latest) {
          const signature = JSON.stringify(record);
          let row = rows.get(key);
          if (!row) {
            row = {
              node: liveActivityNode(record, scope, options) as HTMLElement,
              record: signature,
            };
            rows.set(key, row);
          } else if (row.record !== signature) {
            if (key === 'status') {
              const label = liveStatusLabel(
                String(record.phase || ''),
                (record.fields || {}) as Record<string, unknown>,
              );
              const copy = row.node.querySelector('.mp-chat-turn-status-label');
              if (copy && copy.textContent !== label) {
                copy.textContent = label;
              }
              copy?.setAttribute('data-quiet', String(label === 'Thinking'));
              row.node.setAttribute('aria-label', label);
            } else {
              const replacement = liveActivityNode(
                record,
                scope,
                options,
              ) as HTMLElement;
              row.node.setAttribute(
                'data-state',
                replacement.getAttribute('data-state') || 'running',
              );
              row.node.replaceChildren(...Array.from(replacement.childNodes));
            }
            row.record = signature;
          }
          desired.push(row.node);
        }
        const nextThinking = String(snapshot.thinking || '');
        if (nextThinking) {
          if (!thinking) {
            thinking = thinkNode('', true, `${scope}:head`) as HTMLElement;
          }
          if (!thinkingStartedAt) {
            thinkingStartedAt = Date.now();
          }
          const body = thinking.querySelector<HTMLElement>(
            '.mp-chat-think-body',
          )!;
          appendText(body, thinkingText, nextThinking);
          const summary = thinking.querySelector('.mp-chat-summary')!;
          const derived = latestLine(nextThinking);
          const latestSummary =
            derived.trim() === ''
              ? 'Thinking'
              : stripTrailingPunctuation(derived);
          if (summary.textContent !== latestSummary) {
            summary.textContent = latestSummary;
          }
          thinkingText = nextThinking;
          updateThinkingState(
            thinking,
            nextThinking,
            !snapshot.answer,
            Date.now() - thinkingStartedAt,
          );
          desired.push(thinking);
        }
        const nextAnswer = String(snapshot.answer || '');
        if (nextAnswer) {
          if (!answer) {
            answer = liveMarkdownNode('');
            answer.setAttribute('aria-live', 'polite');
          }
          updateLiveMarkdown(answer, nextAnswer);
          desired.push(answer);
        }
        for (const child of Array.from(host.children)) {
          if (!desired.includes(child as HTMLElement)) {
            child.remove();
          }
        }
        desired.forEach((node, index) => {
          if (host.children[index] !== node) {
            host.insertBefore(node, host.children[index] || null);
          }
        });
      },
      finish(turn: AssistantTurnInput) {
        host.className = host.className
          .split(' ')
          .filter(name => name !== 'mp-chat-live-turn')
          .join(' ');
        globalThis.OpenUIHost?.dispose(host);
        host.replaceChildren(
          ...(assistantTurnNode(turn, scope, options) as HTMLElement[]),
        );
        globalThis.OpenUIHost?.sync(host, scope, false);
      },
    };
  }

  function createConversationView(flow: HTMLElement) {
    const turns = new Map<
      number,
      {
        host: HTMLElement;
        live: ReturnType<typeof createLiveTurn>;
        final: string | null;
        presentation: TurnPresentation;
      }
    >();
    return {
      update(conversation: {
        id: string;
        agentSessionId?: string;
        hasPendingWork?: boolean;
        turns?: Array<
          AssistantTurnInput & {
            question?: string;
            outcome?: string;
            liveProgress?: LiveTurnSnapshot;
            permissionAnswer?: {decision?: string; rule?: string};
          }
        >;
      }) {
        const undoFileChanges = Boolean(conversation.agentSessionId) &&
          !conversation.hasPendingWork &&
          !conversation.turns?.some(item => item.liveProgress || item.outcome === '进行中');
        for (const [turnIndex, turn] of (conversation.turns || []).entries()) {
          let current = turns.get(turnIndex);
          if (!current) {
            if (turn.permissionAnswer) {
              flow.appendChild(
                permissionAnswerNode(turn.permissionAnswer) as HTMLElement,
              );
            } else if (turn.question) {
              flow.appendChild(
                userNode(turn.question, turn.at, {
                  conversationId: conversation.id,
                  turnIndex,
                }) as HTMLElement,
              );
            }
            const host = document.createElement('div');
            host.className = 'mp-chat-flow-item';
            host.dataset.turnIndex = String(turnIndex);
            flow.appendChild(host);
            const presentation: TurnPresentation = {taskPanel: true, undoFileChanges};
            current = {
              host,
              live: createLiveTurn(host, `${conversation.id}#${turnIndex}`, presentation),
              final: null,
              presentation,
            };
            turns.set(turnIndex, current);
          }
          current.presentation.undoFileChanges = undoFileChanges;
          if (turn.liveProgress || turn.outcome === '进行中') {
            current.live.update(
              turn.liveProgress || {
                answer: turn.answer,
                thinking: turn.thinking,
              },
            );
            current.final = null;
          } else {
            const signature = JSON.stringify([turn, undoFileChanges]);
            if (signature !== current.final) {
              current.live.finish({
                ...turn,
                conversationId: conversation.id,
                turnIndex,
              });
            }
            current.final = signature;
          }
        }
      },
    };
  }

  function liveStatusLabel(
    phase: string,
    fields: Record<string, unknown>,
  ): string {
    const turn = String(fields.turn || '');
    const labels: Record<string, string> = {
      runtime_boot: lt('phase.runtime_boot'),
      runtime_ready: lt('phase.runtime_ready'),
      session_ready: lt('phase.session_ready'),
      agent_start: lt('phase.agent_start'),
      agent_turn: turn ? lt('phase.agent_turn', {turn}) : lt('phase.reasoning'),
      model_request: turn
        ? lt('phase.agent_turn', {turn})
        : lt('phase.reasoning'),
      model_first_chunk: lt('phase.model_first_chunk'),
      model_response: lt('phase.model_response'),
      budget_renewed: lt('phase.budget_renewed'),
      permission_review_started: lt('phase.review_started', {
        name: String(fields.name || lt('phase.review_default_target')),
      }),
      permission_review_finished: lt('phase.review_finished'),
      total: lt('phase.total'),
    };
    if (labels[phase]) {
      return labels[phase];
    }
    const normalized = phase.replace(/[_-]turn[=_]\d+$/i, '');
    if (labels[normalized]) {
      const embedded = /turn[=_](\d+)$/i.exec(phase);
      return embedded
        ? lt('phase.agent_turn', {turn: embedded[1]})
        : labels[normalized];
    }
    return phase || lt('phase.fallback');
  }

  function toggleDisclosure(act: HTMLElement): void {
    const row = act.closest<HTMLElement>('.mp-chat-row');
    const disclosure = act.closest<HTMLElement>('.mp-chat-disclosure');
    if (!row || !disclosure) {
      return;
    }
    const open = disclosure.getAttribute('data-open') === 'true';
    disclosure.setAttribute('data-open', open ? 'false' : 'true');
    row.setAttribute('aria-expanded', open ? 'false' : 'true');
    if (!open) {
      disclosure.querySelectorAll<HTMLElement>('[data-mp-chat-act="load-file-diff"]')
        .forEach(button => { void loadFileDiff(button); });
    }
    const rowId = disclosure.getAttribute('data-row-id');
    if (rowId) {
      rememberExpansion(ROW_EXPANSION, rowId, !open);
    }
  }

  function rememberGroupToggle(event: Event): void {
    const target = event.target as HTMLElement | null;
    if (
      !target ||
      !target.classList ||
      !target.classList.contains('mp-chat-tool-group')
    ) {
      return;
    }
    const summary = target.querySelector(':scope > .mp-chat-tool-group-header');
    if (target.hasAttribute('open')) {
      target.querySelectorAll<HTMLElement>('[data-mp-chat-act="load-file-diff"]')
        .forEach(button => {
          if (button.closest('.mp-chat-disclosure')?.getAttribute('data-open') === 'true') {
            void loadFileDiff(button);
          }
        });
    }
    const groupId = summary?.getAttribute('data-group-id');
    if (!groupId) {
      return;
    }
    rememberGroupExpansion(groupId, target.hasAttribute('open'));
    summary?.setAttribute(
      'aria-expanded',
      target.hasAttribute('open') ? 'true' : 'false',
    );
  }

  function copyToClipboard(text: string): Promise<boolean> {
    if (
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      return navigator.clipboard.writeText(text).then(
        () => true,
        () => fallbackCopyText(text),
      );
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

  function openChatImage(source: HTMLImageElement): void {
    if (!DOC || !source.src) {
      return;
    }
    DOC.querySelector<HTMLDialogElement>('.mp-chat-image-viewer')?.close();
    const viewer = DOC.createElement('dialog');
    viewer.className = 'mp-chat-image-viewer';
    viewer.setAttribute('aria-label', source.alt || lt('chat.image_preview'));
    const toolbar = DOC.createElement('div');
    toolbar.className = 'mp-chat-image-toolbar';
    const caption = DOC.createElement('span');
    caption.textContent = source.alt || lt('chat.image_preview');
    const close = DOC.createElement('button');
    close.type = 'button';
    close.textContent = lt('common.close');
    toolbar.append(caption, close);
    const viewport = DOC.createElement('div');
    viewport.className = 'mp-chat-image-viewport';
    const image = DOC.createElement('img');
    image.src = source.currentSrc || source.src;
    image.alt = source.alt;
    image.title = lt('chat.image_original_size');
    viewport.append(image);
    viewer.append(toolbar, viewport);
    close.addEventListener('click', () => viewer.close());
    viewer.addEventListener('click', event => {
      if (event.target === viewer) {
        viewer.close();
      }
    });
    image.addEventListener('click', () => {
      viewport.classList.toggle('is-original');
    });
    viewer.addEventListener(
      'close',
      () => {
        viewer.remove();
        if (source.isConnected) {
          source.focus();
        }
      },
      {once: true},
    );
    DOC.body.append(viewer);
    viewer.showModal();
  }

  function bindDelegation(
    scope: Element | Document = DOC || ({} as Element),
  ): void {
    if (!DOC) {
      return;
    }
    const host = scope as Document;
    if ((host as unknown as {__mpChatBound?: boolean}).__mpChatBound) {
      return;
    }
    (host as unknown as {__mpChatBound?: boolean}).__mpChatBound = true;
    host.addEventListener('toggle', rememberGroupToggle, true);
    host.addEventListener('mousedown', (event: MouseEvent) => {
      if (
        (event.target as Element | null)?.closest('.mp-chat-diff-copy') ||
        (event.target as Element | null)?.closest('.mp-chat-think-copy')
      ) {
        event.preventDefault();
      }
    });
    host.addEventListener('click', (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }
      const act = target.closest<HTMLElement>('[data-mp-chat-act]');
      if (!act) {
        return;
      }
      const kind = act.getAttribute('data-mp-chat-act');
      if (kind === 'toggle-files') {
        const more = act.closest('.mp-chat-files-more');
        const rest = more?.querySelector('.mp-chat-files-more-list');
        const label = more?.querySelector('.mp-chat-files-more-label');
        if (!rest || !label) {
          return;
        }
        const expanded = act.getAttribute('aria-expanded') !== 'true';
        if (expanded) {
          rest.removeAttribute('hidden');
        } else {
          rest.setAttribute('hidden', 'true');
        }
        act.setAttribute('aria-expanded', String(expanded));
        label.textContent = expanded ? lt('chat.files_show_less')
          : act.getAttribute('data-files-collapsed-label') || '';
        rememberExpansion(ROW_EXPANSION, act.getAttribute('data-files-expansion-key') || '', expanded);
        return;
      }
      if (kind === 'view-image' && act instanceof HTMLImageElement) {
        event.preventDefault();
        openChatImage(act);
      } else if (kind === 'load-file-diff') {
        void loadFileDiff(act);
      } else if (kind === 'toggle') {
        toggleDisclosure(act);
      } else if (kind === 'open-subagent') {
        const parentCallId =
          act.getAttribute('data-subagent-parent-call-id') || '';
        if (!parentCallId) {
          return;
        }
        DOC.dispatchEvent(
          new CustomEvent('mp:open-subagent', {
            detail: {parentCallId},
          }),
        );
      } else if (kind === 'copy' || kind === 'copy-thinking') {
        const thinkingCopy = kind === 'copy-thinking';
        const text = thinkingCopy
          ? thinkingQuote(
              act.closest('.mp-chat-think')?.querySelector('.mp-chat-think-body')
                ?.textContent || '',
            ).trim()
          : act.getAttribute('data-mp-chat-copy') || '';
        const button = act;
        const diffCopy = button.getAttribute('class')?.split(' ').includes('mp-chat-diff-copy');
        const previous = COPY_RESET_TIMERS.get(button);
        if (previous !== undefined) {
          window.clearTimeout(previous);
          COPY_RESET_TIMERS.delete(button);
        }
        void copyToClipboard(text).then((ok: boolean) => {
          if (button.isConnected === false) {
            return;
          }
          const glyph =
            button.querySelector('.mp-chat-diff-copy-glyph') ||
            button.querySelector('.mp-chat-think-copy-glyph');
          if (glyph) {
            glyph.setAttribute('data-glyph', ok ? '\ue03b' : '\ue056');
          } else {
            button.querySelector('svg')?.remove();
            button.appendChild(icon(ok ? 'check' : 'copy', 16) as Element);
          }
          if (!ok) {
            button.setAttribute('aria-label', lt('chat.copy_failed'));
          } else if (diffCopy || thinkingCopy) {
            button.setAttribute('aria-label', lt('chat.copied'));
          }
          const timer = window.setTimeout(() => {
            COPY_RESET_TIMERS.delete(button);
            if (button.isConnected === false) {
              return;
            }
            const glyph =
              button.querySelector('.mp-chat-diff-copy-glyph') ||
              button.querySelector('.mp-chat-think-copy-glyph');
            if (glyph) {
              glyph.setAttribute('data-glyph', '\ue056');
            } else {
              button.querySelector('svg')?.remove();
              button.appendChild(icon('copy', 16) as Element);
            }
            button.setAttribute(
              'aria-label',
              lt(thinkingCopy ? 'chat.copy_as_quote' : 'chat.copy'),
            );
          }, diffCopy ? 1200 : 2000);
          COPY_RESET_TIMERS.set(button, timer);
        });
      } else if (kind === 'retry') {
        const question = act.getAttribute('data-mp-chat-retry') || '';
        if (!question) {
          return;
        }
        DOC.dispatchEvent(
          new CustomEvent('mp:retry-question', {detail: {question}}),
        );
      } else if (kind === 'undo-files') {
        event.preventDefault();
        event.stopPropagation();
        if (act.dataset.undoPending === 'true') {
          return;
        }
        const conversationId = act.getAttribute('data-undo-conversation') || '';
        const turnIndex = Number(act.getAttribute('data-undo-turn'));
        if (!conversationId || !Number.isInteger(turnIndex) || turnIndex < 0) {
          return;
        }
        act.dataset.undoPending = 'true';
        (act as HTMLButtonElement).disabled = true;
        const card = act.closest('.mp-chat-files');
        card?.querySelector('.mp-chat-files-error')?.remove();
        DOC.dispatchEvent(new CustomEvent('mp:undo-file-changes', {
          detail: {
            conversationId,
            turnIndex,
            respond: (result: {ok: boolean; error?: string}) => {
              if (act.isConnected === false) {
                return;
              }
              act.dataset.undoPending = 'false';
              (act as HTMLButtonElement).disabled = false;
              if (!result.ok) {
                const error = DOC.createElement('span');
                error.className = 'mp-chat-files-error';
                error.setAttribute('role', 'alert');
                error.textContent = result.error || lt('chat.files_undo_failed');
                card?.appendChild(error);
              }
            },
          },
        }));
      } else if (kind === 'open-artifact') {
        const artifactId = act.getAttribute('data-artifact-id') || '';
        const conversationId =
          act.getAttribute('data-artifact-conversation') || '';
        if (!artifactId) {
          return;
        }
        DOC.dispatchEvent(
          new CustomEvent('mp:open-artifact', {
            detail: {artifactId, conversationId},
          }),
        );
      } else if (kind === 'open-file') {
        event.preventDefault();
        event.stopPropagation();
        const path = act.getAttribute('data-file-path') || '';
        if (!path) {
          return;
        }
        const previewPath = act.getAttribute('data-preview-path') || '';
        const absolutePath = act.getAttribute('data-file-absolute-path') || '';
        const originUnknown =
          act.getAttribute('data-file-origin-unknown') === 'true';
        const reference = act.getAttribute('data-file-open-diff');
        DOC.dispatchEvent(
          new CustomEvent('mp:open-file', {
            detail: {
              path,
              ...(absolutePath ? {absolutePath} : {}),
              ...(previewPath ? {previewPath} : {}),
              ...(originUnknown ? {originUnknown} : {}),
              ...(reference ? {diffReference: JSON.parse(reference)} : {}),
            },
          }),
        );
      } else if (kind === 'branch') {
        const conversationId =
          act.getAttribute('data-mp-chat-branch-conversation') || '';
        const turnIndex = Number(act.getAttribute('data-mp-chat-branch-turn'));
        if (!conversationId || !Number.isInteger(turnIndex)) {
          return;
        }
        DOC.dispatchEvent(
          new CustomEvent('mp:branch-conversation', {
            detail: {conversationId, turnIndex},
          }),
        );
      }
    });
    host.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      if (
        event.repeat &&
        ((event.target as Element | null)?.closest('.mp-chat-diff-copy') ||
          (event.target as Element | null)?.closest('.mp-chat-think-copy'))
      ) {
        event.preventDefault();
        return;
      }
      if (
        (event.target as Element | null)?.closest('button, a, input, textarea, select')
      ) {
        return;
      }
      const row = (event.target as HTMLElement | null)?.closest?.(
        '.mp-chat-row[data-mp-chat-act], img[data-mp-chat-act="view-image"]',
      ) as HTMLElement | null;
      if (!row) {
        return;
      }
      event.preventDefault();
      if (row.dataset.mpChatAct === 'toggle') {
        toggleDisclosure(row);
      } else {
        row.click();
      }
    });
  }

  return {
    userNode,
    assistantTurnNode,
    artifactCardNode,
    fileDiffNode,
    fileUndoQuestion,
    deletedFileNode,
    turnStatusNode,
    turnErrorNode,
    thinkNode,
    toolRowModel,
    toolRowNode,
    liveActivityNode,
    createLiveTurn,
    createConversationView,
    permissionAnswerNode,
    formatRunMeta,
    stateDot,
    bindDelegation,
    expansion: {
      row: (id: string) => ROW_EXPANSION.get(id),
      setRow: (id: string, open: boolean) =>
        rememberExpansion(ROW_EXPANSION, id, open),
      group: (id: string) => GROUP_EXPANSION.get(id)?.open,
      setGroup: (id: string, open: boolean) => rememberGroupExpansion(id, open),
      clear: () => {
        ROW_EXPANSION.clear();
        GROUP_EXPANSION.clear();
      },
    },
    __test: {
      thinkingQuote,
      firstLine,
      latestLine,
      classifyTool,
      deriveSummary,
      deriveDiff,
      diffPreviewNode,
      formatClock,
      relativeTime,
      toolGroupLabel,
      normaliseToolName,
      toolCategory,
      toolLabel,
      commandSummary,
      fileChangeMode,
      thinkingDuration,
      runningDuration,
      connectorDisplayName,
      shortenPath,
      webResults,
      outputRecord,
      webCountLabel,
    },
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ChatView;
}
