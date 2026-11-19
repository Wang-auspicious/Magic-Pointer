import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {buildSystemPrompt} from '../electron/runtime/agent';
import {modelPayload} from '../electron/runtime/model';
import {EventSession} from '../electron/runtime/session';
const {
  createConversationStore,
  sanitizeLearnAnchor,
} = require('../electron/conversation_store');
const ChatMarkdown = require('../electron/renderer/chat_markdown');

const REPO_ROOT = resolve(__dirname, '..');

test('Learn and Code use distinct task instructions on the same runtime', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'mp-learn-mode-'));
  const learn = await buildSystemPrompt({
    userDataDir,
    workspace: '',
    workMode: 'learn',
  } as Parameters<typeof buildSystemPrompt>[0]);
  const legacyWork = await buildSystemPrompt({
    userDataDir,
    workspace: '',
    workMode: 'work',
  } as Parameters<typeof buildSystemPrompt>[0]);
  const code = await buildSystemPrompt({
    userDataDir,
    workspace: '',
    workMode: 'code',
  } as Parameters<typeof buildSystemPrompt>[0]);
  assert.match(learn, /工作模式：Learn/);
  assert.match(learn, /短回合|3~6\s*句/);
  assert.match(learn, /Intelligence UI|:::ui/);
  assert.doesNotMatch(learn, /\bP0\b|\bP1\b|\bP2\b/);
  assert.doesNotMatch(learn, /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u);
  assert.equal(learn, legacyWork);
  assert.match(code, /工作模式：Code/);
  assert.notEqual(learn, code);
});

test('sanitizeLearnAnchor preserves valid non-negative integer blockIndex and ignores negative/NaN/float blockIndex', () => {
  assert.equal(typeof sanitizeLearnAnchor, 'function');

  const zero = sanitizeLearnAnchor({
    kind: 'term',
    label: 'σ-有限测度',
    snippet: 'σ-有限测度',
    blockIndex: 0,
  });
  assert.equal(zero.blockIndex, 0);

  const positive = sanitizeLearnAnchor({
    kind: 'card',
    label: '核心引理',
    snippet: '核心引理内容',
    blockIndex: 7,
  });
  assert.equal(positive.blockIndex, 7);

  for (const bad of [-1, -42, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2', null]) {
    const sanitized = sanitizeLearnAnchor({
      kind: 'selection',
      label: '片段',
      snippet: '片段正文',
      blockIndex: bad,
    });
    assert.equal(
      sanitized.blockIndex,
      undefined,
      `expected invalid blockIndex ${String(bad)} to be ignored`,
    );
    assert.equal(Object.hasOwn(sanitized, 'blockIndex'), false);
  }
});

test('conversation learn tree, highlights, dock, and promote survive reopen', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-learn-session-'));
  const store = createConversationStore({baseDir});
  const conversation = store.appendTurn({
    question: 'Prove Radon-Nikodym',
    workMode: 'learn',
    answer: 'Main proof',
  });
  const appended = store.appendBranchTurn({
    conversationId: conversation.id,
    parentBranchId: null,
    parentTurnIndex: 0,
    anchor: {
      kind: 'term',
      label: 'σ-有限测度',
      snippet: 'σ-有限测度',
      gloss: '可拆成可数个有限测度集之并',
      blockIndex: 2,
    },
    agentSessionId: 'agent-branch-1',
    forkMessageCount: 2,
    question: '为什么必须假设 σ-有限？',
  });
  assert.ok(appended);
  assert.equal(appended.branch.anchor.blockIndex, 2);
  store.updateBranchTurn({
    conversationId: conversation.id,
    branchId: appended.branch.id,
    turnIndex: 0,
    answer: '否则计数测度会给出反例。',
    outcome: '已完成',
    runtimeTurn: 2,
  });
  store.updateBranchMeta(conversation.id, appended.branch.id, {docked: true});
  store.toggleUserHighlight(conversation.id, {
    branchId: null,
    turnIndex: 0,
    quote: 'Main proof',
  });
  store.flush();

  const reopened = createConversationStore({baseDir});
  const loaded = reopened.get(conversation.id);
  assert.equal(loaded.workMode, 'learn');
  assert.equal(loaded.branches.length, 1);
  assert.equal(loaded.branches[0].anchor.blockIndex, 2);
  assert.equal(loaded.branches[0].docked, true);
  assert.equal(loaded.userHighlights.length, 1);

  const promoted = reopened.promoteBranch(conversation.id, appended.branch.id);
  assert.ok(promoted);
  assert.equal(promoted.turns.length, 2);
  assert.equal(promoted.workMode, 'learn');
});

