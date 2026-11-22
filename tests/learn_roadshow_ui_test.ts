import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

interface MockNode {
  tagName: string;
  className: string;
  textContent: string;
  value: string;
  hidden: boolean;
  disabled: boolean;
  readOnly: boolean;
  type: string;
  placeholder: string;
  rows: number;
  style: Record<string, string>;
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  children: MockNode[];
  parentElement: MockNode | null;
  listeners: Record<string, Array<(event?: Record<string, unknown>) => void>>;
  classList: {
    toggle: (token: string, force?: boolean) => boolean;
    contains: (token: string) => boolean;
    add: (token: string) => void;
    remove: (token: string) => void;
  };
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  appendChild: <T extends MockNode>(child: T) => T;
  append: (...nodes: Array<MockNode | string>) => void;
  replaceChildren: (...nodes: Array<MockNode | string>) => void;
  addEventListener: (
    type: string,
    cb: (event?: Record<string, unknown>) => void,
  ) => void;
  dispatchEvent: (event: Record<string, unknown>) => boolean;
  click: () => void;
  focus: () => void;
  querySelector: (selector: string) => MockNode | null;
  querySelectorAll: (selector: string) => MockNode[];
}

function createMockDocument() {
  function attrToDatasetKey(attr: string): string {
    return attr
      .slice(5)
      .replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
  }

  function makeNode(tag: string): MockNode {
    const classes = new Set<string>();
    const node: MockNode = {
      tagName: tag.toUpperCase(),
      get className() {
        return Array.from(classes).join(' ');
      },
      set className(v: string) {
        classes.clear();
        for (const token of String(v || '').split(/\s+/)) {
          if (token) {
            classes.add(token);
          }
        }
      },
      textContent: '',
      value: '',
      hidden: false,
      disabled: false,
      readOnly: false,
      type: '',
      placeholder: '',
      rows: 1,
      style: {},
      dataset: {},
      attributes: {},
      children: [],
      parentElement: null,
      listeners: {},
      classList: {
        toggle(token: string, force?: boolean) {
          const next = force === undefined ? !classes.has(token) : force;
          if (next) {
            classes.add(token);
          } else {
            classes.delete(token);
          }
          return next;
        },
        contains(token: string) {
          return classes.has(token);
        },
        add(token: string) {
          classes.add(token);
        },
        remove(token: string) {
          classes.delete(token);
        },
      },
      setAttribute(name: string, value: string) {
        node.attributes[name] = String(value);
        if (name === 'class') {
          node.className = String(value);
        } else if (name.startsWith('data-')) {
          node.dataset[attrToDatasetKey(name)] = String(value);
        }
      },
      getAttribute(name: string) {
        return name in node.attributes ? node.attributes[name] : null;
      },
      appendChild<T extends MockNode>(child: T): T {
        if (child.tagName === '#FRAGMENT') {
          for (const nested of [...child.children]) {
            node.appendChild(nested);
          }
          return child;
        }
        child.parentElement = node;
        node.children.push(child);
        return child;
      },
      append(...nodes: Array<MockNode | string>) {
        for (const item of nodes) {
          if (typeof item === 'string') {
            const textNode = makeNode('#TEXT');
            textNode.textContent = item;
            node.appendChild(textNode);
          } else {
            node.appendChild(item);
          }
        }
      },
      replaceChildren(...nodes: Array<MockNode | string>) {
        node.children = [];
        node.append(...nodes);
      },
      addEventListener(type: string, cb: (event?: Record<string, unknown>) => void) {
        if (!node.listeners[type]) {
          node.listeners[type] = [];
        }
        node.listeners[type].push(cb);
      },
      dispatchEvent(event: Record<string, unknown>) {
        const type = String(event.type || '');
        for (const cb of node.listeners[type] || []) {
          cb(event);
        }
        return true;
      },
      click() {
        node.dispatchEvent({type: 'click', target: node, preventDefault() {}});
      },
      focus() {},
      querySelector(selector: string) {
        return node.querySelectorAll(selector)[0] || null;
      },
      querySelectorAll(selector: string) {
        const out: MockNode[] = [];
        const matchSingle = (candidate: MockNode, sel: string): boolean => {
          const s = sel.trim();
          if (s.startsWith('.')) {
            return candidate.classList.contains(s.slice(1));
          }
          return candidate.tagName.toLowerCase() === s.toLowerCase();
        };
        const walk = (curr: MockNode) => {
          for (const child of curr.children) {
            if (matchSingle(child, selector)) {
              out.push(child);
            }
            walk(child);
          }
        };
        walk(node);
        return out;
      },
    };
    return node;
  }

  return {
    createElement(tag: string) {
      return makeNode(tag);
    },
    createElementNS(_ns: string, tag: string) {
      return makeNode(tag);
    },
    createTextNode(text: string) {
      const node = makeNode('#TEXT');
      node.textContent = String(text);
      return node;
    },
    createDocumentFragment() {
      return makeNode('#FRAGMENT');
    },
  };
}

