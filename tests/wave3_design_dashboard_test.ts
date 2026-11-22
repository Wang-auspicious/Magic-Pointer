'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, it} from 'node:test';
import vm from 'node:vm';

const ROOT = process.cwd();
const DESIGN_STUDIO_PATH = path.join(ROOT, 'electron/renderer/design_studio.ts');
const DESIGN_CSS_PATH = path.join(ROOT, 'electron/renderer/design_studio.css');
const DASHBOARD_CSS_PATH = path.join(ROOT, 'electron/renderer/dashboard.css');
const STUDIO_PATH = path.join(ROOT, 'electron/renderer/studio.ts');
const DATA_PATH = path.join(ROOT, 'electron/renderer/data.ts');

interface FakeElement {
  tagName: string;
  className: string;
  textContent: string;
  title: string;
  type: string;
  value: string;
  placeholder: string;
  min: string;
  max: string;
  step: string;
  hidden: boolean;
  clientWidth: number;
  clientHeight: number;
  style: Record<string, string>;
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  children: FakeElement[];
  listeners: Record<string, Array<(ev: unknown) => void>>;
  classList: {
    toggle(cls: string, force?: boolean): boolean;
    add(cls: string): void;
    remove(cls: string): void;
    contains(cls: string): boolean;
  };
  contentWindow: {postMessage(msg: unknown, target: string): void};
  set innerHTML(val: string);
  get innerHTML(): string;
  appendChild(child: FakeElement): FakeElement;
  append(...nodes: FakeElement[]): void;
  remove(): void;
  setAttribute(name: string, val: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  dispatchEvent(ev: {type: string; [key: string]: unknown}): void;
  querySelector(selector: string): FakeElement | null;
  querySelectorAll(selector: string): FakeElement[];
}

function createFakeDom(): {
  document: {
    createElement(tag: string): FakeElement;
  };
  window: {
    addEventListener(type: string, fn: (ev: unknown) => void): void;
    removeEventListener(type: string, fn: (ev: unknown) => void): void;
  };
  flushRaf(): void;
} {
  const rafQueue: Array<() => void> = [];
  const winListeners: Record<string, Array<(ev: unknown) => void>> = {};

  function matchesSelector(el: FakeElement, selector: string): boolean {
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      return el.className.split(/\s+/).includes(cls);
    }
    if (selector.startsWith('[') && selector.endsWith(']')) {
      const inner = selector.slice(1, -1);
      const eqIdx = inner.indexOf('=');
      if (eqIdx === -1) {
        return inner in el.attributes || (inner.startsWith('data-') && toCamel(inner.slice(5)) in el.dataset);
      }
      const attr = inner.slice(0, eqIdx);
      const expected = inner.slice(eqIdx + 1).replace(/^["']|["']$/g, '');
      return el.getAttribute(attr) === expected;
    }
    return el.tagName.toLowerCase() === selector.toLowerCase();
  }

  function toCamel(kebab: string): string {
    return kebab.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
  }

  function createElement(tag: string): FakeElement {
    let rawInnerHtml = '';
    const classes = new Set<string>();
    const el: FakeElement = {
      tagName: tag.toUpperCase(),
      get className(): string {
        return [...classes].join(' ');
      },
      set className(val: string) {
        classes.clear();
        for (const part of String(val || '').split(/\s+/)) {
          if (part) {
            classes.add(part);
          }
        }
      },
      textContent: '',
      title: '',
      type: '',
      value: '',
      placeholder: '',
      min: '',
      max: '',
      step: '',
      hidden: false,
      clientWidth: 900,
      clientHeight: 600,
      style: {},
      dataset: {},
      attributes: {},
      children: [],
      listeners: {},
      classList: {
        toggle(cls: string, force?: boolean): boolean {
          const has = classes.has(cls);
          const next = force === undefined ? !has : Boolean(force);
          if (next) {
            classes.add(cls);
          } else {
            classes.delete(cls);
          }
          return next;
        },
        add(cls: string) {
          classes.add(cls);
        },
        remove(cls: string) {
          classes.delete(cls);
        },
        contains(cls: string) {
          return classes.has(cls);
        },
      },
      contentWindow: {
        postMessage() {},
      },
      set innerHTML(val: string) {
        rawInnerHtml = val;
        if (val === '') {
          el.children = [];
        }
      },
      get innerHTML(): string {
        return rawInnerHtml;
      },
      appendChild(child: FakeElement): FakeElement {
        el.children.push(child);
        return child;
      },
      append(...nodes: FakeElement[]) {
        for (const n of nodes) {
          el.children.push(n);
        }
      },
      remove() {},
      setAttribute(name: string, val: string) {
        el.attributes[name] = val;
        if (name.startsWith('data-')) {
          el.dataset[toCamel(name.slice(5))] = val;
        }
      },
      removeAttribute(name: string) {
        delete el.attributes[name];
      },
      getAttribute(name: string): string | null {
        if (name in el.attributes) {
          return el.attributes[name];
        }
        if (name.startsWith('data-')) {
          const key = toCamel(name.slice(5));
          return key in el.dataset ? el.dataset[key] : null;
        }
        return null;
      },
      addEventListener(type: string, fn: (ev: unknown) => void) {
        if (!el.listeners[type]) {
          el.listeners[type] = [];
        }
        el.listeners[type].push(fn);
      },
      dispatchEvent(ev: {type: string; [key: string]: unknown}) {
        const list = el.listeners[ev.type] || [];
        for (const fn of list) {
          fn(ev);
        }
      },
      querySelector(selector: string): FakeElement | null {
        for (const child of el.children) {
          if (matchesSelector(child, selector)) {
            return child;
          }
          const nested = child.querySelector(selector);
          if (nested) {
            return nested;
          }
        }
        return null;
      },
      querySelectorAll(selector: string): FakeElement[] {
        const found: FakeElement[] = [];
        for (const child of el.children) {
          if (matchesSelector(child, selector)) {
            found.push(child);
          }
          found.push(...child.querySelectorAll(selector));
        }
        return found;
      },
    };
    return el;
  }

  return {
    document: {createElement},
    window: {
      addEventListener(type: string, fn: (ev: unknown) => void) {
        if (!winListeners[type]) {
          winListeners[type] = [];
        }
        winListeners[type].push(fn);
      },
      removeEventListener(type: string, fn: (ev: unknown) => void) {
        const list = winListeners[type];
        if (!list) {
          return;
        }
        const idx = list.indexOf(fn);
        if (idx !== -1) {
          list.splice(idx, 1);
        }
      },
    },
    flushRaf() {
      while (rafQueue.length > 0) {
        const cb = rafQueue.shift();
        cb?.();
      }
    },
    get _rafQueue() {
      return rafQueue;
    },
  } as unknown as {
    document: {createElement(tag: string): FakeElement};
    window: {
      addEventListener(type: string, fn: (ev: unknown) => void): void;
      removeEventListener(type: string, fn: (ev: unknown) => void): void;
    };
    flushRaf(): void;
  };
}

async function transpileAndRun<T>(
  filePath: string,
  globalName: string,
  extraGlobals: Record<string, unknown> = {},
): Promise<{api: T; sandbox: Record<string, unknown>}> {
  const ts = await import('typescript');
  const source = fs.readFileSync(filePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
      strict: true,
    },
  }).outputText;

