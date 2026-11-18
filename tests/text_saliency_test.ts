import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

type SaliencyLevel = 0 | 1 | 2 | 3;

interface ScoredTokenLike {
  text: string;
  start: number;
  end: number;
  isWord: boolean;
  level: SaliencyLevel;
  clauseIndex: number;
  protected: boolean;
}

interface ScoredClauseLike {
  index: number;
  wordCount: number;
  darkCount: number;
  tokens: ScoredTokenLike[];
}

interface ScoredParagraphLike {
  text: string;
  locale: 'en' | 'zh-Hans';
  tokens: ScoredTokenLike[];
  words: ScoredTokenLike[];
  clauses: ScoredClauseLike[];
  durationMs: number;
}

interface TextSaliencyApi {
  scoreParagraph(
    text: string,
    options?: {locale?: 'en' | 'zh-Hans' | 'auto'},
  ): ScoredParagraphLike;
  alignCompressions(
    original: string,
    compressedLevels:
      readonly string[] | {level1?: string; level2?: string; level3?: string},
    options?: {locale?: 'en' | 'zh-Hans' | 'auto'},
  ): ScoredParagraphLike;
  apply(
    rootEl: unknown,
    options?: {
      locale?: 'en' | 'zh-Hans' | 'auto';
      compressedLevels?:
        readonly string[] | {level1?: string; level2?: string; level3?: string};
      reveal?: boolean;
    },
  ): unknown;
  clear(rootEl: unknown): void;
}

const MODULE_PATH = path.resolve(
  __dirname,
  '..',
  'electron',
  'renderer',
  'text_saliency.ts',
);
const CSS_PATH = path.resolve(
  __dirname,
  '..',
  'electron',
  'renderer',
  'text_saliency.css',
);
const NOTICES_PATH = path.resolve(__dirname, '..', 'THIRD_PARTY_NOTICES.md');

function loadTextSaliency(): TextSaliencyApi {
  return require('../electron/renderer/text_saliency') as TextSaliencyApi;
}

const ESC_HTML: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

