import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

class DomNode {
  tagName: string;
  className = '';
  id = '';
  textContent = '';
  title = '';
  value = '';
  type = '';
  placeholder = '';
  disabled = false;
  hidden = false;
  rows = 1;
  scrollTop = 0;
  scrollHeight = 100;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: DomNode[] = [];
  parentNode: DomNode | null = null;
  listeners: Record<string, Array<(ev: any) => void>> = {};

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get classList() {
    const self = this;
    return {
      add(...tokens: string[]) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        for (const t of tokens) {
          set.add(t);
        }
        self.className = [...set].join(' ');
      },
      remove(...tokens: string[]) {
        const drop = new Set(tokens);
        self.className = self.className
          .split(/\s+/)
          .filter(c => c && !drop.has(c))
          .join(' ');
      },
      contains(token: string) {
        return self.className.split(/\s+/).includes(token);
      },
      toggle(token: string, force?: boolean) {
        if (force === true || (force === undefined && !this.contains(token))) {
          this.add(token);
          return true;
        }
        this.remove(token);
        return false;
      },
    };
  }

  get isConnected(): boolean {
    return true;
  }

  get childElementCount(): number {
    return this.children.length;
  }

  appendChild(child: DomNode): DomNode {
    if (!child) {
      return child;
    }
    if (child.tagName === '#FRAGMENT') {
      for (const nested of [...child.children]) {
        this.appendChild(nested);
      }
      return child;
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...items: Array<DomNode | string>) {
    for (const item of items) {
      if (typeof item === 'string') {
        const txt = new DomNode('#TEXT');
        txt.textContent = item;
        this.appendChild(txt);
      } else {
        this.appendChild(item);
      }
    }
  }

  prepend(child: DomNode) {
    child.parentNode = this;
    this.children.unshift(child);
  }

  insertBefore(child: DomNode, ref: DomNode | null) {
    const idx = ref ? this.children.indexOf(ref) : -1;
    child.parentNode = this;
    if (idx >= 0) {
      this.children.splice(idx, 0, child);
    } else {
      this.children.push(child);
    }
    return child;
  }

  replaceChildren(...nodes: DomNode[]) {
    this.children = [];
    for (const n of nodes) {
      this.appendChild(n);
    }
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter(c => c !== this);
      this.parentNode = null;
    }
  }

  setAttribute(name: string, value: string) {
    this.attrs[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
    if (name.startsWith('data-')) {
      const camel = name
        .slice(5)
        .replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
      this.dataset[camel] = String(value);
    }
  }

  getAttribute(name: string): string | null {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    return name in this.attrs ? this.attrs[name]! : null;
  }

  addEventListener(type: string, fn: (ev: any) => void) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type]!.push(fn);
  }

  dispatchEvent(ev: any) {
    const event = {
      preventDefault() {},
      stopPropagation() {},
      currentTarget: this,
      target: this,
      ...ev,
    };
    for (const fn of this.listeners[event.type] || []) {
      fn(event);
    }
    return true;
  }

  click() {
    this.dispatchEvent({type: 'click'});
  }

  requestSubmit() {
    this.dispatchEvent({type: 'submit'});
  }

  closest(selector: string): DomNode | null {
    let cur: DomNode | null = this;
    while (cur) {
      if (matchesSimple(cur, selector)) {
        return cur;
      }
      cur = cur.parentNode;
    }
    return null;
  }

  querySelectorAll(selector: string): DomNode[] {
    const out: DomNode[] = [];
    const parts = selector
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const visit = (node: DomNode) => {
      for (const c of node.children) {
        if (parts.some(p => matchesSimple(c, p))) {
          out.push(c);
        }
        visit(c);
      }
    };
    visit(this);
    return out;
  }

  querySelector(selector: string): DomNode | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  get allText(): string {
    return [this.textContent, ...this.children.map(c => c.allText)]
      .filter(Boolean)
      .join(' ');
  }
}

function matchesSimple(node: DomNode, selector: string): boolean {
  const s = selector.trim();
  if (!s) return false;
  if (s.startsWith('.')) {
    return node.classList.contains(s.slice(1).split('[')[0]!);
  }
  if (s.startsWith('#')) {
    return node.id === s.slice(1);
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1);
    const eqIdx = inner.indexOf('=');
    if (eqIdx < 0) {
      return inner in node.attrs;
    }
    const key = inner.slice(0, eqIdx).trim();
    const val = inner.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    return node.getAttribute(key) === val;
  }
  return node.tagName.toLowerCase() === s.toLowerCase();
}

