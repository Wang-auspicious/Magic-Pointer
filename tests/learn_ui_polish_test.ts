import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(__dirname, '..');

test('learn_tree.css enforces nowrap on priority pills, StretchText overview rules, Tufte sidenotes, and Learn HUD', () => {
  const css = fs.readFileSync(
    path.join(ROOT, 'electron', 'renderer', 'learn_tree.css'),
    'utf8',
  );
  assert.match(css, /\.mp-learn-priority-opt,[\s\S]*?white-space:\s*nowrap/);
  assert.match(css, /\[data-learn-resolution="overview"\]/);
  assert.match(css, /\.mp-learn-sidenote-gutter/);
  assert.match(css, /\.mp-learn-hud/);
});

test('LearnTree converts raw LaTeX branch labels to Unicode, builds Tufte sidenotes, and drives Learn HUD resolution and fading', () => {
  const ConceptGraph = require('../electron/renderer/concept_graph');
  const LearnLab = require('../electron/renderer/learn_lab');
  const LearnTree = require('../electron/renderer/learn_tree');
  assert.equal(typeof LearnTree.__test?.cleanFormulaLabel, 'function');
  assert.equal(typeof LearnTree.renderHud, 'function');

  // Verify global Graph/Lab integration and Unicode cleanup
  (globalThis as Record<string, unknown>).ConceptGraph = ConceptGraph;
  (globalThis as Record<string, unknown>).LearnLab = LearnLab;
  const cleaned = LearnTree.__test.cleanFormulaLabel('\\omega_1 + \\lambda_{21}');
  assert.equal(cleaned, 'ω₁ + λ₂₁');
  assert.doesNotMatch(cleaned, /\\omega|\\lambda/);

  // Build minimal DOM harness for HUD & StretchText resolution switch
  class FakeEl {
    tagName: string;
    className = '';
    textContent = '';
    hidden = false;
    type = '';
    title = '';
    dataset: Record<string, string> = {};
    attrs: Record<string, string> = {};
    children: FakeEl[] = [];
    listeners = new Map<string, Array<(...args: any[]) => void>>();
    classList = {
      add: (c: string) => {
        if (!this.className.split(/\s+/).includes(c)) {
          this.className = `${this.className} ${c}`.trim();
        }
      },
      remove: (c: string) => {
        this.className = this.className
          .split(/\s+/)
          .filter(x => x && x !== c)
          .join(' ');
      },
      contains: (c: string) => this.className.split(/\s+/).includes(c),
      toggle: (c: string, force?: boolean) => {
        const next = force ?? !this.classList.contains(c);
        if (next) this.classList.add(c);
        else this.classList.remove(c);
        return next;
      },
    };
    constructor(tag: string) {
      this.tagName = tag.toUpperCase();
    }
    setAttribute(k: string, v: string) {
      this.attrs[k] = String(v);
    }
    getAttribute(k: string) {
      return this.attrs[k] ?? null;
    }
    removeAttribute(k: string) {
      delete this.attrs[k];
    }
    append(...kids: FakeEl[]) {
      this.children.push(...kids);
    }
    appendChild(kid: FakeEl) {
      this.children.push(kid);
      return kid;
    }
    addEventListener(ev: string, fn: (...args: any[]) => void) {
      if (!this.listeners.has(ev)) this.listeners.set(ev, []);
      this.listeners.get(ev)!.push(fn);
    }
    click() {
      for (const fn of this.listeners.get('click') || []) fn({stopPropagation() {}});
    }
    querySelectorAll(sel: string): FakeEl[] {
      const out: FakeEl[] = [];
      const cls = sel.startsWith('.') ? sel.slice(1) : '';
      const walk = (n: FakeEl) => {
        for (const ch of n.children) {
          if (cls && ch.classList.contains(cls)) out.push(ch);
          else if (!cls && ch.tagName === sel.toUpperCase()) out.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel: string): FakeEl | null {
      return this.querySelectorAll(sel)[0] || null;
    }
    set innerHTML(v: string) {
      if (v === '') this.children = [];
    }
    get innerHTML() {
      return '';
    }
    get allText(): string {
      return `${this.textContent}${this.children.map(c => c.allText).join(' ')}`;
    }
  }

  const prevDoc = globalThis.document;
  (globalThis as Record<string, unknown>).document = {
    createElement: (t: string) => new FakeEl(t),
    createElementNS: (_ns: string, t: string) => new FakeEl(t),
  };

  try {
    const hud = new FakeEl('div') as unknown as HTMLElement;
    const stream = new FakeEl('div') as unknown as HTMLElement;
    const codeConv = {id: 'c-code', workMode: 'code' as const, turns: [{answer: 'done'}]};
    LearnTree.renderHud(hud, codeConv, stream);
    assert.equal(hud.hidden, true);

    const learnConv = {
      id: 'c-learn',
      workMode: 'learn' as const,
      learnMastery: {
        't0:b0': {nodeId: 't0:b0', status: 'verified' as const, updatedAt: 100},
      },
      turns: [
        {
          question: 'Bayes?',
          answer: ':::card [concept] Risk\n==Optimal decision==\n:::',
        },
      ],
    };
    LearnTree.renderHud(hud, learnConv, stream);
    assert.equal(hud.hidden, false);
    const hudText = (hud as unknown as FakeEl).allText;
    assert.match(hudText, /1\s*\/\s*1/);
    assert.match(hudText, /概览/);
    assert.match(hudText, /挖空自测/);

    const overviewBtn = (hud as unknown as FakeEl)
      .querySelectorAll('button')
      .find(b => b.textContent.includes('概览'));
    assert.ok(overviewBtn);
    overviewBtn.click();
    assert.equal(stream.dataset.learnResolution, 'overview');
  } finally {
    globalThis.document = prevDoc;
  }
});