function escapeAttr(raw: string): string {
  return raw.replace(/[&<>"]/g, ch => ESC_HTML[ch] || ch);
}

function escapeText(raw: string): string {
  return raw.replace(/[&<>]/g, ch => ESC_HTML[ch] || ch);
}

class FakeNode {
  nodeType: number;
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;

  constructor(nodeType: number) {
    this.nodeType = nodeType;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] || null;
  }

  get nextSibling(): FakeNode | null {
    if (!this.parentNode) {
      return null;
    }
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 ? this.parentNode.childNodes[idx + 1] || null : null;
  }

  get textContent(): string {
    return this.childNodes.map(c => c.textContent).join('');
  }

  set textContent(value: string) {
    this.replaceChildren(new FakeText(String(value)));
  }

  appendChild<T extends FakeNode>(node: T): T {
    return this.insertBefore(node, null);
  }

  insertBefore<T extends FakeNode>(node: T, before: FakeNode | null): T {
    if (node.nodeType === 11) {
      const children = [...node.childNodes];
      for (const child of children) {
        this.insertBefore(child, before);
      }
      return node;
    }
    if (node.parentNode) {
      node.remove();
    }
    const idx = before
      ? this.childNodes.indexOf(before)
      : this.childNodes.length;
    const insertAt = idx < 0 ? this.childNodes.length : idx;
    this.childNodes.splice(insertAt, 0, node);
    node.parentNode = this;
    return node;
  }

  replaceChild<T extends FakeNode>(newChild: FakeNode, oldChild: T): T {
    const idx = this.childNodes.indexOf(oldChild);
    if (idx < 0) {
      throw new Error('oldChild not found');
    }
    if (newChild.nodeType === 11) {
      const children = [...newChild.childNodes];
      oldChild.parentNode = null;
      this.childNodes.splice(idx, 1);
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        if (child.parentNode) {
          child.remove();
        }
        child.parentNode = this;
        this.childNodes.splice(idx + i, 0, child);
      }
      return oldChild;
    }
    if (newChild.parentNode) {
      newChild.remove();
    }
    oldChild.parentNode = null;
    newChild.parentNode = this;
    this.childNodes.splice(idx, 1, newChild);
    return oldChild;
  }

  removeChild<T extends FakeNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove(): void {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  replaceChildren(...nodes: FakeNode[]): void {
    for (const existing of [...this.childNodes]) {
      existing.remove();
    }
    for (const node of nodes) {
      this.appendChild(node);
    }
  }
}

class FakeText extends FakeNode {
  data: string;

  constructor(data: string) {
    super(3);
    this.data = String(data);
  }

  get nodeValue(): string {
    return this.data;
  }

  set nodeValue(value: string) {
    this.data = String(value);
  }

  override get textContent(): string {
    return this.data;
  }

  override set textContent(value: string) {
    this.data = String(value);
  }
}

class FakeFragment extends FakeNode {
  constructor() {
    super(11);
  }
}

class FakeElement extends FakeNode {
  tagName: string;
  attrs: Record<string, string> = {};

  constructor(tag: string) {
    super(1);
    this.tagName = tag.toUpperCase();
  }

  get children(): FakeElement[] {
    return this.childNodes.filter(
      (node): node is FakeElement => node.nodeType === 1,
    );
  }

  get className(): string {
    return this.attrs.class || '';
  }

  set className(value: string) {
    if (!value) {
      delete this.attrs.class;
    } else {
      this.attrs.class = String(value);
    }
  }

  getAttribute(key: string): string | null {
    return Object.hasOwn(this.attrs, key) ? this.attrs[key] : null;
  }

  setAttribute(key: string, value: string): void {
    this.attrs[key] = String(value);
  }

  removeAttribute(key: string): void {
    delete this.attrs[key];
  }

  hasAttribute(key: string): boolean {
    return Object.hasOwn(this.attrs, key);
  }

  matchesSelector(selector: string): boolean {
    const trimmed = selector.trim();
    if (!trimmed) {
      return false;
    }
    if (trimmed.includes(' ')) {
      const parts = trimmed.split(/\s+/);
      const last = parts[parts.length - 1];
      if (!this.matchesSelector(last)) {
        return false;
      }
      let cur: FakeNode | null = this.parentNode;
      for (let i = parts.length - 2; i >= 0; i -= 1) {
        const part = parts[i];
        while (
          cur &&
          (cur.nodeType !== 1 || !(cur as FakeElement).matchesSelector(part))
        ) {
          cur = cur.parentNode;
        }
        if (!cur) {
          return false;
        }
        cur = cur.parentNode;
      }
      return true;
    }
    if (trimmed.startsWith('.')) {
      return this.className.split(/\s+/).includes(trimmed.slice(1));
    }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const inner = trimmed.slice(1, -1);
      const eq = inner.indexOf('=');
      if (eq < 0) {
        return this.hasAttribute(inner);
      }
      const attrName = inner.slice(0, eq).trim();
      const attrVal = inner
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      return this.getAttribute(attrName) === attrVal;
    }
    return this.tagName === trimmed.toUpperCase();
  }

  closest(selector: string): FakeElement | null {
    const options = selector.split(',').map(s => s.trim());
    let cur: FakeNode | null = this;
    while (cur) {
      if (
        cur.nodeType === 1 &&
        options.some(sel => (cur as FakeElement).matchesSelector(sel))
      ) {
        return cur as FakeElement;
      }
      cur = cur.parentNode;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const options = selector.split(',').map(s => s.trim());
    const found: FakeElement[] = [];
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        if (options.some(sel => child.matchesSelector(sel))) {
          found.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  get innerHTML(): string {
    return this.childNodes
      .map(child =>
        child.nodeType === 3
          ? escapeText((child as FakeText).data)
          : (child as FakeElement).outerHTML,
      )
      .join('');
  }

  get outerHTML(): string {
    const tag = this.tagName.toLowerCase();
    const attr = Object.entries(this.attrs)
      .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
      .join('');
    return `<${tag}${attr}>${this.innerHTML}</${tag}>`;
  }
}

function el(
  tag: string,
  attrs: Record<string, string> = {},
  ...children: Array<string | FakeNode>
): FakeElement {
  const node = new FakeElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, v);
  }
  for (const child of children) {
    node.appendChild(typeof child === 'string' ? new FakeText(child) : child);
  }
  return node;
}

function withFakeDocument<T>(fn: () => T): T {
  const globalAny = globalThis as {document?: unknown};
  const previous = globalAny.document;
  globalAny.document = {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (data: string) => new FakeText(data),
    createDocumentFragment: () => new FakeFragment(),
  };
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete globalAny.document;
    } else {
      globalAny.document = previous;
    }
  }
}

