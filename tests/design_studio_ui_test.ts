'use strict';

import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = process.cwd();
const DC_RUNTIME_PATH = path.join(ROOT, 'electron/renderer/design_dc_runtime.ts');
const STUDIO_PATH = path.join(ROOT, 'electron/renderer/design_studio.ts');
const SANDBOX_PATH = path.join(ROOT, 'electron/renderer/design_sandbox.html');
const CSS_PATH = path.join(ROOT, 'electron/renderer/design_studio.css');

async function loadBrowserGlobal<T>(filePath: string, globalName: string): Promise<T> {
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
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(transpiled, sandbox, {filename: filePath});
  const api = sandbox[globalName] as T | undefined;
  assert.ok(api, `Expected globalThis.${globalName} to be defined`);
  return api;
}

describe('DesignDcRuntime (.dc.html parsing, compilation, tweaks, outline & drift)', () => {
  it('parses .dc.html helmet, x-dc template, data-props schema, and compiles DCLogic', async () => {
    const rt = await loadBrowserGlobal<{
      isDcDocument(html: string): boolean;
      parseDataPropsSchema(raw: string): {
        preview?: {width: number; height: number};
        props: Array<{
          key: string;
          kind: string;
          value: unknown;
          options?: unknown[];
          min?: number;
          max?: number;
          step?: number;
          unit?: string;
        }>;
      };
      renderDcDocument(
        html: string,
        overrides?: Record<string, unknown>,
      ): {
        isDc: boolean;
        renderedHtml: string;
        errors: string[];
        propsMeta: Array<{key: string; kind: string; value: unknown}>;
      };
    }>(DC_RUNTIME_PATH, 'DesignDcRuntime');

    const sampleDc = `<!doctype html>
<html>
<head>
  <script src="./support.js"></script>
</head>
<body>
  <x-dc>
    <helmet><style>.hero { color: {{ accent }}; }</style></helmet>
    <section class="hero">
      <h1>{{ title }}</h1>
      <sc-if value="{{ showBadge }}"><span>LIVE</span></sc-if>
      <ul>
        <sc-for list="{{ items }}" as="item">
          <li>{{ $index }}: {{ item.name }}</li>
        </sc-for>
      </ul>
      <dc-import name="Card" card-title="{{ title }}" hint-size="100%,120px"></dc-import>
    </section>
  </x-dc>
  <script type="text/x-dc" data-dc-script data-props='{
    "$preview": { "width": 880, "height": 560 },
    "title": "Spring Launch",
    "accent": { "type": "color", "default": "#D97757", "options": ["#D97757", "#2563EB"] },
    "showBadge": true,
    "spacing": { "type": "range", "default": 16, "min": 8, "max": 32, "step": 4, "unit": "px" },
    "density": { "type": "enum", "default": "cozy", "options": ["compact", "cozy", "spacious"] }
  }'>
    class Component extends DCLogic {
      renderVals() {
        return {
          title: this.props.title,
          accent: this.props.accent,
          showBadge: this.props.showBadge,
          items: [{ name: "Alpha" }, { name: "Beta" }],
        };
      }
    }
  </script>
</body>
</html>`;

    assert.equal(rt.isDcDocument(sampleDc), true);
    assert.equal(rt.isDcDocument('<html><body><h1>Plain HTML</h1></body></html>'), false);

    const schema = rt.parseDataPropsSchema(
      '{"$preview":{"width":880,"height":560},"title":"Hi","accent":{"type":"color","default":"#D97757","options":["#D97757","#2563EB"]},"cols":{"type":"int","default":3},"ratio":{"type":"float","default":1.5},"on":{"type":"boolean","default":true}}',
    );
    assert.equal(schema.preview?.width, 880);
    assert.equal(schema.preview?.height, 560);
    assert.equal(schema.props.find(p => p.key === 'accent')?.kind, 'color');
    assert.equal(schema.props.find(p => p.key === 'cols')?.kind, 'int');
    assert.equal(schema.props.find(p => p.key === 'ratio')?.kind, 'float');
    assert.equal(schema.props.find(p => p.key === 'on')?.kind, 'boolean');

    const res = rt.renderDcDocument(sampleDc, {title: 'Summer Launch', showBadge: false});
    assert.equal(res.isDc, true);
    assert.equal(res.errors.length, 0);
    assert.match(res.renderedHtml, /Summer Launch/);
    assert.doesNotMatch(res.renderedHtml, /<span>LIVE<\/span>/);
    assert.match(res.renderedHtml, /0: Alpha/);
    assert.match(res.renderedHtml, /1: Beta/);
    assert.match(res.renderedHtml, /data-dc-import="Card"/);
    assert.match(res.renderedHtml, /<style>\.hero \{ color: #D97757; \}<\/style>/);
  });

  it('gracefully wraps standard HTML/CSS/SVG artboards and updates data-props live', async () => {
    const rt = await loadBrowserGlobal<{
      renderDcDocument(html: string): {isDc: boolean; renderedHtml: string; errors: string[]};
      updateDataPropsInHtml(html: string, key: string, value: unknown): string;
    }>(DC_RUNTIME_PATH, 'DesignDcRuntime');

    const plain = '<html><head><style>body{margin:0}</style></head><body><svg width="40" height="40"></svg></body></html>';
    const plainRes = rt.renderDcDocument(plain);
    assert.equal(plainRes.isDc, false);
    assert.equal(plainRes.errors.length, 0);
    assert.match(plainRes.renderedHtml, /<svg width="40" height="40">/);

    const dc = `<x-dc><h1>{{ title }}</h1></x-dc><script type="text/x-dc" data-dc-script data-props='{"title":"Before"}'>class Component extends DCLogic { renderVals() { return { title: this.props.title }; } }</script>`;
    const updated = rt.updateDataPropsInHtml(dc, 'title', 'After');
    assert.match(updated, /"title"\s*:\s*"After"/);
  });

  it('builds tid:path outline trees and resolves 4-state anchor drift', async () => {
    const rt = await loadBrowserGlobal<{
      buildOutlineTree(html: string): Array<{
        tid: number;
        path: string;
        tag: string;
        text: string;
        htmlHint: string;
        children: unknown[];
      }>;
      formatAnchorId(file: string, tid: number, pathStr: string): string;
      resolveAnchorDrift(
        anchor: {
          file: string;
          tid: number;
          path: string;
          selector?: string;
          htmlHint?: string;
          text?: string;
          version: number;
          lastGoodPosition?: {x: number; y: number};
        },
        outline: Array<{
          tid: number;
          path: string;
          tag: string;
          text: string;
          htmlHint: string;
          selector?: string;
          rect?: {x: number; y: number; w: number; h: number};
        }>,
        currentVersion: number,
      ): {
        state: 'anchored' | 'reanchored' | 'stale' | 'lost';
        tid?: number;
        path?: string;
        lastGoodPosition?: {x: number; y: number};
      };
    }>(DC_RUNTIME_PATH, 'DesignDcRuntime');

    const html = `<x-dc><section id="hero"><h1>Welcome</h1><button class="cta">Start</button></section></x-dc>`;
    const tree = rt.buildOutlineTree(html);
    assert.ok(tree.length > 0);
    assert.equal(rt.formatAnchorId('Main.dc.html', 2, '0/1'), 'Main.dc.html#2:0/1');

    const flat = [
      {tid: 0, path: '0', tag: 'section', text: '', htmlHint: '<section id="hero">', selector: '#hero', rect: {x: 0, y: 0, w: 800, h: 400}},
      {tid: 1, path: '0/0', tag: 'h1', text: 'Welcome', htmlHint: '<h1>Welcome</h1>', selector: 'h1', rect: {x: 20, y: 20, w: 300, h: 40}},
      {tid: 2, path: '0/1', tag: 'button', text: 'Start', htmlHint: '<button class="cta">Start</button>', selector: 'button.cta', rect: {x: 20, y: 80, w: 120, h: 40}},
    ];

    const anchored = rt.resolveAnchorDrift(
      {file: 'Main.dc.html', tid: 2, path: '0/1', htmlHint: '<button class="cta">Start</button>', version: 1},
      flat,
      1,
    );
    assert.equal(anchored.state, 'anchored');

    const reanchored = rt.resolveAnchorDrift(
      {file: 'Main.dc.html', tid: 2, path: '0/1', htmlHint: '<button class="cta">Start</button>', version: 1},
      flat,
      2,
    );
    assert.equal(reanchored.state, 'reanchored');

    const stale = rt.resolveAnchorDrift(
      {
        file: 'Main.dc.html',
        tid: 99,
        path: '9/9',
        selector: 'button.cta',
        htmlHint: '<button class="cta">Start</button>',
        text: 'Start',
        version: 1,
        lastGoodPosition: {x: 25, y: 85},
      },
      flat,
      2,
    );
    assert.equal(stale.state, 'stale');
    assert.equal(stale.tid, 2);

    const lost = rt.resolveAnchorDrift(
      {
        file: 'Main.dc.html',
        tid: 88,
        path: '8/8',
        selector: '#missing-node',
        htmlHint: '<div id="missing-node">',
        text: 'Nonexistent',
        version: 1,
        lastGoodPosition: {x: 120, y: 240},
      },
      flat,
      2,
    );
    assert.equal(lost.state, 'lost');
    assert.deepEqual(lost.lastGoodPosition, {x: 120, y: 240});
  });
});

describe('DesignStudio (viewport/zoom math, LRU pool, and agent XML serializers)', () => {
  it('computes zoom steps, fit-to-screen viewport, and screen/canvas coordinates', async () => {
    const studio = await loadBrowserGlobal<{
      ZOOM_STEPS: readonly number[];
      DEVICE_PRESETS: ReadonlyArray<{id: string; label: string; width: number; height: number}>;
      nextZoomStep(current: number, dir: 'in' | 'out'): number;
      computeFitViewport(
        boards: Array<{x: number; y: number; w: number; h: number}>,
        containerW: number,
        containerH: number,
        padding?: number,
      ): {x: number; y: number; zoom: number};
      screenToCanvas(
        clientX: number,
        clientY: number,
        viewport: {x: number; y: number; zoom: number},
        rect: {left: number; top: number},
      ): {x: number; y: number};
      createLruPool(cap: number): {
        touch(key: string): string[];
        has(key: string): boolean;
        size(): number;
      };
      serializeDesignViewContext(ctx: {
        mode: 'canvas' | 'focused';
        page: string;
        pageName?: string;
        visibleArtboards: string[];
        selectedArtboards: string[];
        selectedAnchors: string[];
        erroredArtboards: Array<{file: string; error: string}>;
        dirty: boolean;
        edits: number;
      }): string;
      serializeDesignAnnotations(
        annotations: Array<{
          pin: number;
          file: string;
          anchor?: string;
          area?: string;
          text: string;
        }>,
        canvasSlug: string,
      ): string;
    }>(STUDIO_PATH, 'DesignStudio');

    assert.deepEqual([...studio.ZOOM_STEPS], [0.25, 0.5, 0.75, 1, 1.5, 2]);
    assert.equal(studio.DEVICE_PRESETS.length >= 6, true);
    assert.equal(studio.nextZoomStep(1, 'in'), 1.5);
    assert.equal(studio.nextZoomStep(1, 'out'), 0.75);

    const fit = studio.computeFitViewport(
      [
        {x: 0, y: 0, w: 1440, h: 900},
        {x: 1520, y: 0, w: 390, h: 844},
      ],
      1000,
      600,
      40,
    );
    assert.ok(fit.zoom > 0.2 && fit.zoom <= 1);

    const pt = studio.screenToCanvas(300, 200, {x: 100, y: 50, zoom: 2}, {left: 100, top: 100});
    assert.equal(pt.x, 50);
    assert.equal(pt.y, 25);

    const pool = studio.createLruPool(16);
    for (let i = 0; i < 18; i++) {
      pool.touch(`board-${i}.dc.html`);
    }
    assert.equal(pool.size(), 16);
    assert.equal(pool.has('board-0.dc.html'), false);
    assert.equal(pool.has('board-17.dc.html'), true);

    const viewXml = studio.serializeDesignViewContext({
      mode: 'canvas',
      page: 'page-1',
      pageName: 'Desktop',
      visibleArtboards: ['Main.dc.html'],
      selectedArtboards: ['Main.dc.html'],
      selectedAnchors: ['Main.dc.html#2:0/1'],
      erroredArtboards: [],
      dirty: true,
      edits: 3,
    });
    assert.match(viewXml, /<design_view_context/);
    assert.match(viewXml, /mode="canvas"/);
    assert.match(viewXml, /dirty="true"/);
    assert.match(viewXml, /edits="3"/);

    const annXml = studio.serializeDesignAnnotations(
      [{pin: 1, file: 'Main.dc.html', anchor: 'Main.dc.html#2:0/1', text: 'Make CTA wider'}],
      'spring-launch',
    );
    assert.match(annXml, /<design_annotations canvas="spring-launch">/);
    assert.match(annXml, /Main\.dc\.html#2:0\/1/);
    assert.match(annXml, /Make CTA wider/);
  });

  it('ships CSP-isolated design_sandbox.html and design_studio.css', () => {
    assert.equal(fs.existsSync(SANDBOX_PATH), true, 'design_sandbox.html must exist');
    assert.equal(fs.existsSync(CSS_PATH), true, 'design_studio.css must exist');
    const html = fs.readFileSync(SANDBOX_PATH, 'utf8');
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /mp-design-init/);
    assert.match(html, /mp-design-set-props/);
    assert.match(html, /mp-design-error/);
  });
});
