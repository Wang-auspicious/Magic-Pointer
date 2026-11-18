import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

class FidelityNode {
  tagName: string;
  nodeType: number;
  childNodes: FidelityNode[] = [];
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  nodeValue: string;
  parentNode: FidelityNode | null = null;

  constructor(tag = '', text = '') {
    this.tagName = tag.toUpperCase();
    this.nodeType = tag ? 1 : 3;
    this.nodeValue = text;
  }

  get children(): FidelityNode[] {
    return this.childNodes.filter(node => node.nodeType === 1);
  }

  get firstChild(): FidelityNode | null {
    return this.childNodes[0] || null;
  }

  get lastChild(): FidelityNode | null {
    return this.childNodes[this.childNodes.length - 1] || null;
  }

  get lastElementChild(): FidelityNode | null {
    const kids = this.children;
    return kids[kids.length - 1] || null;
  }

  get textContent(): string {
    return this.nodeType === 3
      ? this.nodeValue
      : this.childNodes.map(node => node.textContent).join('');
  }

  set textContent(value: string) {
    this.replaceChildren(new FidelityNode('', String(value)));
  }

  get className(): string {
    return this.attrs.class || '';
  }

  set className(value: string) {
    this.setAttribute('class', value);
  }

  get classList() {
    return {
      contains: (name: string) => this.className.split(/\s+/).includes(name),
    };
  }

  setAttribute(key: string, value: string): void {
    if (key.startsWith('data-')) {
      this.dataset[
        key.slice(5).replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase())
      ] = String(value);
    }
    this.attrs[key] = String(value);
  }

  getAttribute(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, key)
      ? this.attrs[key]
      : null;
  }

  removeAttribute(key: string): void {
    if (key.startsWith('data-')) {
      delete this.dataset[
        key.slice(5).replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase())
      ];
    }
    delete this.attrs[key];
  }

  hasAttribute(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.attrs, key);
  }

  appendChild(node: FidelityNode): FidelityNode {
    return this.insertBefore(node, null);
  }

  insertBefore(node: FidelityNode, before: FidelityNode | null): FidelityNode {
    if (
      node &&
      node.nodeType === 11 &&
      Array.isArray((node as unknown as {childNodes: FidelityNode[]}).childNodes)
    ) {
      for (const item of [...node.childNodes]) {
        this.insertBefore(item, before);
      }
      return node;
    }
    if (node.parentNode) {
      node.remove();
    }
    const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, node);
    node.parentNode = this;
    return node;
  }

  replaceChild(nextNode: FidelityNode, oldNode: FidelityNode): FidelityNode {
    this.insertBefore(nextNode, oldNode);
    oldNode.remove();
    return oldNode;
  }

  remove(): void {
    if (!this.parentNode) {
      return;
    }
    const siblings = this.parentNode.childNodes;
    const index = siblings.indexOf(this);
    if (index >= 0) {
      siblings.splice(index, 1);
    }
    this.parentNode = null;
  }

  replaceChildren(...nodes: FidelityNode[]): void {
    for (const child of [...this.childNodes]) {
      child.remove();
    }
    for (const node of nodes) {
      this.appendChild(node);
    }
  }

  contains(target: unknown): boolean {
    if (target === this) {
      return true;
    }
    return this.childNodes.some(child => child.contains(target));
  }

  closest(selector: string): FidelityNode | null {
    for (let current: FidelityNode | null = this; current; current = current.parentNode) {
      if (
        selector
          .split(',')
          .map(part => part.trim())
          .some(part => matchSelector(current!, part))
      ) {
        return current;
      }
    }
    return null;
  }

  querySelectorAll(selector: string): FidelityNode[] {
    const selectors = selector
      .split(',')
      .map(part => part.trim())
      .filter(Boolean);
    const matches: FidelityNode[] = [];
    for (const child of this.children) {
      if (selectors.some(sel => matchSelector(child, sel))) {
        matches.push(child);
      }
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }

  querySelector(selector: string): FidelityNode | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  addEventListener(): void {}
}