test('text_saliency.ts is a clean classic browser-global IIFE with Intl.Segmenter and zero top-level imports/exports', () => {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m);
  assert.match(source, /Intl\.Segmenter/);
  assert.match(source, /'en'|"en"/);
  assert.match(source, /'zh-Hans'|"zh-Hans"/);

  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  assert.doesNotMatch(transpiled, /^\s*Object\.defineProperty\(exports\b/m);
  assert.doesNotMatch(transpiled, /^\s*exports\.\w/m);

  const sandbox: {globalThis: {TextSaliency?: TextSaliencyApi}} = {
    globalThis: {},
  };
  vm.runInNewContext(transpiled, sandbox, {filename: 'text_saliency.js'});
  assert.equal(typeof sandbox.globalThis.TextSaliency?.apply, 'function');
  assert.equal(typeof sandbox.globalThis.TextSaliency?.clear, 'function');
  assert.equal(
    typeof sandbox.globalThis.TextSaliency?.scoreParagraph,
    'function',
  );
  assert.equal(
    typeof sandbox.globalThis.TextSaliency?.alignCompressions,
    'function',
  );
});

test('Engine 1 scores English and Chinese paragraphs in < 2ms with 4 discrete levels 0..3 and exact byte preservation', () => {
  const tsm = loadTextSaliency();
  const enText =
    'The architecture does not rely on recurrent states, because self-attention computes relationships across all 100% of tokens in parallel within a single layer.';
  const zhText =
    '当级数不满足绝对收敛条件时，所有部分和序列的极限无法在任意子区间上保持一致收敛，而且没有任何例外情况。';

  // Warm up Intl.Segmenter and JIT
  tsm.scoreParagraph(enText);
  tsm.scoreParagraph(zhText);

  const runs = 20;
  const start = performance.now();
  for (let i = 0; i < runs; i += 1) {
    tsm.scoreParagraph(i % 2 === 0 ? enText : zhText);
  }
  const avgMs = (performance.now() - start) / runs;
  assert.ok(
    avgMs < 2,
    `Expected average scoring < 2ms, got ${avgMs.toFixed(3)}ms`,
  );

  const enScored = tsm.scoreParagraph(enText);
  const zhScored = tsm.scoreParagraph(zhText);

  assert.equal(enScored.locale, 'en');
  assert.equal(zhScored.locale, 'zh-Hans');
  assert.equal(enScored.tokens.map(t => t.text).join(''), enText);
  assert.equal(zhScored.tokens.map(t => t.text).join(''), zhText);

  const enLevels = new Set(enScored.words.map(w => w.level));
  const zhLevels = new Set(zhScored.words.map(w => w.level));
  for (const level of enLevels) {
    assert.ok(level === 0 || level === 1 || level === 2 || level === 3);
  }
  for (const level of zhLevels) {
    assert.ok(level === 0 || level === 1 || level === 2 || level === 3);
  }
  assert.ok(
    enLevels.has(0) && enLevels.has(3),
    'English should span lightest 0 and darkest 3',
  );
  assert.ok(
    zhLevels.has(0) && zhLevels.has(3),
    'Chinese should span lightest 0 and darkest 3',
  );
});

