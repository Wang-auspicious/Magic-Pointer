import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');

function decodeHtml(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function encodeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

interface MockEventInit {
  target?: MockNode | null;
  key?: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

class MockEvent {
  type: string;
  target: MockNode | null;
  currentTarget: MockNode | null = null;
  defaultPrevented = false;
  propagationStopped = false;
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;

  constructor(type: string, init: MockEventInit = {}) {
    this.type = type;
    this.target = init.target ?? null;
    this.key = init.key ?? '';
    this.shiftKey = Boolean(init.shiftKey);
    this.isComposing = Boolean(init.isComposing);
    this.keyCode = init.keyCode ?? 0;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

class MockNode {
  parentElement: MockElement | null = null;
  textContentValue = '';
  constructor(text = '') {
    this.textContentValue = text;
  }
}

function parseAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex =
    /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(attrText)) !== null) {
    const key = match[1].toLowerCase();
    const val = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[key] = decodeHtml(val);
  }
  return attrs;
}

function toCamelCase(attr: string): string {
  return attr.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function matchesSimpleSelector(el: MockElement, simple: string): boolean {
  let rest = simple.trim();
  if (!rest) {
    return false;
  }
  const tagMatch = rest.match(/^[a-zA-Z][\w-]*/);
  if (tagMatch) {
    if (el.tagName !== tagMatch[0].toLowerCase()) {
      return false;
    }
    rest = rest.slice(tagMatch[0].length);
  }
  while (rest.length > 0) {
    if (rest[0] === '#') {
      const m = rest.slice(1).match(/^[\w-]+/);
      if (!m || el.id !== m[0]) {
        return false;
      }
      rest = rest.slice(1 + m[0].length);
    } else if (rest[0] === '.') {
      const m = rest.slice(1).match(/^[\w-]+/);
      if (!m) {
        return false;
      }
      const classes = el.className.split(/\s+/).filter(Boolean);
      if (!classes.includes(m[0])) {
        return false;
      }
      rest = rest.slice(1 + m[0].length);
    } else if (rest[0] === '[') {
      const closeIdx = rest.indexOf(']');
      if (closeIdx < 0) {
        return false;
      }
      const inner = rest.slice(1, closeIdx);
      rest = rest.slice(closeIdx + 1);
      const eqIdx = inner.indexOf('=');
      if (eqIdx < 0) {
        const attrName = inner.trim().toLowerCase();
        if (!el.hasAttribute(attrName)) {
          return false;
        }
      } else {
        const attrName = inner.slice(0, eqIdx).trim().toLowerCase();
        const rawVal = inner
          .slice(eqIdx + 1)
          .trim()
          .replace(/^["']|["']$/g, '');
        if (el.getAttribute(attrName) !== rawVal) {
          return false;
        }
      }
    } else {
      return false;
    }
  }
  return true;
}

function splitSelectorTokens(selector: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (quote) {
      cur += ch;
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) {
    tokens.push(cur);
  }
  return tokens;
}

function matchesSelectorPart(el: MockElement, selector: string): boolean {
  const tokens = splitSelectorTokens(selector);
  if (tokens.length === 0) {
    return false;
  }
  if (!matchesSimpleSelector(el, tokens[tokens.length - 1])) {
    return false;
  }
  let current: MockElement | null = el.parentElement;
  for (let i = tokens.length - 2; i >= 0; i--) {
    while (current && !matchesSimpleSelector(current, tokens[i])) {
      current = current.parentElement;
    }
    if (!current) {
      return false;
    }
    current = current.parentElement;
  }
  return true;
}

class MockElement extends MockNode {
  tagName: string;
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  childNodes: MockNode[] = [];
  listeners = new Map<string, Array<(ev: MockEvent) => void>>();
  scrollTop = 0;
  selectionStart = 0;
  selectionEnd = 0;
  scrolledIntoView = false;
  private _value = '';
  private _checked = false;
  private _disabled = false;
  private _rawHtml = '';
  private _doc: MockDocument | null = null;

  constructor(tagName = 'div', doc: MockDocument | null = null) {
    super('');
    this.tagName = tagName.toLowerCase();
    this._doc = doc;
  }

  get id(): string {
    return this.attributes.id || '';
  }

  set id(val: string) {
    this.setAttribute('id', val);
  }

  get className(): string {
    return this.attributes.class || '';
  }

  set className(val: string) {
    this.setAttribute('class', val);
  }

  get value(): string {
    return this._value;
  }

  set value(val: string) {
    this._value = String(val);
    this.attributes.value = this._value;
  }

  get checked(): boolean {
    return this._checked;
  }

  set checked(val: boolean) {
    this._checked = Boolean(val);
    if (this._checked) {
      this.attributes.checked = '';
    } else {
      delete this.attributes.checked;
    }
  }

  get disabled(): boolean {
    return this._disabled;
  }

  set disabled(val: boolean) {
    this._disabled = Boolean(val);
    if (this._disabled) {
      this.attributes.disabled = '';
    } else {
      delete this.attributes.disabled;
    }
  }

  get children(): MockElement[] {
    return this.childNodes.filter(
      (node): node is MockElement => node instanceof MockElement,
    );
  }

  get isConnected(): boolean {
    return true;
  }

  get textContent(): string {
    return this.childNodes
      .map(n =>
        n instanceof MockElement ? n.textContent : n.textContentValue,
      )
      .join('');
  }

  set textContent(val: string) {
    this.childNodes = val ? [new MockNode(String(val))] : [];
    this._rawHtml = String(val);
  }

  get innerHTML(): string {
    if (this._rawHtml && this.childNodes.length === 0) {
      return this._rawHtml;
    }
    return this.serializeChildren();
  }

  set innerHTML(html: string) {
    this._rawHtml = html;
    this.childNodes = [];
    this.parseInto(html);
  }

  get outerHTML(): string {
    const attrPairs = Object.entries(this.attributes)
      .map(([k, v]) => (v === '' ? k : `${k}="${encodeAttr(v)}"`))
      .join(' ');
    const open = attrPairs
      ? `<${this.tagName} ${attrPairs}>`
      : `<${this.tagName}>`;
    if (VOID_TAGS.has(this.tagName)) {
      return open;
    }
    return `${open}${this.serializeChildren()}</${this.tagName}>`;
  }

  private serializeChildren(): string {
    return this.childNodes
      .map(node => {
        if (!(node instanceof MockElement)) {
          return node.textContentValue;
        }
        return node.outerHTML;
      })
      .join('');
  }

  private parseInto(html: string): void {
    const stack: MockElement[] = [this];
    const tokenRegex = /<\/([a-zA-Z][\w-]*)>|<([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(html)) !== null) {
      const top = stack[stack.length - 1];
      if (match[1]) {
        const closeTag = match[1].toLowerCase();
        for (let i = stack.length - 1; i >= 1; i--) {
          if (stack[i].tagName === closeTag) {
            if (closeTag === 'textarea') {
              stack[i]._value = stack[i].textContent;
            } else if (closeTag === 'select') {
              const opts = stack[i].children.filter(c => c.tagName === 'option');
              const selected =
                opts.find(o => o.hasAttribute('selected')) ?? opts[0];
              if (selected) {
                stack[i]._value = selected.getAttribute('value') ?? selected.textContent;
              }
            }
            stack.length = i;
            break;
          }
        }
      } else if (match[2]) {
        const tag = match[2].toLowerCase();
        const rawAttrs = match[3] || '';
        const selfClosing = rawAttrs.trim().endsWith('/') || VOID_TAGS.has(tag);
        const cleanAttrs = rawAttrs.replace(/\/\s*$/, '');
        const el = new MockElement(tag, this._doc);
        const attrs = parseAttributes(cleanAttrs);
        for (const [k, v] of Object.entries(attrs)) {
          el.setAttribute(k, v);
        }
        el.parentElement = top;
        top.childNodes.push(el);
        if (!selfClosing) {
          stack.push(el);
        }
      } else if (match[4]) {
        const textNode = new MockNode(decodeHtml(match[4]));
        textNode.parentElement = top;
        top.childNodes.push(textNode);
      }
    }
  }

  setAttribute(name: string, value: string): void {
    const key = name.toLowerCase();
    this.attributes[key] = String(value);
    if (key.startsWith('data-')) {
      this.dataset[toCamelCase(key.slice(5))] = String(value);
    } else if (key === 'value') {
      this._value = String(value);
    } else if (key === 'checked') {
      this._checked = true;
    } else if (key === 'disabled') {
      this._disabled = true;
    }
  }

  getAttribute(name: string): string | null {
    const key = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(this.attributes, key)
      ? this.attributes[key]
      : null;
  }

  hasAttribute(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(
      this.attributes,
      name.toLowerCase(),
    );
  }

  replaceChildren(...nodes: MockElement[]): void {
    this.childNodes = [];
    for (const node of nodes) {
      node.parentElement = this;
      this.childNodes.push(node);
    }
  }

  append(...nodes: MockElement[]): void {
    for (const node of nodes) {
      node.parentElement = this;
      this.childNodes.push(node);
    }
  }

  appendChild(node: MockNode): MockNode {
    node.parentElement = this;
    this.childNodes.push(node);
    return node;
  }

  contains(other: MockNode | null): boolean {
    let cur: MockNode | null = other;
    while (cur) {
      if (cur === this) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  focus(): void {
    if (this._doc) {
      this._doc.activeElement = this;
    }
  }

  scrollIntoView(): void {
    this.scrolledIntoView = true;
  }

  matches(selector: string): boolean {
    return selector
      .split(',')
      .some(part => matchesSelectorPart(this, part.trim()));
  }

  closest(selector: string): MockElement | null {
    let cur: MockElement | null = this;
    while (cur) {
      if (cur.matches(selector)) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const out: MockElement[] = [];
    const visit = (node: MockElement) => {
      for (const child of node.children) {
        if (child.matches(selector)) {
          out.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  querySelector(selector: string): MockElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  addEventListener(type: string, fn: (ev: MockEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  dispatchEvent(ev: MockEvent): boolean {
    if (!ev.target) {
      ev.target = this;
    }
    let cur: MockElement | null = this;
    while (cur && !ev.propagationStopped) {
      ev.currentTarget = cur;
      const list = cur.listeners.get(ev.type) ?? [];
      for (const fn of list) {
        fn(ev);
      }
      cur = cur.parentElement;
    }
    return !ev.defaultPrevented;
  }

  click(): void {
    this.dispatchEvent(new MockEvent('click', {target: this}));
  }
}

class MockDocument {
  activeElement: MockElement | null = null;
  createElement(tag: string): MockElement {
    return new MockElement(tag, this);
  }
  createTextNode(text: string): MockNode {
    return new MockNode(text);
  }
  addEventListener(): void {}
}

class MockFormData {
  private entries = new Map<string, string>();
  constructor(form: MockElement) {
    for (const el of form.querySelectorAll('input, textarea, select')) {
      const name = el.getAttribute('name');
      if (!name) {
        continue;
      }
      if (el.tagName === 'input' && el.getAttribute('type') === 'checkbox') {
        if (el.checked) {
          this.entries.set(name, 'on');
        }
      } else {
        this.entries.set(name, el.value);
      }
    }
  }
  get(name: string): string | null {
    return this.entries.get(name) ?? null;
  }
}

interface PoActions {
  onBack(): void;
  onSendGoal(text: string): Promise<void> | void;
  onStopRun?(threadId?: string): Promise<void> | void;
  onAnswerDecision(decisionId: string, optionIndex: number): Promise<void> | void;
  onWithdrawDecision?(decisionId: string): Promise<void> | void;
  onSelectThread(threadId: string): Promise<void> | void;
  onMessageThread?(
    threadId: string,
    text: string,
  ): Promise<{ok: boolean; thread?: Record<string, unknown>; error?: string} | void>;
  onResolveThread(threadId: string, resolved: boolean): Promise<void> | void;
  onRemindThread(threadId: string, remindAt: number): Promise<void> | void;
  onInspectDiff(threadId: string): Promise<Record<string, unknown> | void>;
  onDiscardThread(threadId: string): Promise<void> | void;
  onSaveFile(input: Record<string, unknown>): Promise<{ok: boolean; error?: string}>;
  onSaveMemory(
    input: Record<string, unknown>,
  ): Promise<{ok: boolean; sha256?: string; error?: string}>;
  onSaveSettings(
    patch: Record<string, unknown>,
  ): Promise<{ok: boolean; error?: string}>;
  onTogglePinArtifact(artifactId: string, pinned: boolean): Promise<void> | void;
  onDismissRecap(): Promise<void> | void;
  onUpdateSections(patch: Record<string, unknown>): Promise<void> | void;
}

interface PoState {
  project: Record<string, unknown>;
  userName?: string;
  modelContext?: Record<string, unknown>;
  threads: Array<Record<string, unknown>>;
  timeline: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  activeRun?: Record<string, unknown> | null;
  activeRuns?: Record<string, Record<string, unknown>>;
  files?: Array<Record<string, unknown>>;
  memory?: Record<string, unknown>;
  activeTab?: 'overview' | 'threads' | 'artifacts' | 'files' | 'settings';
  actions: PoActions;
}

interface PoManagedHandle {
  unmount(): void;
  update(nextState: Omit<PoState, 'actions'> & {actions?: PoActions}): void;
}

interface PoApi {
  mount(host: unknown, state: PoState): () => void;
  mountManaged(host: unknown, state: PoState): PoManagedHandle;
}

function loadProjectOverviewHarness(withChatMarkdown = true): {
  doc: MockDocument;
  ProjectOverview: PoApi;
} {
  const poSource = fs.readFileSync(
    path.join(ROOT, 'electron/renderer/project_overview.ts'),
    'utf8',
  );
  assert.equal(/^\s*(?:import|export)\s/m.test(poSource), false);
  assert.equal(/抄袭|copied\s+from/i.test(poSource), false);

  const poJs = ts.transpileModule(poSource, {
    compilerOptions: {target: ts.ScriptTarget.ES2022},
  }).outputText;

  const doc = new MockDocument();
  const sandbox: Record<string, unknown> = {
    window: {},
    document: doc,
    FormData: MockFormData,
    globalThis: {},
    CdsIcons: require('../electron/renderer/cds_icons.ts'),
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  if (withChatMarkdown) {
    const mdSource = fs.readFileSync(
      path.join(ROOT, 'electron/renderer/chat_markdown.ts'),
      'utf8',
    );
    const mdJs = ts.transpileModule(mdSource, {
      compilerOptions: {target: ts.ScriptTarget.ES2022},
    }).outputText;
    vm.runInContext(mdJs, sandbox);
  }

  vm.runInContext(poJs, sandbox);

  return {
    doc,
    ProjectOverview: sandbox.ProjectOverview as PoApi,
  };
}

function makeBaseState(overrides: Partial<PoState> = {}): PoState {
  const defaultActions: PoActions = {
    onBack: () => {},
    onSendGoal: async () => {},
    onStopRun: async () => {},
    onAnswerDecision: async () => {},
    onWithdrawDecision: async () => {},
    onSelectThread: async () => {},
    onResolveThread: async () => {},
    onRemindThread: async () => {},
    onInspectDiff: async () => ({ok: true, diff: '', summary: 'Clean', files: []}),
    onDiscardThread: async () => {},
    onSaveFile: async () => ({ok: true}),
    onSaveMemory: async () => ({ok: true, sha256: 'newsha'}),
    onSaveSettings: async () => ({ok: true}),
    onTogglePinArtifact: async () => {},
    onDismissRecap: async () => {},
    onUpdateSections: async () => {},
  };

  return {
    project: {
      id: 'proj-w5',
      root: 'D:/repo',
      name: 'Claude Video Project',
      goal: 'Ship 1:1 Projects UI',
      color: '#D97757',
      projectIcon: 'Projects',
      paused: false,
      archived: false,
      multiAgentConfig: {
        agentTeam: 'squad',
        coordinatorModel: 'claude-sonnet-4-5',
        coordinatorEffort: 'high',
        workerModel: 'claude-haiku-4-5',
        workerEffort: 'medium',
      },
    },
    userName: 'Alex',
    modelContext: {
      defaultModel: 'claude-sonnet-4-5',
      coordinatorModel: 'claude-sonnet-4-5',
      coordinatorEffort: 'high',
      workerModel: 'claude-haiku-4-5',
      workerEffort: 'medium',
      availableModels: [
        {model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', active: true},
        {model: 'claude-opus-4-1', label: 'Opus 4.1', provider: 'Anthropic'},
        {model: 'claude-haiku-4-5', label: 'Haiku 4.5', provider: 'Anthropic'},
      ],
    },
    threads: [],
    timeline: [],
    decisions: [],
    artifacts: [],
    files: [{path: 'notes/plan.md', size: 42, updatedAt: 1000}],
    memory: {path: '/MEMORY.md', content: '# Shared', sha256: 'sha-1'},
    ...overrides,
    actions: {
      ...defaultActions,
      ...(overrides.actions || {}),
    },
  };
}

test('Wave 5.1: Clean 50/50 split defaults to Threads Home with Welcome back greeting, dynamic waiting subtitle, collapsible groups, and checklist progress', () => {
  const {doc, ProjectOverview} = loadProjectOverviewHarness();
  const host = doc.createElement('div');
  const now = Date.now();

  // 0 waiting threads -> "Nothing is waiting on you."
  const handle = ProjectOverview.mountManaged(
    host,
    makeBaseState({
      threads: [
        {
          id: 't-work',
          projectId: 'proj-w5',
          title: 'Audit API Routes',
          body: '- [x] Inspect auth routes\n- [ ] Verify rate limits',
          boundSessionIds: [],
          boundSessions: [{id: 's-w', status: 'active', working: true}],
          createdAt: now - 30_000,
          lastReplyAt: now - 10_000,
          replyCount: 1,
          hasUnread: false,
        },
        {
          id: 't-idle',
          projectId: 'proj-w5',
          title: 'Polish Styles',
          body: 'Spacing check',
          boundSessionIds: [],
          boundSessions: [{id: 's-i', status: 'active'}],
          worktreeBranch: 'mp/polish-styles',
          createdAt: now - 120_000,
          lastReplyAt: now - 60_000,
          replyCount: 2,
          hasUnread: false,
        },
        {
          id: 't-done',
          projectId: 'proj-w5',
          title: 'Setup Fixtures',
          resolved: true,
          boundSessionIds: [],
          boundSessions: [{id: 's-d', status: 'archived'}],
          createdAt: now - 300_000,
          lastReplyAt: now - 200_000,
          replyCount: 1,
          hasUnread: false,
        },
      ],
    }),
  );

  assert.ok(host.querySelector('.mp-po-shell'));
  assert.ok(host.querySelector('.mp-po-coordinator'));
  assert.ok(host.querySelector('.mp-po-right'));
  // Threads Home is DEFAULT view (no activeTab passed)
  assert.ok(host.querySelector('[data-po-tab="threads"]')!.className.includes('is-active'));
  assert.ok(host.querySelector('.mp-po-welcome-heading')!.textContent.includes('Welcome back, Alex.'));
  assert.ok(host.querySelector('.mp-po-welcome-sub')!.textContent.includes('Nothing is waiting on you.'));

  // Waiting group hidden when 0, Working / Idle / Resolved shown
  assert.equal(host.querySelector('[data-po-thread-group="waiting"]'), null);
  const workingGroup = host.querySelector('[data-po-thread-group="working"]')!;
  assert.ok(workingGroup);
  assert.ok(workingGroup.textContent.includes('Audit API Routes'));
  assert.ok(workingGroup.textContent.includes('1/2'));
  assert.ok(host.querySelector('[data-po-thread-group="idle"]')!.textContent.includes('mp/polish-styles'));
  assert.ok(host.querySelector('[data-po-thread-group="resolved"]'));

  // Collapse Working group and verify state persists across background update
  host.querySelector('[data-po-toggle-group="working"]')!.click();
  assert.equal(
    host.querySelector('[data-po-thread-group="working"] [data-po-thread="t-work"]'),
    null,
  );

  // 1 waiting thread -> "1 thread is waiting on you."
  handle.update(
    makeBaseState({
      threads: [
        {
          id: 't-wait',
          projectId: 'proj-w5',
          title: 'Auth Token Question',
          threadStatus: 'needs_input',
          boundSessionIds: [],
          boundSessions: [{id: 's-1', status: 'active', boardStatus: 'blocked'}],
          createdAt: now - 20_000,
          lastReplyAt: now - 5_000,
          replyCount: 1,
          hasUnread: true,
        },
        {
          id: 't-work',
          projectId: 'proj-w5',
          title: 'Audit API Routes',
          body: '- [x] Inspect auth routes\n- [ ] Verify rate limits',
          boundSessionIds: [],
          boundSessions: [{id: 's-w', status: 'active', working: true}],
          createdAt: now - 30_000,
          lastReplyAt: now - 10_000,
          replyCount: 1,
          hasUnread: false,
        },
      ],
    }),
  );

  assert.ok(host.querySelector('.mp-po-welcome-sub')!.textContent.includes('1 thread is waiting on you.'));
  assert.ok(host.querySelector('[data-po-thread-group="waiting"]'));
  // Working group remains collapsed across update
  assert.equal(
    host.querySelector('[data-po-thread-group="working"] [data-po-thread="t-work"]'),
    null,
  );

  // List -> Board view toggle works without stacking any drawer underneath
  host.querySelector('[data-po-action="toggle-board-view"]')!.click();
  assert.ok(host.querySelector('.mp-po-threads-board'));
  assert.equal(host.querySelector('.mp-po-thread-drawer'), null);

  handle.unmount();
});

test('Wave 5.2: Left Coordinator stream renders routing caption, inline Thread Cards, @Thread pills, Decision View thread, and Retry', async () => {
  const {doc, ProjectOverview} = loadProjectOverviewHarness(true);
  const host = doc.createElement('div');
  const retried: string[] = [];
  const now = Date.now();

  const handle = ProjectOverview.mountManaged(
    host,
    makeBaseState({
      threads: [
        {
          id: 't-auth',
          projectId: 'proj-w5',
          title: 'Fix Auth Flow',
          threadStatus: 'working',
          boundSessionIds: [],
          boundSessions: [{id: 's-1', status: 'active', working: true}],
          createdAt: now - 10_000,
          lastReplyAt: now - 2_000,
          replyCount: 3,
          hasUnread: false,
        },
        {
          id: 't-ui',
          projectId: 'proj-w5',
          title: 'Update Header',
          threadStatus: 'needs_input',
          boundSessionIds: [],
          boundSessions: [{id: 's-2', status: 'active', boardStatus: 'blocked'}],
          createdAt: now - 20_000,
          lastReplyAt: now - 4_000,
          replyCount: 1,
          hasUnread: true,
          messages: [
            {id: 'm1', author: 'worker', text: 'Need confirmation on icon size', timestamp: now - 4_000},
          ],
        },
      ],
      activeRuns: {
        't-auth': {
          running: true,
          startedAt: now - 5_000,
          answer: 'Scanning token refresh handler',
          thinking: '',
          trajectory: [{name: 'Read', status: 'running', summary: 'auth.ts'}],
        },
      },
      timeline: [
        {
          seq: 1,
          id: 'g-1',
          type: 'goal',
          timestamp: now - 12_000,
          author: 'user',
          text: 'Fix auth and header layout',
        },
        {
          seq: 2,
          id: 'ts-1',
          type: 'thread_started',
          timestamp: now - 11_000,
          threadId: 't-auth',
          author: 'coordinator',
          text: 'Fix Auth Flow',
        },
        {
          seq: 3,
          id: 'mr-1',
          type: 'message_routed',
          timestamp: now - 10_500,
          threadId: 't-ui',
          author: 'coordinator',
          text: 'Check header spacing',
          hiddenFromChat: true,
        },
        {
          seq: 4,
          id: 'cp-1',
          type: 'coordinator_post',
          timestamp: now - 9_000,
          author: 'coordinator',
          text: 'Dispatched @Fix Auth Flow and `Fix Auth Flow` in code, plus Update Header for layout.',
        },
        {
          seq: 5,
          id: 'err-1',
          type: 'activity',
          timestamp: now - 1_000,
          author: 'system',
          text: 'Coordinator error: Upstream timeout',
          payload: {error: true, failedPrompt: 'Fix auth and header layout'},
        },
      ],
      decisions: [
        {
          id: 'dec-ui',
          projectId: 'proj-w5',
          threadId: 't-ui',
          question: 'Keep 48px header?',
          options: [{label: 'Yes', consequence: 'Matches video'}],
          recommended: 0,
          status: 'open',
          createdAt: now - 3_000,
        },
      ],
      actions: {
        onBack: () => {},
        onSendGoal: async (text: string) => {
          retried.push(text);
        },
        onAnswerDecision: async () => {},
        onSelectThread: async () => {},
        onResolveThread: async () => {},
        onRemindThread: async () => {},
        onInspectDiff: async () => {},
        onDiscardThread: async () => {},
        onSaveFile: async () => ({ok: true}),
        onSaveMemory: async () => ({ok: true}),
        onSaveSettings: async () => ({ok: true}),
        onTogglePinArtifact: async () => {},
        onDismissRecap: async () => {},
        onUpdateSections: async () => {},
      },
    }),
  );

  // Routing caption directly under user turn
  const caption = host.querySelector('.mp-po-routing-caption')!;
  assert.ok(caption);
  assert.ok(caption.textContent.includes('Sent to 2 threads'));

  // Inline Thread Status Card
  const inlineCard = host.querySelector('[data-po-select-inline-thread="t-auth"]')!;
  assert.ok(inlineCard);
  assert.ok(inlineCard.textContent.includes('Fix Auth Flow'));

  // Inline @Thread mention pills in prose (outside <code>!)
  const mentionBtn = host.querySelector('[data-po-thread-mention="t-auth"]')!;
  assert.ok(mentionBtn);
  assert.ok(mentionBtn.getAttribute('title')?.includes('3 replies'));
  const codeEl = host.querySelector('.mp-po-assistant-turn code');
  assert.ok(codeEl);
  assert.equal(codeEl.querySelector('[data-po-thread-mention]'), null);

  // Decision card has "View thread" button
  const viewThreadBtn = host.querySelector('.mp-po-decision-card [data-po-thread="t-ui"]');
  assert.ok(viewThreadBtn);
  assert.ok(viewThreadBtn.textContent.includes('View thread'));

  // Retry button works
  host.querySelector('[data-po-retry-goal]')!.click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(retried, ['Fix auth and header layout']);

  handle.unmount();
});

test('Wave 5.3: Clicking inline thread card replaces Right Pane with Focused Thread Detail (no stacked Kanban), shows forwarded divider, live worker stream + retryNotice, Worker Retry, and breadcrumb back', async () => {
  const {doc, ProjectOverview} = loadProjectOverviewHarness(true);
  const host = doc.createElement('div');
  const stoppedIds: Array<string | undefined> = [];
  const retriedMessages: Array<{threadId: string; text: string}> = [];
  const now = Date.now();

  const handle = ProjectOverview.mountManaged(
    host,
    makeBaseState({
      threads: [
        {
          id: 't-worker',
          projectId: 'proj-w5',
          title: 'Build Parser',
          body: '- [x] Read schema\n- [ ] Write parser',
          lastPromptText: 'Write parser cleanly',
          boundSessionIds: ['sess-w'],
          boundSessions: [{id: 'sess-w', status: 'active', working: true}],
          worktreeBranch: 'mp/build-parser',
          worktreePath: 'D:/repo/.mp-worktrees/t-worker',
          createdAt: now - 30_000,
          lastReplyAt: now - 5_000,
          replyCount: 2,
          hasUnread: true,
          messages: [
            {
              id: 'm-fwd',
              author: 'coordinator',
              text: 'Please implement the parser module.',
              timestamp: now - 25_000,
              routeFromOverview: true,
            },
            {
              id: 'm-err',
              author: 'worker',
              text: 'Worker error: Rate limit exceeded (429)',
              timestamp: now - 10_000,
            },
          ],
        },
      ],
      activeRuns: {
        't-worker': {
          running: true,
          startedAt: now - 4_000,
          answer: 'Writing **AST** visitor...',
          thinking: 'Checking edge cases',
          trajectory: [{name: 'Edit', status: 'running', summary: 'parser.ts'}],
          retryNotice: 'Rate limited (429), retrying in 4s...',
        },
      },
      timeline: [
        {
          seq: 1,
          id: 'g-1',
          type: 'goal',
          timestamp: now - 30_000,
          author: 'user',
          text: 'Build the parser',
        },
        {
          seq: 2,
          id: 'ts-1',
          type: 'thread_started',
          timestamp: now - 29_000,
          threadId: 't-worker',
          author: 'coordinator',
          text: 'Build Parser',
        },
      ],
      actions: {
        onBack: () => {},
        onSendGoal: async () => {},
        onStopRun: async (threadId?: string) => {
          stoppedIds.push(threadId);
        },
        onMessageThread: async (threadId: string, text: string) => {
          retriedMessages.push({threadId, text});
          return {ok: true};
        },
        onAnswerDecision: async () => {},
        onSelectThread: async () => {},
        onResolveThread: async () => {},
        onRemindThread: async () => {},
        onInspectDiff: async () => {},
        onDiscardThread: async () => {},
        onSaveFile: async () => ({ok: true}),
        onSaveMemory: async () => ({ok: true}),
        onSaveSettings: async () => ({ok: true}),
        onTogglePinArtifact: async () => {},
        onDismissRecap: async () => {},
        onUpdateSections: async () => {},
      },
    }),
  );

  // Single thread routing caption uses "one thread"
  assert.ok(host.querySelector('.mp-po-routing-caption')!.textContent.includes('Sent to one thread'));

  // Click inline thread card
  host.querySelector('[data-po-select-inline-thread="t-worker"]')!.click();

  // Right Pane replaced by Focused Thread Detail (NO stacked board!)
  assert.equal(host.querySelector('.mp-po-threads-board'), null);
  assert.equal(host.querySelector('.mp-po-welcome-heading'), null);
  assert.ok(host.querySelector('.mp-po-thread-focused'));

  // Breadcrumb: Threads / Build Parser
  const breadcrumb = host.querySelector('.mp-po-right-header')!;
  assert.ok(breadcrumb.textContent.includes('Threads'));
  assert.ok(breadcrumb.textContent.includes('Build Parser'));

  // Forwarded divider
  assert.ok(host.querySelector('.mp-po-forwarded-bar')!.textContent.includes('Message forwarded from project chat'));

  // Live worker stream + retryNotice + Stop button
  const liveWorker = host.querySelector('[data-po-thread-live-run="t-worker"]')!;
  assert.ok(liveWorker);
  assert.ok(liveWorker.textContent.includes('Rate limited (429), retrying in 4s...'));
  assert.ok(liveWorker.innerHTML.includes('<strong>AST</strong>'));
  host.querySelector('[data-po-action="stop-thread-run"]')!.click();
  assert.deepEqual(stoppedIds, ['t-worker']);

  // Worker error callout 1-click retry
  host.querySelector('[data-po-retry-thread="t-worker"]')!.click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(retriedMessages, [{threadId: 't-worker', text: 'Write parser cleanly'}]);

  // Clicking Threads breadcrumb returns smoothly to Threads Home
  host.querySelector('[data-po-action="close-thread"]')!.click();
  assert.equal(host.querySelector('.mp-po-thread-focused'), null);
  assert.ok(host.querySelector('.mp-po-welcome-heading'));

  handle.unmount();
});

test('Wave 5.4: Coordinator & Thread composers expose Model Picker, Effort Picker, and Context Ring saving settings immediately', async () => {
  const {doc, ProjectOverview} = loadProjectOverviewHarness();
  const host = doc.createElement('div');
  const savedPatches: Array<Record<string, unknown>> = [];

  const handle = ProjectOverview.mountManaged(
    host,
    makeBaseState({
      threads: [
        {
          id: 't-1',
          projectId: 'proj-w5',
          title: 'Worker Thread',
          boundSessionIds: [],
          boundSessions: [{id: 's-1', status: 'active'}],
          createdAt: 1000,
          lastReplyAt: 2000,
          replyCount: 0,
          hasUnread: false,
        },
      ],
      actions: {
        onBack: () => {},
        onSendGoal: async () => {},
        onAnswerDecision: async () => {},
        onSelectThread: async () => {},
        onResolveThread: async () => {},
        onRemindThread: async () => {},
        onInspectDiff: async () => {},
        onDiscardThread: async () => {},
        onSaveFile: async () => ({ok: true}),
        onSaveMemory: async () => ({ok: true}),
        onSaveSettings: async (patch: Record<string, unknown>) => {
          savedPatches.push(patch);
          return {ok: true};
        },
        onTogglePinArtifact: async () => {},
        onDismissRecap: async () => {},
        onUpdateSections: async () => {},
      },
    }),
  );

  // Coordinator composer pickers + context ring
  const coordForm = host.querySelector('[data-po-goal-form]')!;
  assert.ok(coordForm.querySelector('.mp-po-context-ring'));
  const coordModelBtn = coordForm.querySelector('[data-po-action="toggle-coord-model"]')!;
  assert.ok(coordModelBtn.textContent.includes('Sonnet 4.5') || coordModelBtn.textContent.includes('claude-sonnet-4-5'));
  coordModelBtn.click();

  const coordPopover = host.querySelector('[data-po-picker="coord-model"]')!;
  assert.ok(coordPopover);
  assert.ok(coordPopover.textContent.includes('Opus 4.1'));
  coordPopover.querySelector('[data-po-pick-coord-model="claude-opus-4-1"]')!.click();

  // Coordinator effort picker
  host.querySelector('[data-po-action="toggle-coord-effort"]')!.click();
  host.querySelector('[data-po-pick-coord-effort="max"]')!.click();

  // Open focused thread & test Worker Model & Effort pickers + Context Ring
  host.querySelector('[data-po-thread="t-1"]')!.click();
  const threadForm = host.querySelector('[data-po-followup-form]')!;
  assert.ok(threadForm.querySelector('.mp-po-context-ring'));

  threadForm.querySelector('[data-po-action="toggle-worker-model"]')!.click();
  const workerPopover = host.querySelector('[data-po-picker="worker-model"]')!;
  assert.ok(workerPopover);
  workerPopover.querySelector('[data-po-pick-worker-model="claude-sonnet-4-5"]')!.click();

  host.querySelector('[data-po-action="toggle-worker-effort"]')!.click();
  host.querySelector('[data-po-pick-worker-effort="low"]')!.click();

  assert.deepEqual(JSON.parse(JSON.stringify(savedPatches)), [
    {multiAgentConfig: {coordinatorModel: 'claude-opus-4-1'}},
    {multiAgentConfig: {coordinatorEffort: 'max'}},
    {multiAgentConfig: {workerModel: 'claude-sonnet-4-5'}},
    {multiAgentConfig: {workerEffort: 'low'}},
  ]);

  handle.unmount();
});

test('Wave 5.5: studio_libraries.ts wires activeRuns for threadId + coordinator, retryNotice, and project_overview.css enforces 50/50 split', () => {
  const libSrc = fs.readFileSync(
    path.join(ROOT, 'electron/renderer/studio_libraries.ts'),
    'utf8',
  );
  assert.match(libSrc, /activeRuns/);
  assert.match(libSrc, /retryNotice/);
  assert.match(libSrc, /run_queued/);
  assert.match(libSrc, /projectsMaStopRun\(\{\s*projectId,\s*threadId\s*\}\)/);
  assert.match(libSrc, /refreshSidebar/);

  const cssSrc = fs.readFileSync(
    path.join(ROOT, 'electron/renderer/project_overview.css'),
    'utf8',
  );
  assert.match(cssSrc, /flex:\s*1\s+1\s+50%/);
  assert.match(cssSrc, /min-width:\s*360px/);
  assert.match(cssSrc, /\.mp-po-inline-thread-card/);
  assert.match(cssSrc, /\.mp-po-thread-mention/);
  assert.match(cssSrc, /\.mp-po-welcome-heading/);
  assert.match(cssSrc, /\.mp-po-picker-popover/);
  assert.match(cssSrc, /\.mp-po-context-ring/);
});

test('Wave 6.1: Coordinator deduplicates errors and hides worker activities, humanizes raw 429/session_busy into calm rows, and Focused Thread collapses Task prompt with flat input-box composers', async () => {
  const {doc, ProjectOverview} = loadProjectOverviewHarness(true);
  const host = doc.createElement('div');
  const now = Date.now();
  const raw429 =
    'backend_error:http_429:{"error":{"type":"rate_limit_error","message":"Rate limit exceeded. Please try again later."}}';

  const handle = ProjectOverview.mountManaged(
    host,
    makeBaseState({
      threads: [
        {
          id: 't-1',
          projectId: 'proj-w5',
          title: 'Audit Entrypoints',
          body: 'Inspect startup sequence carefully.',
          threadStatus: 'needs_input',
          boundSessionIds: [],
          boundSessions: [],
          escalation: {reason: 'Worker paused', question: 'Proceed?'},
          createdAt: now - 15_000,
          lastReplyAt: now - 2_000,
          replyCount: 2,
          hasUnread: true,
          messages: [
            {
              id: 'm-busy',
              author: 'worker',
              text: 'Worker error: session_busy',
              timestamp: now - 4_000,
            },
            {
              id: 'm-ok',
              author: 'worker',
              text: 'Found 3 entrypoints.',
              timestamp: now - 2_000,
            },
          ],
        },
      ],
      activeRuns: {
        coordinator: {
          running: true,
          startedAt: now - 3_000,
          answer: 'Coordinating...',
          thinking: '',
          trajectory: [],
        },
      },
      timeline: [
        {
          seq: 1,
          id: 'g-1',
          type: 'goal',
          timestamp: now - 14_000,
          author: 'user',
          text: 'Audit core entrypoints',
        },
        {
          seq: 2,
          id: 'ts-1',
          type: 'thread_started',
          timestamp: now - 13_000,
          threadId: 't-1',
          author: 'coordinator',
          text: 'Audit Entrypoints',
        },
        {
          seq: 3,
          id: 'act-w',
          type: 'activity',
          timestamp: now - 12_000,
          threadId: 't-1',
          author: 'worker',
          text: 'Reading main.py',
        },
        {
          seq: 4,
          id: 'err-1',
          type: 'error',
          timestamp: now - 11_000,
          author: 'coordinator',
          text: raw429,
          goalText: 'Audit core entrypoints',
        },
        {
          seq: 5,
          id: 'err-2',
          type: 'error',
          timestamp: now - 10_000,
          author: 'coordinator',
          text: raw429,
          goalText: 'Audit core entrypoints',
        },
        {
          seq: 6,
          id: 'ar-1',
          type: 'coordinator_post',
          timestamp: now - 9_000,
          author: 'coordinator',
          text: 'Sent follow-up to Audit Entrypoints.',
        },
      ],
    }),
  );

  const coordStream = host.querySelector('.mp-po-timeline')!;
  const coordCalmErrors = coordStream.querySelectorAll('.mp-po-calm-error');
  assert.equal(coordCalmErrors.length, 1);
  assert.ok(coordCalmErrors[0].querySelector('.mp-po-calm-retry'));
  assert.match(coordCalmErrors[0].textContent, /Rate limit exceeded — switch model or retry/);
  assert.equal(coordStream.textContent.includes('backend_error:http_429'), false);
  assert.equal(coordStream.textContent.includes('Reading main.py'), false);
  assert.equal(coordStream.querySelectorAll('[data-po-escalation="t-1"]').length, 0);
  assert.ok(coordStream.querySelector('.mp-po-thread-mention'));
  assert.ok(coordStream.querySelector('.mp-po-turn-meta-row'));
  assert.ok(coordStream.querySelector('[data-po-copy-text]'));

  const workingDots = coordStream.querySelector('.mp-po-working-dots');
  assert.ok(workingDots);
  assert.equal(workingDots.querySelectorAll('span').length, 3);
  assert.match(coordStream.textContent, /Working/);

  const coordForm = host.querySelector('[data-po-goal-form]')!;
  assert.ok(coordForm.querySelector('.mp-po-input-box'));
  assert.ok(coordForm.querySelector('.mp-po-composer-bar'));
  assert.equal(coordForm.querySelectorAll('.mp-po-composer-send.is-primary').length, 0);

  host.querySelector('[data-po-thread="t-1"]')!.click();
  const threadFeed = host.querySelector('.mp-po-thread-feed')!;
  const disclosure = threadFeed.querySelector('details.mp-po-brief-disclosure')!;
  assert.ok(disclosure);
  assert.equal(disclosure.hasAttribute('open'), false);
  assert.match(disclosure.textContent, /Task prompt/);
  assert.match(disclosure.textContent, /Inspect startup sequence carefully\./);

  const threadCalmErrors = threadFeed.querySelectorAll('.mp-po-calm-error');
  assert.equal(threadCalmErrors.length, 1);
  assert.match(threadCalmErrors[0].textContent, /Session busy — ready to retry/);
  assert.equal(threadFeed.textContent.includes('Worker error: session_busy'), false);
  assert.ok(threadFeed.querySelector('.mp-po-turn-meta-row'));
  assert.ok(threadFeed.querySelector('[data-po-copy-text]'));

  const threadForm = host.querySelector('[data-po-followup-form]')!;
  const threadInputBox = threadForm.querySelector('.mp-po-input-box')!;
  assert.ok(threadInputBox);
  assert.ok(threadInputBox.querySelector('.mp-po-composer-send.is-inline-return'));
  assert.ok(threadForm.querySelector('.mp-po-composer-bar'));
  assert.equal(threadForm.querySelectorAll('.mp-po-composer-send.is-primary').length, 0);

  handle.unmount();
});

test('Wave 6.2: Sidebar opens projects directly on row click and CSS enforces calm promo styling without orange primary send', () => {
  const studioSrc = fs.readFileSync(
    path.join(ROOT, 'electron/renderer/studio.ts'),
    'utf8',
  );
  assert.match(studioSrc, /dataset\.projectDirectOpen/);
  assert.match(studioSrc, /if\s*\(directKey\s*&&\s*!clickedChevron\)/);
  assert.match(studioSrc, /libraryUi\.openProject\(matched\?\.id\s*\|\|\s*directKey\)/);

  const layoutCss = fs.readFileSync(
    path.join(ROOT, 'electron/renderer/studio_layout.css'),
    'utf8',
  );
  const badgeBlockMatch = layoutCss.match(/\.mp-project-badge-count\s*\{[\s\S]*?\.mp-project-badge-dot\s*\{[\s\S]*?\}/);
  assert.ok(badgeBlockMatch, 'expected .mp-project-badge-* block in studio_layout.css');
  assert.equal(/#d97757/i.test(badgeBlockMatch[0]), false);

  const poCss = fs.readFileSync(
    path.join(ROOT, 'electron/renderer/project_overview.css'),
    'utf8',
  );
  assert.match(poCss, /\.mp-po-calm-error/);
  assert.match(poCss, /\.mp-po-input-box/);
  assert.match(poCss, /\.mp-po-composer-bar/);
  assert.match(poCss, /\.mp-po-working-dots/);
  assert.match(poCss, /\.mp-po-brief-disclosure/);
  assert.match(poCss, /\.mp-po-thread-mention[\s\S]*?rgba\(59,\s*130,\s*246/);
  assert.equal(/\.mp-po-composer-send\.is-primary/.test(poCss), false);
});

