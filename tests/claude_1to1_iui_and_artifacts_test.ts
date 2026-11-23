import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {PDFDocument, rgb} from 'pdf-lib';
import sharp from 'sharp';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

interface MockNode {
  tagName: string;
  className: string;
  textContent: string;
  innerHTML: string;
  hidden: boolean;
  disabled: boolean;
  dataset: Record<string, string>;
  style: Record<string, string>;
  attributes: Record<string, string>;
  children: MockNode[];
  parentNode: MockNode | null;
  listeners: Record<string, Array<(ev?: Record<string, unknown>) => void>>;
  classList: {
    add: (...tokens: string[]) => void;
    remove: (...tokens: string[]) => void;
    contains: (token: string) => boolean;
    toggle: (token: string, force?: boolean) => boolean;
  };
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  appendChild: <T extends MockNode>(child: T) => T;
  append: (...nodes: Array<MockNode | string>) => void;
  replaceChildren: (...nodes: Array<MockNode | string>) => void;
  insertBefore: (child: MockNode, ref: MockNode | null) => MockNode;
  replaceWith: (node: MockNode) => void;
  remove: () => void;
  addEventListener: (
    type: string,
    cb: (ev?: Record<string, unknown>) => void,
  ) => void;
  dispatchEvent: (ev: Record<string, unknown>) => boolean;
  click: () => void;
  querySelector: (selector: string) => MockNode | null;
  querySelectorAll: (selector: string) => MockNode[];
}