test('Negations, quantifiers/numbers, capitalized entities, technical terms, and <strong> always retain level >= 3', () => {
  const tsm = loadTextSaliency();

  const negEn = tsm.scoreParagraph(
    'Users cannot proceed without valid tokens; we never allow no checks, neither local nor remote, and do not skip tests.',
  );
  const negWordsEn = new Map(
    negEn.words.map(w => [w.text.toLowerCase(), w.level]),
  );
  for (const requiredNeg of [
    'not',
    'never',
    'no',
    'without',
    'neither',
    'cannot',
    'nor',
  ]) {
    assert.equal(
      negWordsEn.get(requiredNeg),
      3,
      `English negation "${requiredNeg}" must retain level 3`,
    );
  }

  const negZh = tsm.scoreParagraph(
    '绝对不要跳过校验：如果没有权限，非管理员无法写入，也绝不或别修改无保护的字段。',
  );
  for (const tok of negZh.words) {
    if (/(不|没|非|无|别)/.test(tok.text)) {
      assert.equal(
        tok.level,
        3,
        `Chinese negation token "${tok.text}" must retain level 3`,
      );
    }
  }

  const quantText =
    'All 42 nodes must satisfy every check, using only 95% of memory across 3.14 seconds.';
  const quantScored = tsm.scoreParagraph(quantText);
  const quantMap = new Map(
    quantScored.words.map(w => [w.text.toLowerCase(), w.level]),
  );
  for (const key of ['all', 'only', 'every', '42', '95', '3.14']) {
    assert.equal(
      quantMap.get(key),
      3,
      `Quantifier/number "${key}" must retain level 3`,
    );
  }

  const techText =
    'The runtime uses PostgreSQL and FrameLease via TypeScript with snake_case_ids and HTTP.';
  const techScored = tsm.scoreParagraph(techText);
  const techByText = new Map(techScored.words.map(w => [w.text, w.level]));
  assert.equal(
    techByText.get('The'),
    0,
    'Sentence-initial stopword "The" stays de-emphasized',
  );
  for (const term of [
    'PostgreSQL',
    'FrameLease',
    'TypeScript',
    'snake_case_ids',
    'HTTP',
  ]) {
    assert.equal(
      techByText.get(term),
      3,
      `Entity/technical term "${term}" must retain level 3`,
    );
  }

  withFakeDocument(() => {
    const p = el(
      'p',
      {},
      'Consider ',
      el('strong', {}, 'the only'),
      ' critical invariant here.',
    );
    const before = p.textContent;
    tsm.apply(p);
    assert.equal(p.textContent, before);
    const strong = p.querySelector('strong')!;
    const strongSpans = strong.querySelectorAll('.mp-tsm-word');
    assert.equal(strongSpans.length, 2);
    for (const span of strongSpans) {
      assert.ok(
        span.className.split(/\s+/).includes('mp-tsm-l3'),
        `Token "${span.textContent}" inside <strong> must keep .mp-tsm-l3`,
      );
    }
  });
});

test('Clause invariant: every clause with >= 6 words retains at least 2 dark words (level >= 3)', () => {
  const tsm = loadTextSaliency();
  const cases = [
    'the background worker reads the local configuration file from the disk during normal startup, and the scheduler dispatches pending messages into the durable queue without dropping events.',
    'when a user clicks the button in the corner, the panel opens smoothly on the right side of the window while keeping focus inside the dialog.',
    '如果后台任务在等待确认时收到新的补充输入，系统会先保存最新状态然后再继续执行后续步骤，同时在界面上展示清晰的进度提示。',
  ];

  for (const text of cases) {
    const scored = tsm.scoreParagraph(text);
    assert.ok(scored.clauses.length >= 2, 'Should segment multiple clauses');
    for (const clause of scored.clauses) {
      if (clause.wordCount >= 6) {
        const darkWords = clause.tokens.filter(t => t.isWord && t.level >= 3);
        assert.ok(
          darkWords.length >= 2,
          `Clause "${clause.tokens.map(t => t.text).join('')}" (${clause.wordCount} words) had only ${darkWords.length} dark words`,
        );
      }
    }
  }
});