  const sandbox: Record<string, unknown> = {
    console,
    Math,
    JSON,
    Object,
    Array,
    Map,
    Set,
    WeakMap,
    Number,
    String,
    Boolean,
    RegExp,
    Error,
    Date,
    Promise,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout,
    clearTimeout,
    ...extraGlobals,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${transpiled}\nif (typeof ${globalName} !== 'undefined') { globalThis.${globalName} = ${globalName}; }`,
    sandbox,
    {filename: filePath},
  );
  const api = sandbox[globalName] as T | undefined;
  assert.ok(api, `Expected globalThis.${globalName} to be defined`);
  return {api, sandbox};
}

describe('Wave 3: Design Studio auto-fit, topbar deduplication & handle extensions', () => {
  it('auto-fits Welcome Artboard via requestAnimationFrame, deduplicates topbar, adds + Add Artboard presets, and exposes fitToScreen/setLintFindings/focusBoard', async () => {
    const fakeDom = createFakeDom();
    const rafCallbacks: Array<() => void> = [];
    const {api: studio} = await transpileAndRun<{
      mount(
        container: unknown,
        options: Record<string, unknown>,
      ): {
        destroy(): void;
        setFiles(files: Record<string, string>): void;
        getViewContextXml(): string;
        getAnnotations(): unknown[];
        fitToScreen(): void;
        setLintFindings(findings: Record<string, unknown[]>): void;
        focusBoard(file: string): void;
      };
    }>(DESIGN_STUDIO_PATH, 'DesignStudio', {
      document: fakeDom.document,
      window: fakeDom.window,
      requestAnimationFrame: (cb: () => void) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      },
      cancelAnimationFrame: () => {},
    });

    const container = fakeDom.document.createElement('div');
    const addedPresets: Array<{id: string; label: string; width: number; height: number}> = [];
    const handle = studio.mount(container, {
      slug: 'welcome-canvas',
      manifest: {
        v: 3,
        title: 'Welcome Canvas',
        pages: [
          {id: 'page-1', name: 'Page 1'},
          {id: 'page-2', name: 'Page 2'},
        ],
        order: ['welcome.dc.html', 'mobile.dc.html'],
        boards: {
          'welcome.dc.html': {x: 0, y: 0, w: 1280, h: 800, title: 'Welcome Artboard', page: 'page-1'},
          'mobile.dc.html': {x: 0, y: 0, w: 390, h: 844, title: 'Mobile Flow', page: 'page-2'},
        },
      },
      files: {
        'welcome.dc.html': '<x-dc><h1>Welcome</h1></x-dc>',
        'mobile.dc.html': '<x-dc><h1>Mobile</h1></x-dc>',
      },
      onAddArtboard: (preset: {id: string; label: string; width: number; height: number}) => {
        addedPresets.push(preset);
      },
    });

    assert.equal(typeof handle.fitToScreen, 'function');
    assert.equal(typeof handle.setLintFindings, 'function');
    assert.equal(typeof handle.focusBoard, 'function');

    // Topbar deduplication: no duplicate .mp-design-title or Export… select
    const topbar = container.querySelector('.mp-design-topbar');
    assert.ok(topbar, 'Expected .mp-design-topbar');
    assert.equal(topbar.querySelector('.mp-design-title'), null, 'Duplicate canvas title must be removed from .mp-design-topbar');
    const selects = topbar.querySelectorAll('select');
    assert.equal(selects.length, 2, 'Expected Page switcher <select> and + Add Artboard <select>');
    const exportOption = selects
      .flatMap(s => s.children)
      .find(opt => /Export/i.test(opt.textContent));
    assert.equal(exportOption, undefined, 'Duplicate Export select must be removed from .mp-design-topbar');

    // + Add Artboard preset options
    const addSelect = selects[1];
    const presetLabels = addSelect.children.map(o => o.textContent);
    assert.ok(presetLabels[0].includes('+ Add Artboard'));
    for (const expected of [
      'Desktop 1440×900',
      'Tablet 820×1180',
      'Mobile 390×844',
      'Slide 1920×1080',
      'Dashboard 1280×800',
    ]) {
      assert.ok(presetLabels.includes(expected), `Expected preset option ${expected}`);
    }
    addSelect.value = 'mobile';
    addSelect.dispatchEvent({type: 'change'});
    assert.equal(addedPresets.length, 1);
    assert.equal(addedPresets[0].width, 390);
    assert.equal(addedPresets[0].height, 844);

    // Auto-fit scheduled via requestAnimationFrame scales 1280x800 Welcome Artboard to fit inside 900x600 viewport
    assert.ok(rafCallbacks.length >= 1, 'Expected initial mount to schedule requestAnimationFrame for auto-fit');
    for (const cb of rafCallbacks) {
      cb();
    }
    const world = container.querySelector('.mp-design-canvas-world');
    assert.ok(world, 'Expected .mp-design-canvas-world');
    const match = /scale\(([^)]+)\)/.exec(world.style.transform || '');
    assert.ok(match, `Expected transform scale(...), got ${world.style.transform}`);
    const zoom = Number(match[1]);
    assert.ok(zoom < 1 && zoom > 0.4, `Expected fitted zoom < 1 for 1280x800 in 900x600 viewport, got ${zoom}`);

    // setLintFindings updates Code inspector badges
    handle.setLintFindings({
      'welcome.dc.html': [{severity: 'P0', rule: 'no-generic-slop', message: 'Avoid generic gradients'}],
    });
    const codeTab = container.querySelector('[data-testid="dc-mode-code"]');
    assert.ok(codeTab);
    codeTab.dispatchEvent({type: 'click'});
    const badge = container.querySelector('.mp-design-lint-badge');
    assert.ok(badge, 'Expected lint badge in Code inspector after setLintFindings');
    assert.match(badge.textContent, /P0 no-generic-slop/);

    // focusBoard switches page & selects target artboard
    handle.focusBoard('mobile.dc.html');
    const ctxXml = handle.getViewContextXml();
    assert.match(ctxXml, /page="page-2"/);
    assert.match(ctxXml, /selected_artboards="mobile\.dc\.html"/);

    handle.destroy();
  });
});

describe('Wave 3: Sidebar multi-agent badges, Design workspace UX & Dashboard parity', () => {
  it('unwraps nested projects:ma:sidebar-badges ({ badge: { kind, count }, threads }) and subscribes once to onProjectsMaEvent', () => {
    const studioSrc = fs.readFileSync(STUDIO_PATH, 'utf8');
    assert.match(studioSrc, /rawBadgeEntry\?\.badge\s*\?\?\s*rawBadgeEntry/);
    assert.match(studioSrc, /badge\?:\s*(?:\{|SidebarBadgeShape)/);
    assert.match(studioSrc, /projectsMaSidebarSubscribed/);
    assert.match(studioSrc, /Data\.onProjectsMaEvent/);
  });

  it('provides interactive Brand popover, Craft Check drawer with Fix with Design Agent, 4-item Export menu, and Enter-to-submit', () => {
    const studioSrc = fs.readFileSync(STUDIO_PATH, 'utf8');
    const cssSrc = fs.readFileSync(DESIGN_CSS_PATH, 'utf8');

    for (const preset of ['Terracotta Studio', 'Cobalt Tech', 'Forest Editorial', 'Obsidian Dark']) {
      assert.ok(studioSrc.includes(preset), `Expected Brand preset ${preset}`);
    }
    assert.match(studioSrc, /mp-design-popover/);
    assert.match(studioSrc, /type="color"/);
    assert.match(studioSrc, /Generate &amp; Install|Generate & Install/);
    assert.match(studioSrc, /Data\.designGenerateBrand\(/);

    assert.match(studioSrc, /mp-design-lint-drawer/);
    assert.match(studioSrc, /setLintFindings/);
    assert.match(studioSrc, /Fix with Design Agent/);

    assert.match(studioSrc, /mp-design-export-menu/);
    for (const label of ['Standalone HTML', 'PNG Snapshot', 'Multi-page PDF', 'Handoff ZIP']) {
      assert.ok(studioSrc.includes(label), `Expected export item ${label}`);
    }

    assert.match(studioSrc, /design-prompt-input[\s\S]*keydown[\s\S]*isComposing/);

    assert.match(cssSrc, /\.mp-design-popover/);
    assert.match(cssSrc, /\.mp-design-lint-drawer/);
    assert.match(cssSrc, /\.mp-design-export-menu/);
  });

  it('keeps Dashboard header on a single row and exposes Data.dashboardCreateSample + empty-state Load Sample Dashboard button', async () => {
    const dashCss = fs.readFileSync(DASHBOARD_CSS_PATH, 'utf8');
    assert.match(dashCss, /\.mp-dash-head-right\s*\{[^}]*flex-wrap:\s*nowrap/);
    assert.match(dashCss, /\.mp-dash-head-right\s*\{[^}]*white-space:\s*nowrap/);
    assert.match(dashCss, /\.mp-dash-head-right\s*\{[^}]*gap:\s*6px/);
    assert.match(dashCss, /\.mp-dash-head-left\s*\{[^}]*min-width:\s*0/);
    assert.match(dashCss, /\.mp-dash-updated\s*\{[^}]*white-space:\s*nowrap/);

    let calledSample = false;
    const {api: dataApi} = await transpileAndRun<{
      dashboardCreateSample(): Promise<Record<string, unknown>>;
    }>(DATA_PATH, 'Data', {
      window: {
        magicPointerDashboard: {
          dashboard: {
            createSample: async () => {
              calledSample = true;
              return {ok: true, dashboardId: 'sample-q4-revenue'};
            },
          },
        },
      },
    });

    const sampleRes = await dataApi.dashboardCreateSample();
    assert.equal(calledSample, true);
    assert.equal(sampleRes.dashboardId, 'sample-q4-revenue');

    const studioSrc = fs.readFileSync(STUDIO_PATH, 'utf8');
    assert.match(studioSrc, /data-dash-sample/);
    assert.match(studioSrc, /Load Sample Dashboard/);
    assert.match(studioSrc, /Data\.dashboardCreateSample\(\)/);
    assert.match(studioSrc, /sample-q4-revenue/);
  });
});
