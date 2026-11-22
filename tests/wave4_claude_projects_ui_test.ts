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

function loadProjectOverviewHarness(withChatMarkdown = true): {
  doc: MockDocument;
  ProjectOverview: ProjectOverviewApi;
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
    ProjectOverview: sandbox.ProjectOverview as ProjectOverviewApi,
  };
}

function makeBaseState(
  overrides: Partial<ProjectOverviewState> = {},
): ProjectOverviewState {
  const defaultActions: ProjectOverviewActions = {
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
      id: 'proj-w4',
      root: 'D:/repo',
      name: 'Claude Parity Project',
      goal: 'Ship Overview v2',
      color: '#D97757',
      projectIcon: 'Projects',
      paused: false,
      archived: false,
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

test('Wave 4.1: Airy empty state renders Serif heading, 3 starter pills, centered composer, and submits starter prompt', async () => {
  const {doc, ProjectOverview} = loadProjectOverviewHarness();
  const host = doc.createElement('div');
  const sentGoals: string[] = [];

  ProjectOverview.mountManaged(
    host as unknown as HTMLElement,
    makeBaseState({
      activeTab: 'overview',
      actions: {
        onBack: () => {},
        onSendGoal: async text => {
          sentGoals.push(text);
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

  assert.ok(host.querySelector('.mp-po-empty-workspace'));
  assert.ok(host.querySelector('.mp-po-empty-heading'));
  assert.equal(host.querySelectorAll('[data-po-starter-prompt]').length, 3);
  assert.ok(host.querySelector('.mp-po-composer.is-centered'));

  // Empty statusPageHtml must NOT render iframe or old yellow callout box
  assert.equal(host.querySelector('[data-po-status-iframe]'), null);
  assert.ok(
    host.textContent.includes(
      'Project overview updates live as the Coordinator delegates worker threads.',
    ),
  );

  host.querySelector('[data-po-starter-prompt]')!.click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(sentGoals, ['Audit project architecture']);
});

test('Wave 4.2: Header icon+color picker saves immediately, right tile collapses/reopens, and Threads board expands', async () => {
  const {doc, ProjectOverview} = loadProjectOverviewHarness();
  const host = doc.createElement('div');
  const savedPatches: Array<Record<string, unknown>> = [];

  ProjectOverview.mountManaged(
    host as unknown as HTMLElement,
    makeBaseState({
      activeTab: 'overview',
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
        onSaveSettings: async patch => {
          savedPatches.push(patch);
          return {ok: true};
        },
        onTogglePinArtifact: async () => {},
        onDismissRecap: async () => {},
        onUpdateSections: async () => {},
      },
    }),
  );

  // Open icon & color picker
  host.querySelector('[data-po-action="toggle-icon-picker"]')!.click();
  assert.ok(host.querySelector('.mp-po-icon-popover'));
  host.querySelector('[data-po-pick-color="#2566D0"]')!.click();
  host.querySelector('[data-po-pick-icon="GitBranch"]')!.click();
  assert.deepEqual(JSON.parse(JSON.stringify(savedPatches)), [
    {color: '#2566D0'},
    {projectIcon: 'GitBranch'},
  ]);

  // Collapse & reopen right tile
  assert.equal(host.querySelector('.mp-po-right')!.hasAttribute('hidden'), false);
  host.querySelector('[data-po-action="toggle-right-tile"]')!.click();
  assert.equal(host.querySelector('.mp-po-right')!.hasAttribute('hidden'), true);
  host.querySelector('[data-po-action="toggle-right-tile"]')!.click();
  assert.equal(host.querySelector('.mp-po-right')!.hasAttribute('hidden'), false);

  // Switch to Threads and expand Kanban
  host.querySelector('[data-po-tab="threads"]')!.click();
  host.querySelector('[data-po-action="toggle-expand-board"]')!.click();
  assert.ok(host.querySelector('.mp-po-shell.is-board-expanded'));
  assert.ok(host.querySelector('.mp-po-right.is-expanded'));
});

test('Wave 4.3: Conversation stream renders user bubble, ChatMarkdown prose, collapsible tools/thinking, live stream + Stop button, and error Retry', async () => {
  const {doc, ProjectOverview} = loadProjectOverviewHarness(true);
  const host = doc.createElement('div');
  const retriedPrompts: string[] = [];
  let stopCount = 0;

  const handle = ProjectOverview.mountManaged(
    host as unknown as HTMLElement,
    makeBaseState({
      timeline: [
        {
          seq: 1,
          id: 'ev-goal',
          type: 'goal',
          timestamp: 1000,
          author: 'user',
          text: 'Inspect API surface',
        },
        {
          seq: 2,
          id: 'ev-post',
          type: 'coordinator_post',
          timestamp: 2000,
          author: 'coordinator',
          text: '### Summary\nChecked **3 endpoints** safely.',
          payload: {
            thinking: 'Let me inspect the main IPC handlers first.',
            tools: [
              {name: 'Project.start_thread', status: 'done', summary: 'Started worker'},
            ],
          },
        },
        {
          seq: 3,
          id: 'ev-err',
          type: 'activity',
          timestamp: 3000,
          author: 'system',
          text: 'Coordinator error: Model timeout',
          payload: {error: true, failedPrompt: 'Inspect API surface'},
        },
      ],
      activeRun: {
        running: true,
        startedAt: 4000,
        answer: 'Streaming **partial** answer',
        thinking: 'Checking tests...',
        trajectory: [{name: 'Read', status: 'running', summary: 'electron/main.ts'}],
      },
      actions: {
        onBack: () => {},
        onSendGoal: async text => {
          retriedPrompts.push(text);
        },
        onStopRun: async () => {
          stopCount += 1;
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

  // User bubble + borderless markdown + collapsible tools/thinking
  assert.equal(host.querySelector('.mp-po-event'), null);
  assert.ok(host.querySelector('.mp-po-user-bubble')!.textContent.includes('Inspect API surface'));
  assert.ok(host.querySelector('.mp-po-assistant-turn .mp-chat-markdown'));
  assert.ok(host.innerHTML.includes('<strong>3 endpoints</strong>'));
  const details = host.querySelector('.mp-po-tools-summary')!;
  assert.ok(details.textContent.includes('Thought process'));
  assert.ok(details.textContent.includes('Project.start_thread'));

  // Live streaming turn & Stop button
  const liveTurn = host.querySelector('[data-po-live-run]')!;
  assert.ok(liveTurn);
  assert.ok(liveTurn.textContent.includes('Working'));
  assert.ok(liveTurn.innerHTML.includes('<strong>partial</strong>'));
  const stopBtn = host.querySelector('[data-po-action="stop-run"]')!;
  assert.ok(stopBtn);
  stopBtn.click();
  assert.equal(stopCount, 1);

  // Error turn with 1-click Retry
  const retryBtn = host.querySelector('[data-po-retry-goal]')!;
  assert.ok(retryBtn);
  retryBtn.click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(retriedPrompts, ['Inspect API surface']);

  // Fallback without ChatMarkdown still renders cleanly
  const {doc: doc2, ProjectOverview: PoNoMd} = loadProjectOverviewHarness(false);
  const host2 = doc2.createElement('div');
  PoNoMd.mountManaged(
    host2 as unknown as HTMLElement,
    makeBaseState({
      timeline: [
        {
          seq: 1,
          id: 'ev-p',
          type: 'coordinator_post',
          timestamp: 1000,
          author: 'coordinator',
          text: 'Plain paragraph fallback.',
        },
      ],
    }),
  );
  assert.ok(host2.querySelector('.mp-po-assistant-turn')!.textContent.includes('Plain paragraph fallback.'));

  handle.unmount();
});

test('Wave 4.4: Overview panel v2 groups Needs attention, Active threads, Artifacts, Completed threads, and opens Settings as centered modal', () => {
  const {doc, ProjectOverview} = loadProjectOverviewHarness();
  const host = doc.createElement('div');
  let withdrawnId = '';

  ProjectOverview.mountManaged(
    host as unknown as HTMLElement,
    makeBaseState({
      activeTab: 'overview',
      threads: [
        {
          id: 't-attn',
          projectId: 'proj-w4',
          title: 'Blocked Auth Thread',
          boundSessionIds: [],
          boundSessions: [{id: 's1', status: 'active', boardStatus: 'blocked'}],
          createdAt: 1000,
          lastReplyAt: 2000,
          replyCount: 1,
          hasUnread: true,
        },
        {
          id: 't-active',
          projectId: 'proj-w4',
          title: 'Live Worker Thread',
          boundSessionIds: [],
          boundSessions: [{id: 's2', status: 'active', working: true}],
          createdAt: 1000,
          lastReplyAt: 2000,
          replyCount: 1,
          hasUnread: false,
        },
        {
          id: 't-done',
          projectId: 'proj-w4',
          title: 'Finished Thread',
          resolved: true,
          boundSessionIds: [],
          boundSessions: [{id: 's3', status: 'archived'}],
          createdAt: 1000,
          lastReplyAt: 2000,
          replyCount: 1,
          hasUnread: false,
        },
      ],
      decisions: [
        {
          id: 'dec-w4',
          projectId: 'proj-w4',
          question: 'Use worktrees?',
          options: [
            {label: 'Yes', consequence: 'Isolated'},
            {label: 'No', consequence: 'Shared'},
          ],
          recommended: 0,
          status: 'open',
          createdAt: 1000,
        },
      ],
      artifacts: [
        {
          id: 'art-w4',
          projectId: 'proj-w4',
          kind: 'artifact',
          title: 'Audit Spec',
          pathOrUrl: 'docs/audit.md',
          pinned: false,
          createdAt: 1000,
          updatedAt: 2000,
        },
      ],
      actions: {
        onBack: () => {},
        onSendGoal: async () => {},
        onAnswerDecision: async () => {},
        onWithdrawDecision: async id => {
          withdrawnId = id;
        },
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

  // Overview v2 structured sections
  assert.ok(host.querySelector('section[aria-label="Needs attention"] h2')!.textContent.includes('(2)'));
  assert.ok(host.querySelector('section[aria-label="Active threads"] .prog.is-live'));
  assert.ok(host.querySelector('section[aria-label="Artifacts"] .mp-po-v2-artifact-row'));
  assert.ok(host.querySelector('section[aria-label="Completed threads"] ul.threads.done'));

  // Withdraw decision button
  host.querySelector('[data-po-withdraw-decision="dec-w4"]')!.click();
  assert.equal(withdrawnId, 'dec-w4');

  // Settings opens as centered modal WITHOUT wiping out Overview panel behind it
  host.querySelector('[data-po-tab="settings"]')!.click();
  assert.ok(host.querySelector('.mp-po-settings-modal'));
  assert.ok(host.querySelector('[data-po-settings-form]'));
  assert.ok(host.querySelector('section[aria-label="Active threads"]'));

  // Close restores Overview active tab
  host.querySelector('[data-po-action="close-settings-modal"]')!.click();
  assert.equal(host.querySelector('.mp-po-settings-modal'), null);
  assert.ok(host.querySelector('[data-po-tab="overview"]')!.className.includes('is-active'));

  // Files & Memory segmented pill switches editor cleanly
  host.querySelector('[data-po-tab="files"]')!.click();
  assert.equal(host.querySelectorAll('.mp-po-editor-pane')[1].hasAttribute('hidden'), true);
  host.querySelector('[data-po-files-subtab="memory"]')!.click();
  assert.equal(host.querySelectorAll('.mp-po-editor-pane')[0].hasAttribute('hidden'), true);
  assert.equal(host.querySelectorAll('.mp-po-editor-pane')[1].hasAttribute('hidden'), false);
});

test('Wave 4.5: studio_libraries.ts wires projectsMaStopRun and mutates activeRuns/activeRun in-place on run_started/stream_progress without polling overview state', () => {
  const libSrc = fs.readFileSync(
    path.join(ROOT, 'electron/renderer/studio_libraries.ts'),
    'utf8',
  );
  assert.match(libSrc, /projectsMaStopRun/);
  assert.match(libSrc, /onStopRun:/);
  assert.match(libSrc, /run_started/);
  assert.match(libSrc, /stream_progress/);
  assert.match(libSrc, /latestOverviewState/);

  const cssSrc = fs.readFileSync(
    path.join(ROOT, 'electron/renderer/project_overview.css'),
    'utf8',
  );
  assert.match(cssSrc, /height:\s*48px/);
  assert.match(cssSrc, /flex:\s*1\s+1\s+50%/);
  assert.match(cssSrc, /\.mp-po-settings-modal/);
  assert.match(cssSrc, /grid-template-columns:\s*repeat\(4,\s*minmax\(175px,\s*1fr\)\)/);
  assert.match(cssSrc, /740px/);
});