test('DOM apply() preserves textContent byte-for-byte, skips excluded elements, is idempotent, and clear() restores clean text nodes', () => {
  const tsm = loadTextSaliency();
  withFakeDocument(() => {
    const container = el(
      'div',
      {class: 'mp-chat-markdown'},
      el('h1', {}, 'Heading should stay untouched'),
      el('h3', {}, 'Subheading untouched'),
      el(
        'p',
        {},
        'The service ',
        el('strong', {}, 'always'),
        ' validates ',
        el('code', {}, 'FrameLease.id'),
        ' before saving state.',
      ),
      el('pre', {}, el('code', {}, 'const x = notModulated(123);')),
      el('kbd', {}, 'Alt'),
      el('samp', {}, 'sample output text'),
      el('button', {type: 'button'}, 'Do not modulate button text'),
      el(
        'table',
        {},
        el(
          'tbody',
          {},
          el('tr', {}, el('td', {}, 'Table cell text untouched')),
        ),
      ),
      el('span', {class: 'katex'}, 'x_1 + x_2 = 1'),
      el('div', {class: 'mp-katex-display'}, 'display math untouched'),
      el('p', {'data-tsm-skip': 'true'}, 'Explicitly skipped paragraph text.'),
      el(
        'section',
        {class: 'mp-learn-card'},
        el(
          'header',
          {},
          el('span', {class: 'mp-learn-card-tag'}, 'mechanism'),
          el('strong', {}, 'Card heading'),
        ),
        el(
          'div',
          {class: 'mp-learn-card-body'},
          el(
            'p',
            {},
            'The card body explains why convergence holds under uniform bounds.',
          ),
        ),
      ),
    );

    const originalText = container.textContent;
    const originalBytes = Buffer.from(originalText, 'utf8');

    tsm.apply(container);

    // Byte-for-byte zero text mutation
    assert.equal(container.textContent, originalText);
    assert.ok(Buffer.from(container.textContent, 'utf8').equals(originalBytes));

    // Excluded containers have zero .mp-tsm-word descendants
    const excludedSelectors = [
      'pre',
      'code',
      'kbd',
      'samp',
      'button',
      'table',
      'h1',
      'h3',
      '.katex',
      '.mp-katex-display',
      '[data-tsm-skip]',
      '.mp-learn-card .mp-learn-card-tag',
    ];
    for (const sel of excludedSelectors) {
      const target = container.querySelector(sel);
      assert.ok(target, `Expected fixture to have ${sel}`);
      assert.equal(
        target.querySelectorAll('.mp-tsm-word').length,
        0,
        `Excluded element ${sel} must not contain .mp-tsm-word spans`,
      );
    }

    // Included paragraphs WERE modulated
    const firstP = container.querySelector('p')!;
    const cardBodyP = container.querySelector('.mp-learn-card-body p')!;
    assert.ok(firstP.querySelectorAll('.mp-tsm-word').length > 0);
    assert.ok(cardBodyP.querySelectorAll('.mp-tsm-word').length > 0);

    // Idempotency: calling apply() twice produces identical HTML and no nested spans
    const htmlAfterFirst = container.outerHTML;
    const countAfterFirst = container.querySelectorAll('.mp-tsm-word').length;
    tsm.apply(container);
    assert.equal(container.outerHTML, htmlAfterFirst);
    assert.equal(
      container.querySelectorAll('.mp-tsm-word').length,
      countAfterFirst,
    );
    assert.equal(
      container.querySelectorAll('.mp-tsm-word .mp-tsm-word').length,
      0,
    );

    // clear(rootEl) removes all .mp-tsm-word spans and restores merged clean text nodes
    tsm.clear(container);
    assert.equal(container.querySelectorAll('.mp-tsm-word').length, 0);
    assert.equal(container.textContent, originalText);
    assert.ok(Buffer.from(container.textContent, 'utf8').equals(originalBytes));
    assert.equal(cardBodyP.childNodes.length, 1);
    assert.equal(cardBodyP.childNodes[0].nodeType, 3);
    assert.equal(firstP.childNodes.length, 5);
    assert.ok(
      firstP.childNodes.every((n, idx) =>
        idx === 1 || idx === 3 ? n.nodeType === 1 : n.nodeType === 3,
      ),
    );

    // Engine 2 DOM mode + reveal toggle + nested strong span
    const nested = el(
      'div',
      {},
      el(
        'p',
        {},
        'The ',
        el('strong', {}, el('span', {}, 'core')),
        ' mechanism validates local state.',
      ),
    );
    tsm.apply(nested, {
      compressedLevels: ['core mechanism validates state'],
      reveal: true,
    });
    assert.equal(nested.getAttribute('data-tsm-reveal'), 'true');
    assert.equal(
      nested.textContent,
      'The core mechanism validates local state.',
    );
    const words = nested.querySelectorAll('.mp-tsm-word');
    assert.equal(words[0].className, 'mp-tsm-word mp-tsm-l0');
    assert.equal(words[1].className, 'mp-tsm-word mp-tsm-l3');
    tsm.apply(nested, {reveal: false});
    assert.equal(nested.getAttribute('data-tsm-reveal'), null);
  });
});

test('Empty, whitespace, single-word, and empty-compression edge cases are safe and lossless', () => {
  const tsm = loadTextSaliency();
  for (const edge of ['', '   \n\t ', 'Done.', '完成。']) {
    const scored = tsm.scoreParagraph(edge);
    assert.equal(scored.tokens.map(t => t.text).join(''), edge);
    assert.ok(scored.words.every(w => w.level >= 0 && w.level <= 3));
  }
  const orig = 'The runtime does not skip validation checks.';
  const fallback = tsm.alignCompressions(orig, []);
  assert.equal(fallback.tokens.map(t => t.text).join(''), orig);
  assert.ok(fallback.words.some(w => w.level === 3));
});

