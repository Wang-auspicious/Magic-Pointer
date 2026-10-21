'use strict';
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve('data/runtime/task-lifecycle');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 60000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1240,
    height: 900,
    show: false,
    webPreferences: {
      offscreen: true,
      sandbox: false,
      contextIsolation: true,
      preload: path.resolve('scripts/probe_studio_layout_preload.js'),
      additionalArguments: [
        '--mp-probe-theme=light',
        '--mp-probe-state=landing',
      ],
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  try {
    await win.loadFile(path.resolve('build/electron/renderer/studio.html'));
    const exercising = win.webContents.executeJavaScript(`(async()=>{
   const check=(ok,message)=>{if(!ok)throw new Error(message);};
   const wait=()=>new Promise(resolve=>setTimeout(resolve,40));
   const original={id:'delete-lifecycle',title:'Retain my task',agentSessionId:'agent-delete-fixture',turns:[{question:'Read the notes',answer:'A retained answer',outcome:'已完成'}]};
   const other={...structuredClone(original),id:'other-task',title:'Other task'};
   let rows=[original,other];
   Data.conversation=async id=>structuredClone(rows.find(row=>row.id===id)||null);
   Data.conversations=async()=>structuredClone(rows);
   Data.recovery=async()=>({ok:true,pendingRecovery:[]});
   Data.subagents=async()=>({ok:true,tasks:[]});
   await openConversation(original.id);
   const textarea=document.querySelector('#composer-form textarea');
   textarea.value='Unsent thought';textarea.dispatchEvent(new Event('input',{bubbles:true}));
   let settle;
   let deleteCalls=0;
   Data.deleteConversation=()=>{deleteCalls++;return new Promise(resolve=>{settle=resolve;});};
   document.getElementById('thread-more').click();
   [...document.querySelectorAll('#thread-menu button')].find(button=>button.textContent.trim().startsWith('Delete')).click();
   await wait();
   check(activeConversationId===original.id,'delete navigated away before the result');
   check(textarea.value==='Unsent thought','pending deletion lost the draft');
   document.getElementById('thread-more').click();
   [...document.querySelectorAll('#thread-menu button')].find(button=>button.textContent.trim().startsWith('Delete')).click();
   await wait();check(deleteCalls===1,'pending delete was submitted twice');
   settle({ok:false,error:'Stop this task before deleting it.'});await wait();
   check(activeConversationId===original.id,'failed deletion removed the current task');
   check(textarea.value==='Unsent thought','failed deletion lost the draft');
   check(document.body.textContent.includes('Stop this task before deleting it.'),'failed deletion is invisible');
   await new Promise(resolve=>{window.finishLifecycleScreenshot=resolve;});
   document.querySelector('#conversation-delete-error .close').click();
   check(!document.getElementById('conversation-delete-error'),'delete error cannot be dismissed');
   document.getElementById('thread-more').click();
   [...document.querySelectorAll('#thread-menu button')].find(button=>button.textContent.trim().startsWith('Delete')).click();
   await wait();
   await openConversation(other.id);
   rows=rows.filter(row=>row.id!==original.id);
   settle({ok:true});await wait();
   check(activeConversationId===other.id,'late deletion result navigated away from another task');
   let pendingA,pendingB;
   const refreshCalls=[];
   Data.subagents=({conversationId})=>{refreshCalls.push(conversationId);return new Promise(resolve=>{if(conversationId==='refresh-a')pendingA=resolve;else pendingB=resolve;});};
   const a=refreshBackgroundAgentTasks('refresh-a');
   const b=refreshBackgroundAgentTasks('refresh-b');
   const again=refreshBackgroundAgentTasks('refresh-a');
   check(refreshCalls.join(',')==='refresh-a,refresh-b','switching tasks launched a duplicate snapshot request');
   pendingA({ok:true,tasks:[]});pendingB({ok:true,tasks:[]});
   await Promise.all([a,b,again]);
   return {retainedWhilePending:true,retainedAfterFailure:true,draftPreserved:true,errorVisible:true,deleteDeduplicated:true,lateResultPreservesNavigation:true,refreshDeduplicated:true};
  })()`);
    for (let attempt=0;attempt<100;attempt++) {
      if (await win.webContents.executeJavaScript('typeof window.finishLifecycleScreenshot === "function"')) {break;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    for (const theme of ['light','dark']) {
      await win.webContents.executeJavaScript(`document.documentElement.dataset.theme='${theme}';document.documentElement.classList.toggle('dark',${theme==='dark'});`);
      await new Promise(resolve=>setTimeout(resolve,120));
      fs.writeFileSync(path.join(output,`delete-error-${theme}.png`),(await win.webContents.capturePage()).toPNG());
    }
    await win.webContents.executeJavaScript('finishLifecycleScreenshot()');
    const witness = await exercising;
    const report = {
      ok: errors.length === 0,
      usedBackend:
        'production Studio in isolated Electron; controlled deletion response',
      ...witness,
      errors,
    };
    fs.writeFileSync(
      path.join(output, 'renderer-result.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.ok ? 0 : 1);
  } catch (error) {
    console.error(error, errors);
    app.exit(1);
  } finally {
    clearTimeout(deadline);
  }
});
