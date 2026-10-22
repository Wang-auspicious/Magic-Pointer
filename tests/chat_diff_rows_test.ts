import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import {buildSync} from 'esbuild';
import ts from 'typescript';
import * as diffRows from '../electron/renderer/chat_diff_rows';

const chat = require('../electron/renderer/chat_view');

function preview(beforeText: string, afterText: string): any {
  const diff = chat.__test.deriveDiff('', '', {
    kind: 'file_diff',
    beforeText,
    afterText,
  });
  return chat.__test.diffPreviewNode(diff, {filePath: 'actual.txt'});
}

function findAll(root: any, className: string): any[] {
  const found: any[] = [];
  const walk = (node: any): void => {
    if (typeof node?.getAttribute !== 'function') {
      return;
    }
    if (node.getAttribute('class')?.split(' ').includes(className)) {
      found.push(node);
    }
    node.children.forEach(walk);
  };
  walk(root);
  return found;
}

test('full retained versions show one original-side number per unified row', () => {
  const root = preview('first\nold A\nold B\nlast\n', 'first\nnew\nlast\n');
  const rows = findAll(root, 'mp-chat-diff-code-row');
  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.map(row => row.getAttribute('data-kind')),
    ['context', 'del', 'del', 'add', 'context'],
  );
  assert.deepEqual(
    rows.map(row => row.getAttribute('data-line-number')),
    ['1', '2', '3', '2', '3'],
  );
  const bodies = findAll(root, 'mp-chat-diff-code-text');
  assert.deepEqual(
    bodies.map(body => body.children.join('')),
    ['first', 'old A', 'old B', 'new', 'last'],
  );
  assert.equal(findAll(root, 'mp-chat-diff-number').length, rows.length);
  assert.ok(root.outerHTML.includes('data-mp-chat-copy="first\nnew\nlast\n"'));
});

test('whole-file Write has numbered empty lines and a bounded initial window', () => {
  const content = 'first\n' + '\n'.repeat(12000) + 'last';
  const root = chat.toolRowNode(
    chat.toolRowModel(
      'Write',
      JSON.stringify({
        path: 'actual.txt',
        content,
      }),
    ),
  );
  const rows = findAll(root, 'mp-chat-diff-code-row');
  assert.ok(rows.length > 0 && rows.length <= 50);
  assert.equal(rows[1].getAttribute('data-line-number'), '2');
  assert.equal(findAll(root, 'mp-chat-diff-virtual-spacer').length, 2);
  assert.ok(root.outerHTML.includes('data-diff-total-rows="12002"'));
  assert.ok(root.outerHTML.includes('data-mp-chat-copy="' + content + '"'));
});

test('displayed lone CR is visible while copy retains the actual file text', () => {
  const root = preview('', 'a\rb\r\n\nlast\n');
  const rows = findAll(root, 'mp-chat-diff-code-text');
  assert.deepEqual(
    rows.map(row => row.children.join('')),
    ['a␍b', '', 'last'],
  );
  assert.ok(root.outerHTML.includes('data-mp-chat-copy="a\rb\r\n\nlast\n"'));
  const fragment = chat.toolRowNode(
    chat.toolRowModel(
      'Edit',
      JSON.stringify({
        path: 'actual.txt',
        old_string: 'partial old',
        new_string: 'partial new',
      }),
    ),
  );
  assert.equal(findAll(fragment, 'mp-chat-diff-number').length, 0);
});

test('pure file sides select the original File branch rather than unified indicators', () => {
  const added = findAll(preview('', 'created\n'), 'mp-chat-diff')[0];
  const deleted = findAll(preview('removed\n', ''), 'mp-chat-diff')[0];
  const mixed = findAll(preview('old\n', 'new\n'), 'mp-chat-diff')[0];
  assert.equal(added.getAttribute('data-diff-pure-side'), 'add');
  assert.equal(deleted.getAttribute('data-diff-pure-side'), 'del');
  assert.equal(mixed.getAttribute('data-diff-pure-side'), null);
});