test('Engine 2 alignCompressions() uses word-level LCS to map multi-level compressions onto discrete levels 0..3', () => {
  const tsm = loadTextSaliency();
  const original =
    'The background runtime validates every frame lease before running local tools so that stale coordinates never trigger wrong actions.';
  // 3 progressive compression tiers:
  // level 3 (strictest core)
  const core =
    'runtime validates lease stale coordinates never trigger wrong actions';
  // level 2 (mid)
  const mid =
    'background runtime validates every frame lease before running tools stale coordinates never trigger wrong actions';
  // level 1 (broad)
  const broad =
    'The background runtime validates every frame lease before running local tools stale coordinates never trigger wrong actions';

  const alignedAsc = tsm.alignCompressions(original, [core, mid, broad]);
  const alignedDesc = tsm.alignCompressions(original, [broad, mid, core]);
  const alignedMap = tsm.alignCompressions(original, {
    level1: broad,
    level2: mid,
    level3: core,
  });

  assert.equal(alignedAsc.tokens.map(t => t.text).join(''), original);
  assert.deepEqual(
    alignedAsc.words.map(w => w.level),
    alignedDesc.words.map(w => w.level),
  );
  assert.deepEqual(
    alignedAsc.words.map(w => w.level),
    alignedMap.words.map(w => w.level),
  );

  const byWord = new Map(
    alignedAsc.words.map(w => [w.text.toLowerCase(), w.level]),
  );
  assert.equal(byWord.get('validates'), 3, 'Core summary word -> level 3');
  assert.equal(byWord.get('never'), 3, 'Core summary word -> level 3');
  assert.equal(byWord.get('background'), 2, 'Mid-only word -> level 2');
  assert.equal(byWord.get('before'), 2, 'Mid-only word -> level 2');
  assert.equal(byWord.get('local'), 1, 'Broad-only word -> level 1');
  assert.equal(byWord.get('the'), 1, 'Broad-only word -> level 1');
  assert.equal(byWord.get('so'), 0, 'Omitted word -> level 0');
  assert.equal(byWord.get('that'), 0, 'Omitted word -> level 0');

  // Repeated words should align contextually via LCS rather than grabbing wrong occurrence
  const repeated =
    'First the model reads data, and then the model validates the final result.';
  const repCore = 'model validates result';
  const repMid = 'reads data model validates final result';
  const repBroad = 'First model reads data then model validates final result';
  const repAligned = tsm.alignCompressions(repeated, [
    repBroad,
    repMid,
    repCore,
  ]);
  const modelWords = repAligned.words.filter(w => w.text === 'model');
  assert.equal(modelWords.length, 2);
  assert.ok(
    modelWords[1].level === 3 && modelWords[0].level <= 2,
    `Expected second "model" (adjacent to "validates") to get level 3 and first "model" <= 2, got ${modelWords.map(w => w.level)}`,
  );

  // Chinese LCS compression alignment
  const zhOrig =
    '当系统检测到权限失效时，运行时会立即中止当前写入并提示用户确认。';
  const zhCore = '权限失效 运行时 中止 写入 确认';
  const zhMid = '系统 权限失效 运行时 立即 中止 写入 用户 确认';
  const zhBroad =
    '当 系统 检测 权限失效 时 运行时 立即 中止 当前 写入 提示 用户 确认';
  const zhAligned = tsm.alignCompressions(zhOrig, [zhCore, zhMid, zhBroad]);
  assert.equal(zhAligned.tokens.map(t => t.text).join(''), zhOrig);
  const zhLevels = new Set(zhAligned.words.map(w => w.level));
  assert.ok(zhLevels.has(3) && zhLevels.has(2) && zhLevels.has(0));
});