function runBrowserGlobalScript(relPath: string, extraGlobals: Record<string, unknown>) {
  const source = readRepo(relPath);
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  const document = createMockDocument();
  const context: Record<string, unknown> = {
    window: undefined,
    document,
    globalThis: undefined,
    HTMLElement: Object,
    console,
    setTimeout,
    clearTimeout,
    ...extraGlobals,
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(compiled, context, {filename: relPath});
  return {context, document};
}

test('ChatMarkdown parses :::checkin blocks into .mp-checkin-host containers', () => {
  const {context} = runBrowserGlobalScript('electron/renderer/chat_markdown.ts', {});
  const chatMd = context.ChatMarkdown as {
    render: (md: string) => MockNode;
  };
  assert.ok(chatMd, 'ChatMarkdown global must register');

  const md = [
    '先做一次直觉边界确认：',
    '',
    ':::checkin',
    'prompt: SwiGLU 里把 $W_1, W_3$ 升维拆成两条门控分支，隐藏维度为什么要缩成 $8/3 d$？',
    '- [1] 保持总参数量与双线性 FFN 对齐（3 个矩阵合计 ≈ 2 × 4d²） | 参数守恒',
    '- [2] 只是实验玄学调参，没有任何计算量考虑',
    ':::',
  ].join('\n');

  const frag = chatMd.render(md);
  const hosts = frag.querySelectorAll('.mp-checkin-host');
  assert.equal(hosts.length, 1, 'Expected exactly one .mp-checkin-host element');
  assert.equal(hosts[0].dataset.checkinComplete, 'true');
  assert.match(hosts[0].dataset.checkinRaw || '', /SwiGLU/);
});

test('LearnCheckinCard parses :::checkin block, injects unsure fallback, accepts reasoning note, and formats reply', () => {
  const {context} = runBrowserGlobalScript('electron/renderer/learn_checkin_card.ts', {});
  const cardApi = context.LearnCheckinCard as {
    parseBlock: (raw: string, fallbackId?: string) => Record<string, unknown> | null;
    render: (
      spec: Record<string, unknown>,
      handlers: {onSubmit: (payload: Record<string, unknown>) => void},
    ) => MockNode;
    formatReplyForAgent: (payload: Record<string, unknown>) => string;
  };
  assert.ok(cardApi, 'LearnCheckinCard global must register');

  const raw = [
    'prompt: 为什么 RoPE 在 $m-n$ 相对位移时只依赖旋转角差？',
    '- 正交旋转矩阵满足 $R_m^\\top R_n = R_{n-m}$ | 几何保持内积',
    '- 因为 Softmax 会自动消除绝对位置',
  ].join('\n');

  const parsed = cardApi.parseBlock(raw);
  assert.ok(parsed, 'parseBlock should parse valid checkin lines');

  let submitted: Record<string, unknown> | null = null;
  const el = cardApi.render(parsed, {
    onSubmit(payload) {
      submitted = payload;
    },
  });

  const options = el.querySelectorAll('.mp-checkin-option');
  assert.equal(options.length, 3, 'Should inject "我不太确定" fallback as 3rd option');
  assert.equal(options[2].classList.contains('is-unsure'), true);

  const noteInput = el.querySelector('textarea');
  assert.ok(noteInput, 'Should render optional reasoning textarea');
  noteInput.value = '我卡在正交矩阵转置为什么等于逆旋转这一步';
  noteInput.dispatchEvent({type: 'input', target: noteInput});
  options[2].click();

  const submitBtn = el.querySelector('.mp-checkin-submit');
  assert.ok(submitBtn, 'Should render submit button');
  submitBtn.click();

  assert.ok(submitted, 'Clicking submit must invoke onSubmit');
  assert.equal(submitted.unsure, true);
  assert.equal(
    submitted.reasoningNote,
    '我卡在正交矩阵转置为什么等于逆旋转这一步',
  );
  const reply = cardApi.formatReplyForAgent(submitted);
  assert.match(reply, /不太确定/);
  assert.match(reply, /正交矩阵转置/);
});

test('Studio HTML and TS wire 3-column Learn layout, course header pill, and all Learn modules', () => {
  const html = readRepo('electron/renderer/studio.html');
  assert.match(html, /learn_studio\.css/);
  assert.match(html, /id="header-learn-course-pill"/);
  assert.match(html, /id="header-study-toggle"/);
  assert.match(html, /id="learn-sidechat-dock"/);
  assert.match(html, /id="learn-sidechat-dock-host"/);
  assert.match(html, /learn_checkin_card\.js/);
  assert.match(html, /learn_neural_graph\.js/);
  assert.match(html, /learn_study_artifact\.js/);

  const studioSrc = readRepo('electron/renderer/studio.ts');
  assert.match(studioSrc, /setLearnSideChatDock/);
  assert.match(studioSrc, /mountLearnStudyWorkbench/);
  assert.match(studioSrc, /hydrateStreamCheckins/);
  assert.match(studioSrc, /onPromoteToArtifact/);
  assert.match(studioSrc, /LearnCheckinCard\.render/);
  assert.match(studioSrc, /Data\.learn\s*\.recordCheckin/);
});

test('Active Learn CSS and Sandbox enforce strict Claude monochrome CDS without orange accents', () => {
  const forbiddenOrangeRe = /#(d97757|cc5a36|f59575|f0936d|ea580c)/i;
  for (const relPath of [
    'electron/renderer/learn_studio.css',
    'electron/renderer/learn_tree.css',
    'electron/renderer/learn_kit_styles.css',
    'electron/renderer/iui_sandbox.html',
  ]) {
    const content = readRepo(relPath);
    assert.doesNotMatch(
      content,
      forbiddenOrangeRe,
      `${relPath} must not use orange accent colors in Learn chrome`,
    );
  }
});
