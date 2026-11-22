import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, it} from 'node:test';
import AdmZip from 'adm-zip';
import {PDFDocument} from 'pdf-lib';

import {
  DESIGN_BOARD_MAX_PX,
  DESIGN_BOARD_MIN_PX,
  DESIGN_CANVAS_VERSION,
  DESIGN_PAPER_DIMENSIONS,
} from '../electron/runtime/design_types';
import {DesignConflictError, DesignStore} from '../electron/runtime/design_store';
import {checkDesignCanvas, lintDesignMarkup} from '../electron/runtime/design_check';
import {
  compileBrandSystem,
  defaultSeedToken,
  generateColorScale,
} from '../electron/runtime/design_brand_engine';
import {
  DESIGN_DIRECTIONS,
  buildDesignSystemPrompt,
  formatDesignAnnotations,
  formatDesignViewContext,
} from '../electron/runtime/design_skills';
import {createDesignTools} from '../electron/runtime/design_tools';
import {ToolRegistry} from '../electron/runtime/tools';

const tempDirs: string[] = [];

function createTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mp-design-core-'));
  tempDirs.push(dir);
  return dir;
}

function makeValidDcHtml(options?: {
  width?: number;
  height?: number;
  body?: string;
  propsExtra?: string;
}): string {
  const w = options?.width ?? 880;
  const h = options?.height ?? 560;
  const body =
    options?.body ??
    '<main data-mp-id="hero" style="padding: 32px;"><h1>{{title}}</h1></main>';
  const extra = options?.propsExtra ? `, ${options.propsExtra}` : '';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <script src="./support.js"></script>',
    '  <title>Board</title>',
    '</head>',
    '<body>',
    `  <x-dc>${body}</x-dc>`,
    `  <script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":${w},"height":${h}}${extra}}'>`,
    '    class Component extends DCLogic {',
    '      renderVals() {',
    '        return { title: "Editorial Studio" };',
    '      }',
    '    }',
    '  </script>',
    '</body>',
    '</html>',
  ].join('\n');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, {recursive: true, force: true});
    }
  }
});

describe('design_types constants', () => {
  it('defines canonical v3 canvas and paper dimensions', () => {
    assert.equal(DESIGN_CANVAS_VERSION, 3);
    assert.equal(DESIGN_BOARD_MIN_PX, 40);
    assert.equal(DESIGN_BOARD_MAX_PX, 8000);
    assert.deepEqual(DESIGN_PAPER_DIMENSIONS.letter, {width: 816, height: 1056});
    assert.deepEqual(DESIGN_PAPER_DIMENSIONS.a4, {width: 794, height: 1123});
  });
});