test('text_saliency.css modulates grayscale color-mix(in lab, --mp-ink) only without mutating font-weight or font-size, and supports recovery', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');

  // Must use color-mix(in lab, ...) with --mp-ink and Light + Dark percentages
  assert.match(
    css,
    /\.mp-tsm-l0\b[^}]*color-mix\(\s*in lab\s*,\s*var\(--mp-ink/s,
  );
  assert.match(
    css,
    /\.mp-tsm-l1\b[^}]*color-mix\(\s*in lab\s*,\s*var\(--mp-ink/s,
  );
  assert.match(
    css,
    /\.mp-tsm-l2\b[^}]*color-mix\(\s*in lab\s*,\s*var\(--mp-ink/s,
  );
  assert.match(
    css,
    /\.mp-tsm-l3\b[^}]*color-mix\(\s*in lab\s*,\s*var\(--mp-ink/s,
  );

  // Light and dark readable steps
  assert.match(css, /32%/);
  assert.match(css, /54%/);
  assert.match(css, /76%/);
  assert.match(css, /44%/);
  assert.match(css, /64%/);
  assert.match(css, /82%/);
  assert.match(css, /100%/);

  // Transition and font-weight inheritance; never change font-weight or font-size on saliency classes
  assert.match(css, /transition:\s*color\s+120ms\s+ease/);
  assert.match(css, /font-weight:\s*inherit/);
  const weightMutations = [...css.matchAll(/font-weight\s*:\s*([^;]+);/g)]
    .map(m => m[1].trim())
    .filter(v => v !== 'inherit');
  assert.equal(
    weightMutations.length,
    0,
    `Must never mutate font-weight: ${weightMutations.join(', ')}`,
  );
  const sizeMutations = [...css.matchAll(/font-size\s*:\s*([^;]+);/g)]
    .map(m => m[1].trim())
    .filter(v => v !== 'inherit');
  assert.equal(
    sizeMutations.length,
    0,
    `Must never mutate font-size: ${sizeMutations.join(', ')}`,
  );

  // Full-ink recovery triggers
  assert.match(css, /:hover\s+\.mp-tsm-word/);
  assert.match(css, /\[data-tsm-reveal=["']true["']\]/);
  assert.match(css, /\.mp-tsm-word::selection/);
  assert.match(css, /@media\s+print/);
});

test('THIRD_PARTY_NOTICES.md documents clean-room GP-TSM CHI 2024 algorithmic attribution', () => {
  const notices = fs.readFileSync(NOTICES_PATH, 'utf8');
  assert.match(notices, /Grammar-Preserving Text Saliency Modulation/i);
  assert.match(notices, /CHI\s*'?24|CHI\s+2024/i);
  assert.match(notices, /Gu\s+et\s+al\.|Ziwei\s*Gu/i);
  assert.match(notices, /clean-room|independent/i);
  assert.match(notices, /non-commercial/i);
});

test('L3 darkest skeleton retains conditions, comparatives, quantities, negations, and causal conclusions', () => {
  const api = loadTextSaliency();
  const zhConclusion =
    '只有当先验估计误差不超过 5% 且两类误判代价满足严格不等式时，该固定阈值才成立；如果噪声比例超过 20% 或样本存在严重类别偏移，则不能直接沿用原阈值，至少需要重新校准后验概率或采用超过 2 倍的交叉验证重采样，因此实际部署中必须先验证代价矩阵与先验分布，否则最优性无法保证。';
  const zhScored = api.scoreParagraph(zhConclusion, {locale: 'zh-Hans'});
  const zhDark = zhScored.words.filter(w => w.level === 3).map(w => w.text);
  for (const required of ['只有', '不超过', '5', '如果', '超过', '20', '不能', '至少', '因此', '必须', '否则', '无法', '保证']) {
    const matched = zhDark.some(tok => tok.includes(required) || (required === '不超过' && zhDark.includes('不') && zhDark.includes('超过')));
    assert.ok(
      matched,
      `ZH L3 darkest skeleton dropped critical semantic token "${required}". Got L3=[${zhDark.join(', ')}]`,
    );
  }

  const enConclusion =
    'This fixed threshold holds only if the prior error is at most 5% and costs differ strictly; unless noise stays below 20%, you must not reuse the old cutoff, and therefore must recalibrate optimality first.';
  const enScored = api.scoreParagraph(enConclusion, {locale: 'en'});
  const enDark = enScored.words.filter(w => w.level === 3).map(w => w.text.toLowerCase());
  for (const required of ['if', '5', 'unless', 'below', '20', 'not', 'therefore']) {
    assert.ok(
      enDark.includes(required),
      `EN L3 darkest skeleton dropped critical token "${required}". Got L3=[${enDark.join(', ')}]`,
    );
  }
});