test('retained diff uses four context lines, actual offsets and simple inter-hunk gaps', () => {
  const lines = Array.from({length: 60}, (_, i) => `line ${i + 1}\n`);
  const after = [...lines];
  after[9] = 'changed 10\n';
  after[39] = 'changed 40\n';
  const root = preview(lines.join(''), after.join(''));
  const rows = findAll(root, 'mp-chat-diff-code-row');
  assert.deepEqual(
    rows.map(row => Number(row.getAttribute('data-line-number'))),
    [
      6, 7, 8, 9, 10, 10, 11, 12, 13, 14, 36, 37, 38, 39, 40, 40, 41, 42, 43,
      44,
    ],
  );
  assert.equal(findAll(root, 'mp-chat-diff-hunk-separator').length, 1);
  assert.ok(
    root.outerHTML.includes('data-mp-chat-copy="' + after.join('') + '"'),
  );
  const bodies = findAll(root, 'mp-chat-diff-code-text').map(row =>
    row.children.join(''),
  );
  assert.ok(
    !bodies.includes('line 1') &&
      !bodies.includes('line 20') &&
      !bodies.includes('line 60'),
  );
  const separator = findAll(root, 'mp-chat-diff-hunk-separator')[0];
  assert.equal(separator.getAttribute('aria-hidden'), 'true');
  assert.equal(separator.getAttribute('data-mp-chat-act'), null);
});

test('one omitted context line is restored at edges and between close hunks', () => {
  for (const gap of [8, 9, 10]) {
    const context = Array.from({length: gap}, (_, i) => `context ${i}\n`).join(
      '',
    );
    const root = preview(
      `old first\n${context}old last\n`,
      `new first\n${context}new last\n`,
    );
    assert.equal(
      findAll(root, 'mp-chat-diff-hunk-separator').length,
      gap === 10 ? 1 : 0,
    );
    assert.equal(
      findAll(root, 'mp-chat-diff-code-row').length,
      4 + (gap === 10 ? 8 : gap),
    );
  }
  for (const edge of [5, 6]) {
    const context = Array.from({length: edge}, (_, i) => `edge ${i}\n`).join(
      '',
    );
    const root = preview(
      `${context}old\n${context}`,
      `${context}new\n${context}`,
    );
    const rows = findAll(root, 'mp-chat-diff-code-row');
    assert.equal(rows.length, edge === 5 ? 12 : 10);
    assert.equal(
      Number(rows[0].getAttribute('data-line-number')),
      edge === 5 ? 1 : 3,
    );
    assert.equal(findAll(root, 'mp-chat-diff-hunk-separator').length, 0);
  }
});

test('unchanged versions have no fake hunk and a long unchanged prefix is indexed, not rendered', () => {
  const unchanged = preview('same\nretained\n', 'same\nretained\n');
  assert.equal(findAll(unchanged, 'mp-chat-diff-code-row').length, 0);
  const context = Array.from({length: 12000}, (_, i) => `context ${i}\n`).join(
    '',
  );
  const root = preview(context + 'old\n', context + 'new\n');
  const rows = findAll(root, 'mp-chat-diff-code-row');
  assert.equal(rows.length, 6);
  assert.equal(rows[0].getAttribute('data-line-number'), '11997');
  assert.equal(findAll(root, 'mp-chat-diff-virtual-spacer').length, 0);
});

