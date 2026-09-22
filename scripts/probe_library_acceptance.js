'use strict';

const { app, BrowserWindow, ipcMain, session, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const STARTED_AT = Date.now();
const OUTPUT = path.resolve(process.argv[2] || path.join(ROOT, 'artifacts/library-acceptance'));
const PROFILE = path.join(ROOT, 'data/runtime/acceptance', `libraries-${process.pid}`);
const WORKSPACE = path.join(PROFILE, 'Research workspace');
const SECOND_WORKSPACE = path.join(PROFILE, 'Delivery workspace');
fs.mkdirSync(OUTPUT, { recursive: true });
fs.mkdirSync(WORKSPACE, { recursive: true });
fs.mkdirSync(SECOND_WORKSPACE, { recursive: true });
const MATERIAL = path.join(WORKSPACE, 'research-notes.md');
fs.writeFileSync(MATERIAL, '# Acceptance notes\nRecorded local material for interface verification.\n');
const plugin = path.join(PROFILE, 'data/plugins/acceptance_plugin');
fs.mkdirSync(plugin, { recursive: true });
fs.writeFileSync(path.join(plugin, 'plugin.json'), JSON.stringify({ description: 'Local fixture plugin; its code must remain unexecuted.' }));
fs.writeFileSync(path.join(plugin, 'plugin.py'), `from pathlib import Path\nPath(${JSON.stringify(path.join(PROFILE, 'UNEXPECTED_PLUGIN_EXECUTION'))}).touch()\n`);
fs.writeFileSync(path.join(PROFILE, 'data/mcp.json'), JSON.stringify({ mcpServers: {
  acceptance_notes: { command: 'fixture-must-not-run', env: { TOKEN: 'fixture-secret-must-not-appear' } },
  acceptance_paused: { command: 'fixture-must-not-run', disabled: true },
} }));
process.env.MAGIC_POINTER_USER_DATA_DIR = PROFILE;
process.env.MAGIC_POINTER_PLUGIN_DIR = path.join(PROFILE, 'data/plugins');
process.env.MAGIC_POINTER_MCP_CONFIG = path.join(PROFILE, 'data/mcp.json');
app.setPath('userData', PROFILE);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '2');
const originalWhenReady = app.whenReady.bind(app);
let skippedStartup = 0;
app.whenReady = () => ({ then() { skippedStartup++; } });
const MAIN_PATH = path.join(ROOT, 'build/electron/main.js');
const productionMain = new Module(MAIN_PATH, module);
productionMain.filename = MAIN_PATH;
productionMain.paths = Module._nodeModulePaths(path.dirname(MAIN_PATH));
productionMain._compile(fs.readFileSync(MAIN_PATH, 'utf8') + `
let acceptanceUnexpectedRuns = 0;
module.exports.acceptance = {
  conversations, notifyConversationChanged,
  bindWindow(window) {
    dashboardWindow = window;
    fabricSettingsStore = new ElectronSettingsStore(path.join(app.getPath('userData'), 'fabric-settings.json'));
    fabricSettings = defaultSettings();
    fabricSettingsStore.save(fabricSettings);
    contextTrackerRuntime = createContextTrackerRuntime({
      loadTrackers: () => fabricSettings.context_trackers || [],
      persistTrackers: (trackers) => {
        fabricSettings = { ...fabricSettings, context_trackers: trackers };
        fabricSettingsStore.save(fabricSettings);
      },
      runTask: async () => { acceptanceUnexpectedRuns++; throw new Error('Acceptance cannot execute scheduled work'); },
    });
    return contextTrackerRuntime.start();
  },
  trackers: () => contextTrackerRuntime.list(),
  unexpectedRuns: () => acceptanceUnexpectedRuns,
  stop: () => contextTrackerRuntime.stop(),
  flush: flushConversations,
};
`, MAIN_PATH);
app.whenReady = originalWhenReady;
const main = productionMain.exports.acceptance;
let pickerDirectory = WORKSPACE;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pickerDirectory] });
const externalBoundaries = {
  'models:catalog': { ok: true, catalog: { current: 'Offline acceptance fixture', groups: [] } },
  'models:quota': { ok: false, error: 'fixture_no_network' },
  'slash:directory': { ok: true, commands: [], skills: [
    { name: 'acceptance-notes', description: 'Summarize the selected local fixture notes.', source: 'Fixture workspace', modifiedAt: 1000 },
    { name: 'acceptance-review', description: 'Review local fixture changes.', source: 'Fixture user directory', modifiedAt: 2000 },
  ], errors: [] },
  'runtime-snapshot:get': {},
  'dashboard:model-health-refresh': {},
  'projects:environment': { ok: true, git: null, entries: [] },
  'projects:tree': { ok: true, entries: [] },
  'stash:list': [],
  'figma:status': { ok: true, connections: [] },
};
for (const [channel, value] of Object.entries(externalBoundaries)) {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, () => value);
}
const report = {
  kind: 'actual-main-preload-library-acceptance', usedBackend: 'local.store.fixture',
  evidenceBoundary: 'Real main IPC, preload, renderer, conversation and tracker stores; seeded local fixture data. Models and skill directory are offline fixtures. No AI, catalog, plugin or MCP execution.',
  skippedStartup, externalBoundaries: Object.keys(externalBoundaries),
  profile: PROFILE, checks: {}, failures: [], consoleErrors: [], screenshots: [],
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let studio;
const evaluate = source => studio.webContents.executeJavaScript(source);
async function waitFor(label, predicate, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(65);
  }
  throw new Error(`Timed out: ${label}`);
}
async function visible(selector) {
  return evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return false; const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && getComputedStyle(e).visibility!=='hidden'; })()`);
}
async function point(selector) {
  await waitFor(`visible ${selector}`, () => visible(selector));
  return evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
}
async function hover(selector) { studio.webContents.sendInputEvent({ type: 'mouseMove', ...await point(selector) }); }
async function click(selector) {
  const target = await point(selector);
  studio.webContents.sendInputEvent({ type: 'mouseMove', ...target });
  studio.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...target });
  studio.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...target });
  await delay(45);
}
async function navigate(view) {
  await evaluate(`document.querySelector('.mp-library-dialog-mask')?.remove(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true`);
  await click(`[data-goto="${view}"]`);
  await waitFor(`view ${view}`, () => evaluate(`document.getElementById('view-${view}')?.hidden === false`));
  studio.webContents.sendInputEvent({ type: 'mouseMove', x: 1000, y: 850 });
}
async function screenshot(name) {
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  studio.webContents.invalidate();
  await delay(120);
  const destination = path.join(OUTPUT, name + '.png');
  const captured = await studio.webContents.capturePage();
  report.screenshotPixels = captured.getSize();
  fs.writeFileSync(destination, captured.toPNG());
  report.screenshots.push(destination);
}
async function step(name, work) {
  try { report.checks[name] = await work() || true; }
  catch (error) { report.failures.push({ name, error: error.stack || String(error) }); await screenshot(`${name}-failure`); }
}
function seedConversation() {
  const store = main.conversations();
  const capturedAt = Date.now() - 3600000;
  const c = store.appendTurn({
    capturedAt, question: 'Research plan and source notes', answer: '# Research plan\n\nA recorded local fixture, ready for review.',
    outcome: '已完成', workspaceRoot: WORKSPACE, agentSessionId: 'acceptance-library-task',
    object: { app: 'Acceptance', elementPath: 'fixture:research' },
    taskContext: { taskId: 'acceptance-library-task', referenceRevision: 1,
      sources: [{ sourceId: 'source:acceptance-notes', title: 'Research notes', kind: 'file', identity: { absolutePath: MATERIAL } }], references: [] },
    artifacts: [{ name: 'Research brief', kind: 'text', summary: 'Scope, evidence and the next decisions.' },
      { name: 'Dashboard outline.html', kind: 'code', summary: '<main style="padding:12px;background:#e8eef7"><h1>Research dashboard</h1></main><script>window.__acceptancePreviewExecuted=true</script>' },
      { name: 'Research diagram.svg', kind: 'image', summary: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#d9e8e2"/><text x="20" y="90" font-size="24">Source → Evidence</text></svg>' },
      { name: 'Pixel sample.png', kind: 'image', summary: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6f8AAAAASUVORK5CYII=' }],
  });
  for (let i = 1; i <= 3; i++) store.appendTurn({
    conversationId: c.id, capturedAt: capturedAt + i * 1000,
    question: ['Compare the material sources', 'Review the implementation plan', 'Prepare the final verification summary'][i - 1],
    answer: (`## Verification note ${i}\n\n` + 'The selected material remains available in the isolated workspace.\n\n').repeat(8),
    outcome: '已完成', artifacts: i === 3 ? [{ name: 'Verification checklist.md', kind: 'file', summary: 'Read sources, confirm output, record limitations.' }] : [],
  });
  main.notifyConversationChanged(c.id); main.flush();
  return c.id;
}