test('EventSession fork records forkMessageCount and pins 4th prompt-cache breakpoint', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'mp-fork-cache-'));
  const root = await EventSession.open(userDataDir, 'agent-root', true);
  await root.startTurn(1);
  await root.appendMessage({role: 'user', content: 'Root Q'});
  await root.appendMessage({role: 'assistant', content: 'Root A'});
  await root.endTurn('completed');

  const child = await root.fork(userDataDir, 'agent-child', 1);
  assert.equal(child.forkMessageCount(), 2);

  const payload = modelPayload(
    {
      provider: 'anthropic',
      apiMode: 'messages',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'test',
      model: 'claude-sonnet-4-20250514',
    } as Parameters<typeof modelPayload>[0],
    {
      system: 'Learn system prompt',
      tools: [{name: 'Read', description: 'read', parameters: {type: 'object'}}],
      forkMessageCount: 2,
      messages: [
        {role: 'user', content: 'Root Q'},
        {role: 'assistant', content: 'Root A'},
        {role: 'user', content: 'Branch Q1'},
        {role: 'assistant', content: 'Branch A1'},
        {role: 'user', content: 'Branch Q2'},
      ],
    },
  );
  // Breakpoint 1: system, Breakpoint 2: tools, Breakpoint 3: fork boundary (msg 1), Breakpoint 4: prior turn (msg 3)
  assert.ok(payload.system[0].cache_control);
  assert.ok(payload.tools[0].cache_control);
  assert.ok(payload.messages[1].content[0].cache_control);
  assert.ok(payload.messages[3].content[0].cache_control);
});

test('ChatMarkdown emits sequential data-block-index on top-level blocks and calm editorial dividers without P0/P1/P2 badges', () => {
  const root = ChatMarkdown.render(
    [
      '# 引言',
      '',
      '第一段包含 ==核心不变量== 与 [[一致可积|尾概率积分对全体指标一致趋于零]]。',
      '',
      ':::card [concept] 核心收敛判据',
      '当级数 $\\sum_{i=1}^n x_i + y_i$ 绝对收敛时，结论成立。',
      '$$\\int_{\\Omega} f_n \\, d\\mu \\to \\int_{\\Omega} f \\, d\\mu$$',
      ':::',
      '',
      '- 列表第一项',
      '- 列表第二项',
      '',
      '> 这是一段关键引文。',
      '',
      '```ts',
      'const x = 1;',
      '```',
    ].join('\n'),
  );

  const blockIndices = root.children.map((node: {attrs?: Record<string, string>}) =>
    node.attrs?.['data-block-index'],
  );
  assert.deepEqual(blockIndices, ['0', '1', '2', '3', '4', '5']);

  const html = root.outerHTML;
  assert.match(html, /<h1[^>]*data-block-index="0"/);
  assert.match(html, /<p[^>]*data-block-index="1"/);
  assert.match(html, /<section[^>]*class="mp-learn-card"[^>]*data-block-index="2"/);
  assert.match(html, /<ul[^>]*data-block-index="3"/);
  assert.match(html, /<blockquote[^>]*data-block-index="4"/);
  assert.match(html, /<div[^>]*class="mp-chat-code"[^>]*data-block-index="5"/);

  assert.match(html, /class="mp-learn-card"[^>]*data-category="concept"/);
  assert.match(html, /class="mp-learn-card-tag"[^>]*>concept<\/span>/);
  assert.match(html, /class="mp-learn-mark"/);
  assert.match(
    html,
    /class="mp-learn-term"[^>]*data-mp-learn-gloss="尾概率积分对全体指标一致趋于零"/,
  );
  assert.match(html, /class="katex"/);
  assert.doesNotMatch(html, /<em>i=1\^n x<\/em>/);
  assert.doesNotMatch(html, /mp-learn-card-badge|data-priority=/);
  assert.doesNotMatch(html, /↘\s*深入此卡|↘\s*追问公式/);

  // Legacy :::card [P0] degrades cleanly into editorial divider without P0 pill
  const legacyHtml = ChatMarkdown.render(':::card [P0] 旧版标题\n正文\n:::').outerHTML;
  assert.match(legacyHtml, /class="mp-learn-card"/);
  assert.doesNotMatch(legacyHtml, /mp-learn-card-badge|>P0</);
});

