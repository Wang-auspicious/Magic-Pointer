'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data/runtime/startup-ui-20260920');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
fs.mkdirSync(output, { recursive: true });
const deadline = setTimeout(() => { console.error('startup UI probe timed out'); app.exit(1); }, 25000);
app.whenReady().then(async () => {
  const failures = [];
  const check = (ok, message) => { if (!ok) failures.push(message); };
  const win = new BrowserWindow({ width: 1239, height: 820, useContentSize: true, show: false,
    webPreferences: { offscreen: true, sandbox: false, contextIsolation: true,
      preload: path.join(root, 'scripts/probe_studio_layout_preload.js'),
      additionalArguments: ['--mp-probe-theme=light', '--mp-probe-state=landing'] } });
  const wc = win.webContents;
  try {
    await win.loadFile(path.join(root, 'build/electron/renderer/studio.html'), { query: { view: 'chat' } });
    await wc.executeJavaScript('document.fonts.ready');
    for (let i = 0; i < 100; i++) {
      if (await wc.executeJavaScript("typeof openModelMenu === 'function'").catch(() => false)) break;
      await wait(25);
    }
    const model = await wc.executeJavaScript(`(async () => {
      let finishStartup;
      const catalog = { current: 'deepseek-v4.1-flash', currentProfileId: 'zen', groups: [
        { id: 'zen', profileId: 'zen', name: 'opencode-zen', models: [{ id: 'deepseek-v4.1-flash', profileId: 'zen' }] }
      ] };
      let calls = 0;
      Data.models = () => ++calls === 1 ? new Promise(resolve => { finishStartup = resolve; }) : Promise.resolve(catalog);
      modelCatalog = null;
      renderComposerModel();
      const startup = refreshComposerModel();
      await openModelMenu();
      finishStartup({ current: 'old-model', groups: [] });
      await startup;
      const label = document.getElementById('composer-model-label').textContent;
      document.querySelector('[data-model-id="deepseek-v4.1-flash"]').click();
      const selectedLabel = document.getElementById('composer-model-label').textContent;
      Data.models = () => Promise.resolve(null);
      await refreshComposerModel();
      return { label, selectedLabel, afterFailure: document.getElementById('composer-model-label').textContent };
    })()`);
    for (const [key, value] of Object.entries(model)) check(value === 'deepseek-v4.1-flash', `${key}: ${value}`);
    const mode = await wc.executeJavaScript(`(() => {
      document.getElementById('mode-design').click();
      return { labels: [...document.querySelectorAll('#mode-switch button')].map(b => b.textContent.trim()),
        active: document.getElementById('shell').dataset.productMode,
        navVisible: !document.querySelector('.mp-design-nav').hidden && getComputedStyle(document.querySelector('.mp-design-nav')).display !== 'none',
        icons: document.querySelectorAll('#mode-switch .cds-icon').length };
    })()`);
    check(mode.labels.join(',') === 'Work,Design' && mode.active === 'design' && mode.navVisible && mode.icons === 2, `mode: ${JSON.stringify(mode)}`);
    await wc.executeJavaScript(`(async () => {
      const entries = Array.from({ length: 12 }, (_, i) => ({ title: 'Material ' + i, app: 'Notes', time: '9月20日', kind: '素材', icon: 'ic-docs',
        items: [{ id: 'fixture-' + i, t: 'shot', w: 240, h: 160, desc: 'A saved material', summary: i % 2 ? '' : 'A long summary '.repeat(30) }] }));
      Data.stash = async () => entries;
      Data.searchStash = async () => entries;
      show('stash');
      await renderStash(true);
      document.querySelector('#stash-mode [data-mode="canvas"]').click();
    })()`);
    const measure = () => wc.executeJavaScript(`(() => {
      const rect = s => { const r = document.querySelector(s).getBoundingClientRect(); return { width:r.width,height:r.height,x:r.x,y:r.y,right:r.right,bottom:r.bottom }; };
      return { canvas:rect('#canvas'), card:rect('.node'), icon:rect('.node-cap svg'), toolbar:rect('.page-toolbar'),
        position:getComputedStyle(document.querySelector('.node')).position,
        overflow:document.documentElement.scrollWidth > innerWidth,
        canvasOverflow:getComputedStyle(document.querySelector('#canvas')).overflow,
        searchIcon:rect('.mp-stash-search svg'), zoom:document.getElementById('zoom-val').textContent,
        selectedNav:[...document.querySelectorAll('.mp-design-nav .is-on')].map(b => b.textContent.trim()),
        descriptionsFit:[...document.querySelectorAll('.node')].every(n => n.querySelector('.node-desc').getBoundingClientRect().bottom <= n.getBoundingClientRect().bottom) };
    })()`);
    const canvas = await measure();
    check(canvas.position === 'absolute' && canvas.canvas.height > 200 && canvas.canvasOverflow === 'hidden', `canvas layout: ${JSON.stringify(canvas)}`);
    check(canvas.icon.width <= 20 && canvas.searchIcon.width <= 20 && !canvas.overflow, 'icons and canvas must fit the viewport');
    check(canvas.zoom === '100%' && canvas.selectedNav.join(',') === 'Canvas' && canvas.descriptionsFit, 'canvas must open at readable size with one selected navigation item and unclipped descriptions');
    await wait(250);
    fs.writeFileSync(path.join(output, 'canvas.png'), (await wc.capturePage()).toPNG());
    await wc.executeJavaScript("document.querySelector('#stash-mode [data-mode=\"list\"]').click()");
    const list = await wc.executeJavaScript(`(() => ({
      display:getComputedStyle(document.querySelector('.stash-row')).display,
      height:document.querySelector('.stash-row').getBoundingClientRect().height,
      overflow:document.documentElement.scrollWidth > innerWidth,
      canvasHidden:document.querySelector('#canvas').hidden,
      selectedNav:[...document.querySelectorAll('.mp-design-nav .is-on')].map(b => b.textContent.trim())
    }))()`);
    check(list.display === 'grid' && list.height <= 90 && !list.overflow && list.canvasHidden, `list layout: ${JSON.stringify(list)}`);
    check(list.selectedNav.join(',') === 'Assets', 'list mode must select only Assets');
    await wait(250);
    fs.writeFileSync(path.join(output, 'list.png'), (await wc.capturePage()).toPNG());
    win.setContentSize(760, 600);
    await wait(100);
    check(await wc.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'), 'narrow list overflows');
    fs.writeFileSync(path.join(output, 'witness.json'), JSON.stringify({ model, mode, canvas, list, failures }, null, 2));
    console.log(JSON.stringify({ model, mode, canvas, list, failures }));
    clearTimeout(deadline);
    app.exit(failures.length ? 1 : 0);
  } catch (error) { console.error(error); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