function createMockDocument() {
  const attrToDataset = (attr: string) =>
    attr.slice(5).replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());

  function makeNode(tag: string): MockNode {
    const classes = new Set<string>();
    const node: MockNode = {
      tagName: tag.toUpperCase(),
      get className() {
        return Array.from(classes).join(' ');
      },
      set className(val: string) {
        classes.clear();
        for (const t of String(val || '').split(/\s+/)) {
          if (t) {
            classes.add(t);
          }
        }
      },
      textContent: '',
      innerHTML: '',
      hidden: false,
      disabled: false,
      dataset: {},
      style: {},
      attributes: {},
      children: [],
      parentNode: null,
      listeners: {},
      classList: {
        add(...tokens: string[]) {
          tokens.forEach(t => t && classes.add(t));
        },
        remove(...tokens: string[]) {
          tokens.forEach(t => classes.delete(t));
        },
        contains(token: string) {
          return classes.has(token);
        },
        toggle(token: string, force?: boolean) {
          const next = force === undefined ? !classes.has(token) : force;
          if (next) {
            classes.add(token);
          } else {
            classes.delete(token);
          }
          return next;
        },
      },
      setAttribute(k: string, v: string) {
        node.attributes[k] = String(v);
        if (k === 'class') {
          node.className = String(v);
        } else if (k === 'hidden') {
          node.hidden = String(v) !== 'false';
        } else if (k.startsWith('data-')) {
          node.dataset[attrToDataset(k)] = String(v);
        }
      },
      removeAttribute(k: string) {
        delete node.attributes[k];
        if (k === 'hidden') {
          node.hidden = false;
        }
      },
      getAttribute(k: string) {
        return k in node.attributes ? node.attributes[k] : null;
      },
      appendChild<T extends MockNode>(child: T): T {
        if (child.tagName === '#FRAGMENT') {
          for (const nested of [...child.children]) {
            node.appendChild(nested);
          }
          return child;
        }
        if (child.parentNode && child.parentNode !== node) {
          const idx = child.parentNode.children.indexOf(child);
          if (idx >= 0) {
            child.parentNode.children.splice(idx, 1);
          }
        }
        child.parentNode = node;
        node.children.push(child);
        return child;
      },
      append(...nodes: Array<MockNode | string>) {
        for (const item of nodes) {
          if (typeof item === 'string') {
            const txt = makeNode('#TEXT');
            txt.textContent = item;
            node.appendChild(txt);
          } else {
            node.appendChild(item);
          }
        }
      },
      replaceChildren(...nodes: Array<MockNode | string>) {
        node.children = [];
        node.append(...nodes);
      },
      insertBefore(child: MockNode, ref: MockNode | null) {
        child.parentNode = node;
        const idx = ref ? node.children.indexOf(ref) : -1;
        if (idx >= 0) {
          node.children.splice(idx, 0, child);
        } else {
          node.children.push(child);
        }
        return child;
      },
      replaceWith(replacement: MockNode) {
        if (!node.parentNode) {
          return;
        }
        node.parentNode.insertBefore(replacement, node);
        node.remove();
      },
      remove() {
        if (!node.parentNode) {
          return;
        }
        const idx = node.parentNode.children.indexOf(node);
        if (idx >= 0) {
          node.parentNode.children.splice(idx, 1);
        }
        node.parentNode = null;
      },
      addEventListener(type: string, cb: (ev?: Record<string, unknown>) => void) {
        node.listeners[type] = node.listeners[type] || [];
        node.listeners[type].push(cb);
      },
      dispatchEvent(ev: Record<string, unknown>) {
        const type = String(ev.type || '');
        for (const cb of node.listeners[type] || []) {
          cb({...ev, target: ev.target || node});
        }
        return true;
      },
      click() {
        node.dispatchEvent({type: 'click', target: node, preventDefault() {}});
      },
      querySelector(selector: string) {
        return node.querySelectorAll(selector)[0] || null;
      },
      querySelectorAll(selector: string) {
        const out: MockNode[] = [];
        const parts = selector
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
        const matchesPart = (cand: MockNode, sel: string): boolean => {
          const simple = sel.split(/\s+/).pop() || sel;
          const attrMatch = /^([^[]+)\[([^\]]+)\]$/.exec(simple);
          let base = simple;
          let attrName = '';
          if (attrMatch) {
            base = attrMatch[1];
            attrName = attrMatch[2].split('=')[0];
          }
          const okAttr = !attrName || attrName in cand.attributes;
          if (!okAttr) {
            return false;
          }
          if (base.startsWith('.')) {
            return cand.classList.contains(base.slice(1));
          }
          if (base === '*') {
            return true;
          }
          return cand.tagName.toLowerCase() === base.toLowerCase();
        };
        const walk = (curr: MockNode) => {
          for (const child of curr.children) {
            if (parts.some(p => matchesPart(child, p))) {
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

  const body = makeNode('body');
  return {
    documentElement: {dataset: {theme: 'dark'}},
    body,
    createElement: (tag: string) => makeNode(tag),
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
    createTextNode: (text: string) => {
      const t = makeNode('#TEXT');
      t.textContent = String(text);
      return t;
    },
    createDocumentFragment: () => makeNode('#FRAGMENT'),
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

function runBrowserScript(
  relPaths: string[],
  extraGlobals: Record<string, unknown> = {},
) {
  const document = createMockDocument();
  const context: Record<string, unknown> = {
    window: undefined,
    document,
    globalThis: undefined,
    HTMLElement: Object,
    console,
    setTimeout,
    clearTimeout,
    addEventListener: () => {},
    removeEventListener: () => {},
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, init?: {detail?: unknown}) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    ...extraGlobals,
  };
  context.globalThis = context;
  context.window = context;
  for (const relPath of relPaths) {
    const compiled = ts.transpileModule(readRepo(relPath), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    }).outputText;
    vm.runInNewContext(compiled, context, {filename: relPath});
  }
  return {context, document};
}

function collectText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (!node || typeof node !== 'object') {
    return '';
  }
  const anyNode = node as {textContent?: string; children?: unknown[]};
  return (anyNode.textContent || '') + (anyNode.children || []).map(collectText).join('');
}

function findAnyNodes(
  root: unknown,
  predicate: (node: Record<string, unknown>) => boolean,
  out: Array<Record<string, unknown>> = [],
): Array<Record<string, unknown>> {
  if (!root || typeof root !== 'object') {
    return out;
  }
  const rec = root as Record<string, unknown>;
  if (predicate(rec)) {
    out.push(rec);
  }
  if (Array.isArray(rec.children)) {
    for (const child of rec.children) {
      findAnyNodes(child, predicate, out);
    }
  }
  return out;
}

function classOf(node: Record<string, unknown>): string {
  const attrs = node.attrs as Record<string, string> | undefined;
  return String(node.className || attrs?.class || '');
}

function attrValue(node: Record<string, unknown>, key: string): string {
  const attrs = node.attrs as Record<string, string> | undefined;
  return String(attrs?.[key] || '');
}

test('Phase 1.1: Document.crop_pdf_figure renders and crops real PDF figures and registers in runtime', async () => {
  const {cropPdfFigure, registerPdfFigureTools} = require(
    '../electron/runtime/pdf_figure_tool',
  );
  const {ToolRegistry} = require('../electron/runtime/tools');
  const {initialToolNames} = require('../electron/runtime/agent_services');

  const learnTools = initialToolNames({workMode: 'learn', workspace: ''});
  assert.ok(learnTools.includes('Web.search_images'));
  assert.ok(learnTools.includes('Document.crop_pdf_figure'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-pdf-fig-'));
  try {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 300]);
    page.drawRectangle({
      x: 40,
      y: 130,
      width: 180,
      height: 110,
      color: rgb(0.15, 0.38, 0.85),
    });
    page.drawText('Figure 1: Transformer Scaled Dot-Product Block', {
      x: 40,
      y: 105,
      size: 11,
    });
    const pdfPath = path.join(tmpDir, 'paper.pdf');
    fs.writeFileSync(pdfPath, await doc.save());

    const explicitCrop = await cropPdfFigure(
      {
        path: pdfPath,
        page: 1,
        bbox: {x: 0.08, y: 0.15, width: 0.5, height: 0.45},
        caption: 'Fig. 1 · Attention Block (p.1)',
      },
      {dataDir: tmpDir},
    );
    assert.equal(explicitCrop.ok, true);
    assert.ok(fs.existsSync(explicitCrop.imagePath));
    const meta = await sharp(explicitCrop.imagePath).metadata();
    assert.ok((meta.width || 0) >= 200 && (meta.width || 0) <= 550);
    assert.ok((meta.height || 0) >= 120 && (meta.height || 0) <= 450);
    assert.ok(String(explicitCrop.fileUrl).startsWith('file:///'));
    assert.match(String(explicitCrop.markdown), /^!\[Fig\. 1/);

    const labelCrop = await cropPdfFigure(
      {
        path: pdfPath,
        page: 1,
        figureLabel: 'Figure 1',
      },
      {dataDir: tmpDir},
    );
    assert.equal(labelCrop.ok, true);
    assert.ok(fs.existsSync(labelCrop.imagePath));

    const registry = new ToolRegistry();
    registerPdfFigureTools(registry, {dataDir: tmpDir});
    assert.ok(registry.get('Document.crop_pdf_figure'));
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

test('Phase 1.1: Web.search_images parses image search results and falls back to Wikimedia Commons', async () => {
  const {registerWebTools, searchWebImages} = require(
    '../electron/runtime/agent_services',
  );
  const {ToolRegistry} = require('../electron/runtime/tools');

  const registry = new ToolRegistry();
  registerWebTools(registry);
  assert.ok(registry.get('Web.search_images'), 'Web.search_images must be registered');

  const ac = new AbortController();
  const mockFetch = async (url: string) => {
    if (url.includes('duckduckgo.com/?q=')) {
      return new Response('<html><script>vqd="4-1234567890";</script></html>', {
        status: 200,
      });
    }
    if (url.includes('duckduckgo.com/i.js')) {
      return new Response(
        JSON.stringify({
          results: [
            {
              title: 'Dwarf Lemur 1',
              image: 'https://lemurfaction.example.com/lemur1.jpg',
              thumbnail: 'https://lemurfaction.example.com/thumb1.jpg',
              url: 'https://lemurfaction.example.com/post',
              width: 900,
              height: 1200,
            },
            {
              title: 'Dwarf Lemur 2',
              image: 'https://wildlifemadagascar.example.org/lemur2.jpg',
              thumbnail: 'https://wildlifemadagascar.example.org/thumb2.jpg',
              url: 'https://wildlifemadagascar.example.org/entry',
              width: 800,
              height: 500,
            },
          ],
        }),
        {status: 200, headers: {'content-type': 'application/json'}},
      );
    }
    return new Response('{}', {status: 404});
  };
  const ddgRes = await searchWebImages(
    'Furry-eared Dwarf Lemur',
    4,
    ac.signal,
    mockFetch as unknown as typeof fetch,
  );
  assert.equal(ddgRes.results.length, 2);
  assert.equal(ddgRes.results[0].sourceDomain, 'lemurfaction.example.com');
  assert.match(ddgRes.galleryMarkdown, /^:::gallery Results from the web/);

  const wikiFallbackFetch = async (url: string) => {
    if (url.includes('commons.wikimedia.org')) {
      return new Response(
        JSON.stringify({
          query: {
            pages: {
              '101': {
                title: 'File:Cheirogaleus_medius.jpg',
                imageinfo: [
                  {
                    url: 'https://upload.wikimedia.org/wikipedia/commons/lemur.jpg',
                    thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/lemur.jpg',
                    width: 1024,
                    height: 768,
                    descriptionurl: 'https://commons.wikimedia.org/wiki/File:Cheirogaleus_medius.jpg',
                  },
                ],
              },
            },
          },
        }),
        {status: 200, headers: {'content-type': 'application/json'}},
      );
    }
    return new Response('', {status: 429});
  };
  const wikiRes = await searchWebImages(
    'Cheirogaleus medius',
    3,
    ac.signal,
    wikiFallbackFetch as unknown as typeof fetch,
  );
  assert.equal(wikiRes.results.length, 1);
  assert.equal(wikiRes.results[0].sourceDomain, 'commons.wikimedia.org');
});

test('Phase 1.2: Interactive :::steps stepper, citation pills, and Bento :::gallery collage render and hydrate interactively', () => {
  const {context, document} = runBrowserScript([
    'electron/renderer/chat_markdown.ts',
    'electron/renderer/intelligence_ui.ts',
  ]);
  const ChatMarkdown = context.ChatMarkdown as {render: (md: string) => MockNode};
  const IntelligenceUI = context.IntelligenceUI as {
    hydrate: (root: MockNode | null) => void;
  };

  const md = [
    'Read [apple](https://support.apple.com "cite") for account verification.',
    '',
    ':::steps',
    '## Revisa un dispositivo donde ya tengas sesión',
    'En un iPhone o iPad, abre Ajustes y toca tu nombre.',
    '## Usa un dispositivo de confianza',
    'Entra a iforgot.apple.com desde otro dispositivo.',
    '## Espera confirmación de recuperación',
    'Apple envía un SMS al llegar tu ventana.',
    ':::',
    '',
    ':::gallery Results from the web',
    '![Fat-tailed Dwarf Lemur | lemurfaction](https://example.com/a.jpg)',
    '![Pair on branch | vibe.2maarten](https://example.com/b.jpg)',
    '![Closeup | wildlifemadagascar](https://example.com/c.jpg)',
    ':::',
    '',
    '![One](https://example.com/1.png)',
    '![Two | arxiv](https://example.com/2.png)',
    '![Three | local](https://example.com/3.png)',
  ].join('\n');

  const root = document.body;
  root.appendChild(ChatMarkdown.render(md));
  IntelligenceUI.hydrate(root);

  const citePills = root.querySelectorAll('.mp-md-cite-pill');
  assert.equal(citePills.length, 1);
  assert.equal(collectText(citePills[0]), 'apple');

  const steppers = root.querySelectorAll('.mp-iui-steps');
  assert.equal(steppers.length, 1);
  const stepper = steppers[0];
  const dots = stepper.querySelectorAll('.mp-iui-step-dot');
  assert.equal(dots.length, 3);
  assert.equal(dots[0].classList.contains('is-active'), true);
  assert.equal(dots[1].classList.contains('is-active'), false);

  const panels = stepper.querySelectorAll('.mp-iui-step-panel');
  assert.equal(panels.length, 3);
  assert.equal(panels[0].hidden, false);
  assert.equal(panels[1].hidden, true);

  const nextBtn = stepper.querySelector('.mp-iui-steps-next');
  assert.ok(nextBtn);
  nextBtn.click();
  assert.equal(dots[1].classList.contains('is-active'), true);
  assert.equal(panels[0].hidden, true);
  assert.equal(panels[1].hidden, false);

  const viewAllBtn = stepper.querySelector('.mp-iui-steps-all-btn');
  assert.ok(viewAllBtn);
  viewAllBtn.click();
  assert.equal(panels.every(panel => panel.hidden === false), true);

  const galleries = root.querySelectorAll('.mp-md-gallery');
  assert.equal(galleries.length, 2, 'Both :::gallery and consecutive images must render .mp-md-gallery');
  assert.equal(galleries[0].dataset.count, '3');
  assert.equal(galleries[0].querySelectorAll('.mp-md-gallery-tile').length, 3);
  assert.equal(
    collectText(galleries[0].querySelector('.mp-md-gallery-source')!),
    'lemurfaction',
  );
  assert.equal(
    collectText(galleries[0].querySelector('.mp-md-gallery-caption')!),
    'Results from the web',
  );
});

test('Phase 2: Tool summary inline diff (+900 -0) and unified Published artifact + linked file row render cleanly', () => {
  const ChatView = require('../electron/renderer/chat_view');
  const fileResultsNode = ChatView.__test.fileResultsNode as (
    files: Array<Record<string, unknown>>,
    artifacts: Array<Record<string, unknown>>,
    conversationId: string,
  ) => MockNode | null;
  const toolGroupNode = ChatView.__test.toolGroupNode as (
    chips: Array<Record<string, unknown>>,
  ) => MockNode;

  const group = toolGroupNode([
    {
      name: 'Write',
      callId: 'c1',
      argsRaw: JSON.stringify({
        file_path: 'cvpr2027-verified-top5.html',
        content: 'line1\nline2',
      }),
      result: {
        text: JSON.stringify({
          path: 'cvpr2027-verified-top5.html',
          diffStat: {added: 900, removed: 0},
        }),
        isError: false,
      },
    },
    {
      name: 'Read',
      callId: 'c2',
      argsRaw: JSON.stringify({file_path: 'README.md'}),
      result: {text: 'ok', isError: false},
    },
  ]) as unknown as Record<string, unknown>;

  const diffStat = findAnyNodes(group, n =>
    classOf(n).includes('mp-chat-summary-diff'),
  )[0];
  assert.ok(diffStat, 'Tool group summary must display inline +added −removed diff stat');
  assert.ok(collectText(diffStat).includes('+900'));

  const card = fileResultsNode(
    [
      {
        path: 'C:/tmp/cvpr2027-verified-top5.html',
        name: 'cvpr2027-verified-top5.html',
        added: 293,
        removed: 13,
        statKnown: true,
        created: true,
        deleted: false,
        sourceCalls: new Set(['c1']),
      },
    ],
    [
      {
        artifactId: 'art-cvpr',
        kind: 'html',
        title: 'CVPR 2027 选题核验',
        filename: 'cvpr2027-verified-top5.html',
        path: 'C:/tmp/cvpr2027-verified-top5.html',
        revision: 1,
      },
    ],
    'conv-p2',
  ) as unknown as Record<string, unknown> | null;
  assert.ok(card, 'fileResultsNode must render unified delivery card');
  assert.match(collectText(card), /Published artifact/);
  assert.match(collectText(card), /CVPR 2027 选题核验/);
  assert.match(collectText(card), /Open/);
  assert.ok(
    findAnyNodes(card, n => attrValue(n, 'data-mp-chat-act') === 'open-file').length >= 1,
    'Linked backing file row (+293 −13) must stay visible below Published artifact header',
  );
});