test('Item 1: Interrupted turn preserves partial answer and avoids red crash box', () => {
  const agentSrc = readRepo('electron/runtime/agent.ts');
  assert.doesNotMatch(
    agentSrc,
    /reason === 'user_interrupt'[\s\S]{0,120}answer = /,
    'agent.ts must keep accumulated streamed answer on user_interrupt instead of overwriting with "User interrupted"',
  );

  const chatSrc = readRepo('electron/renderer/chat_view.ts');
  assert.match(chatSrc, /mp-chat-interrupted/);
  assert.match(chatSrc, /isUserInterrupted/);
});

test('Item 2: Tool group updates keep header DOM stable, hide Loaded tools, humanize patterns, and restrict Learn repo scanning', () => {
  const learnVoice = require('../electron/runtime/learn_voice');
  assert.equal(learnVoice.LEARN_PROMPT_VERSION, 'learn-v6.0-real-mentor-memory-20261127');
  const conceptualPrompt = learnVoice.buildLearnVoicePrompt({
    topicText: '老师在讲大数据spark程序，完全看不懂怎么办',
    localDate: '2026-11-19',
    platform: 'win32',
    workspace: 'D:\\Desktop\\DiskSentry',
  });
  assert.doesNotMatch(
    conceptualPrompt,
    /DiskSentry/,
    'Conceptual Learn questions must not inject local workspace directory',
  );

  const chatViewSrc = readRepo('electron/renderer/chat_view.ts');
  assert.match(chatViewSrc, /isHiddenMetaTool/);
  assert.match(chatViewSrc, /humanizeSearchPattern/);
  assert.match(chatViewSrc, /syncLiveToolGroupNode/);
});