describe('DesignStore CRUD, assets, concurrency, and exports', () => {
  it('initializes, lists, upserts boards, and guards optimistic contentHash', async () => {
    const root = createTempRoot();
    const store = new DesignStore(root);

    const created = await store.initCanvas({
      slug: 'spring-poster',
      title: 'Spring Poster',
      pages: [{id: 'page-1', name: 'Desktop'}],
    });
    assert.equal(created.canvas.v, 3);
    assert.equal(created.canvas.title, 'Spring Poster');
    assert.ok(created.contentHash.length === 64);

    const list = await store.listCanvases();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.slug, 'spring-poster');

    const updated = await store.upsertBoard({
      slug: 'spring-poster',
      file: 'Main.dc.html',
      html: makeValidDcHtml({width: 880, height: 560}),
      board: {x: 0, y: 0, w: 880, h: 560, title: 'Main', page: 'page-1'},
      expectedContentHash: created.contentHash,
    });
    assert.deepEqual(updated.canvas.order, ['Main.dc.html']);
    assert.notEqual(updated.contentHash, created.contentHash);

    await assert.rejects(
      () =>
        store.upsertBoard({
          slug: 'spring-poster',
          file: 'Main.dc.html',
          html: makeValidDcHtml({width: 880, height: 560}),
          board: {x: 0, y: 0, w: 880, h: 560, title: 'Stale'},
          expectedContentHash: created.contentHash,
        }),
      err => err instanceof DesignConflictError,
    );
  });

  it('rejects unsafe slugs and path traversal', async () => {
    const root = createTempRoot();
    const store = new DesignStore(root);

    await assert.rejects(() =>
      store.initCanvas({slug: '../escape', title: 'Bad'}),
    );
    await store.initCanvas({slug: 'safe-canvas', title: 'Safe'});
    await assert.rejects(() =>
      store.upsertBoard({
        slug: 'safe-canvas',
        file: '../../evil.dc.html',
        html: makeValidDcHtml(),
        board: {x: 0, y: 0, w: 880, h: 560},
      }),
    );
  });

  it('imports content-addressed assets and rejects unsupported or oversized files', async () => {
    const root = createTempRoot();
    const store = new DesignStore(root);
    await store.initCanvas({slug: 'assets-test', title: 'Assets'});

    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const imported = await store.importAsset({
      slug: 'assets-test',
      bytes: svgBytes,
      filename: 'logo.svg',
    });
    assert.match(imported.id, /^[0-9a-f]{32}$/);
    assert.equal(imported.blobUrl, `/_blob/${imported.id}`);
    assert.equal(imported.relativePath, `assets/${imported.id}.svg`);

    await assert.rejects(() =>
      store.importAsset({
        slug: 'assets-test',
        bytes: Buffer.from('binary'),
        filename: 'malware.exe',
      }),
    );

    const oversized = Buffer.alloc(20 * 1024 * 1024 + 1);
    await assert.rejects(() =>
      store.importAsset({
        slug: 'assets-test',
        bytes: oversized,
        filename: 'huge.png',
      }),
    );
  });

  it('exports standalone HTML, handoff ZIP with manifest, and normalized multi-page PDF', async () => {
    const root = createTempRoot();
    const store = new DesignStore(root);
    await store.initCanvas({slug: 'export-demo', title: 'Export Demo'});

    const asset = await store.importAsset({
      slug: 'export-demo',
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>'),
      filename: 'mark.svg',
    });

    const htmlWithBlob = makeValidDcHtml({
      width: 816,
      height: 1056,
      body: `<main data-mp-id="hero"><img src="${asset.blobUrl}" alt="Mark" /></main>`,
    });
    await store.upsertBoard({
      slug: 'export-demo',
      file: 'Main.dc.html',
      html: htmlWithBlob,
      board: {
        x: 0,
        y: 0,
        w: 816,
        h: 1056,
        title: 'Main',
        print: 'flow',
        paper: 'letter',
      },
    });
    await store.upsertBoard({
      slug: 'export-demo',
      file: 'Detail.dc.html',
      html: makeValidDcHtml({width: 400, height: 300}),
      board: {x: 900, y: 0, w: 400, h: 300, title: 'Detail'},
    });

    const bundled = await store.exportStandaloneHtml('export-demo');
    assert.ok(bundled.html.includes('data:image/svg+xml;base64,'));
    assert.ok(!bundled.html.includes(asset.blobUrl));
    assert.equal(bundled.boardCount, 2);

    const zipOut = await store.exportHandoffZip('export-demo');
    const zip = new AdmZip(zipOut.buffer);
    const entryNames = zip.getEntries().map(e => e.entryName);
    assert.ok(entryNames.includes('DESIGN-MANIFEST.json'));
    assert.ok(entryNames.includes('DESIGN-HANDOFF.md'));
    assert.ok(entryNames.includes('canvas.json'));
    assert.ok(entryNames.includes('Main.dc.html'));

    const pdfOut = await store.exportPdf('export-demo', {paper: 'letter'});
    const pdfDoc = await PDFDocument.load(pdfOut.bytes);
    assert.equal(pdfDoc.getPageCount(), 2);
    const firstSize = pdfDoc.getPage(0).getSize();
    assert.equal(Math.round(firstSize.width), 612);
    assert.equal(Math.round(firstSize.height), 792);
  });
});

