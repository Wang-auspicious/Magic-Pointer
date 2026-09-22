'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'data/runtime/model-menu-20260919');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
fs.mkdirSync(out, { recursive: true });
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1199, height: 800, useContentSize: true, frame: false, show: false,
    webPreferences: { offscreen: true, sandbox: false, contextIsolation: true,
      preload: path.join(root, 'scripts/probe_studio_layout_preload.js'),
      additionalArguments: ['--mp-probe-theme=light', '--mp-probe-state=landing'] } });
  const wc = win.webContents;
  const failures = [];
  const check = (value, message) => { if (!value) failures.push(message); };
  const click = async selector => {
    const p = await wc.executeJavaScript(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
    wc.sendInputEvent({ type: 'mouseMove', ...p });
    wc.sendInputEvent({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', ...p, button: 'left', clickCount: 1 });
    await wait(100);
  };
  const measure = () => wc.executeJavaScript(`(() => {
    const menu=document.querySelector('#composer-model-menu'),panel=menu.querySelector('.mpw-model-more-panel');
    const box=n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
    return {menu:box(menu),panel:panel?box(panel):null,viewport:{width:innerWidth,height:innerHeight},hidden:menu.hidden,
      rows:[...menu.querySelectorAll('[data-model-id]')].map(n=>({id:n.dataset.modelId,height:n.getBoundingClientRect().height,key:n.dataset.modelKey})),
      checked:[...menu.querySelectorAll('[data-model-pin][aria-checked="true"]')].map(n=>n.dataset.modelPin),text:menu.textContent};
  })()`);
  try {
    await win.loadFile(path.join(root, 'build/electron/renderer/studio.html'), { query: { view: 'chat' } });
    for (let i=0;i<100;i++) {
      if (await wc.executeJavaScript("typeof renderModelMenu === 'function'").catch(()=>false)) break;
      await wait(50);
    }
    await wc.executeJavaScript('document.fonts.ready');
    await wc.executeJavaScript(`(async()=>{
      await openModelMenu(); localStorage.removeItem('mp:model-pins');
      if(typeof modelPinsCache!=='undefined') modelPinsCache=null;
      modelCatalog={current:'mimo-v2.5',groups:[{id:'fixture',name:'Fixture',models:
        ['mimo-v2.5','minimax-m3','minimax-m2.7','minimax-m2.5','kimi-k3',...Array.from({length:24},(_,i)=>'vendor/model-'+i)]
        .map(id=>({id,contextWindow:128000}))}]};
      renderModelMenu();
    })()`);
    wc.focus();
    const main=await measure();
    check(main.menu.width===244, `menu width ${main.menu.width}, expected reference 244 CSS px`);
    check(main.rows.length===4 && main.rows.every(r=>r.height===24), 'expected four compact 24px model rows');
    check(!/Fast mode|usage credits|视觉/.test(main.text), 'main menu must contain only names and More models');
    check(await wc.executeJavaScript("document.querySelectorAll('[data-model-id] .mpw-model-source').length===4"), 'each main model needs its provider badge');
    fs.writeFileSync(path.join(out,'main.png'),(await wc.capturePage()).toPNG());
    await click('[data-model-more]');
    const expanded=await measure();
    check(expanded.panel && expanded.panel.bottom<=expanded.viewport.height-8, 'More models extends below GUI viewport');
    check(expanded.panel && expanded.panel.height<=216, 'More models should show about eight rows and scroll');
    check(await wc.executeJavaScript("document.querySelectorAll('[data-model-pin] .mpw-model-source').length===29"), 'each More model needs its provider badge');
    await click('[data-model-pin="minimax-m2.7"]');
    const removed=await measure();
    check(!removed.checked.includes('minimax-m2.7'), 'unchecked model 3 was automatically restored');
    await click('[data-model-pin="kimi-k3"]');
    const replaced=await measure();
    check(replaced.rows[2]?.id==='kimi-k3' && replaced.rows[3]?.id==='minimax-m2.5', 'new model did not replace slot 3');
    check(replaced.rows.length<=4 && !replaced.hidden, 'pin editing must keep menu open and within four slots');
    fs.writeFileSync(path.join(out,'more.png'),(await wc.capturePage()).toPNG());
    await wc.executeJavaScript(`document.querySelector('.mpw-model-more-panel').scrollTop=10000`);
    const reachable=await wc.executeJavaScript(`(() => {const n=document.querySelector('[data-model-pin="vendor/model-23"]'),r=n.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('[data-model-pin]')===n})()`);
    check(reachable, 'last model is not reachable by scrolling');
    win.setContentSize(720,480);
    await wait(120);
    const narrow=await measure();
    check(narrow.panel && narrow.panel.left>=8 && narrow.panel.right<=narrow.viewport.width-8 && narrow.panel.top>=8 && narrow.panel.bottom<=narrow.viewport.height-8, 'More must stay within resized GUI');
    await wc.executeJavaScript("document.querySelector('.mpw-model-more-panel').scrollTop=0");
    const firstReachable=await wc.executeJavaScript(`(() => {const n=document.querySelector('[data-model-pin]'),r=n.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('[data-model-pin]')===n})()`);
    check(firstReachable, 'first model must not be covered by the native title bar');
    fs.writeFileSync(path.join(out,'narrow.png'),(await wc.capturePage()).toPNG());
    fs.writeFileSync(path.join(out,'witness.json'),JSON.stringify({main,expanded,removed,replaced,narrow,reachable,failures},null,2));
    console.log(JSON.stringify({failures,main:main.menu,expanded:expanded.panel,narrow:narrow.panel}));
    app.exit(failures.length?1:0);
  } catch(error) { console.error(error); app.exit(1); }
}).catch(error=>{ console.error(error);app.exit(1); });