originalWhenReady().then(async () => {
  try {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    studio = new BrowserWindow({ width: 1037, height: 879, show: false, frame: false,
      webPreferences: { preload: path.join(ROOT, 'build/electron/preload.js'), offscreen: true,
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    await main.bindWindow(studio);
    studio.webContents.on('console-message', (...args) => {
      const detail = typeof args[1] === 'object' ? args[1] : null;
      const level = detail?.level ?? args[1];
      if (level === 3 || level === 'error') report.consoleErrors.push(String(detail?.message ?? args[2] ?? ''));
    });
    studio.webContents.on('preload-error', (_event, _file, error) => report.consoleErrors.push(String(error)));
    await studio.loadFile(path.join(ROOT, 'build/electron/renderer/studio.html'), { query: { view: 'chat' } });
    await waitFor('Studio boot', () => evaluate(`document.activeElement?.classList.contains('mpw-input')`));
    await evaluate('document.fonts.ready.then(() => true)');
    await evaluate(`document.documentElement.dataset.theme='light'; document.documentElement.style.colorScheme='light'; document.body.removeAttribute('data-ds-dark-theme'); true`);
    report.viewport = await evaluate(`({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})`);

    await step('projects-empty', async () => {
      await navigate('projects');
      await waitFor('empty project state', () => evaluate(`document.getElementById('library-projects').textContent.includes('Organize your work')`));
      await screenshot('projects-empty');
      await click('#library-projects [data-library-open-project]');
      await waitFor('real project store updated by project picker', () => main.conversations().listProjects().length === 1);
      await navigate('projects');
      await waitFor('project card', () => visible('#library-projects [data-library-project]'));
      await screenshot('projects-populated');
      await click('#library-projects .mp-library-sort summary');
      await click('[data-library-sort="projects"][data-sort-value="name"]');
      assert.equal(await evaluate(`document.querySelector('[data-library-sort="projects"][data-sort-value="name"]').getAttribute('aria-checked')`), 'true');
      return { createdViaRealIpc: true, count: main.conversations().listProjects().length };
    });
    await step('scheduled-empty', async () => {
      await navigate('scheduled');
      await waitFor('empty scheduled state', () => evaluate(`document.getElementById('library-scheduled').textContent.includes('No scheduled tasks')`));
      await screenshot('scheduled-empty');
      assert.equal(await evaluate(`Boolean(document.querySelector('[data-library-sort="scheduled"][data-sort-value="next"]'))`), true);
      await click('#library-scheduled .mp-library-new-menu:not(.mp-library-sort) summary');
      assert.equal(await evaluate(`document.querySelectorAll('[data-schedule-new] .cds-icon').length`), 2);
      await click('[data-schedule-new="manual"]');
      await waitFor('new task dialog without sources', () => visible('[data-schedule-attach]'));
      await screenshot('scheduled-dialog-no-sources');
      await click('[data-schedule-cancel]');
    });
    const conversationId = seedConversation();
    report.conversationId = conversationId;
    await step('scheduled-create-toggle-remove', async () => {
      await navigate('projects'); await navigate('scheduled');
      await click('#library-scheduled .mp-library-new-menu:not(.mp-library-sort) summary');
      await click('[data-schedule-new="manual"]');
      await waitFor('source selection from real conversation summary', () => visible('.mp-library-dialog [type=submit]'));
      await evaluate(`const task=document.querySelector('.mp-library-dialog [name=task]'); task.value='Daily review of the selected research notes'; task.dispatchEvent(new Event('input',{bubbles:true})); true`);
      await screenshot('scheduled-new-task-dialog');
      await click('.mp-library-dialog [type=submit]');
      await waitFor('real tracker created', () => main.trackers().length === 1);
      await waitFor('scheduled row created', () => visible('[data-tracker-toggle]'));
      const trackerId = main.trackers()[0].trackerId;
      assert.equal(main.trackers()[0].enabled, true);
      await screenshot('scheduled-populated');
      await click('[data-tracker-toggle]');
      await waitFor('tracker paused through IPC', () => main.trackers()[0]?.enabled === false);
      await waitFor('resume button', () => evaluate(`document.querySelector('[data-tracker-toggle]')?.textContent === 'Resume'`));
      await screenshot('scheduled-paused');
      await click('[data-tracker-toggle]');
      await waitFor('tracker resumed', () => main.trackers()[0]?.enabled === true);
      await click('[data-tracker-remove]');
      await waitFor('tracker removed through IPC', () => main.trackers().length === 0);
      const settings = JSON.parse(fs.readFileSync(path.join(PROFILE, 'fabric-settings.json'), 'utf8'));
      assert.equal(settings.context_trackers.length, 0);
      return { trackerId, created: true, paused: true, resumed: true, removedAndPersisted: true };
    });
    await step('customize-tabs', async () => {
      await navigate('customize');
      await waitFor('fixture skill directory', () => visible('[data-library-skill="acceptance-notes"]'));
      await click('#library-customize .mp-library-sort summary');
      await click('[data-library-sort="skills"][data-sort-value="edited"]');
      assert.equal(await evaluate(`document.querySelector('[data-library-skill]')?.dataset.librarySkill`), 'acceptance-review');
      await screenshot('customize-skills');
      await click('[data-customize-tab="connectors"]');
      await waitFor('actual MCP inventory', () => evaluate(`document.getElementById('library-customize').textContent.includes('acceptance_notes')`));
      assert.equal(await evaluate(`document.getElementById('library-customize').textContent.includes('fixture-secret')`), false);
      await screenshot('customize-connectors');
      await click('[data-directory-tab="discover"]');
      await waitFor('separate connector Discover cards', () => visible('[data-connector-card]'));
      await screenshot('customize-connectors-discover');
      await click('[data-directory-tab="yours"]');
      await click('[data-customize-tab="plugins"]');
      await waitFor('actual local plugin metadata', () => evaluate(`document.getElementById('library-customize').textContent.includes('acceptance_plugin')`));
      const pluginRow = await evaluate(`(() => {const row=document.querySelector('.mp-plugin-row');return row ? {height:row.getBoundingClientRect().height,text:row.textContent}:null;})()`);
      assert.ok(pluginRow && pluginRow.height > 0 && pluginRow.height < 120 && pluginRow.text.includes('acceptance_plugin'));
      assert.equal(fs.existsSync(path.join(PROFILE, 'UNEXPECTED_PLUGIN_EXECUTION')), false);
      await screenshot('customize-plugins');
      return { skillsDirectoryFixture: true, mcpAndPluginsReadFromRealLocalFiles: true, noPluginExecution: true };
    });
    await step('artifacts-layout-and-type', async () => {
      await navigate('artifacts');
      await waitFor('real stored artifact rows', () => evaluate(`document.querySelectorAll('.mp-artifact-item').length === 5`));
      studio.webContents.sendInputEvent({ type: 'mouseMove', x: 1000, y: 850 });
      report.checks.artifactNavigation = await evaluate(`['nav-artifacts','nav-customize'].map(id=>({id,on:document.getElementById(id).classList.contains('is-on'),hover:document.getElementById(id).matches(':hover')}))`);
      await screenshot('artifacts-list');
      await click('#artifact-layout-toggle');
      await waitFor('grid layout', () => evaluate(`document.getElementById('art-list').dataset.layout === 'grid'`));
      const columns = await evaluate(`getComputedStyle(document.querySelector('#art-list')).gridTemplateColumns.split(' ').length`);
      assert.equal(columns, 3);
      await waitFor('real image decoded', () => evaluate(`Boolean([...document.querySelectorAll('#art-list img.mp-artifact-image-preview')].find(img=>img.complete&&img.naturalWidth>0))`));
      const sandboxedFrames = await evaluate(`([...document.querySelectorAll('#art-list iframe.mp-artifact-html-preview')].map(frame=>({sandbox:frame.getAttribute('sandbox'),scriptRemoved:!/<script[\\s>]/i.test(frame.srcdoc)})))`);
      assert.equal(sandboxedFrames.length, 2);
      assert.ok(sandboxedFrames.every(frame => frame.sandbox === '' && frame.scriptRemoved));
      await waitFor('HTML and SVG preview frames loaded', () => studio.webContents.mainFrame.frames.filter(frame => frame.url === 'about:srcdoc').length >= 2);
      await screenshot('artifacts-grid');
      await click('#artifact-kind-trigger');
      await waitFor('type menu', () => visible('#artifact-kind-menu [data-artifact-kind="code"]'));
      await screenshot('artifacts-type-menu');
      await click('[data-artifact-kind="code"]');
      await waitFor('code filter', () => evaluate(`document.querySelectorAll('.mp-artifact-item').length === 1`));
      return { listCount: 5, grid: true, columns, imageDecoded: true, htmlAndSvgFramesLoaded: true, previewScreenshot: 'artifacts-grid.png', sandboxedFrames, filteredCount: 1 };
    });
    await step('original-preview-animations', async () => {
      await navigate('artifacts');
      await waitFor('original artifact preview mounted', () => evaluate(`document.querySelector('#view-artifacts [data-original-preview="slides"]')?.dataset.previewMounted === 'true'`));
      const selector = '#view-artifacts [data-original-preview="slides"]';
      const bounds = await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {width:r.width,height:r.height};})()`);
      assert.deepEqual(bounds, { width: 136, height: 96 });
      await hover(selector);
      await waitFor('original preview animates on hover', () => evaluate(`document.querySelector(${JSON.stringify(selector)}).getAnimations({subtree:true}).length > 0`));
      const animationCount = await evaluate(`document.querySelector(${JSON.stringify(selector)}).getAnimations({subtree:true}).length`);
      await delay(350); await screenshot('artifacts-original-preview-hover');
      studio.webContents.sendInputEvent({ type: 'mouseMove', x: 1000, y: 850 });
      await waitFor('preview leaves and stops', () => evaluate(`document.querySelector(${JSON.stringify(selector)}).getAnimations({subtree:true}).length === 0`));
      await evaluate(`document.documentElement.dataset.reduceMotion='true'; true`);
      await hover(selector); await delay(250);
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).getAnimations({subtree:true}).length`), 0);
      await evaluate(`delete document.documentElement.dataset.reduceMotion; true`);
      await navigate('designs');
      await waitFor('three design previews', () => evaluate(`document.querySelectorAll('#library-designs [data-preview-mounted="true"]').length === 3`));
      await screenshot('designs-original-previews');
      await hover('#library-designs [data-original-preview="design"]');
      await waitFor('design preview animates', () => evaluate(`document.querySelector('#library-designs [data-original-preview="design"]').getAnimations({subtree:true}).length > 0`));
      await delay(350); await screenshot('designs-original-preview-hover');
      await click('#library-designs [data-design-layout]');
      await waitFor('Design grid and date groups', () => evaluate(`document.querySelector('.mp-design-results')?.dataset.layout==='grid'&&document.querySelectorAll('.mp-design-date-group').length>0`));
      await screenshot('designs-grid');
      await click('#library-designs [data-design-layout]');
      await waitFor('Design returns to list', () => evaluate(`document.querySelector('.mp-design-results')?.dataset.layout==='list'`));
      return { bounds, animationCount, reducedMotionPreventsAnimation: true, designAnimations: true };
    });
    await step('sidebar-menus', async () => {
      await click('#sidebar-more'); await waitFor('more menu', () => visible('[data-edit-sidebar]'));
      await screenshot('sidebar-more');
      await click('[data-edit-sidebar]'); await waitFor('edit sidebar', () => visible('[data-nav-visibility="projects"]'));
      await screenshot('sidebar-edit');
      await click('[data-nav-visibility="projects"]');
      assert.equal(await evaluate(`document.getElementById('nav-projects').hidden`), true);
      await click('[data-nav-visibility="projects"]');
      assert.equal(await evaluate(`document.getElementById('nav-projects').hidden`), false);
      await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true`);
      await click('#sidebar-group-sort');
      const parent = '.mp-library-menu-group:nth-child(4) .mp-library-menu-parent';
      await hover(parent); await waitFor('group submenu opens on hover', () => visible('[data-library-filter="group"][data-value="type"]'));
      await screenshot('sidebar-group-submenu');
      await click('[data-library-filter="group"][data-value="type"]');
      await waitFor('group change updates sidebar', () => evaluate(`document.querySelector('#side-convos')?.textContent.includes('Tasks')`));
      return { visibilityPreferenceApplied: true, groupingApplied: true };
    });
    await step('collapsed-navigation', async () => {
      await click('#sidebar-toggle');
      await waitFor('collapsed sidebar', () => evaluate(`document.getElementById('shell').dataset.sidebar === 'collapsed'`));
      const icons = await evaluate(`['nav-projects','nav-artifacts','nav-scheduled','nav-designs','nav-customize'].map(id => {const e=document.querySelector('#'+id+' .cds-icon');const r=e?.getBoundingClientRect();return {id,visible:!!r&&r.width>0&&r.height>0&&getComputedStyle(e).display!=='none'};})`);
      assert.ok(icons.every(item => item.visible)); await screenshot('sidebar-collapsed');
      await click('#sidebar-toggle'); return icons;
    });
    await step('native-icon-font-animation', async () => {
      const axes = selector => evaluate(`(() => {const s=getComputedStyle(document.querySelector(${JSON.stringify(selector)}));return {settings:s.fontVariationSettings,anim:Number(s.getPropertyValue('--cds-anim')),anim2:Number(s.getPropertyValue('--cds-anim2'))};})()`);
      const samples = [];
      await evaluate('document.activeElement?.blur(); true');
      for (const id of ['nav-projects', 'nav-artifacts', 'nav-designs', 'nav-customize']) {
        const selector = `#${id} .cds-icon`;
        await hover(`#${id}`);
        await waitFor(`${id} font axis responds to native hover`, async () => (await axes(selector)).anim > 0);
        const entered = await axes(selector);
        assert.ok(entered.settings.includes('ANIM'));
        studio.webContents.sendInputEvent({ type: 'mouseMove', x: 1000, y: 850 });
        await waitFor(`${id} font axis returns to zero`, async () => (await axes(selector)).anim === 0);
        samples.push({ id, entered, exited: await axes(selector) });
      }
      const code = '.cds-icon[data-cds-anim="ANIM ANM2"]';
      await hover(code);
      await waitFor('Code alternate font axis enters loop', async () => (await axes(code)).anim2 === 100);
      const codeAlternate = await axes(code);
      await waitFor('Code alternate font axis returns during loop', async () => (await axes(code)).anim2 === 0);
      await evaluate(`document.documentElement.dataset.reduceMotion='true'; true`);
      await hover('#nav-projects'); await delay(120);
      assert.equal((await axes('#nav-projects .cds-icon')).anim, 0);
      await evaluate(`delete document.documentElement.dataset.reduceMotion; true`);
      studio.webContents.sendInputEvent({ type: 'mouseMove', x: 1000, y: 850 });
      return { samples, codeAlternate, reducedMotionStopsFontAxis: true };
    });
    await step('timeline-idle-hover', async () => {
      await evaluate(`document.querySelector(${JSON.stringify(`[data-open="${conversationId}"]`)})?.click(); true`);
      await waitFor('conversation and timeline', () => evaluate(`document.querySelectorAll('#stream .mp-chat-user').length === 4 && document.querySelectorAll('.mpw-rail-mark').length >= 4`));
      studio.webContents.sendInputEvent({ type: 'mouseMove', x: 1000, y: 850 });
      assert.equal(await evaluate(`getComputedStyle(document.getElementById('stream-rail-menu')).display`), 'none');
      await screenshot('timeline-idle');
      await hover('#stream-rail-marks');
      await waitFor('timeline hover opens labels', () => evaluate(`getComputedStyle(document.getElementById('stream-rail-menu')).display !== 'none'`));
      await screenshot('timeline-hover');
      return { marks: await evaluate(`document.querySelectorAll('.mpw-rail-mark').length`), labelsOnHover: true };
    });
    await step('artifact-hover-create', async () => {
      await hover('#nav-artifacts');
      await waitFor('artifact create plus is visible on hover', () => evaluate(`getComputedStyle(document.getElementById('nav-artifact-create')).opacity==='1'`));
      await click('#nav-artifact-create');
      await waitFor('artifact prompt in editable composer', () => evaluate(`document.querySelector('#composer-form textarea')?.value.includes('可编辑产物')`));
      assert.equal(main.conversations().list().length, 1);
      await screenshot('artifacts-create-prompt');
      return { editable: true, noTaskSent: true };
    });
    await step('chats-bulk-actions', async () => {
      const ids = [1, 2].map(index => main.conversations().appendTurn({ newConversation: true, capturedAt: Date.now() + index, question: `Bulk fixture ${index}`, answer: 'Isolated local record', outcome: '已完成' }).id);
      assert.equal(new Set(ids).size, 2);
      ids.forEach(id => main.notifyConversationChanged(id)); main.flush();
      await navigate('chats');
      await waitFor('chat list includes isolated records', () => visible(`#library-chats [data-open="${ids[0]}"]`));
      const heading = await evaluate(`(() => {const heading=document.querySelector('.mp-chats-heading');const h1=heading?.querySelector('h1');const actions=heading?.querySelector('[data-chat-selection]');return h1&&actions?{titleY:h1.getBoundingClientRect().y,actionsY:actions.getBoundingClientRect().y}:null;})()`);
      assert.ok(heading && Math.abs(heading.titleY - heading.actionsY) < 20, 'Chats title and actions must occupy the same row');
      await click('[data-chat-search-toggle]');
      await evaluate(`(() => {const search=document.querySelector('#library-chats [data-library-search]');search.value='Bulk fixture 2';search.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await waitFor('Chats search filters actual records', () => evaluate(`document.querySelectorAll('#library-chats [data-open]').length===1`));
      await evaluate(`(() => {const search=document.querySelector('#library-chats [data-library-search]');search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await waitFor('Chats search clears', () => visible(`#library-chats [data-open="${ids[0]}"]`));
      await screenshot('chats-heading-search');
      await click(`[data-library-chat-menu="${ids[0]}"]`);
      await click('[data-chat-action="rename"]');
      await evaluate(`document.querySelector('.mpw-rename-input').value='Renamed bulk fixture'; true`);
      await click('.mpw-perm-confirm .is-primary');
      await waitFor('rename updates the open Chats library', () => evaluate(`document.querySelector('#library-chats [data-open="${ids[0]}"]')?.textContent.includes('Renamed bulk fixture')`));
      await click(`[data-library-chat-menu="${ids[0]}"]`);
      await click('[data-chat-action="project"]');
      await waitFor('project assignment submenu', () => visible('.mp-project-assignment [data-project-search]'));
      await evaluate(`(() => {const search=document.querySelector('[data-project-search]');search.value='Research';search.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await screenshot('chats-project-search');
      await click('.mp-project-assignment [data-project-root]:not([data-project-root=""])');
      await waitFor('assign existing project persists through IPC', () => main.conversations().get(ids[0])?.workspaceRoot === WORKSPACE);
      await click(`[data-library-chat-menu="${ids[0]}"]`);
      await click('[data-chat-action="project"]');
      pickerDirectory = SECOND_WORKSPACE;
      await click('.mp-project-assignment [data-project-picker]');
      await waitFor('new folder project registered and assigned', () => main.conversations().get(ids[0])?.workspaceRoot === SECOND_WORKSPACE && main.conversations().listProjects().length === 2);
      report.checks.projectAssignment = { searchedExisting: true, assignedExisting: true, createdAndAssignedThroughPicker: true };
      await click('#library-chats [data-library-filters]');
      await hover('.mp-library-menu-group:nth-child(2) .mp-library-menu-parent');
      const statusPoint = await point('[data-library-filter="status"][data-value="all"]');
      report.checks.chatStatusFilterPoint = statusPoint;
      assert.ok(statusPoint.x < 1037 && statusPoint.y < 879, 'Chats filter submenu must remain inside the actual viewport');
      await screenshot('chats-status-filter');
      await click('[data-library-filter="status"][data-value="all"]');
      await waitFor('All status applied', () => evaluate(`JSON.parse(localStorage.getItem('mp:library-preferences')).filters.status==='all'`), 1000);
      await click('[data-chat-selection]');
      for (const id of ids) await click(`[data-chat-select="${id}"]`);
      await screenshot('chats-selection');
      await click('[data-chat-bulk="archive"]');
      await waitFor('chat archive preferences persisted', () => evaluate(`${JSON.stringify(ids)}.every(id=>JSON.parse(localStorage.getItem('mp:library-preferences')).sessions[id]?.archived===true)`));
      for (const id of ids) await click(`[data-chat-select="${id}"]`);
      await click('[data-chat-bulk="unarchive"]');
      await waitFor('chat unarchive preferences persisted', () => evaluate(`${JSON.stringify(ids)}.every(id=>JSON.parse(localStorage.getItem('mp:library-preferences')).sessions[id]?.archived===false)`));
      for (const id of ids) await click(`[data-chat-select="${id}"]`);
      await click('[data-chat-bulk="delete"]');
      await waitFor('chat records deleted through real IPC', () => ids.every(id => !main.conversations().get(id)));
      main.flush();
      await waitFor('deleted records removed from list', () => evaluate(`${JSON.stringify(ids)}.every(id=>!document.querySelector('#library-chats [data-open="'+id+'"]'))`));
      return { ids, renamedInPlace: true, archived: true, unarchived: true, deletedFromRealStore: true };
    });
    assert.equal(main.unexpectedRuns(), 0);
    report.checks.noScheduledExecution = true;
    report.ok = report.failures.length === 0 && report.consoleErrors.length === 0;
  } catch (error) {
    report.ok = false; report.failures.push({ name: 'setup', error: error.stack || String(error) });
    if (studio && !studio.isDestroyed()) await screenshot('setup-failure');
  } finally {
    await main.stop(); main.flush();
    report.timingMs = Date.now() - STARTED_AT;
    fs.writeFileSync(path.join(OUTPUT, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    app.exit(report.ok ? 0 : 1);
  }
});