function matchSelector(node: FidelityNode, selector: string): boolean {
  const clean = selector.replace(/^:scope\s*>\s*/, '').trim();
  const tokens = clean.match(/^[a-zA-Z0-9_-]+|\.[a-zA-Z0-9_-]+|\[[^\]]+\]/g);
  if (!tokens || tokens.join('') !== clean) {
    return false;
  }
  return tokens.every(token => {
    if (token.startsWith('.')) {
      return node.className.split(/\s+/).includes(token.slice(1));
    }
    if (token.startsWith('[')) {
      const inner = token.slice(1, -1);
      const eq = inner.indexOf('=');
      if (eq === -1) {
        return node.hasAttribute(inner);
      }
      const key = inner.slice(0, eq);
      const expected = inner.slice(eq + 1).replace(/^['"]|['"]$/g, '');
      return node.getAttribute(key) === expected;
    }
    return node.tagName.toLowerCase() === token.toLowerCase();
  });
}

function withDom<T>(run: (helpers: {
  ChatView: typeof import('../electron/renderer/chat_view');
  ChatMarkdown: typeof import('../electron/renderer/chat_markdown');
  handlers: Map<string, (event: unknown) => void>;
}) => T): T {
  const g = globalThis as Record<string, unknown>;
  const prevDoc = g.document;
  const prevHtml = g.HTMLElement;
  const handlers = new Map<string, (event: unknown) => void>();
  const docObj = {
    documentElement: {lang: 'en', dataset: {}, getAttribute: () => null},
    getSelection: () => ({isCollapsed: true, rangeCount: 0}),
    createElement: (tag: string) => new FidelityNode(tag),
    createElementNS: (_ns: string, tag: string) => new FidelityNode(tag),
    createTextNode: (text: string) => new FidelityNode('', text),
    createDocumentFragment: () => ({
      nodeType: 11,
      childNodes: [] as FidelityNode[],
      appendChild(n: FidelityNode) {
        this.childNodes.push(n);
        return n;
      },
    }),
  };
  g.HTMLElement = FidelityNode;
  g.document = docObj;

  const cvPath = require.resolve('../electron/renderer/chat_view');
  const cmPath = require.resolve('../electron/renderer/chat_markdown');
  const prevCv = require.cache[cvPath];
  const prevCm = require.cache[cmPath];
  delete require.cache[cmPath];
  delete require.cache[cvPath];

  try {
    const ChatMarkdown = require(cmPath);
    const ChatView = require(cvPath);
    ChatView.expansion.clear();
    return run({ChatView, ChatMarkdown, handlers});
  } finally {
    g.document = prevDoc;
    g.HTMLElement = prevHtml;
    if (prevCm) {
      require.cache[cmPath] = prevCm;
    } else {
      delete require.cache[cmPath];
    }
    if (prevCv) {
      require.cache[cvPath] = prevCv;
    } else {
      delete require.cache[cvPath];
    }
  }
}

test('Thought process renders as independent sibling before tool group and auto-collapses when work or prose follows', () => {
  withDom(({ChatView}) => {
    // 1a. Live turn transitions: standalone reasoning starts open, then collapses in place when Read tool follows.
    const host = new FidelityNode('div');
    const live = ChatView.createLiveTurn(host as unknown as HTMLElement, 'live-think#0');
    live.update({
      trajectory: [{kind: 'message', turn: 1, reasoning: 'Inspecting files', state: 'running'}],
    });
    const thinkEl = host.querySelector('.mp-chat-think');
    assert.ok(thinkEl, 'standalone reasoning renders .mp-chat-think');
    assert.equal(thinkEl.getAttribute('data-open'), 'true', 'standalone reasoning stays open while nothing follows');
    assert.equal(thinkEl.getAttribute('data-row-id'), 'think:live-think#0:r1');

    live.update({
      trajectory: [
        {kind: 'message', turn: 1, reasoning: 'Inspecting files\nChecking Read', state: 'done'},
        {kind: 'tool', turn: 1, callId: 'read-1', name: 'Read', text: '{"path":"src/a.ts"}', state: 'running'},
      ],
    });
    assert.equal(host.querySelector('.mp-chat-think'), thinkEl, 'existing .mp-chat-think updates in place');
    assert.equal(thinkEl.getAttribute('data-open'), 'false', 'auto-opened Thought process collapses when tool follows');
    const group = host.querySelector('.mp-chat-tool-group');
    assert.ok(group, 'Read tool renders a tool group');
    assert.equal(group.getAttribute('data-single'), 'true');
    assert.equal(group.hasAttribute('open'), false, 'single Read tool stays collapsed');
    assert.equal(
      group.querySelector('.mp-chat-tool-group-body')?.querySelector('.mp-chat-think'),
      null,
      'Thought process must NEVER render inside .mp-chat-tool-group-body',
    );
    const thinkIdx = host.children.indexOf(thinkEl);
    const groupIdx = host.children.indexOf(group);
    assert.ok(thinkIdx >= 0 && groupIdx > thinkIdx, '.mp-chat-think is a top-level sibling BEFORE .mp-chat-tool-group');

    // 1b. Settled assistantTurnNode has the exact same top-level sibling structure & collapse behavior.
    ChatView.expansion.clear();
    const settledNodes = ChatView.assistantTurnNode({
      conversationId: 'settled',
      turnIndex: 0,
      answer: 'Done.',
      trajectory: [
        {kind: 'message', turn: 1, reasoning: 'Need to inspect src/a.ts', state: 'done'},
        {kind: 'tool', turn: 1, callId: 'read-1', name: 'Read', text: '{"path":"src/a.ts"}', result: 'ok', state: 'done'},
      ],
    }) as unknown as FidelityNode[];
    const assistant = settledNodes[0];
    const body = assistant.querySelector('.mp-chat-assistant-body')!;
    const settledThink = body.children.find(c => c.classList.contains('mp-chat-think'));
    const settledGroup = body.children.find(c => c.classList.contains('mp-chat-tool-group'));
    assert.ok(settledThink, 'settled assistantTurnNode renders .mp-chat-think directly inside .mp-chat-assistant-body');
    assert.ok(settledGroup, 'settled assistantTurnNode renders .mp-chat-tool-group directly inside .mp-chat-assistant-body');
    assert.ok(
      body.children.indexOf(settledThink) < body.children.indexOf(settledGroup),
      'settled .mp-chat-think comes BEFORE .mp-chat-tool-group',
    );
    assert.equal(
      settledGroup.querySelector('.mp-chat-tool-group-body')?.querySelector('.mp-chat-think'),
      null,
      'settled Thought process must NEVER live inside .mp-chat-tool-group-body',
    );
    assert.equal(settledThink.getAttribute('data-open'), 'false');
    assert.equal(settledGroup.getAttribute('data-single'), 'true');
    assert.equal(settledGroup.hasAttribute('open'), false);

    // 1c. Explicit ROW_EXPANSION toggle always wins over auto-collapse and standalone default.
    ChatView.expansion.clear();
    ChatView.expansion.setRow('think:pin-live#0:r1', true);
    const pinHost = new FidelityNode('div');
    const pinLive = ChatView.createLiveTurn(pinHost as unknown as HTMLElement, 'pin-live#0');
    pinLive.update({
      trajectory: [
        {kind: 'message', turn: 1, reasoning: 'Pinned thought', state: 'done'},
        {kind: 'tool', turn: 1, callId: 'read-p', name: 'Read', text: '{"path":"p.ts"}', result: 'ok', state: 'done'},
      ],
      answer: 'Done.',
    });
    assert.equal(pinHost.querySelector('.mp-chat-think')?.getAttribute('data-open'), 'true', 'explicit open in ROW_EXPANSION wins over tool/answer collapse');

    const pinSettled = (ChatView.assistantTurnNode({
      conversationId: 'pin-live',
      turnIndex: 0,
      answer: 'Done.',
      trajectory: [
        {kind: 'message', turn: 1, reasoning: 'Pinned thought', state: 'done'},
        {kind: 'tool', turn: 1, callId: 'read-p', name: 'Read', text: '{"path":"p.ts"}', result: 'ok', state: 'done'},
      ],
    }) as unknown as FidelityNode[])[0];
    assert.equal(pinSettled.querySelector('.mp-chat-think')?.getAttribute('data-open'), 'true');

    ChatView.expansion.setRow('think:closed-standalone#0:r1', false);
    const closedStandalone = (ChatView.assistantTurnNode({
      conversationId: 'closed-standalone',
      turnIndex: 0,
      answer: '',
      trajectory: [{kind: 'message', turn: 1, reasoning: 'Only thought', text: ''}],
    }) as unknown as FidelityNode[])[0];
    assert.equal(closedStandalone.querySelector('.mp-chat-think')?.getAttribute('data-open'), 'false', 'explicit false in ROW_EXPANSION wins over standalone open');

    // 1d. Prose/answer following Thought process collapses it; trailing answer not in message record renders live.
    ChatView.expansion.clear();
    const proseHost = new FidelityNode('div');
    const proseLive = ChatView.createLiveTurn(proseHost as unknown as HTMLElement, 'prose-live#0');
    proseLive.update({
      trajectory: [{kind: 'message', turn: 1, reasoning: 'Thinking before prose', state: 'running'}],
    });
    assert.equal(proseHost.querySelector('.mp-chat-think')?.getAttribute('data-open'), 'true');
    proseLive.update({
      trajectory: [{kind: 'message', turn: 1, reasoning: 'Thinking before prose', state: 'done'}],
      answer: 'Trailing answer not in message record.',
    });
    assert.equal(proseHost.querySelector('.mp-chat-think')?.getAttribute('data-open'), 'false');
    const liveAns = proseHost.querySelector('.mp-chat-stream-live');
    assert.ok(liveAns, 'trailing snapshot.answer renders via liveMarkdownNode');
    assert.match(liveAns.textContent, /Trailing answer not in message record/);
    const statusIdx = proseHost.children.indexOf(proseHost.querySelector('.mp-chat-turn-status')!);
    assert.ok(proseHost.children.indexOf(liveAns) < statusIdx, 'live-answer renders before traceStatus');
  });
});

test('tool-group-header renders title followed by Anthropicons row caret sibling', () => {
  withDom(({ChatView}) => {
    const settled = (ChatView.assistantTurnNode({
      conversationId: 'caret',
      turnIndex: 0,
      answer: 'Ok.',
      trajectory: [
        {kind: 'tool', turn: 1, callId: 'r1', name: 'Read', text: '{"path":"a.ts"}', result: 'ok', state: 'done'},
      ],
    }) as unknown as FidelityNode[])[0];
    const header = settled.querySelector('.mp-chat-tool-group-header');
    assert.ok(header);
    const title = header.querySelector('.mp-chat-tool-group-title');
    const caret = header.querySelector('.mp-chat-row-caret');
    assert.ok(title, 'summary must contain .mp-chat-tool-group-title');
    assert.ok(caret, 'summary must contain .mp-chat-row-caret');
    assert.equal(caret.getAttribute('aria-hidden'), 'true');
    assert.equal(caret.textContent, '\ue02a');
    assert.equal(header.children.indexOf(caret), header.children.indexOf(title) + 1);
  });
});

test('commandCardNode renders .mp-chat-cmd-stack with kind label outside .mp-chat-code.mp-chat-cmd-box and output below it', () => {
  withDom(({ChatView, ChatMarkdown}) => {
    const bashRow = ChatView.toolRowNode(
      ChatView.toolRowModel(
        'Bash',
        JSON.stringify({command: 'ls -la\necho done'}),
        {text: JSON.stringify({stdout: 'file1.txt\nfile2.txt', stderr: '', exit: 0})},
        'cmd-bash',
      ),
    ) as unknown as FidelityNode;
    const stack = bashRow.querySelector('.mp-chat-cmd-stack');
    assert.ok(stack, 'Bash row must render .mp-chat-cmd-stack');
    const kind = stack.querySelector('.mp-chat-cmd-kind');
    const box = stack.querySelector('.mp-chat-code.mp-chat-cmd-box') ??
      (stack.querySelector('.mp-chat-cmd-box') as FidelityNode | null);
    assert.ok(kind, 'must render .mp-chat-cmd-kind');
    assert.equal(kind.textContent, 'Bash');
    assert.ok(box, 'must render .mp-chat-code.mp-chat-cmd-box');
    assert.ok(box.classList.contains('mp-chat-code'), 'box must have .mp-chat-code');
    assert.ok(box.classList.contains('mp-chat-cmd-box'), 'box must have .mp-chat-cmd-box');
    assert.equal(box.querySelector('.mp-chat-cmd-kind'), null, '.mp-chat-cmd-kind must be OUTSIDE .mp-chat-code');
    const copy = box.querySelector('[data-mp-chat-act="copy"]');
    assert.ok(copy, 'copy button must sit inside .mp-chat-code');
    const output = stack.querySelector('.mp-chat-cmd-output');
    assert.ok(output, 'must render .mp-chat-code-body.mp-chat-cmd-output');
    assert.ok(output.classList.contains('mp-chat-code-body'), 'output must carry .mp-chat-code-body');
    assert.equal(box.querySelector('.mp-chat-cmd-output'), null, 'output must be OUTSIDE .mp-chat-code');
    assert.ok(
      stack.children.indexOf(kind) < stack.children.indexOf(box) &&
        stack.children.indexOf(box) < stack.children.indexOf(output),
      'stack child order must be kind -> cmd-box -> cmd-output',
    );
    assert.equal(output.getAttribute('data-error'), null);
    assert.match(output.textContent, /file1\.txt/);

    const pwshErrorRow = ChatView.toolRowNode(
      ChatView.toolRowModel(
        'pwsh',
        JSON.stringify({command: 'Invoke-WebRequest https://example.com'}),
        {text: JSON.stringify({stdout: '', stderr: 'ERR 403 Forbidden', exit: 1}), isError: true},
        'cmd-pwsh',
      ),
    ) as unknown as FidelityNode;
    const errStack = pwshErrorRow.querySelector('.mp-chat-cmd-stack')!;
    assert.equal(errStack.querySelector('.mp-chat-cmd-kind')?.textContent, 'PowerShell');
    assert.equal(errStack.querySelector('.mp-chat-code-prompt')?.textContent, '>');
    const errOutput = errStack.querySelector('.mp-chat-cmd-output')!;
    assert.equal(errOutput.getAttribute('data-error'), 'true');
    assert.match(errOutput.textContent, /ERR 403 Forbidden/);

    // Markdown fenced code blocks remain untouched.
    const md = ChatMarkdown.render('```bash\necho hi\n```') as unknown as FidelityNode;
    assert.equal(md.querySelector('.mp-chat-cmd-stack'), null);
    assert.ok(md.querySelector('.mp-chat-code-head'));
    assert.equal(md.querySelector('.mp-chat-code-lang')?.textContent, 'bash');
  });
});

test('single pending AskUserQuestion opens its tool-group unless collapsed by user, while normal single tools stay closed', () => {
  withDom(({ChatView}) => {
    // Live pending AskUserQuestion
    const liveHost = new FidelityNode('div');
    const live = ChatView.createLiveTurn(liveHost as unknown as HTMLElement, 'ask-live#0');
    live.update({
      trajectory: [
        {
          kind: 'tool',
          turn: 1,
          callId: 'ask-1',
          name: 'AskUserQuestion',
          text: JSON.stringify({question: 'Which format?'}),
          state: 'running',
        },
      ],
    });
    const liveGroup = liveHost.querySelector('.mp-chat-tool-group')!;
    assert.equal(liveGroup.getAttribute('data-single'), 'true');
    assert.equal(liveGroup.hasAttribute('open'), true, 'pending AskUserQuestion opens automatically');

    // Once answered, it collapses like any settled tool
    live.update({
      trajectory: [
        {
          kind: 'tool',
          turn: 1,
          callId: 'ask-1',
          name: 'AskUserQuestion',
          text: JSON.stringify({question: 'Which format?'}),
          result: JSON.stringify({answered: true, answers: {'Which format?': 'Brief'}}),
          state: 'done',
        },
      ],
    });
    const answeredGroup = liveHost.querySelector('.mp-chat-tool-group')!;
    assert.equal(answeredGroup.hasAttribute('open'), false, 'answered AskUserQuestion closes');

    // Settled assistantTurnNode pending AskUserQuestion
    ChatView.expansion.clear();
    const settledAsk = (ChatView.assistantTurnNode({
      conversationId: 'ask-settled',
      turnIndex: 0,
      trajectory: [
        {
          kind: 'tool',
          turn: 1,
          callId: 'ask-2',
          name: 'AskUserQuestion',
          text: JSON.stringify({question: 'Proceed?'}),
          state: 'running',
        },
      ],
    }) as unknown as FidelityNode[])[0];
    const settledGroup = settledAsk.querySelector('.mp-chat-tool-group')!;
    assert.equal(settledGroup.getAttribute('data-single'), 'true');
    assert.equal(settledGroup.hasAttribute('open'), true);

    // Explicit collapse in ROW_EXPANSION wins over pending AskUserQuestion default
    ChatView.expansion.clear();
    ChatView.expansion.setRow('tool:ask-collapsed#0:ask-3', false);
    const collapsedAsk = (ChatView.assistantTurnNode({
      conversationId: 'ask-collapsed',
      turnIndex: 0,
      trajectory: [
        {
          kind: 'tool',
          turn: 1,
          callId: 'ask-3',
          name: 'AskUserQuestion',
          text: JSON.stringify({question: 'Proceed?'}),
          state: 'running',
        },
      ],
    }) as unknown as FidelityNode[])[0];
    assert.equal(collapsedAsk.querySelector('.mp-chat-tool-group')?.hasAttribute('open'), false);

    // Normal single tools (Read, Bash, Edit, Grep) stay collapsed by default (both running and done)
    ChatView.expansion.clear();
    for (const [name, args] of [
      ['Read', {path: 'a.ts'}],
      ['Bash', {command: 'pwd'}],
      ['Edit', {path: 'a.ts', old_string: 'a', new_string: 'b'}],
      ['Grep', {pattern: 'foo'}],
    ] as const) {
      const turn = (ChatView.assistantTurnNode({
        conversationId: `single-${name}`,
        turnIndex: 0,
        trajectory: [
          {kind: 'tool', turn: 1, callId: `c-${name}`, name, text: JSON.stringify(args), state: 'running'},
        ],
      }) as unknown as FidelityNode[])[0];
      const toolGroup = turn.querySelector('.mp-chat-tool-group')!;
      assert.equal(toolGroup.getAttribute('data-single'), 'true');
      assert.equal(toolGroup.hasAttribute('open'), false, `${name} must remain collapsed by default`);
    }
  });
});

test('chat_styles.css encodes single vs multi-tool card, caret, hover, error title and command stack fidelity', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'renderer', 'chat_styles.css'),
    'utf8',
  );
  assert.doesNotMatch(css, /\.mp-chat-tool-group-header::after\b/, 'CSS border triangle must be removed');
  assert.match(css, /\.mp-chat-tool-group\[open\]\s*>\s*\.mp-chat-tool-group-header\s*>\s*\.mp-chat-row-caret[\s\S]*?rotate\(90deg\)/);
  assert.match(css, /\.mp-chat-tool-group\[data-single='true'\]\s*>\s*\.mp-chat-tool-group-body[\s\S]*?border:\s*0[\s\S]*?background:\s*transparent/);
  assert.match(css, /\.mp-chat-tool-group:not\(\[data-single='true'\]\):not\(\[data-thought-only='true'\]\)\s*>\s*\.mp-chat-tool-group-body[\s\S]*?background:\s*var\(--mp-panel\)/);
  assert.match(css, /\.mp-chat-cmd-stack\b/);
  assert.match(css, /\.mp-chat-cmd-kind\b/);
  assert.match(css, /\.mp-chat-code\.mp-chat-cmd-box\b/);
  assert.match(css, /\.mp-chat-cmd-output\[data-error='true'\][\s\S]*?color:\s*var\(--mp-danger\)/);
  assert.match(css, /\.mp-chat-code\.mp-chat-cmd-box\s*>\s*\.mp-chat-code-first\s*>\s*\.mp-chat-code-line[\s\S]*?overflow-wrap:\s*anywhere/);
  assert.match(css, /\.mp-chat-row\s*>\s*\.mp-chat-tool-sep\s*\{\s*display:\s*none;/);
});