test('Item 3A & 3B: Session Rail removes Context/Environment cards, enables parallel task detail, and Context bar infers window cleanly', () => {
  const studioSrc = readRepo('electron/renderer/studio.ts');
  assert.doesNotMatch(studioSrc, /makeCard\(\s*'context'/);
  assert.doesNotMatch(studioSrc, /makeCard\(\s*'environment'/);
  assert.match(studioSrc, /className = `mp-session-rail\$\{selectedTask \? ' has-detail' : ''\}`/);
  assert.match(studioSrc, /inferModelContextWindow/);
  assert.doesNotMatch(studioSrc, /composerQuota\.source[\s\S]{0,80}https?:\/\//);
});

test('Item 4 & Item 6B: Compact single-line Slash rows and idle transparent scrollbars with .is-scrolling reveal', () => {
  const chatCss = readRepo('electron/renderer/chat_styles.css');
  assert.match(chatCss, /\.mpw-slash-row\s*\{[^}]*min-height:\s*32px;[^}]*max-height:\s*34px/s);

  const tokensCss = readRepo('electron/renderer/theme_tokens.css');
  assert.match(tokensCss, /::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*transparent/s);
  assert.match(tokensCss, /\.is-scrolling::-webkit-scrollbar-thumb/);

  const studioSrc = readRepo('electron/renderer/studio.ts');
  assert.match(studioSrc, /classList\.add\('is-scrolling'\)/);
});

test('Item 5 & Item 11A/11B/11C/11D: Side Chat hides [New] strip, supports nested parent breadcrumbs, hydrates IntelligenceUI, clears bottom quote on send, and skips center duplicate EXCERPT', () => {
  const studioSrc = readRepo('electron/renderer/studio.ts');
  assert.match(studioSrc, /res\?\.branchId\s*\|\|\s*res\?\.branch\?\.id/);
  assert.match(studioSrc, /surface:\s*'side'/);
  assert.doesNotMatch(
    studioSrc,
    /productMode !== 'design'[\s\S]{0,40}id:\s*'env'/,
  );

  const SideChatPane = require('../electron/renderer/side_chat_pane');
  const prevDoc = globalThis.document;
  const docBody = new DomNode('body');
  (globalThis as Record<string, unknown>).document = {
    body: docBody,
    documentElement: {lang: 'zh-CN'},
    createElement: (t: string) => new DomNode(t),
    createTextNode: (s: string) => {
      const n = new DomNode('#TEXT');
      n.textContent = s;
      return n;
    },
  };
  let hydratedCount = 0;
  const prevIui = (globalThis as Record<string, unknown>).IntelligenceUI;
  const prevCM = (globalThis as Record<string, unknown>).ChatMarkdown;
  (globalThis as Record<string, unknown>).IntelligenceUI = {
    hydrate: () => {
      hydratedCount += 1;
    },
  };
  (globalThis as Record<string, unknown>).ChatMarkdown = {
    render: (src: string) => {
      const p = new DomNode('p');
      p.textContent = src;
      return p;
    },
  };

  try {
    const conv = {
      id: 'c-side',
      workMode: 'learn',
      turns: [{question: 'Main', answer: 'Main answer'}],
      branches: [
        {
          id: 'br-parent',
          parentBranchId: null,
          parentTurnIndex: 0,
          surface: 'side',
          anchor: {kind: 'selection', label: '最后一个机制', snippet: '最后一个机制'},
          title: '最后一个机制',
          turns: [{question: 'Q1', answer: 'A1 with ```html``` visual'}],
        },
        {
          id: 'br-child',
          parentBranchId: 'br-parent',
          parentTurnIndex: 0,
          surface: 'side',
          anchor: {kind: 'selection', label: '子追问', snippet: '子追问'},
          title: '旋转矩阵正交性',
          turns: [{question: 'Q2', answer: 'Child answer'}],
        },
      ],
    };

    const host = new DomNode('div') as unknown as HTMLElement;
    const sentPayloads: any[] = [];
    SideChatPane.openBranch('br-child');
    SideChatPane.renderPane(host, conv, {
      onSend: async (p: any) => {
        sentPayloads.push(p);
      },
      onToggleMount: async () => {},
    });

    const root = host as unknown as DomNode;
    assert.equal(root.querySelectorAll('.mp-sidechat-tabs').length, 0, 'Legacy [New] tab strip must be removed');
    const crumbs = root.querySelectorAll('.mp-sidechat-crumb');
    assert.ok(crumbs.length >= 2, 'Nested side chat should show parent breadcrumbs');
    assert.ok(hydratedCount >= 1, 'SideChatPane must hydrate IntelligenceUI blocks');

    // Opening a draft shows bottom quote, then submitting clears bottom quote immediately & sends parentBranchId
    SideChatPane.openDraft({
      conversationId: 'c-side',
      parentTurnIndex: 0,
      parentBranchId: 'br-child',
      quote: '特征值模长为1',
      snippet: '特征值模长为1',
    });
    SideChatPane.renderPane(host, conv, {
      onSend: async (p: any) => {
        sentPayloads.push(p);
      },
      onToggleMount: async () => {},
    });
    assert.ok(root.querySelector('.mp-sidechat-reply-bar'), 'Draft quote bar visible before submit');
    const input = root.querySelector('.mp-sidechat-input')!;
    input.value = '为什么模长不变？';
    root.querySelector('.mp-sidechat-composer')!.requestSubmit();
    assert.equal(
      root.querySelector('.mp-sidechat-reply-bar'),
      null,
      'Bottom quote bar must be removed immediately when message is sent',
    );
    assert.equal(sentPayloads[0]?.parentBranchId, 'br-child');

    // Live bubble must render quote chip above question while streaming
    SideChatPane.setLiveState({
      requestId: 'req-live-1',
      branchId: '',
      question: '为什么模长不变？',
      quote: '特征值模长为1',
      answer: '',
      thinking: '',
    });
    SideChatPane.renderPane(host, conv, {
      onSend: async () => {},
      onToggleMount: async () => {},
    });
    const liveUser = root.querySelectorAll('.mp-sidechat-msg').find(n => n.classList.contains('is-user'));
    const liveQuote = liveUser?.querySelector('.mp-sidechat-msg-quote') || null;
    assert.ok(liveQuote, 'Live streaming user bubble should display attached quote chip');
    SideChatPane.setLiveState(null);
  } finally {
    globalThis.document = prevDoc;
    (globalThis as Record<string, unknown>).IntelligenceUI = prevIui;
    (globalThis as Record<string, unknown>).ChatMarkdown = prevCM;
  }

  // LearnTree inline mounter skips surface === 'side' so center EXCERPT never duplicates Side Chat
  const learnTreeSrc = readRepo('electron/renderer/learn_tree.ts');
  assert.match(learnTreeSrc, /if\s*\(\s*!inDeck\s*&&\s*branch\.surface\s*===\s*'side'\s*\)/);

  // Markdown upgrades complete ```html visualization blocks into .mp-iui-card with source toggle
  const mdSrc = readRepo('electron/renderer/chat_markdown.ts');
  assert.match(mdSrc, /classifyVisualFence[\s\S]{0,1400}normalizedLang\s*===\s*'html'/);
  assert.match(mdSrc, /'data-iui-allow-source':\s*'true'/);
  const sandboxSrc = readRepo('electron/renderer/iui_sandbox.html');
  assert.match(sandboxSrc, /<body\\b/i);
});

test('Item 6A, 8A, 8B: Auto-titling handles quoted_reply comments cleanly, steering warnings suppressed, and Vault search/read works against real Obsidian notes', () => {
  const {titleFrom} = require('../electron/conversation_store');
  assert.equal(
    titleFrom('<quoted_reply turn="0" comment="为什么不能Q乘Q">对称性</quoted_reply>'),
    '不能Q乘Q',
  );
  assert.doesNotMatch(titleFrom('老师在讲大数据spark程序是什么意思'), /是什么意思/);

  const {searchKnowledgeVault, readVaultNote} = require('../electron/knowledge_vault');
  const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-vault-test-'));
  try {
    fs.writeFileSync(
      path.join(tmpVault, '位置编码.md'),
      '# 位置编码\n\nRoPE 通过二维旋转将相对位置引入内积，关联 [[Attention 机制]]。\n\n- [ ] 推导复数内积实部公式\n',
      'utf8',
    );
    const hits = searchKnowledgeVault(tmpVault, '位置编码', 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, '位置编码');
    const note = readVaultNote(tmpVault, hits[0].relativePath);
    assert.equal(note.ok, true);
    assert.match(note.content || '', /二维旋转/);
  } finally {
    fs.rmSync(tmpVault, {recursive: true, force: true});
  }

  const activitySrc = readRepo('electron/runtime/agent_activity.ts');
  assert.doesNotMatch(activitySrc, /tool_warning.*type:\s*'notice'/s);
});

test('Item 7: Desktop perception popover uses compact 248px menu and inline switch', () => {
  const dpSrc = readRepo('electron/renderer/desktop_perception.ts');
  assert.match(dpSrc, /mp-perception-menu/);
  assert.match(dpSrc, /mp-perception-menu-switch/);
  assert.doesNotMatch(dpSrc, /Hide window and point/);
});

test('Item 10 & Item 11E: Composer houses reply bar + lemma strip inside .mpw-scroll, supports inline reply comment & precision range highlighting', () => {
  const html = readRepo('electron/renderer/studio.html');
  const scrollStart = html.indexOf('<div class="mpw-scroll">');
  const scrollEnd = html.indexOf('<div class="mpw-input-line">', scrollStart);
  const insideScrollTop = html.slice(scrollStart, scrollEnd);
  assert.match(insideScrollTop, /id="composer-reply-bar"/);
  assert.match(insideScrollTop, /id="composer-lemma-strip"/);

  const chatViewSrc = readRepo('electron/renderer/chat_view.ts');
  assert.match(chatViewSrc, /comment="/);
  assert.match(chatViewSrc, /mp-chat-reply-comment/);

  const studioSrc = readRepo('electron/renderer/studio.ts');
  assert.match(studioSrc, /openInlineReplyPopover/);
  assert.match(studioSrc, /findTextRangeInContainer/);
  assert.match(studioSrc, /highlightTextRange/);
  assert.doesNotMatch(
    studioSrc,
    /target\.classList\.add\('mp-reply-jump-highlight'\)/,
    'jumpToReplyQuoteSource must never apply whole-bubble highlight to the whole assistant container',
  );
});

test('Item 11G: ConceptGraph consolidates large graphs to <=8 cohesive nodes and auto-infers verified/gap status', () => {
  const ConceptGraph = require('../electron/renderer/concept_graph');
  const sections = Array.from({length: 14}, (_, i) =>
    `### 概念 ${i + 1}\n\n这里讲解第 ${i + 1} 个核心点。\n`,
  ).join('\n');
  const conv = {
    id: 'c-18nodes',
    workMode: 'learn',
    turns: [
      {question: '展开讲讲', answer: sections},
      {question: '概念 3 还是没懂，为什么这样？', answer: '### 概念 3 补充\n再解释一下边界。'},
      {question: '概念 1 我明白了对头', answer: '### 收尾\n继续下一步。'},
    ],
    branches: [],
  };
  const topology = ConceptGraph.extractTopology(conv);
  assert.ok(
    topology.nodes.length <= 8,
    `Expected consolidated topology <= 8 nodes, got ${topology.nodes.length}`,
  );
  assert.ok(
    topology.nodes.some((n: any) => n.status === 'gap'),
    'Expected auto-inferred gap status when user asked follow-up confusion',
  );
  assert.ok(
    topology.nodes.some((n: any) => n.status === 'verified'),
    'Expected auto-inferred verified status when later turns progressed',
  );
});