function viewportFixture(
  count = 12002,
  connect = true,
  versions?: {beforeText: string; afterText: string},
) {
  const frames = new Map<number, FrameRequestCallback>();
  const observers: any[] = [];
  const mutations: any[] = [];
  let sequence = 0;
  let lineHeight = 17;
  let width = 600;
  const measured = new Map<number, number>();
  const win = {
    requestAnimationFrame(callback: FrameRequestCallback) {
      frames.set(++sequence, callback);
      return sequence;
    },
    cancelAnimationFrame(id: number) {
      frames.delete(id);
    },
    getComputedStyle() {
      return {lineHeight: String(lineHeight), paddingTop: '4'};
    },
    ResizeObserver: class {
      targets = new Set<any>();
      constructor(readonly callback: (entries: any[]) => void) {
        observers.push(this);
      }
      observe(target: any) {
        this.targets.add(target);
      }
      unobserve(target: any) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
      deliver() {
        this.callback(
          [...this.targets].map(target => ({
            target,
            borderBoxSize: [{blockSize: target.getBoundingClientRect().height}],
          })),
        );
      }
    },
    MutationObserver: class {
      disconnected = false;
      constructor(readonly callback: () => void) {
        mutations.push(this);
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    },
  };
  class Element {
    attributes = new Map<string, string>();
    childNodes: any[] = [];
    parentNode: Element | null = null;
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    listeners = new Map<string, () => void>();
    scrollTop = 0;
    connected = false;
    constructor(readonly tagName: string) {}
    get ownerDocument() {
      return doc;
    }
    get isConnected(): boolean {
      return this.connected || !!this.parentNode?.isConnected;
    }
    get clientHeight() {
      return 400;
    }
    get clientWidth() {
      return width;
    }
    get children() {
      return this.childNodes.filter(child => child instanceof Element);
    }
    contains(node: Element): boolean {
      return this === node || this.children.some(child => child.contains(node));
    }
    setAttribute(key: string, value: string) {
      this.attributes.set(key, value);
      if (key.startsWith('data-')) {
        this.dataset[
          key.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
        ] = value;
      }
    }
    getAttribute(key: string) {
      return this.attributes.get(key) ?? null;
    }
    appendChild(child: any) {
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    replaceChildren(...children: any[]) {
      this.childNodes.forEach(child => {
        child.parentNode = null;
      });
      this.childNodes = [];
      children.forEach(child => this.appendChild(child));
    }
    querySelectorAll(selector: string) {
      return findAll(this, selector.slice(1)).filter(node => node !== this);
    }
    addEventListener(name: string, callback: () => void) {
      this.listeners.set(name, callback);
    }
    removeEventListener(name: string) {
      this.listeners.delete(name);
    }
    getBoundingClientRect() {
      if (this.getAttribute('class')?.includes('mp-chat-diff-hunk-separator')) {
        return {height: 4};
      }
      return {height: measured.get(Number(this.dataset.diffRow)) ?? lineHeight};
    }
  }
  const doc: any = {
    defaultView: win,
    documentElement: new Element('html'),
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => ({textContent: text, parentNode: null}),
  };
  const context = vm.createContext({
    document: doc,
    window: win,
    ChatDiffRows: diffRows,
    require: createRequire(path.resolve('electron/renderer/chat_view.ts')),
    module: {exports: {}},
  });
  const code = ts.transpileModule(
    fs.readFileSync('electron/renderer/chat_view.ts', 'utf8'),
    {
      compilerOptions: {target: ts.ScriptTarget.ES2022},
    },
  ).outputText;
  vm.runInContext(code, context);
  const api = (context.module as any).exports;
  const contents =
    versions?.afterText ??
    Array.from({length: count}, (_, i) => `actual ${i + 1}`).join('\n');
  const diff = api.__test.deriveDiff('', '', {
    kind: 'file_diff',
    beforeText: versions?.beforeText ?? '',
    afterText: contents,
  });
  const root = api.__test.diffPreviewNode(diff, {filePath: 'actual.txt'});
  const card = findAll(root, 'mp-chat-diff')[0];
  root.connected = connect;
  mutations.forEach(observer => observer.callback());
  const flush = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(0));
  };
  const settle = () => {
    flush();
    observers.forEach(observer => observer.deliver());
    flush();
  };
  return {
    root,
    card,
    observers,
    mutations,
    measured,
    frames,
    contents,
    settle,
    rows: () => findAll(card, 'mp-chat-diff-code-row'),
    scroll(top: number) {
      card.scrollTop = top;
      card.listeners.get('scroll')();
      settle();
    },
    resize(nextWidth: number, nextLineHeight: number) {
      width = nextWidth;
      lineHeight = nextLineHeight;
      observers.forEach(observer => observer.deliver());
      flush();
    },
    remove() {
      root.connected = false;
      mutations.forEach(observer =>
        observer.callback([{removedNodes: [root]}]),
      );
    },
  };
}

test('production row renderer scrolls to the retained tail and releases native observers', () => {
  const f = viewportFixture();
  f.settle();
  assert.ok(f.rows().length < 100);
  f.scroll(12002 * 17 - 400);
  assert.equal(f.rows().at(-1).getAttribute('data-line-number'), '12002');
  assert.equal(
    findAll(f.card, 'mp-chat-diff-code-text').at(-1).childNodes[0].textContent,
    'actual 12002',
  );
  assert.ok(f.rows().length < 100);
  f.scroll(0);
  assert.equal(f.rows()[0].getAttribute('data-line-number'), '1');
  f.remove();
  assert.ok(f.observers.every(observer => observer.targets.size === 0));
  assert.ok(f.mutations.every(observer => observer.disconnected));
  assert.equal(f.frames.size, 0);
  assert.equal(f.card.listeners.size, 0);
});

