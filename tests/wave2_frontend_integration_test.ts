import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('Wave 2.1: studio.html replaces Learn|Code with Learn|Design and loads Wave-1 UI scripts in order', () => {
  const html = readRepo('electron/renderer/studio.html');

  assert.match(html, /id="mode-learn"[^>]*data-product-mode="learn"/);
  assert.match(html, /id="mode-design"[^>]*data-product-mode="design"/);
  assert.doesNotMatch(html, /id="mode-work"|data-product-mode="walker"/);
  assert.doesNotMatch(html, /<span>Code<\/span>/);

  assert.match(html, /href="design_studio\.css\?v=1"/);
  assert.match(html, /href="project_overview\.css\?v=1"/);
  assert.match(html, /id="design-studio-host"/);
  assert.match(html, /id="design-prompt-form"/);

  const scriptOrder = [
    'dashboard_store.js?v=1',
    'dashboard_charts.js?v=1',
    'dashboard_view.js?v=1',
    'design_dc_runtime.js?v=1',
    'design_studio.js?v=1',
    'project_overview.js?v=1',
    'studio.js?v=28',
  ];
  let lastIndex = -1;
  for (const src of scriptOrder) {
    const idx = html.indexOf(`src="${src}"`);
    assert.ok(idx > lastIndex, `Expected ${src} to load in order`);
    lastIndex = idx;
  }
});

test('Wave 2.2: studio_shell.ts & locale.ts expose Design Studio and Multi-Agent Projects copy', () => {
  const shellSrc = readRepo('electron/studio_shell.ts');
  assert.match(shellSrc, /eyebrow:\s*'DESIGN STUDIO'/);

  const localeSrc = readRepo('electron/renderer/locale.ts');
  assert.match(localeSrc, /'design\.studio\.new_canvas'/);
  assert.match(localeSrc, /'design\.studio\.brand_system'/);
  assert.match(localeSrc, /'projects\.ma\.show_more'/);
});

test('Wave 2.3: CSS defines Learn/Design mode scoping, Design Studio flex layout, and project sidebar badges', () => {
  const layoutCss = readRepo('electron/renderer/studio_layout.css');
  const learnCss = readRepo('electron/renderer/learn_tree.css');

  assert.match(layoutCss, /\.mp-shell\[data-product-mode="learn"\]/);
  assert.match(layoutCss, /\.mp-design-studio-view/);
  assert.match(layoutCss, /\.mp-project-badge-count/);
  assert.match(layoutCss, /\.mp-project-badge-working/);
  assert.match(layoutCss, /\.mp-project-badge-dot/);
  assert.match(layoutCss, /\.mp-project-threads-more/);
  assert.match(learnCss, /\.mp-shell\[data-product-mode="learn"\]/);
  assert.doesNotMatch(learnCss, /data-product-mode="design"/);
});

test('Wave 2.4: data.ts exposes Design, upgraded Dashboard, and Projects Multi-Agent APIs', () => {
  const dataSrc = readRepo('electron/renderer/data.ts');

  for (const method of [
    'designList(',
    'designRead(',
    'designInit(',
    'designUpsertBoard(',
    'designSaveFile(',
    'designCheck(',
    'designGenerateBrand(',
    'designExport(',
    'dashboardRunSql(',
    'dashboardExportInteractive(',
    'dashboardExportChartCsv(',
    'dashboardRemix(',
    'projectsMaGetOverviewState(',
    'projectsMaSidebarBadges(',
    'projectsMaSendGoal(',
    'projectsMaAnswerDecision(',
    'projectsMaUpdateConfig(',
  ]) {
    assert.ok(
      dataSrc.includes(method),
      `Expected Data to expose ${method}`,
    );
  }
});

test('Wave 2.5: studio.ts & studio_libraries.ts integrate DesignStudio, ProjectOverview, Dashboard callbacks, and sidebar badges', () => {
  const studioSrc = readRepo('electron/renderer/studio.ts');
  const libSrc = readRepo('electron/renderer/studio_libraries.ts');

  assert.match(studioSrc, /mp:product-mode-v2/);
  assert.match(studioSrc, /function mountDesignStudioView/);
  assert.match(studioSrc, /DesignStudio\.mount\(/);
  assert.match(studioSrc, /onQueryRun:/);
  assert.match(studioSrc, /onRemix:/);
  assert.match(studioSrc, /onExportChartCsv:/);
  assert.match(studioSrc, /projectsMaSidebarBadges/);

  assert.match(libSrc, /ProjectOverview\.mount\(/);
  assert.match(libSrc, /projectsMaGetOverviewState/);
  assert.match(libSrc, /data-open-design-canvas/);
});