describe('checkDesignCanvas and anti-AI-slop linter', () => {
  it('passes a clean v3 canvas and catches structural errors', async () => {
    const root = createTempRoot();
    const store = new DesignStore(root);
    await store.initCanvas({slug: 'check-ok', title: 'Clean Canvas'});
    await store.upsertBoard({
      slug: 'check-ok',
      file: 'Main.dc.html',
      html: makeValidDcHtml({width: 880, height: 560}),
      board: {x: 0, y: 0, w: 880, h: 560, title: 'Main'},
    });

    const cleanReport = await checkDesignCanvas(join(root, 'designs', 'check-ok'));
    assert.equal(cleanReport.ok, true);
    assert.equal(cleanReport.issues.length, 0);
    assert.equal(cleanReport.p0Count, 0);

    // Write a broken board (missing support.js, expression hole, missing blob)
    const brokenHtml = [
      '<html><head></head><body>',
      '<x-dc><div>{{ a + b }}</div><img src="/_blob/00000000000000000000000000000000" /></x-dc>',
      '<script type="text/x-dc" data-dc-script data-props=\'{"$preview":{"width":500,"height":500}}\'>',
      'class Component extends DCLogic { renderVals() { return {}; } }',
      '</script></body></html>',
    ].join('\n');
    await writeFile(join(root, 'designs', 'check-ok', 'Main.dc.html'), brokenHtml, 'utf8');

    const badReport = await checkDesignCanvas(join(root, 'designs', 'check-ok'));
    assert.equal(badReport.ok, false);
    assert.ok(badReport.issues.some(i => i.message.includes('support.js')));
    assert.ok(badReport.issues.some(i => i.message.includes('expression')));
    assert.ok(badReport.issues.some(i => i.message.includes('not in assets/')));
    assert.ok(badReport.issues.some(i => i.message.includes('$preview')));
  });

  it('flags P0/P1/P2 anti-AI-slop tropes deterministically', () => {
    const slopHtml = `
      <style>
        .hero { background: linear-gradient(90deg, #6366f1, #a855f7); }
        .card { border-left: 4px solid #3b82f6; border-radius: 12px; }
        .eyebrow { text-transform: uppercase; }
      </style>
      <section>
        <h1>🚀 10× faster</h1>
        <p>Lorem ipsum dolor sit amet</p>
        <span style="color: var(--accent)">1</span>
        <span style="color: var(--accent)">2</span>
        <span style="color: var(--accent)">3</span>
        <span style="color: var(--accent)">4</span>
        <span style="color: var(--accent)">5</span>
        <span style="color: var(--accent)">6</span>
        <span style="color: var(--accent)">7</span>
      </section>
    `;
    const findings = lintDesignMarkup(slopHtml, 'Main.dc.html');
    const ids = new Set(findings.map(f => f.id));
    assert.ok(ids.has('purple-gradient'));
    assert.ok(ids.has('emoji-icon'));
    assert.ok(ids.has('left-accent-card'));
    assert.ok(ids.has('invented-metric'));
    assert.ok(ids.has('filler-copy'));
    assert.ok(ids.has('all-caps-no-tracking'));
    assert.ok(ids.has('accent-overuse'));
    assert.ok(ids.has('missing-anchor'));
  });
});

describe('design_brand_engine deterministic SeedToken compiler', () => {
  it('generates 10-step color scales and compiles tokens.css, tokens.json, DESIGN.md, and design-system.json', async () => {
    const scale = generateColorScale('#1677ff');
    assert.equal(scale.length, 10);
    assert.equal(scale[5], '#1677ff');

    const seed = defaultSeedToken({
      colorPrimary: '#c2410c',
      fontDisplay: '"Newsreader", Georgia, serif',
      fontBody: '"Inter", system-ui, sans-serif',
      density: 'compact',
    });
    const compiled = compileBrandSystem({
      ...seed,
      name: 'Ember Editorial',
      namespace: 'ember',
    });
    assert.equal(compiled.designSystemJson.v, 3);
    assert.equal(compiled.designSystemJson.layout, 'files');
    assert.equal(compiled.designSystemJson.namespace, 'ember');
    assert.ok(compiled.tokensCss.includes('--accent: #c2410c;'));
    assert.ok(compiled.tokensCss.includes('[data-theme="dark"]'));
    assert.ok(compiled.tokensCss.includes('[data-density="compact"]'));
    assert.ok(compiled.tokensJson.color.tokens.length > 0);
    assert.ok(compiled.designMd.includes('## Color Palette'));
  });
});