test('wrapped measured heights and density changes retain the visible logical anchor', () => {
  const f = viewportFixture(1000);
  f.settle();
  f.scroll(100 * 17 + 4);
  f.measured.set(90, 68);
  f.resize(600, 17);
  assert.equal(f.card.scrollTop, 100 * 17 + 4 + 51);
  assert.ok(
    f.rows().some(row => row.getAttribute('data-line-number') === '101'),
  );
  f.measured.clear();
  f.resize(400, 19);
  assert.equal(f.card.scrollTop, 100 * 19 + 4);
  assert.ok(f.rows().length < 100);
  f.remove();
});

test('simple hunk gaps keep their four-pixel height while a real row window scrolls and resizes', () => {
  const before = Array.from({length: 400}, (_, i) => `line ${i + 1}\n`);
  const after = [...before];
  for (let i = 0; i < 30; i++) {
    after[9 + i * 12] = `change ${i}\n`;
  }
  const f = viewportFixture(400, true, {
    beforeText: before.join(''),
    afterText: after.join(''),
  });
  f.settle();
  const count = Number(f.card.getAttribute('data-diff-total-rows'));
  const height = () =>
    findAll(f.card, 'mp-chat-diff-window-row').reduce(
      (total, row) => total + row.getBoundingClientRect().height,
      0,
    ) +
    findAll(f.card, 'mp-chat-diff-virtual-spacer').reduce(
      (total, row) =>
        total +
        Number.parseFloat(
          row.style.height || row.getAttribute('style').slice(8),
        ),
      0,
    );
  assert.ok(
    f.observers.some(observer =>
      [...observer.targets].some((row: any) =>
        row.getAttribute('class')?.includes('mp-chat-diff-hunk-separator'),
      ),
    ),
  );
  assert.equal(height(), count * 17 - 29 * 13);
  f.scroll(count * 17 - 400);
  assert.equal(f.rows().at(-1).getAttribute('data-line-number'), '362');
  f.resize(400, 19);
  assert.equal(height(), count * 19 - 29 * 15);
  assert.ok(f.rows().length < 100);
  f.remove();
});

test('a preview removed in its first DOM batch releases the unpainted window', () => {
  const f = viewportFixture(1000, false);
  f.remove();
  assert.ok(f.observers.every(observer => observer.targets.size === 0));
  assert.ok(f.mutations.every(observer => observer.disconnected));
  assert.equal(f.frames.size, 0);
});

test('row index retains empty-file, blank-line and old/new numbering without row objects', () => {
  assert.equal(diffRows.indexDiffRows([]).count, 0);
  const index = diffRows.indexDiffRows([
    {kind: 'del', text: '\nold\n'},
    {kind: 'add', text: '\n'},
    {kind: 'context', text: 'tail'},
  ]);
  assert.deepEqual(
    Array.from({length: index.count}, (_, i) => index.get(i)),
    [
      {kind: 'del', number: 1, text: ''},
      {kind: 'del', number: 2, text: 'old'},
      {kind: 'add', number: 1, text: ''},
      {kind: 'context', number: 2, text: 'tail'},
    ],
  );
});

test('both native surfaces load the actual build entry as a browser global', () => {
  const source = fs.readFileSync('scripts/build-electron.ts', 'utf8');
  const ast = ts.createSourceFile(
    'build-electron.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const entry = ast.statements.find(
    node =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(ast) === 'buildSync' &&
      node.getText(ast).includes("'chat_diff_rows.ts'"),
  );
  assert.ok(entry);
  let output = '';
  vm.runInNewContext(entry.getText(ast), {
    path,
    sourceRoot: path.resolve('electron'),
    outputRoot: path.resolve('data/runtime/inline-diff-rows-36/not-written'),
    buildSync: (options: any) => {
      output = buildSync({...options, write: false, sourcemap: false})
        .outputFiles![0].text;
    },
  });
  const browser = vm.createContext({});
  vm.runInContext(output, browser);
  assert.equal(
    vm.runInContext(
      "ChatDiffRows.indexDiffRows([{kind:'add',text:'native entry'}]).get(0).text",
      browser,
    ),
    'native entry',
  );
  for (const surface of ['studio', 'stage']) {
    const html = fs.readFileSync(`electron/renderer/${surface}.html`, 'utf8');
    const rows = html.indexOf('src="chat_diff_rows.js"');
    assert.ok(rows > 0 && rows < html.indexOf('src="chat_view.js'));
  }
});
