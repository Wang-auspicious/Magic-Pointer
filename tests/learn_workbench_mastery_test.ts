import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(__dirname, '..');

class MiniNode {
  tagName: string;
  className = '';
  id = '';
  textContent = '';
  hidden = false;
  disabled = false;
  type = '';
  value = '';
  placeholder = '';
  title = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: MiniNode[] = [];
  parentNode: MiniNode | null = null;
  listeners = new Map<string, Array<(ev?: any) => void>>();
  classList = {
    add: (...names: string[]) => {
      const set = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const n of names) set.add(n);
      this.className = [...set].join(' ');
    },
    remove: (...names: string[]) => {
      const rem = new Set(names);
      this.className = this.className
        .split(/\s+/)
        .filter(n => n && !rem.has(n))
        .join(' ');
    },
    contains: (n: string) => this.className.split(/\s+/).includes(n),
    toggle: (n: string, force?: boolean) => {
      const next = force ?? !this.classList.contains(n);
      if (next) this.classList.add(n);
      else this.classList.remove(n);
      return next;
    },
  };
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  setAttribute(k: string, v: string) {
    const val = String(v);
    this.attrs[k] = val;
    if (k === 'id') this.id = val;
    if (k.startsWith('data-')) {
      const camel = k
        .slice(5)
        .replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
      this.dataset[camel] = val;
    }
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k: string) {
    delete this.attrs[k];
  }
  append(...kids: Array<MiniNode | string>) {
    for (const k of kids) {
      if (typeof k === 'string') {
        const span = new MiniNode('span');
        span.textContent = k;
        this.appendChild(span);
      } else {
        this.appendChild(k);
      }
    }
  }
  appendChild(kid: MiniNode) {
    kid.parentNode = this;
    this.children.push(kid);
    return kid;
  }
  replaceChildren(...kids: Array<MiniNode | string>) {
    this.children = [];
    this.append(...kids);
  }
  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter(c => c !== this);
      this.parentNode = null;
    }
  }
  addEventListener(ev: string, fn: (ev?: any) => void) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, []);
    this.listeners.get(ev)!.push(fn);
  }
  click() {
    for (const fn of this.listeners.get('click') || []) {
      fn({stopPropagation() {}, preventDefault() {}});
    }
  }
  input(val: string) {
    this.value = val;
    for (const fn of this.listeners.get('input') || []) fn({target: this});
  }
  set innerHTML(v: string) {
    if (v === '') this.children = [];
  }
  get innerHTML() {
    return '';
  }
  get offsetWidth() {
    return 340;
  }
  get offsetHeight() {
    return 140;
  }
  matches(sel: string): boolean {
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    const dataMatch = /^\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/i.exec(sel);
    if (dataMatch) {
      const camel = dataMatch[1]!.replace(/-([a-z])/g, (_, ch: string) =>
        ch.toUpperCase(),
      );
      if (!(camel in this.dataset)) return false;
      return dataMatch[2] === undefined || this.dataset[camel] === dataMatch[2];
    }
    return this.tagName === sel.toUpperCase();
  }
  closest(sel: string): MiniNode | null {
    let cur: MiniNode | null = this;
    while (cur) {
      if (cur.matches(sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
  querySelectorAll(sel: string): MiniNode[] {
    const out: MiniNode[] = [];
    const walk = (node: MiniNode) => {
      for (const ch of node.children) {
        if (ch.matches(sel)) out.push(ch);
        walk(ch);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): MiniNode | null {
    return this.querySelectorAll(sel)[0] || null;
  }
  get allText(): string {
    return `${this.textContent} ${this.children.map(c => c.allText).join(' ')}`
      .replace(/\s+/g, ' ')
      .trim();
  }
}

test('LearnMapView renders layered SVG+HTML DAG, supports filters, node mastery actions, and jump-to-block', () => {
  const LearnMapView = require('../electron/renderer/learn_map_view');
  const ConceptGraph = require('../electron/renderer/concept_graph');
  assert.equal(typeof LearnMapView.renderMap, 'function');

  const conv = {
    id: 'c-dag',
    workMode: 'learn',
    learnMastery: {
      't0:b1': {nodeId: 't0:b1', status: 'verified', updatedAt: 10},
    },
    branches: [
      {
        id: 'br-p1',
        parentBranchId: null,
        parentTurnIndex: 0,
        anchor: {
          kind: 'math',
          label: 'bayes_rule',
          blockIndex: 2,
          snippet: 'bayes',
          priority: 'P1',
        },
        title: 'Posterior Check',
        kind: 'quiz',
        turns: [{question: 'Test boundary', answer: 'Because prior > 0'}],
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    turns: [
      {
        question: 'Explain Bayes Risk',
        answer: [
          ':::prereq [条件概率] -> [全概率公式]',
          ':::',
          ':::card [concept] Posterior',
          '==Posterior equals likelihood times prior==',
          ':::',
          '$$R(\\alpha) = \\sum_y L(\\alpha, y) P(y|x)$$',
        ].join('\n'),
      },
    ],
  };

  const prevDoc = globalThis.document;
  (globalThis as Record<string, unknown>).document = {
    createElement: (t: string) => new MiniNode(t),
    createElementNS: (_ns: string, t: string) => new MiniNode(t),
  };

  try {
    const topology = ConceptGraph.extractTopology(conv);
    const host = new MiniNode('div') as unknown as HTMLElement;
    const jumps: string[] = [];
    const masteries: Array<{nodeId: string; status: string}> = [];
    const quizzes: string[] = [];

    LearnMapView.renderMap(host, topology, {
      onJumpToBlock: (node: any) => jumps.push(node.id),
      onSetMastery: (node: any, status: string) =>
        masteries.push({nodeId: node.id, status}),
      onQuizNode: (node: any) => quizzes.push(node.id),
    });

    const root = host as unknown as MiniNode;
    assert.ok(root.querySelector('svg'), 'Expected SVG dependency canvas');
    assert.ok(root.querySelectorAll('path').length >= 1, 'Expected SVG edges');
    const nodeBtns = root.querySelectorAll('.mp-learn-map-node');
    assert.ok(nodeBtns.length >= 2, 'Expected clickable DAG nodes');

    nodeBtns[0]!.click();
    assert.equal(jumps.length, 1);

    const quizBtn = root
      .querySelectorAll('button')
      .find(b => b.textContent.includes('防错测验'));
    assert.ok(quizBtn, 'Expected node 防错测验 button in detail strip');
    quizBtn.click();
    assert.equal(quizzes.length, 1);

    const masterBtn = root
      .querySelectorAll('button')
      .find(b => b.textContent.includes('已掌握'));
    assert.ok(masterBtn, 'Expected node 已掌握 button in detail strip');
    masterBtn.click();
    assert.equal(masteries[0]?.status, 'verified');

    // Filter to unmastered only hides the verified node
    const unmasteredFilter = root
      .querySelectorAll('button')
      .find(b => b.textContent.includes('未掌握'));
    assert.ok(unmasteredFilter);
    unmasteredFilter.click();
    assert.ok(
      root.querySelectorAll('.mp-learn-map-node').length < nodeBtns.length,
    );
  } finally {
    globalThis.document = prevDoc;
  }
});

test('LearnTree renders 4-tab Workbench (图谱/疑问队列/对照台/沉淀), Feynman Digest markdown, and 3-mode inquiry popover', async () => {
  const ConceptGraph = require('../electron/renderer/concept_graph');
  const LearnLab = require('../electron/renderer/learn_lab');
  const LearnMapView = require('../electron/renderer/learn_map_view');
  const LearnTree = require('../electron/renderer/learn_tree');

  (globalThis as Record<string, unknown>).ConceptGraph = ConceptGraph;
  (globalThis as Record<string, unknown>).LearnLab = LearnLab;
  (globalThis as Record<string, unknown>).LearnMapView = LearnMapView;

  const sentCalls: any[] = [];
  const patchCalls: any[] = [];
  const prevData = (globalThis as Record<string, unknown>).Data;
  (globalThis as Record<string, unknown>).Data = {
    learnSend: async (p: any) => {
      sentCalls.push(p);
      return {ok: true};
    },
    learnPatch: async (p: any) => {
      patchCalls.push(p);
      return {ok: true, conversation: conv};
    },
    onLearnProgress: () => {},
  };

  const conv = {
    id: 'c-wb',
    title: 'Bayes Risk',
    workMode: 'learn',
    learnMastery: {
      't0:b1': {nodeId: 't0:b1', status: 'gap', updatedAt: 20},
    },
    branches: [
      {
        id: 'br-low',
        parentBranchId: null,
        parentTurnIndex: 0,
        anchor: {
          kind: 'card',
          label: 'Minor',
          blockIndex: 1,
          snippet: 'minor',
          priority: 'P3',
        },
        title: 'Minor Note',
        kind: 'ask',
        docked: false,
        turns: [{question: 'Minor?', answer: 'Ok.'}],
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: 'br-high',
        parentBranchId: null,
        parentTurnIndex: 0,
        anchor: {
          kind: 'math',
          label: 'Loss',
          blockIndex: 2,
          snippet: 'loss',
          priority: 'P1',
        },
        title: 'Critical Boundary',
        kind: 'quiz',
        docked: true,
        turns: [{question: 'Why convex?', answer: 'Unique minimizer.'}],
        createdAt: 3,
        updatedAt: 4,
      },
    ],
    turns: [
      {
        question: 'Bayes?',
        answer:
          ':::prereq [Prior]\n:::\n:::card [concept] Risk Formula\n==Expected posterior loss==\n:::\n$$\\omega_1 + \\lambda_{21}$$',
      },
    ],
  };

  const docBody = new MiniNode('body');
  const prevDoc = globalThis.document;
  (globalThis as Record<string, unknown>).document = {
    body: docBody,
    createElement: (t: string) => new MiniNode(t),
    createElementNS: (_ns: string, t: string) => new MiniNode(t),
    getElementById: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  try {
    LearnTree.init({
      getConversation: () => conv,
      getEffort: () => 'high',
      openDeckInInspector: () => {},
      openConversationById: () => {},
      refreshConversation: async () => {},
    });

    const host = new MiniNode('div') as unknown as HTMLElement;
    LearnTree.renderDeck(host, conv);
    const root = host as unknown as MiniNode;

    const tabButtons = root.querySelectorAll('.mp-learn-wb-tab');
    const tabLabels = tabButtons.map(b => b.textContent);
    assert.deepEqual(tabLabels, ['图谱', '疑问队列', '对照台', '沉淀']);

    // Queue tab orders P1 before P3
    tabButtons[1]!.click();
    const queueItems = root.querySelectorAll('.mp-learn-queue-item');
    assert.equal(queueItems.length, 2);
    assert.match(queueItems[0]!.allText, /P1.*Critical Boundary/);
    assert.match(queueItems[1]!.allText, /P3.*Minor Note/);

    // Digest tab synthesizes Markdown & saves via learnPatch
    tabButtons[3]!.click();
    assert.match(root.allText, /Bayes Risk/);
    assert.match(root.allText, /Expected posterior loss/);
    const saveDigestBtn = root
      .querySelectorAll('button')
      .find(b => b.textContent.includes('保存摘要'));
    assert.ok(saveDigestBtn);
    saveDigestBtn.click();
    assert.ok(patchCalls.some(p => p.action === 'save-digest'));

    // Popover supports 追问 / 防错测验 / 费曼复述 modes
    assert.equal(typeof LearnTree.__test?.openPopoverForTest, 'function');
    LearnTree.__test.openPopoverForTest({
      conversationId: conv.id,
      parentBranchId: null,
      parentTurnIndex: 0,
      anchor: {
        kind: 'math',
        label: 'ω₁ + λ₂₁',
        snippet: '\\omega_1 + \\lambda_{21}',
        blockIndex: 2,
      },
      rect: {left: 40, top: 40, right: 120, bottom: 70},
    });
    const pop = docBody.querySelector('.mp-learn-popover')!;
    assert.ok(pop, 'Expected inquiry popover on document.body');
    const modeBtns = pop.querySelectorAll('.mp-learn-popover-mode');
    assert.deepEqual(
      modeBtns.map(b => b.textContent),
      ['追问', '防错测验', '费曼复述'],
    );

    // Switch to 费曼复述 and submit explanation
    modeBtns[2]!.click();
    const input = pop.querySelector('input')!;
    input.input('后验风险越小，期望误判损失越低');
    const submitBtn = pop.querySelector('.mp-learn-popover-submit')!;
    submitBtn.click();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(sentCalls[0]?.kind, 'feynman');
    assert.match(sentCalls[0]?.question || '', /费曼/);
  } finally {
    globalThis.document = prevDoc;
    (globalThis as Record<string, unknown>).Data = prevData;
  }
});

test('studio.html labels inspector tab 学习台 and loads learn_map_view.js before learn_tree.js', () => {
  const html = fs.readFileSync(
    path.join(ROOT, 'electron', 'renderer', 'studio.html'),
    'utf8',
  );
  assert.match(html, /data-inspector-tab="learn"[^>]*>学习台</);
  const mapIdx = html.indexOf('learn_map_view.js');
  const treeIdx = html.indexOf('learn_tree.js');
  assert.ok(mapIdx > 0 && treeIdx > mapIdx);
});