test('mixed tool-group summary maps failed Browser.navigate and ok pwsh to fetched a page and ran a command', () => {
  withDom(({ChatView}) => {
    const settled = (ChatView.assistantTurnNode({
      conversationId: 'mixed-summary',
      turnIndex: 0,
      trajectory: [
        {
          kind: 'tool',
          turn: 1,
          callId: 'nav-1',
          name: 'Browser.navigate',
          text: JSON.stringify({url: 'https://openai.com/index/gpt-6-astra/'}),
          result: 'Request failed with status code 404',
          isError: true,
          state: 'error',
        },
        {
          kind: 'tool',
          turn: 1,
          callId: 'pwsh-1',
          name: 'pwsh',
          text: JSON.stringify({command: 'Write-Output ok'}),
          result: JSON.stringify({stdout: 'ok', stderr: '', exit: 0}),
          state: 'done',
        },
      ],
    }) as unknown as FidelityNode[])[0];
    const title = settled.querySelector('.mp-chat-tool-group-title');
    assert.ok(title, 'mixed group must render .mp-chat-tool-group-title');
    assert.equal(title.textContent, 'Fetched a page (1 failed), ran a command');
    const errorPhrase = title.querySelector('.mp-chat-group-phrase[data-error="true"]');
    assert.ok(errorPhrase, 'failed phrase must carry .mp-chat-group-phrase[data-error="true"]');
    assert.equal(errorPhrase.textContent, 'Fetched a page (1 failed)');
  });
});
