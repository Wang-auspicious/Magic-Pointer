'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'data/runtime/composer-menus-20260919');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1199, height: 800, useContentSize: true, frame: false, show: false,
    webPreferences: { offscreen: true, sandbox: false, contextIsolation: true,
      preload: path.join(root, 'scripts/probe_studio_layout_preload.js'),
      additionalArguments: ['--mp-probe-theme=light', '--mp-probe-state=landing'] } });
  const wc = win.webContents;
  const failures = [], measurements = {};
  const check = (value, message) => { if (!value) failures.push(message); };
  const measure = id => wc.executeJavaScript(`(() => {
    const n=document.getElementById(${JSON.stringify(id)}); if(!n)return null;
    const r=n.getBoundingClientRect(),s=getComputedStyle(n);
    return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,hidden:n.hidden,
      radius:s.borderRadius,text:n.innerText};
  })()`);
  const click = async selector => {
    const p = await wc.executeJavaScript(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
    wc.sendInputEvent({ type: 'mouseMove', ...p });
    wc.sendInputEvent({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', ...p, button: 'left', clickCount: 1 });
    await wait(80);
  };
  try {
    await win.loadFile(path.join(root, 'build/electron/renderer/studio.html'), { query: { view: 'chat' } });
    for (let i=0;i<100;i++) {
      if (await wc.executeJavaScript("typeof openEffortMenu === 'function'").catch(()=>false)) break;
      await wait(50);
    }
    await wc.executeJavaScript('document.fonts.ready.then(()=>true)');
    await wc.executeJavaScript(`(() => {
      window.effortDraws=0;const draw=WebGL2RenderingContext.prototype.drawArrays;
      WebGL2RenderingContext.prototype.drawArrays=function(...args){window.effortDraws++;return draw.apply(this,args)};
    })()`);
    wc.focus();
    await click('#composer-effort');
    measurements.effort = await measure('composer-effort-menu');
    check(measurements.effort.width===220, `effort width ${measurements.effort.width}; Claude is 220`);
    check(measurements.effort.height===111, `effort height ${measurements.effort.height}; Claude compact is 111`);
    await wc.executeJavaScript(`document.querySelector('.mp-effort-track').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`);
    await wait(900);
    check(await wc.executeJavaScript("document.querySelector('.mp-effort-track').getAttribute('aria-valuetext')==='Max'"), 'End must select maximum effort');
    const canvasRect = await wc.executeJavaScript(`(() => {
      const r=document.querySelector('.mp-effort-particles')?.getBoundingClientRect();
      return r?{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}:null;
    })()`);
    const frame = async () => canvasRect ? (await wc.capturePage(canvasRect)).toPNG().toString('base64') : '';
    const first = await frame();
    await wait(200);
    check(first.length>100 && first!==await frame(), 'highest effort must render live purple particles');
    fs.writeFileSync(path.join(out,'effort.png'),(await wc.capturePage()).toPNG());
    await click('#composer-permission');
    const drawsAfterClose=await wc.executeJavaScript('window.effortDraws');
    await wait(100);
    check(drawsAfterClose===await wc.executeJavaScript('window.effortDraws'),'closed effort menu must stop GPU drawing');
    measurements.permission=await measure('composer-permission-menu');
    const rows=await wc.executeJavaScript("[...document.querySelectorAll('#composer-permission-menu .mpw-perm-row')].map(n=>n.getBoundingClientRect().height)");
    check(rows.length===5 && rows.every(h=>h===40.5), `mode rows ${JSON.stringify(rows)}; expected Claude compact 40.5px`);
    check(measurements.permission.width<300,'Mode menu must use native content width, not fixed 320px');
    fs.writeFileSync(path.join(out,'mode.png'),(await wc.capturePage()).toPNG());
    await wc.executeJavaScript('window.filePickerCalls=0; Data.pickProjectFiles=async()=>{window.filePickerCalls++;return {ok:true,paths:[]}};void 0');
    await click('#composer-add');
    measurements.add=await measure('composer-attach-menu');
    check(measurements.add && !measurements.add.hidden,'+ must open the attachment menu');
    check(await wc.executeJavaScript('window.filePickerCalls===0'),'+ must not open the file picker immediately');
    if(measurements.add && !measurements.add.hidden) {
      fs.writeFileSync(path.join(out,'add.png'),(await wc.capturePage()).toPNG());
      await click('[data-attach-command="files"]');
      check(await wc.executeJavaScript('window.filePickerCalls===1'),'Add files or photos must open the picker exactly once');
    }
    await click('#account-footer');
    measurements.account=await measure('account-menu');
    check(measurements.account.width===272,'account menu must be 17rem / 272px');
    for(const label of ['Settings','Language','Get help','View changelog','Learn more']) check(measurements.account.text.includes(label),`account menu missing ${label}`);
    check(measurements.account.radius==='12px','account menu must use Claude 12px popup radius');
    fs.writeFileSync(path.join(out,'account.png'),(await wc.capturePage()).toPNG());
    await click('[data-account-command="learn-more"]');
    check(await wc.executeJavaScript("!document.getElementById('account-submenu').hidden && document.getElementById('account-submenu').innerText.includes('Keyboard shortcuts')"),'Learn more must expose a reachable submenu');
    wc.sendInputEvent({type:'keyDown',keyCode:'Escape'});
    wc.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await wait(80);
    check(await wc.executeJavaScript("document.getElementById('account-menu').hidden && document.getElementById('account-submenu').hidden && document.activeElement.id==='account-footer'"),'Escape must close account and submenu and restore focus');
    await wc.executeJavaScript(`closeAccountMenu();setActiveProject('D:/fixture/repo');composerWorktree=null;composerWorktreeEnabled=false;
      window.worktreeCalls=[];Data.projectWorktree=async p=>{window.worktreeCalls.push(p);return {ok:false,error:'dirty worktree'}};void 0`);
    await click('#composer-worktree');
    check(await wc.executeJavaScript("document.getElementById('composer-worktree').getAttribute('aria-checked')==='true'"),'worktree checkbox must select immediately');
    check(await wc.executeJavaScript('window.worktreeCalls.length===0'),'worktree selection must defer git work until submission');
    await click('#composer-worktree');
    check(await wc.executeJavaScript("document.getElementById('composer-worktree').getAttribute('aria-checked')==='false'"),'worktree must uncheck immediately');
    win.setContentSize(720,480);
    await wait(100);
    for(const [button,menu] of [['composer-effort','composer-effort-menu'],['composer-permission','composer-permission-menu'],['composer-add','composer-attach-menu'],['account-footer','account-menu']]) {
      await click('#'+button);
      const r=await measure(menu);
      check(r && !r.hidden && r.y>=36 && r.bottom<=472 && r.x>=8 && r.right<=712,`${menu} must fit the small window below its title bar`);
    }
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await wc.executeJavaScript("composerEffort='max';openEffortMenu()");
    const quiet=await wc.executeJavaScript('window.effortDraws');
    await wait(200);
    check(quiet===await wc.executeJavaScript('window.effortDraws'),'reduced motion must not schedule particle drawing');
    wc.debugger.detach();
    fs.writeFileSync(path.join(out,'witness.json'),JSON.stringify({measurements,failures},null,2));
    console.log(JSON.stringify({measurements,failures}));
    app.exit(failures.length?1:0);
  } catch(error) { console.error(error); app.exit(1); }
});