describe('design_skills prompt builder and context formatters', () => {
  it('formats <design_view_context>, <design_annotations>, and modular craft rules', () => {
    assert.ok(DESIGN_DIRECTIONS.length >= 3);
    const prompt = buildDesignSystemPrompt({
      direction: DESIGN_DIRECTIONS[0]?.id,
      craft: ['typography', 'anti-ai-slop'],
      includeSlides: true,
      viewContext: {
        canvasSlug: 'spring-poster',
        mode: 'canvas',
        page: 'page-1',
        pageName: 'Desktop',
        visibleArtboards: ['Main.dc.html'],
        selectedArtboards: ['Main.dc.html'],
        erroredArtboards: [],
        dirty: false,
        edits: 2,
      },
      annotations: [
        {
          id: 'ann-1',
          pinNumber: 1,
          file: 'Main.dc.html',
          tid: 4,
          path: '0/1',
          selectionKind: 'element',
          status: 'anchored',
          text: 'Increase headline contrast',
          createdAt: '2026-11-21T00:00:00Z',
        },
      ],
    });
    assert.ok(prompt.includes('<design_view_context '));
    assert.ok(prompt.includes('<design_annotations'));
    assert.ok(prompt.includes('Main.dc.html#4:0/1'));
    assert.ok(prompt.includes('1920'));

    const ctxXml = formatDesignViewContext({
      canvasSlug: 'demo',
      mode: 'focused',
      visibleArtboards: ['Main.dc.html'],
      selectedArtboards: [],
      erroredArtboards: [{file: 'Main.dc.html', message: 'Syntax error'}],
      dirty: true,
      edits: 5,
    });
    assert.ok(ctxXml.includes('dirty="true"'));
    assert.ok(ctxXml.includes('Syntax error'));

    const annXml = formatDesignAnnotations([], 'demo');
    assert.equal(annXml, '');
  });
});

describe('Design.* ToolSpec registry integration', () => {
  it('executes all 9 Design.* tools end-to-end through ToolRegistry', async () => {
    const root = createTempRoot();
    const tools = createDesignTools({rootDir: root});
    const registry = new ToolRegistry();
    for (const tool of tools) {
      registry.register(tool);
    }

    const names = registry.list().map(t => t.name);
    assert.equal(names.length, 9);
    for (const expected of [
      'Design.init_canvas',
      'Design.upsert_board',
      'Design.read_canvas',
      'Design.list_canvases',
      'Design.import_asset',
      'Design.check',
      'Design.generate_brand_system',
      'Design.install_design_system',
      'Design.export',
    ]) {
      assert.ok(names.includes(expected), `Missing tool ${expected}`);
    }

    const controller = new AbortController();
    const callTool = async (name: string, args: Record<string, unknown>) => {
      const res = await registry.execute(
        {id: `call-${name}`, name, arguments: args},
        {signal: controller.signal},
      );
      assert.equal(res.is_error, false, res.error_message);
      return res.value as Record<string, unknown>;
    };

    const initRes = await callTool('Design.init_canvas', {
      slug: 'tool-demo',
      title: 'Tool Demo',
    });
    assert.equal(initRes.slug, 'tool-demo');

    const assetSrcPath = join(root, 'source.svg');
    await mkdir(root, {recursive: true});
    await writeFile(assetSrcPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
    const assetRes = await callTool('Design.import_asset', {
      slug: 'tool-demo',
      sourcePath: assetSrcPath,
    });
    assert.match(String(assetRes.blobUrl), /^\/_blob\/[0-9a-f]{32}$/);

    await callTool('Design.upsert_board', {
      slug: 'tool-demo',
      file: 'Main.dc.html',
      html: makeValidDcHtml({width: 880, height: 560}),
      board: {x: 0, y: 0, w: 880, h: 560, title: 'Main'},
    });

    const brandRes = await callTool('Design.generate_brand_system', {
      name: 'Studio',
      namespace: 'studio',
      colorPrimary: '#0f766e',
    });
    assert.equal(brandRes.namespace, 'studio');

    const installRes = await callTool('Design.install_design_system', {
      slug: 'tool-demo',
      name: 'Studio',
      namespace: 'studio',
      colorPrimary: '#0f766e',
    });
    assert.equal(installRes.installed, true);

    const checkRes = await callTool('Design.check', {slug: 'tool-demo'});
    assert.equal(checkRes.ok, true);

    const listRes = await callTool('Design.list_canvases', {});
    assert.equal((listRes.canvases as unknown[]).length, 1);

    const readRes = await callTool('Design.read_canvas', {slug: 'tool-demo'});
    assert.equal((readRes.canvas as {title: string}).title, 'Tool Demo');

    const exportRes = await callTool('Design.export', {
      slug: 'tool-demo',
      format: 'zip',
    });
    assert.ok(Number(exportRes.bytes) > 0);
  });
});
