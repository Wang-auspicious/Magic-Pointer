'use strict';
// Runs the real main process, preload, IPC and saved conversation. No fixture UI.
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'data/runtime/context-usage-actual');
const id = process.argv.find(arg => arg.startsWith('--conversation='))?.slice(15) || 'c1789745222499';
fs.mkdirSync(out, { recursive: true });
app.setName('magic-pointer');
app.setPath('userData', path.join(process.env.APPDATA, 'magic-pointer'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const cursorEvents = [];
app.on('browser-window-created', (_event, win) => {
  win.webContents.on('cursor-changed', (_event, type) => cursorEvents.push({ id: win.id, type }));
});
const mainPath=path.join(root,'build/electron/main.js');
const Module=require('node:module');
const production=new Module(mainPath,module);
production.filename=mainPath;
production.paths=Module._nodeModulePaths(path.dirname(mainPath));
// Expose only the existing window opener to the probe; IPC and render code run unchanged.
production._compile(fs.readFileSync(mainPath,'utf8')+'\nmodule.exports.openUsageStudio=()=>{onboardingWindow?.hide();showDashboard({view:"chat"},{activate:true});};',mainPath);
const run = async () => {
  production.exports.openUsageStudio();
  let win;
  for (let attempt = 0; attempt < 160; attempt++) {
    win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/studio.html'));
    if (win && await win.webContents.executeJavaScript("typeof openConversation === 'function' && Boolean(modelCatalog)").catch(() => false)) break;
    await wait(250);
  }
  assert(win, 'production Studio window did not open');
  const wc = win.webContents;
  await wc.executeJavaScript('openConversation(' + JSON.stringify(id) + ')');
  await wc.executeJavaScript('document.fonts.ready');
  win.show();
  await wait(300);
  const click = async selector => {
    const point = await wc.executeJavaScript('(() => {const n=document.querySelector(' + JSON.stringify(selector) + ');const r=n.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
    wc.sendInputEvent({ type: 'mouseMove', ...point });
    wc.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await wait(160);
  };
  await click('#composer-context');
  await wait(400);
  await click('#composer-usage-popover .mp-usage-foot');
  const measure = () => wc.executeJavaScript(`(() => {
    const main=document.getElementById('composer-usage-popover'),detail=document.getElementById('composer-usage-breakdown');
    const box=n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
    const colors=[...main.querySelectorAll('.mp-usage-seg')].map(n=>{
      const kind=n.dataset.kind,fill=detail.querySelector('.mp-usage-row-fill[data-kind="'+kind+'"]'),swatch=detail.querySelector('.mp-usage-swatch[data-kind="'+kind+'"]');
      return {kind,segment:getComputedStyle(n).backgroundColor,fill:getComputedStyle(fill).backgroundColor,swatch:getComputedStyle(swatch).backgroundColor};
    });
    return {main:box(main),detail:box(detail),mainHidden:main.hidden,detailHidden:detail.hidden,head:main.querySelector('.mp-usage-head-value').textContent,
      context:latestContextUsage(usageMeterTurns),text:detail.textContent,colors,
      font:getComputedStyle(main.querySelector('.mp-usage-head')).fontSize,barHeight:main.querySelector('.mp-usage-bar').getBoundingClientRect().height};
  })()`);
  const opened=await measure();
  assert.equal(opened.mainHidden,false);
  assert.equal(opened.detailHidden,false);
  assert(opened.detail.right <= opened.main.left - 4);
  assert.equal(opened.context.contextTokens,42085);
  assert(opened.head.includes('42.1k /'));
  assert.equal(opened.main.width,362);
  assert.equal(opened.font,'12px');
  assert.equal(opened.barHeight,4);
  assert(!opened.text.includes('旧记录只有累计消耗'));
  assert(opened.text.includes('92,304'));
  assert.equal(opened.colors.length,4);
  for(const row of opened.colors) { assert.equal(row.segment,row.fill); assert.equal(row.segment,row.swatch); }
  assert.equal(new Set(opened.colors.map(row=>row.segment)).size,4);
  fs.writeFileSync(path.join(out,'expanded.png'),(await wc.capturePage()).toPNG());
  await click('#composer-usage-popover .mp-usage-head');
  let state=await measure();
  assert.equal(state.mainHidden,false); assert.equal(state.detailHidden,true);
  fs.writeFileSync(path.join(out,'collapsed.png'),(await wc.capturePage()).toPNG());
  await click('#composer-usage-popover .mp-usage-head');
  state=await measure();
  assert.equal(state.mainHidden,false); assert.equal(state.detailHidden,false);
  // Native input crosses an empty portion of this visible Studio window.
  // The helper records OS cursor visibility and restores the starting position.
  cursorEvents.length=0;
  const bounds=win.getContentBounds();
  const start=screen.dipToScreenPoint({x:bounds.x+Math.round(bounds.width*.4),y:bounds.y+90});
  const finish=screen.dipToScreenPoint({x:bounds.x+Math.round(bounds.width*.65),y:bounds.y+90});
  const sampleNative=()=>new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/probe_native_cursor.ps1'),
      '-StartX',String(start.x),'-EndX',String(finish.x),'-Y',String(start.y)],{windowsHide:true});
    let stdout='',stderr='';
    child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
    child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(stdout)):reject(new Error(stderr)));
  });
  // Recreate the previous always-visible decoration to observe its OS effect.
  const display=screen.getDisplayMatching(bounds);
  const oldDecoration=new BrowserWindow({ ...display.bounds,height:display.bounds.height-2,
    frame:false,transparent:true,backgroundColor:'#00000000',focusable:false,skipTaskbar:true,
    hasShadow:false,show:false,alwaysOnTop:true });
  oldDecoration.setIgnoreMouseEvents(true,{forward:true});
  await oldDecoration.loadURL('data:text/html,<style>html,body{margin:0;height:100%;cursor:none}*{cursor:none!important}</style>');
  oldDecoration.showInactive();
  const previousNative=await sampleNative();
  oldDecoration.destroy();
  await wait(200);
  cursorEvents.length=0;
  const native=await sampleNative();
  assert.equal(native.hidden,0,'moving over Studio hid the native cursor');
  assert.equal(cursorEvents.filter(event=>event.type==='none').length,0,'a transparent surface reset the cursor to none');
  const witness={...opened,previousNative,native,cursorEvents,windows:BrowserWindow.getAllWindows().map(w=>({id:w.id,visible:w.isVisible(),page:path.basename(w.webContents.getURL().split('?')[0])}))};
  fs.writeFileSync(path.join(out,'witness.json'),JSON.stringify(witness,null,2));
  fs.writeFileSync(path.join(out,'result.txt'),'PASS: real main + saved JEV conversation + single click + left panel + colors + native mouse\n');
  if(!process.argv.includes('--keep-open')) app.quit();
};
app.whenReady().then(run).catch(error=>{
  fs.writeFileSync(path.join(out,'result.txt'),String(error.stack||error));
  app.exit(1);
});
