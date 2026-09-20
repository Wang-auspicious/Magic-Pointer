'use strict';
// Real development main/preload/IPC and saved profiles; no fixture renderer.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'data/runtime/model-menu-20260919/actual');
fs.mkdirSync(out, { recursive: true });
app.setName('magic-pointer');
app.setPath('userData', path.join(process.env.APPDATA, 'magic-pointer'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const mainPath = path.join(root, 'build/electron/main.js');
const production = new Module(mainPath, module);
production.filename = mainPath;
production.paths = Module._nodeModulePaths(path.dirname(mainPath));
production._compile(fs.readFileSync(mainPath, 'utf8') + `
module.exports.modelMenuAcceptance = {
  open: () => { onboardingWindow?.hide(); showDashboard({view:'chat'}, {activate:true}); },
  models: () => JSON.parse(JSON.stringify(fabricSettings.models)),
  restore: models => saveFabricSettingsPatch({models}),
  runtime: () => { const r=activeModelRuntimeConfig(); return r && {profileId:r.profileId,model:r.model,apiMode:r.apiMode,models:r.models}; }
};`, mainPath);
app.whenReady().then(async () => {
  const api = production.exports.modelMenuAcceptance;
  api.open();
  let win;
  for (let i = 0; i < 160; i++) {
    win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/studio.html'));
    if (win && await win.webContents.executeJavaScript("typeof openModelMenu==='function' && Boolean(modelCatalog)").catch(() => false)) break;
    await wait(250);
  }
  assert(win, 'real Studio window must open');
  const wc = win.webContents;
  await wc.executeJavaScript('document.fonts.ready');
  win.show(); win.focus();
  if (process.argv.includes('--open-only')) {
    await wc.executeJavaScript('openModelMenu()');
    await wc.executeJavaScript("document.querySelector('[data-model-more]').click()");
    await wait(120);
    fs.writeFileSync(path.join(out,'delivered.png'), (await wc.capturePage()).toPNG());
    console.log('Latest development Studio opened; model and pin preferences preserved');
    return;
  }
  const click = async selector => {
    // Use the actual DOM handler while the user keeps working in other apps.
    // Chromium hit testing and native input are separately covered by probe_model_menu.
    await wc.executeJavaScript(`(() => {const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw new Error('missing click target');n.click()})()`);
    await wait(40);
  };
  const measure = () => wc.executeJavaScript(`(() => {
    const menu=document.querySelector('#composer-model-menu'),panel=menu.querySelector('.dshw-model-more-panel');
    const box=n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
    return {menu:box(menu),panel:panel?box(panel):null,viewport:{width:innerWidth,height:innerHeight},
      rows:[...menu.querySelectorAll('[data-model-id]')].map(n=>({id:n.dataset.modelId,profileId:n.dataset.modelProfileId,key:n.dataset.modelKey,height:n.getBoundingClientRect().height})),
      pins:resolveModelPins(modelCatalog),current:modelCatalog.current,currentProfileId:modelCatalog.currentProfileId,
      models:modelEntries(modelCatalog),errors:(modelCatalog.groups||[]).filter(g=>g.error).map(g=>g.error),text:menu.textContent};
  })()`);
  const pinSelector = key => `[data-model-pin=${JSON.stringify(key)}]`;
  let savedPins;
  const savedModels = api.models();
  try {
    await click('#composer-model');
    await wc.executeJavaScript('openModelMenu()'); // await actual catalog refresh before editing
    savedPins = await wc.executeJavaScript("localStorage.getItem('mp:model-pins')");
    // This user's previous menu left three saved ids while displaying four.
    // Materialize four defaults once for this requested delivery; subsequent
    // unchecks still preserve empty slots and never auto-refill them.
    await wc.executeJavaScript(`(() => {
      const pins=resolveModelPins(modelCatalog),entries=modelEntries(modelCatalog);
      while(pins.filter(Boolean).length<4) {
        const next=entries.find(entry=>!pins.includes(entry.key));if(!next)break;
        const hole=pins.indexOf('');if(hole>=0)pins[hole]=next.key;else pins.push(next.key);
      }
      writeModelPins(pins);renderModelMenu();
    })()`);
    if (process.argv.includes('--four-defaults')) savedPins = await wc.executeJavaScript("localStorage.getItem('mp:model-pins')");
    await wait(100);
    const main = await measure();
    fs.writeFileSync(path.join(out,'initial.json'),JSON.stringify(main,null,2));
    assert.equal(main.menu.width, 244);
    assert.equal(main.rows.length, 4);
    assert(main.rows.every(row => row.height === 24));
    assert(!/Fast mode|usage credits|视觉/.test(main.text));
    fs.writeFileSync(path.join(out, 'main.png'), (await wc.capturePage()).toPNG());
    await click('[data-model-more]');
    const more = await measure();
    assert(more.panel.bottom <= more.viewport.height - 8);
    assert(more.panel.top >= 8);
    await wc.executeJavaScript("document.querySelector('.dshw-model-more-panel').scrollTop=100000");
    assert(await wc.executeJavaScript(`(() => {const n=[...document.querySelectorAll('[data-model-pin]')].at(-1),r=n.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('[data-model-pin]')===n})()`), 'last real catalog entry is reachable');
    const removed = main.pins[2];
    const next = more.models.find(entry => !main.pins.includes(entry.key));
    assert(next, 'real catalog needs an unpinned model for replacement acceptance');
    await wc.executeJavaScript(`document.querySelector(${JSON.stringify(pinSelector(removed))}).scrollIntoView({block:'nearest'})`);
    await click(pinSelector(removed));
    assert(!(await measure()).pins.includes(removed));
    await wc.executeJavaScript(`document.querySelector(${JSON.stringify(pinSelector(next.key))}).scrollIntoView({block:'nearest'})`);
    await click(pinSelector(next.key));
    const replaced = await measure();
    assert.equal(replaced.pins[2], next.key);
    assert.equal(replaced.pins[3], main.pins[3]);
    assert.equal(replaced.rows.length, 4);
    fs.writeFileSync(path.join(out, 'more.png'), (await wc.capturePage()).toPNG());
    await wc.executeJavaScript('closeModelMenu(); openModelMenu()');
    assert.equal((await measure()).pins[2], next.key, 'replacement survives catalog refresh and reopen');
    const selectionStarted = Date.now();
    await click('[data-model-key="3"]');
    for (let i=0; i<80; i++) {
      if (await wc.executeJavaScript(`modelCatalog?.current===${JSON.stringify(next.id)} && document.querySelector('#composer-model-menu').hidden`)) break;
      await wait(100);
    }
    const selected = api.runtime();
    const selectionMs = Date.now() - selectionStarted;
    assert(selectionMs < 500, `model switching blocked the GUI for ${selectionMs}ms`);
    assert(await wc.executeJavaScript("!document.querySelector('#composer-model').hasAttribute('title')"));
    assert.equal((await measure()).current, next.id);
    if (next.profileId) assert.equal(selected.model, next.id);
    assert.equal(selected.profileId, next.profileId);
    const metadata = selected.models.find(entry => entry.id === next.id);
    assert.equal(metadata?.contextWindow, next.contextWindow, 'selected runtime receives catalog context metadata');
    fs.writeFileSync(path.join(out,'witness.json'), JSON.stringify({usedBackend:'real_electron_main_preload_ipc',selectionMs,main,more,replaced,selected},null,2));
    fs.writeFileSync(path.join(out,'result.txt'), 'PASS: actual development GUI, four compact rows, unpin, slot 3 replacement, reopen persistence, real model selection and runtime metadata\n');
  } finally {
    await api.restore(savedModels);
    // The pre-profile setup persists its current id in the Python secrets file.
    if (!savedModels.profiles?.length) {
      const before = JSON.parse(fs.readFileSync(path.join(out,'initial.json'),'utf8'));
      await wc.executeJavaScript(`Data.selectModel(${JSON.stringify(before.current)})`);
    }
    if (savedPins !== undefined) await wc.executeJavaScript(`localStorage.setItem('mp:model-pins',${JSON.stringify(savedPins)});modelPinsCache=null;closeModelMenu();refreshComposerModel()`);
    await wc.executeJavaScript('openModelMenu()');
    await wait(120);
    fs.writeFileSync(path.join(out,'delivered.png'), (await wc.capturePage()).toPNG());
  }
  console.log('PASS: actual development model menu; restored user model and pins; latest development GUI remains open');
  if (!process.argv.includes('--keep-open')) app.quit();
}).catch(error => {
  fs.writeFileSync(path.join(out,'result.txt'),String(error.stack || error));
  console.error(error); app.exit(1);
});
