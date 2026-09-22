'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'data/runtime/composer-menus-20260919/actual');
fs.mkdirSync(out, { recursive: true });
app.setName('magic-pointer');
app.setPath('userData', path.join(process.env.APPDATA, 'magic-pointer'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const mainPath = path.join(root, 'build/electron/main.js');
const production = new Module(mainPath, module);
production.filename = mainPath;
production.paths = Module._nodeModulePaths(path.dirname(mainPath));
production._compile(fs.readFileSync(mainPath, 'utf8') + `
module.exports.openComposerAcceptance = () => { onboardingWindow?.hide(); showDashboard({view:'chat'}, {activate:true}); };
`, mainPath);
app.whenReady().then(async () => {
  production.exports.openComposerAcceptance();
  let win;
  for(let i=0;i<160;i++) {
    win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/studio.html'));
    if(win && await win.webContents.executeJavaScript("typeof openAttachMenu==='function'").catch(()=>false)) break;
    await wait(125);
  }
  assert(win,'real development Studio must open');
  const wc=win.webContents;
  let saved;
  const witness={};
  try {
    await wc.executeJavaScript('document.fonts.ready.then(()=>true)');
    await wc.executeJavaScript('refreshComposerModel()');
    saved=await wc.executeJavaScript(`({effort:composerEffort,enabled:composerWorktreeEnabled,worktree:composerWorktree,root:activeProjectRoot,
      storage:Object.fromEntries(['mp:composer-effort','mp:composer-worktree','mp:composer-worktree-enabled','mp:active-project-root'].map(k=>[k,localStorage.getItem(k)]))})`);
    await wc.executeJavaScript('closeStudioPopovers();setStudioHomeVisible(true)');
    win.show(); win.focus();
    const capture=async(id,file)=>{
      const result=await wc.executeJavaScript(`(() => {const n=document.getElementById(${JSON.stringify(id)}),r=n.getBoundingClientRect();return {width:r.width,height:r.height,x:r.x,y:r.y,right:r.right,bottom:r.bottom,hidden:n.hidden,text:n.innerText}})()`);
      assert(!result.hidden && result.y>=36 && result.bottom<=win.getContentBounds().height-8, `${id} clipped`);
      fs.writeFileSync(path.join(out,file),(await wc.capturePage()).toPNG());
      return result;
    };
    await wc.executeJavaScript("composerEffort='max';renderEffortChip();openEffortMenu()");
    await wait(1100);
    witness.effort=await capture('composer-effort-menu','effort.png');
    assert.equal(witness.effort.width,220);
    assert.equal(witness.effort.height,111);
    await wc.executeJavaScript('openPermissionMenu()');
    witness.mode=await capture('composer-permission-menu','mode.png');
    await wc.executeJavaScript('openAttachMenu()');
    witness.add=await capture('composer-attach-menu','add.png');
    assert(witness.add.text.includes('Add files or photos') && witness.add.text.includes('Slash commands'));
    await wc.executeJavaScript('openAccountMenu()');
    witness.account=await capture('account-menu','account.png');
    assert.equal(witness.account.width,272);
    const testRoot = saved.root || await wc.executeJavaScript("Data.projects().then(projects=>projects[0]?.root||'')");
    if(testRoot) {
      await wc.executeJavaScript(`setActiveProject(${JSON.stringify(testRoot)})`);
      witness.worktree=await wc.executeJavaScript(`(() => {
        closeStudioPopovers();const button=document.getElementById('composer-worktree');
        const initial=button.getAttribute('aria-checked'),start=performance.now();button.click();
        const selected=button.getAttribute('aria-checked');button.click();
        return {initial,selected,restored:button.getAttribute('aria-checked'),elapsedMs:performance.now()-start,disabled:button.disabled};
      })()`);
      assert.notEqual(witness.worktree.selected,witness.worktree.initial);
      assert.equal(witness.worktree.restored,witness.worktree.initial);
      assert.equal(witness.worktree.disabled,false);
      assert(witness.worktree.elapsedMs<100,'worktree selection must not wait on Git');
    }
    fs.writeFileSync(path.join(out,'witness.json'),JSON.stringify(witness,null,2));
    console.log(JSON.stringify(witness));
  } finally {
    if(saved) await wc.executeJavaScript(`(() => {
      const saved=${JSON.stringify(saved)};closeStudioPopovers();composerEffort=saved.effort;
      composerWorktreeEnabled=saved.enabled;composerWorktree=saved.worktree;setActiveProject(saved.root);
      for(const [key,value] of Object.entries(saved.storage)){if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}
      renderEffortChip();renderComposerWorktree();openEffortMenu();
    })()`);
  }
  fs.writeFileSync(path.join(out,'delivered.png'),(await wc.capturePage()).toPNG());
  fs.writeFileSync(path.join(out,'result.txt'),'PASS — actual development renderer and saved settings; preferences restored.');
  if(!process.argv.includes('--keep-open')) app.exit(0);
}).catch(error=>{ console.error(error);fs.writeFileSync(path.join(out,'result.txt'),String(error));app.exit(1); });