test('learn_tree.css contains zero colored border-left stripes, zero rounded AI card frames/beige boxes, and zero bottom .is-draft-spawn UI', () => {
  const css = readFileSync(
    join(REPO_ROOT, 'electron', 'renderer', 'learn_tree.css'),
    'utf8',
  );
  assert.doesNotMatch(css, /\bborder-left\b/);
  assert.doesNotMatch(css, /--mp-learn-p[012]|--mp-learn-card-bg|#f5efe8/i);
  assert.doesNotMatch(css, /\.is-draft-spawn\b/);
  assert.match(css, /\.mp-learn-card\b[\s\S]*border-top:\s*1px solid/);
  assert.match(css, /\.mp-learn-popover\b/);
  assert.match(css, /\.mp-learn-spine::before\b[\s\S]*width:\s*2px/);
  assert.match(css, /--mp-line-soft/);
});

test('learn_tree.ts contains zero UI emojis, zero .is-draft-spawn, and uses clean CDS 20x20 vector icons', () => {
  const source = readFileSync(
    join(REPO_ROOT, 'electron', 'renderer', 'learn_tree.ts'),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]|🌱|🌳|⚡|🖍|📎|🔗|⚠|✎|⤢|⑂|↘|↗|↙/u,
  );
  assert.doesNotMatch(source, /is-draft-spawn/);
  assert.match(source, /setAttribute\(['"]viewBox['"],\s*['"]0 0 20 20['"]\)|viewBox=['"]0 0 20 20['"]|cds-icon/);
  assert.match(source, /mp-learn-popover/);
});

interface MockRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

function createMiniDom() {
  type Listener = (ev: Record<string, unknown>) => void;
  const docListeners = new Map<string, Listener[]>();

  class MiniElement {
    tagName: string;
    namespaceURI: string | null;
    attributes = new Map<string, string>();
    children: Array<MiniElement | MiniText> = [];
    parentNode: MiniElement | null = null;
    dataset: Record<string, string> = {};
    style: Record<string, string> & {setProperty(k: string, v: string): void};
    listeners = new Map<string, Listener[]>();
    hidden = false;
    type = '';
    value = '';
    placeholder = '';
    title = '';
    disabled = false;
    draggable = false;
    rows = 1;
    focused = false;
    rect: MockRect = {
      left: 100,
      right: 220,
      top: 120,
      bottom: 144,
      width: 120,
      height: 24,
    };

    constructor(tag: string, ns: string | null = null) {
      this.tagName = tag.toUpperCase();
      this.namespaceURI = ns;
      const styleMap: Record<string, string> = {};
      this.style = Object.assign(styleMap, {
        setProperty(k: string, v: string) {
          styleMap[k] = String(v);
        },
      });
      this.dataset = new Proxy<Record<string, string>>(
        {},
        {
          get: (_target, prop: string) => {
            const attrName =
              'data-' + prop.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`);
            return this.attributes.get(attrName);
          },
          set: (_target, prop: string, val: string) => {
            const attrName =
              'data-' + prop.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`);
            this.attributes.set(attrName, String(val));
            return true;
          },
          deleteProperty: (_target, prop: string) => {
            const attrName =
              'data-' + prop.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`);
            this.attributes.delete(attrName);
            return true;
          },
        },
      );
    }

    get className(): string {
      return this.attributes.get('class') || '';
    }
    set className(val: string) {
      this.attributes.set('class', val);
    }

    get classList() {
      const getSet = () =>
        new Set(this.className.split(/\s+/).filter(Boolean));
      return {
        add: (...names: string[]) => {
          const set = getSet();
          for (const n of names) {
            set.add(n);
          }
          this.className = [...set].join(' ');
        },
        remove: (...names: string[]) => {
          const set = getSet();
          for (const n of names) {
            set.delete(n);
          }
          this.className = [...set].join(' ');
        },
        contains: (name: string) => getSet().has(name),
      };
    }

    get textContent(): string {
      return this.children.map(c => c.textContent).join('');
    }
    set textContent(val: string) {
      this.children = val ? [new MiniText(String(val), this)] : [];
    }

    get parentElement(): MiniElement | null {
      return this.parentNode;
    }

    get nextSibling(): MiniElement | MiniText | null {
      if (!this.parentNode) {
        return null;
      }
      const idx = this.parentNode.children.indexOf(this);
      return idx >= 0 ? this.parentNode.children[idx + 1] || null : null;
    }

    get offsetWidth(): number {
      return 320;
    }
    get offsetHeight(): number {
      return 96;
    }

    setAttribute(k: string, v: string): void {
      this.attributes.set(k, String(v));
    }

    getAttribute(k: string): string | null {
      return this.attributes.has(k) ? this.attributes.get(k)! : null;
    }

    hasAttribute(k: string): boolean {
      return this.attributes.has(k);
    }

    set innerHTML(_raw: string) {
      /* noop for SVG raw snippet in unit test */
    }

    appendChild(child: MiniElement | MiniText | MiniFragment): MiniElement | MiniText | MiniFragment {
      if (child instanceof MiniFragment) {
        for (const item of [...child.children]) {
          this.appendChild(item);
        }
        return child;
      }
      if (child.parentNode) {
        child.parentNode.removeChild(child);
      }
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    append(...items: Array<MiniElement | MiniText | string>): void {
      for (const item of items) {
        this.appendChild(
          typeof item === 'string' ? new MiniText(item) : item,
        );
      }
    }

    insertBefore(
      newNode: MiniElement | MiniText,
      refNode: MiniElement | MiniText | null,
    ): MiniElement | MiniText {
      if (!refNode) {
        return this.appendChild(newNode) as MiniElement | MiniText;
      }
      if (newNode.parentNode) {
        newNode.parentNode.removeChild(newNode);
      }
      const idx = this.children.indexOf(refNode);
      newNode.parentNode = this;
      if (idx < 0) {
        this.children.push(newNode);
      } else {
        this.children.splice(idx, 0, newNode);
      }
      return newNode;
    }

    after(...items: Array<MiniElement | MiniText>): void {
      if (!this.parentNode) {
        return;
      }
      const ref = this.nextSibling;
      for (const item of items) {
        this.parentNode.insertBefore(item, ref);
      }
    }

    removeChild(child: MiniElement | MiniText): void {
      const idx = this.children.indexOf(child);
      if (idx >= 0) {
        this.children.splice(idx, 1);
        child.parentNode = null;
      }
    }

    remove(): void {
      this.parentNode?.removeChild(this);
    }

    replaceChildren(...items: Array<MiniElement | MiniText>): void {
      for (const child of [...this.children]) {
        child.parentNode = null;
      }
      this.children = [];
      for (const item of items) {
        this.appendChild(item);
      }
    }

    contains(node: unknown): boolean {
      if (node === this) {
        return true;
      }
      for (const child of this.children) {
        if (child === node) {
          return true;
        }
        if (child instanceof MiniElement && child.contains(node)) {
          return true;
        }
      }
      return false;
    }

    matches(selector: string): boolean {
      return selector
        .split(',')
        .map(s => s.trim())
        .some(part => matchesSimpleSelector(this, part));
    }

    closest(selector: string): MiniElement | null {
      let cur: MiniElement | null = this;
      while (cur) {
        if (cur.matches(selector)) {
          return cur;
        }
        cur = cur.parentNode;
      }
      return null;
    }

    querySelector(selector: string): MiniElement | null {
      return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector: string): MiniElement[] {
      const results: MiniElement[] = [];
      const walk = (node: MiniElement) => {
        for (const child of node.children) {
          if (child instanceof MiniElement) {
            if (child.matches(selector)) {
              results.push(child);
            }
            walk(child);
          }
        }
      };
      walk(this);
      return results;
    }

    addEventListener(type: string, fn: Listener): void {
      const list = this.listeners.get(type) || [];
      list.push(fn);
      this.listeners.set(type, list);
    }

    dispatch(type: string, extra: Record<string, unknown> = {}): void {
      const event: Record<string, unknown> = {
        type,
        target: this,
        currentTarget: this,
        defaultPrevented: false,
        preventDefault() {
          event.defaultPrevented = true;
        },
        stopPropagation() {},
        ...extra,
      };
      let cur: MiniElement | null = this;
      while (cur) {
        for (const fn of cur.listeners.get(type) || []) {
          fn(event);
        }
        cur = cur.parentNode;
      }
      for (const fn of docListeners.get(type) || []) {
        fn(event);
      }
    }

    getBoundingClientRect(): MockRect {
      return this.rect;
    }

    focus(): void {
      this.focused = true;
      doc.activeElement = this;
    }

    get outerHTML(): string {
      const attrs = [...this.attributes.entries()]
        .map(([k, v]) => ` ${k}="${v}"`)
        .join('');
      const inner = this.children
        .map(c => (c instanceof MiniElement ? c.outerHTML : c.textContent))
        .join('');
      return `<${this.tagName.toLowerCase()}${attrs}>${inner}</${this.tagName.toLowerCase()}>`;
    }
  }

  class MiniText {
    nodeValue: string;
    parentNode: MiniElement | null;
    constructor(text: string, parent: MiniElement | null = null) {
      this.nodeValue = text;
      this.parentNode = parent;
    }
    get textContent(): string {
      return this.nodeValue;
    }
    get parentElement(): MiniElement | null {
      return this.parentNode;
    }
  }

  class MiniFragment {
    children: Array<MiniElement | MiniText> = [];
    appendChild(child: MiniElement | MiniText): void {
      this.children.push(child);
    }
  }

  function matchesSimpleSelector(el: MiniElement, selector: string): boolean {
    if (!selector) {
      return false;
    }
    const clean = selector.replace(/^:scope\s*>\s*/, '');
    if (clean.includes(' ')) {
      const parts = clean.split(/\s+/);
      const tail = parts.pop()!;
      if (!matchesSimpleSelector(el, tail)) {
        return false;
      }
      let anc = el.parentNode;
      while (parts.length && anc) {
        const needed = parts[parts.length - 1];
        if (matchesSimpleSelector(anc, needed)) {
          parts.pop();
        }
        anc = anc.parentNode;
      }
      return parts.length === 0;
    }
    let rest = clean;
    const attrMatches: Array<{name: string; value?: string}> = [];
    rest = rest.replace(/\[([^\]=]+)(?:="([^"]*)")?\]/g, (_m, n, v) => {
      attrMatches.push({name: n, value: v});
      return '';
    });
    const classes: string[] = [];
    rest = rest.replace(/\.([a-zA-Z0-9_-]+)/g, (_m, c) => {
      classes.push(c);
      return '';
    });
    const tag = rest.trim();
    if (tag && tag !== '*' && el.tagName.toLowerCase() !== tag.toLowerCase()) {
      return false;
    }
    for (const cls of classes) {
      if (!el.classList.contains(cls)) {
        return false;
      }
    }
    for (const attr of attrMatches) {
      const actual = el.getAttribute(attr.name);
      if (actual === null) {
        return false;
      }
      if (attr.value !== undefined && actual !== attr.value) {
        return false;
      }
    }
    return true;
  }

  const body = new MiniElement('body');
  const doc: Record<string, unknown> = {
    body,
    activeElement: null,
    createElement: (tag: string) => new MiniElement(tag),
    createElementNS: (ns: string, tag: string) => new MiniElement(tag, ns),
    createTextNode: (txt: string) => new MiniText(txt),
    createDocumentFragment: () => new MiniFragment(),
    getElementById: (id: string) =>
      body.querySelectorAll('*').find(n => n.getAttribute('id') === id) || null,
    addEventListener: (type: string, fn: Listener) => {
      const list = docListeners.get(type) || [];
      list.push(fn);
      docListeners.set(type, list);
    },
  };

  return {MiniElement, MiniText, doc, body, docListeners};
}

test('LearnTree opens contextual .mp-learn-popover next to clicked anchors/selection and mounts child subtrees inline under [data-block-index="N"]', async () => {
  const {MiniElement, doc, body} = createMiniDom();
  const prevDoc = globalThis.document;
  const prevWin = (globalThis as Record<string, unknown>).window;
  const prevData = (globalThis as Record<string, unknown>).Data;
  const prevChatMarkdown = (globalThis as Record<string, unknown>).ChatMarkdown;

  const sentPayloads: Array<Record<string, unknown>> = [];
  let currentConversation: Record<string, unknown> | null = null;
  let selectionState: {
    text: string;
    collapsed: boolean;
    anchorEl: InstanceType<typeof MiniElement>;
    rect: MockRect;
  } | null = null;

  const mockWindow: Record<string, unknown> = {
    innerWidth: 1200,
    innerHeight: 800,
    getSelection: () =>
      selectionState
        ? {
            isCollapsed: selectionState.collapsed,
            rangeCount: 1,
            toString: () => selectionState!.text,
            getRangeAt: () => ({
              commonAncestorContainer: selectionState!.anchorEl,
              getBoundingClientRect: () => selectionState!.rect,
            }),
            removeAllRanges: () => {
              selectionState = null;
            },
          }
        : {
            isCollapsed: true,
            rangeCount: 0,
            toString: () => '',
            removeAllRanges: () => {},
          },
  };

  const mockData = {
    learnSend: async (payload: Record<string, unknown>) => {
      sentPayloads.push(payload);
      return {ok: true, branchId: 'br-new', conversation: currentConversation};
    },
    learnPatch: async () => ({ok: true}),
    learnStop: async () => ({ok: true}),
    onLearnProgress: () => {},
  };

  (globalThis as Record<string, unknown>).document = doc;
  (globalThis as Record<string, unknown>).window = mockWindow;
  (globalThis as Record<string, unknown>).Data = mockData;
  (globalThis as Record<string, unknown>).ChatMarkdown = ChatMarkdown;

  try {
    const modPath = require.resolve('../electron/renderer/learn_tree');
    delete require.cache[modPath];
    const LearnTree = require(modPath);

    const streamEl = new MiniElement('div');
    streamEl.setAttribute('id', 'stream');
    body.appendChild(streamEl);

    const turnItem = new MiniElement('div');
    turnItem.className = 'mp-chat-flow-item';
    turnItem.setAttribute('data-turn-index', '0');
    streamEl.appendChild(turnItem);

    const mdRoot = new MiniElement('div');
    mdRoot.className = 'mp-chat-markdown';
    turnItem.appendChild(mdRoot);

    const p0 = new MiniElement('p');
    p0.setAttribute('data-block-index', '0');
    p0.textContent = '这是第一段可划选文字，用于验证划词追问。';
    p0.rect = {left: 80, right: 320, top: 90, bottom: 110, width: 240, height: 20};

    const p1 = new MiniElement('p');
    p1.setAttribute('data-block-index', '1');
    const markEl = new MiniElement('mark');
    markEl.className = 'mp-learn-mark';
    markEl.textContent = '关键不变量';
    markEl.rect = {left: 140, right: 220, top: 180, bottom: 202, width: 80, height: 22};

    const termEl = new MiniElement('button');
    termEl.className = 'mp-learn-term';
    termEl.setAttribute('data-mp-learn-anchor', 'term');
    termEl.setAttribute('data-mp-learn-term', '测度空间');
    termEl.textContent = '测度空间';
    termEl.rect = {left: 240, right: 310, top: 180, bottom: 202, width: 70, height: 22};

    const mathEl = new MiniElement('span');
    mathEl.className = 'katex';
    mathEl.textContent = 'x^2';
    mathEl.rect = {left: 330, right: 370, top: 180, bottom: 202, width: 40, height: 22};
    p1.append(markEl, termEl, mathEl);

    const card2 = new MiniElement('section');
    card2.className = 'mp-learn-card';
    card2.setAttribute('data-block-index', '2');
    const cardAsk = new MiniElement('button');
    cardAsk.className = 'mp-learn-card-ask';
    cardAsk.setAttribute('data-mp-learn-anchor', 'card');
    cardAsk.setAttribute('data-mp-learn-label', '核心推导');
    cardAsk.setAttribute('data-mp-learn-snippet', '分部积分推导');
    cardAsk.rect = {left: 500, right: 524, top: 260, bottom: 284, width: 24, height: 24};
    card2.appendChild(cardAsk);

    const p3 = new MiniElement('p');
    p3.setAttribute('data-block-index', '3');
    p3.textContent = '末尾段落。';

    mdRoot.append(p0, p1, card2, p3);

    currentConversation = {
      id: 'conv-1',
      workMode: 'learn',
      turns: [{question: 'Q', answer: 'A'}],
      branches: [
        {
          id: 'br-inline',
          parentBranchId: null,
          parentTurnIndex: 0,
          anchor: {
            kind: 'term',
            label: '测度空间',
            snippet: '测度空间',
            blockIndex: 1,
          },
          title: '测度空间',
          agentSessionId: 'agent-br-1',
          turns: [{question: '为什么需要 σ-代数？', answer: '为了保证可数并封闭。', outcome: '已完成'}],
          collapsed: false,
          docked: false,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'br-fallback',
          parentBranchId: null,
          parentTurnIndex: 0,
          anchor: {
            kind: 'selection',
            label: '越界锚点',
            snippet: '越界锚点',
            blockIndex: 99,
          },
          title: '越界锚点',
          agentSessionId: 'agent-br-2',
          turns: [{question: '回退问题', answer: '回退回答', outcome: '已完成'}],
          collapsed: false,
          docked: false,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    };

    LearnTree.init({
      getConversation: () => currentConversation,
      getEffort: () => 'high',
      openDeckInInspector: () => {},
      openConversationById: () => {},
      refreshConversation: async () => {},
    });
    LearnTree.mountConversation(streamEl, currentConversation);

    // Inline subtree mounts directly beneath [data-block-index="1"] (before block 2)
    assert.equal(turnItem.querySelectorAll('.is-draft-spawn').length, 0);
    const mdChildren = mdRoot.children;
    const idx1 = mdChildren.indexOf(p1);
    const idx2 = mdChildren.indexOf(card2);
    assert.ok(idx2 === idx1 + 2, 'inline subtree host must sit directly between block 1 and block 2');
    const inlineHost = mdChildren[idx1 + 1] as InstanceType<typeof MiniElement>;
    assert.ok(inlineHost.querySelector('[data-branch-id="br-inline"]'));
    assert.ok(inlineHost.querySelector('.mp-learn-spine'));
    assert.ok(inlineHost.querySelector('svg'), 'collapse toggle must render crisp SVG caret');

    // Out-of-range blockIndex falls back gracefully to end-of-turn
    assert.equal(inlineHost.querySelector('[data-branch-id="br-fallback"]'), null);
    assert.ok(
      turnItem.children[turnItem.children.length - 1]
        .querySelector('[data-branch-id="br-fallback"]'),
    );

    // Clicking .mp-learn-mark, .mp-learn-term, .katex, .mp-learn-card-ask opens .mp-learn-popover nearby
    for (const target of [markEl, termEl, mathEl, cardAsk]) {
      target.dispatch('click');
      const popover = body.querySelector('.mp-learn-popover');
      assert.ok(popover && !popover.hidden, 'expected .mp-learn-popover to open on click');
      assert.equal(body.querySelectorAll('.is-draft-spawn').length, 0);
      assert.ok(popover.querySelector('.mp-learn-popover-input'));
      assert.ok(popover.querySelector('.mp-learn-popover-submit'));
      const topVal = Number.parseFloat(popover.style.top || '0');
      const leftVal = Number.parseFloat(popover.style.left || '0');
      assert.ok(topVal >= 8 && topVal <= 800 - 8);
      assert.ok(leftVal >= 8 && leftVal <= 1200 - 8);
    }

    // Clicking .mp-learn-term near bottom collision-flips popover above trigger
    termEl.rect = {left: 240, right: 310, top: 750, bottom: 774, width: 70, height: 24};
    termEl.dispatch('click');
    const flippedPopover = body.querySelector('.mp-learn-popover')!;
    assert.ok(
      Number.parseFloat(flippedPopover.style.top || '0') < termEl.rect.top,
      'popover near bottom edge must collision-flip above trigger',
    );

    // Submitting from popover attaches blockIndex to learnAnchor
    const input = flippedPopover.querySelector('.mp-learn-popover-input')!;
    input.value = '这里为什么有测度？';
    const submitBtn = flippedPopover.querySelector('.mp-learn-popover-submit')!;
    submitBtn.dispatch('click');
    await Promise.resolve();
    assert.equal(sentPayloads.length, 1);
    const sentAnchor = sentPayloads[0].anchor as Record<string, unknown>;
    assert.equal(sentAnchor.blockIndex, 1);

    // Highlighting text inside [data-block-index="0"] opens .mp-learn-popover
    selectionState = {
      text: '第一段可划选文字',
      collapsed: false,
      anchorEl: p0,
      rect: {left: 100, right: 240, top: 90, bottom: 110, width: 140, height: 20},
    };
    p0.dispatch('mouseup');
    await new Promise(resolveDelay => setTimeout(resolveDelay, 30));
    const selPopover = body.querySelector('.mp-learn-popover');
    assert.ok(selPopover && !selPopover.hidden, 'text selection must open .mp-learn-popover');
    assert.match(selPopover.textContent, /第一段可划选文字/);
  } finally {
    globalThis.document = prevDoc;
    (globalThis as Record<string, unknown>).window = prevWin;
    (globalThis as Record<string, unknown>).Data = prevData;
    (globalThis as Record<string, unknown>).ChatMarkdown = prevChatMarkdown;
  }
});
