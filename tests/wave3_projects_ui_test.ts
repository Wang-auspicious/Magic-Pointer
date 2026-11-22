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

function matchesSelectorPart(el: MockElement, selector: string): boolean {
  const tokens = selector.trim().split(/\s+/).filter(Boolean);
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

  private serializeChildren(): string {
    return this.childNodes
      .map(node => {
        if (!(node instanceof MockElement)) {
          return node.textContentValue;
        }
        const attrPairs = Object.entries(node.attributes)
          .map(([k, v]) => (v === '' ? k : `${k}="${encodeAttr(v)}"`))
          .join(' ');
        const open = attrPairs
          ? `<${node.tagName} ${attrPairs}>`
          : `<${node.tagName}>`;
        if (VOID_TAGS.has(node.tagName)) {
          return open;
        }
        return `${open}${node.serializeChildren()}</${node.tagName}>`;
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

interface LoadedHarness {
  doc: MockDocument;
  ProjectOverview: ProjectOverviewApi;
}

function loadProjectOverviewHarness(): LoadedHarness {
  const tsSource = fs.readFileSync(
    path.join(ROOT, 'electron/renderer/project_overview.ts'),
    'utf8',
  );
  assert.equal(/^\s*(?:import|export)\s/m.test(tsSource), false);

  const compiled = ts.transpileModule(tsSource, {
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
  vm.runInContext(compiled, sandbox);

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
    onAnswerDecision: async () => {},
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
      id: 'proj-w3',
      root: 'D:/repo',
      name: 'Wave 3 Project',
      goal: 'Ship multi-agent UI',
      paused: false,
      archived: false,
    },
    threads: [
      {
        id: 'thr-1',
        projectId: 'proj-w3',
        title: 'Audit IPC',
        body: 'Check all handlers',
        boundSessionIds: ['sess-1'],
        boundSessions: [{id: 'sess-1', status: 'active', working: true}],
        createdAt: 1000,
        lastReplyAt: 2000,
        replyCount: 2,
        hasUnread: true,
        worktreeBranch: 'mp/audit-ipc',
        worktreePath: 'D:/repo/.mp-worktrees/thr-1',
        messages: [
          {
            id: 'm-1',
            author: 'user',
            text: 'Start auditing IPC endpoints',
            timestamp: 1000,
          },
          {
            id: 'm-2',
            author: 'worker',
            text: 'Found 3 endpoints to verify.',
            timestamp: 2000,
          },
        ],
      },
      {
        id: 'thr-2',
        projectId: 'proj-w3',
        title: 'Review CSS',
        boundSessionIds: [],
        boundSessions: [{id: 'sess-2', status: 'active', boardStatus: 'review'}],
        createdAt: 1500,
        lastReplyAt: 2500,
        replyCount: 0,
        hasUnread: false,
      },
    ],
    timeline: [
      {
        seq: 1,
        id: 'ev-1',
        type: 'coordinator_post',
        timestamp: 1000,
        author: 'coordinator',
        text: 'Initial kickoff.',
      },
    ],
    decisions: [],
    artifacts: [
      {
        id: 'art-1',
        projectId: 'proj-w3',
        kind: 'artifact',
        title: 'Design Spec',
        pathOrUrl: 'docs/spec.md',
        pinned: true,
        createdAt: 1000,
        updatedAt: 2000,
      },
    ],
    files: [{path: 'notes/plan.md', size: 42, updatedAt: 1000}],
    memory: {path: '/MEMORY.md', content: '# Shared', sha256: 'sha-1'},
    ...overrides,
    actions: {
      ...defaultActions,
      ...(overrides.actions || {}),
    },
  };
}

test('Wave 3.1: mountManaged preserves tabs, selectedThreadId, drafts, modal state, filters, and scroll across live updates while keeping mount() compatible', async () => {
  const {doc, ProjectOverview} = loadProjectOverviewHarness();
  const host = doc.createElement('div');

  const legacyUnmount = ProjectOverview.mount(
    host as unknown as HTMLElement,
    makeBaseState(),
  );
  assert.equal(typeof legacyUnmount, 'function');
  legacyUnmount();
  assert.equal(host.children.length, 0);

  const handle = ProjectOverview.mountManaged(
    host as unknown as HTMLElement,
    makeBaseState({
      actions: {
        onBack: () => {},
        onSendGoal: async () => {},
        onAnswerDecision: async () => {},
        onSelectThread: async () => {},
        onResolveThread: async () => {},
        onRemindThread: async () => {},
        onInspectDiff: async () =>
          new Promise(resolve => {
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  diff: '+added\n-removed',
                  summary: '1 file',
                  files: ['a.ts'],
                }),
              15,
            );
          }),
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

  // Switch to Threads tab, open New Thread form, type drafts, open focused thread, type goal draft
  host.querySelector('[data-po-tab="threads"]')!.click();
  host.querySelector('[data-po-action="open-new-thread"]')!.click();

  const titleInput = host.querySelector(
    '[data-po-new-thread-form] input[name="title"]',
  )!;
  titleInput.value = 'Draft Title';
  titleInput.dispatchEvent(new MockEvent('input', {target: titleInput}));

  const promptInput = host.querySelector(
    '[data-po-new-thread-form] textarea[name="prompt"]',
  )!;
  promptInput.value = 'Draft Prompt';
  promptInput.dispatchEvent(new MockEvent('input', {target: promptInput}));

  host.querySelector('[data-po-thread="thr-1"]')!.click();

  const goalArea = host.querySelector('[data-po-goal-form] textarea')!;
  goalArea.value = 'Keep this goal draft';
  goalArea.dispatchEvent(new MockEvent('input', {target: goalArea}));

  const timelineEl = host.querySelector('.mp-po-timeline')!;
  timelineEl.scrollTop = 140;
  const rightEl = host.querySelector('.mp-po-right-body')!;
  rightEl.scrollTop = 220;

  // Open diff modal from Focused Thread header
  host.querySelector('[data-po-diff="thr-1"]')!.click();
  assert.ok(host.querySelector('.mp-po-diff-modal'));

  // Push live background update while diff modal is loading
  const base = makeBaseState();
  handle.update({
    ...base,
    timeline: [
      ...base.timeline,
      {
        seq: 2,
        id: 'ev-2',
        type: 'worker_post',
        timestamp: 3000,
        author: 'worker',
        text: 'Background update arrived!',
      },
    ],
  });

  // Still on Threads tab with Focused Thread View intact (NOT reset!)
  assert.ok(
    host
      .querySelector('[data-po-tab="threads"]')!
      .className.includes('is-active'),
  );
  assert.ok(host.innerHTML.includes('Background update arrived!'));
  assert.ok(host.querySelector('.mp-po-thread-focused'));
  assert.ok(host.querySelector('.mp-po-diff-modal'));
  assert.equal(
    host.querySelector('[data-po-goal-form] textarea')!.value,
    'Keep this goal draft',
  );
  assert.equal(host.querySelector('.mp-po-timeline')!.scrollTop, 140);
  assert.equal(host.querySelector('.mp-po-right-body')!.scrollTop, 220);

  await new Promise(resolve => setTimeout(resolve, 35));
  assert.ok(host.querySelector('.mp-po-diff-pre'));

  // Return to Threads Home via breadcrumb & confirm New Thread drafts persisted
  host.querySelector('[data-po-action="close-diff-modal"]')!.click();
  host.querySelector('[data-po-action="close-thread"]')!.click();
  assert.equal(
    host.querySelector('[data-po-new-thread-form] input[name="title"]')!.value,
    'Draft Title',
  );
  assert.equal(
    host.querySelector('[data-po-new-thread-form] textarea[name="prompt"]')!
      .value,
    'Draft Prompt',
  );

  // Verify artifact filter/sort persist across updates
  host.querySelector('[data-po-tab="artifacts"]')!.click();
  host.querySelector('[data-po-art-filter="pinned"]')!.click();
  const sortSel = host.querySelector('[data-po-art-sort]')!;
  sortSel.value = 'recent';
  sortSel.dispatchEvent(new MockEvent('change', {target: sortSel}));

  handle.update(makeBaseState());
  assert.ok(
    host
      .querySelector('[data-po-art-filter="pinned"]')!
      .className.includes('is-active'),
  );
  assert.equal(host.querySelector('[data-po-art-sort]')!.value, 'recent');

  handle.unmount();
  assert.equal(host.children.length, 0);
});

test('Wave 3.2: + New Thread inline form submits onStartThread, clears draft, selects created thread, and respects read-only mode', async () => {
  const {doc, ProjectOverview} = loadProjectOverviewHarness();
  const host = doc.createElement('div');
  const startedCalls: Array<{
    title?: string;
    prompt: string;
    useWorktree: boolean;
  }> = [];
  let refreshCount = 0;

  const createdThread: ProjectOverviewThread = {
    id: 'thr-new',
    projectId: 'proj-w3',
    title: 'Fix auth bug',
    body: 'Investigate token expiry',
    boundSessionIds: [],
    boundSessions: [{id: 's-new', status: 'active', working: true}],
    createdAt: 4000,
    lastReplyAt: 4000,
    replyCount: 0,
    hasUnread: false,
    worktreeBranch: 'mp/fix-auth',
    messages: [],
  };

  const handle = ProjectOverview.mountManaged(
    host as unknown as HTMLElement,
    makeBaseState({
      activeTab: 'threads',
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
        onSaveSettings: async () => ({ok: true}),
        onTogglePinArtifact: async () => {},
        onDismissRecap: async () => {},
        onUpdateSections: async () => {},
        onRefresh: async () => {
          refreshCount += 1;
        },
        onStartThread: async input => {
          startedCalls.push({
            title: input.title,
            prompt: input.prompt,
            useWorktree: input.useWorktree,
          });
          return {ok: true, thread: createdThread};
        },
      },
    }),
  );

  host.querySelector('[data-po-tab="overview"]')!.click();
  host.querySelector('[data-po-action="refresh"]')!.click();
  assert.equal(refreshCount, 1);
  host.querySelector('[data-po-tab="threads"]')!.click();

  const toggleBtn = host.querySelector('[data-po-action="open-new-thread"]')!;
  assert.ok(toggleBtn);
  toggleBtn.click();

  const form = host.querySelector('[data-po-new-thread-form]')!;
  assert.ok(form);
  const worktreeCb = form.querySelector('input[name="useWorktree"]')!;
  assert.equal(worktreeCb.checked, true);

  const titleEl = form.querySelector('input[name="title"]')!;
  titleEl.value = 'Fix auth bug';
  titleEl.dispatchEvent(new MockEvent('input', {target: titleEl}));

  const promptEl = form.querySelector('textarea[name="prompt"]')!;
  promptEl.value = 'Investigate token expiry';
  promptEl.dispatchEvent(new MockEvent('input', {target: promptEl}));

  form.dispatchEvent(new MockEvent('submit', {target: form}));
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.deepEqual(startedCalls, [
    {
      title: 'Fix auth bug',
      prompt: 'Investigate token expiry',
      useWorktree: true,
    },
  ]);
  assert.equal(host.querySelector('[data-po-new-thread-form]'), null);
  const focused = host.querySelector('.mp-po-thread-focused');
  assert.ok(focused);
  assert.ok(host.querySelector('.mp-po-right-header')!.textContent.includes('Fix auth bug'));

  // Read-only mode disables New Thread actions
  handle.update(
    makeBaseState({
      project: {
        id: 'proj-w3',
        root: 'D:/repo',
        name: 'Wave 3 Project',
        paused: true,
      },
    }),
  );
  host.querySelector('[data-po-action="close-thread"]')!.click();
  assert.equal(host.querySelector('[data-po-new-thread-form]'), null);
  assert.equal(
    host.querySelector('.mp-po-right-header [data-po-action="open-new-thread"]')!.disabled,
    true,
  );
});

test('Wave 3.3: Focused Thread Detail shows transcript, Open session, worktree metadata, and sends follow-ups', async () => {
  const {doc, ProjectOverview} = loadProjectOverviewHarness();
  const host = doc.createElement('div');
  const selectedIds: string[] = [];
  const openedSessions: string[] = [];
  const followups: Array<{threadId: string; text: string}> = [];

  ProjectOverview.mountManaged(
    host as unknown as HTMLElement,
    makeBaseState({
      activeTab: 'threads',
      actions: {
        onBack: () => {},
        onSendGoal: async () => {},
        onAnswerDecision: async () => {},
        onSelectThread: async id => {
          selectedIds.push(id);
        },
        onOpenSession: sessionId => {
          openedSessions.push(sessionId);
        },
        onMessageThread: async (threadId, text) => {
          followups.push({threadId, text});
          return {ok: true};
        },
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

  // Clicking thr-1 replaces right pane with Focused Thread Detail AND invokes onSelectThread
  host.querySelector('[data-po-thread="thr-1"]')!.click();
  assert.deepEqual(selectedIds, ['thr-1']);

  const focused1 = host.querySelector('.mp-po-thread-focused')!;
  assert.ok(focused1);
  assert.ok(host.querySelector('.mp-po-right-header')!.textContent.includes('Audit IPC'));
  assert.ok(focused1.textContent.includes('mp/audit-ipc'));
  assert.ok(focused1.textContent.includes('Start auditing IPC endpoints'));
  assert.ok(focused1.textContent.includes('Found 3 endpoints to verify.'));

  const openSessionBtn = host.querySelector('[data-po-open-session="sess-1"]');
  assert.ok(openSessionBtn);
  openSessionBtn.click();
  assert.deepEqual(openedSessions, ['sess-1']);

  // Send follow-up
  const followupForm = focused1.querySelector('[data-po-followup-form]')!;
  const followupArea = followupForm.querySelector('textarea[name="followup"]')!;
  followupArea.value = 'Please also inspect preload.ts';
  followupArea.dispatchEvent(new MockEvent('input', {target: followupArea}));
  followupForm.dispatchEvent(new MockEvent('submit', {target: followupForm}));
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.deepEqual(followups, [
    {threadId: 'thr-1', text: 'Please also inspect preload.ts'},
  ]);

  // Navigate back to Threads Home via breadcrumb, then open thread without session/worktree
  host.querySelector('[data-po-action="close-thread"]')!.click();
  host.querySelector('[data-po-thread="thr-2"]')!.click();
  const focused2 = host.querySelector('.mp-po-thread-focused')!;
  assert.ok(focused2);
  assert.equal(host.querySelector('[data-po-open-session]'), null);
  assert.equal(host.querySelector('[data-po-merge-worktree]'), null);

  // Close focused view via breadcrumb -> returns to Threads Home
  host.querySelector('[data-po-action="close-thread"]')!.click();
  assert.equal(host.querySelector('.mp-po-thread-focused'), null);
});

test('Wave 3.4: Diff & Merge Worktree Modal renders colored diff lines, handles merge conflicts, and closes on success', async () => {
  const {doc, ProjectOverview} = loadProjectOverviewHarness();
  const host = doc.createElement('div');
  let mergeShouldFail = true;
  const mergedIds: string[] = [];

  ProjectOverview.mountManaged(
    host as unknown as HTMLElement,
    makeBaseState({
      activeTab: 'threads',
      actions: {
        onBack: () => {},
        onSendGoal: async () => {},
        onAnswerDecision: async () => {},
        onSelectThread: async () => {},
        onResolveThread: async () => {},
        onRemindThread: async () => {},
        onInspectDiff: async () => ({
          ok: true,
          summary: '2 files changed (+12 / -3)',
          files: ['electron/main.ts', 'electron/preload.ts'],
          diff: [
            'diff --git a/electron/main.ts b/electron/main.ts',
            '@@ -10,2 +10,3 @@',
            '+const added = true;',
            '-const removed = false;',
            ' unchanged();',
          ].join('\n'),
        }),
        onMergeWorktree: async threadId => {
          mergedIds.push(threadId);
          if (mergeShouldFail) {
            return {ok: false, error: 'CONFLICT (content): Merge conflict in electron/main.ts'};
          }
          return {ok: true};
        },
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

  host.querySelector('[data-po-thread="thr-1"]')!.click();
  host.querySelector('[data-po-diff="thr-1"]')!.click();
  await new Promise(resolve => setTimeout(resolve, 10));

  const modal = host.querySelector('.mp-po-diff-modal')!;
  assert.ok(modal);
  assert.ok(modal.textContent.includes('2 files changed (+12 / -3)'));
  assert.ok(modal.textContent.includes('electron/main.ts'));
  assert.ok(modal.textContent.includes('electron/preload.ts'));
  assert.ok(modal.querySelector('.mp-po-diff-pre .is-add'));
  assert.ok(modal.querySelector('.mp-po-diff-pre .is-del'));
  assert.ok(modal.querySelector('.mp-po-diff-pre .is-hunk'));

  // Failed merge keeps modal open and shows error banner
  modal.querySelector('[data-po-merge-worktree="thr-1"]')!.click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(mergedIds, ['thr-1']);
  const modalAfterFail = host.querySelector('.mp-po-diff-modal')!;
  assert.ok(modalAfterFail);
  assert.ok(modalAfterFail.textContent.includes('Merge conflict in electron/main.ts'));

  // Successful merge closes modal
  mergeShouldFail = false;
  modalAfterFail.querySelector('[data-po-merge-worktree="thr-1"]')!.click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(mergedIds, ['thr-1', 'thr-1']);
  assert.equal(host.querySelector('.mp-po-diff-modal'), null);
});

test('Wave 3.5: Coordinator goal Enter submits (Shift+Enter / IME ignored) and shows running indicator while sending', async () => {
  const {doc, ProjectOverview} = loadProjectOverviewHarness();
  const host = doc.createElement('div');
  const sentGoals: string[] = [];
  let releaseGoal: (() => void) | null = null;

  ProjectOverview.mountManaged(
    host as unknown as HTMLElement,
    makeBaseState({
      actions: {
        onBack: () => {},
        onSendGoal: text => {
          sentGoals.push(text);
          return new Promise<void>(resolve => {
            releaseGoal = resolve;
          });
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

  const textarea = host.querySelector('[data-po-goal-form] textarea')!;
  textarea.value = 'Coordinate Wave 3';
  textarea.dispatchEvent(new MockEvent('input', {target: textarea}));

  // Shift+Enter does NOT submit
  textarea.dispatchEvent(
    new MockEvent('keydown', {target: textarea, key: 'Enter', shiftKey: true}),
  );
  assert.equal(sentGoals.length, 0);

  // IME composing Enter does NOT submit
  textarea.dispatchEvent(
    new MockEvent('keydown', {target: textarea, key: 'Enter', isComposing: true}),
  );
  assert.equal(sentGoals.length, 0);

  // Plain Enter submits and shows running indicator
  textarea.dispatchEvent(
    new MockEvent('keydown', {target: textarea, key: 'Enter', shiftKey: false}),
  );
  assert.deepEqual(sentGoals, ['Coordinate Wave 3']);
  assert.ok(host.innerHTML.includes('Coordinator is running...'));

  releaseGoal!();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(host.innerHTML.includes('Coordinator is running...'), false);
});

test('Wave 3.6: CSS and studio_libraries.ts expose responsive 4-column board, focused-thread/modal styling, mountManaged, and full IPC wiring', () => {
  const css = fs.readFileSync(
    path.join(ROOT, 'electron/renderer/project_overview.css'),
    'utf8',
  );
  assert.match(css, /grid-template-columns:\s*repeat\(4,\s*minmax\(175px,\s*1fr\)\)/);
  assert.match(css, /740px/);
  assert.match(css, /\.mp-po-thread-focused/);
  assert.match(css, /\.mp-po-diff-modal/);
  assert.match(css, /\.mp-po-diff-line\.is-add/);
  assert.match(css, /\.mp-po-diff-line\.is-del/);
  assert.match(css, /\.mp-po-diff-line\.is-hunk/);

  const libSrc = fs.readFileSync(
    path.join(ROOT, 'electron/renderer/studio_libraries.ts'),
    'utf8',
  );
  assert.match(libSrc, /ProjectOverview\?\.mountManaged/);
  assert.match(libSrc, /projectsMaStartThread/);
  assert.match(libSrc, /projectsMaMessageThread/);
  assert.match(libSrc, /projectsMaInspectDiff/);
  assert.match(libSrc, /projectsMaMergeWorktree/);
  assert.match(libSrc, /onOpenSession/);
});
