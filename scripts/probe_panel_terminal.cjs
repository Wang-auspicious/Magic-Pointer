'use strict';
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve('data/runtime/panel-terminal');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 30000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      offscreen: true,
      sandbox: false,
      contextIsolation: true,
      preload: path.resolve('scripts/probe_studio_layout_preload.js'),
      additionalArguments: ['--mp-probe-state=landing'],
    },
  });
  try {
    await win.loadFile(path.resolve('build/electron/renderer/studio.html'));
    const result = await win.webContents.executeJavaScript(`(async()=>{
      show('chat');setStudioHomeVisible(false);applyStudioLanguage('en');closeStudioPopovers();
      let stopCalls=0;stopActiveConversation=async()=>{stopCalls++;};
      const cases=[];
      const check=(ok,message)=>{if(!ok)throw new Error(message);};
      const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
      const escape=()=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      const run=async(name,test)=>{
        setInspector(false);setBottomPanel(false);closeStudioPopovers();
        studioComposerBusy=true;pendingConversation={requestId:'panel-task',body:document.createElement('div')};
        stopCalls=0;
        try{await test();cases.push({name,ok:true});}catch(error){cases.push({name,ok:false,error:error.message});}
      };
      await run('Escape in the inspector closes its own panel before the running task',async()=>{
        setInspector(true,'files');document.getElementById('inspector-close').focus();escape();await frame();
        check(!inspectorState.open && stopCalls===0,'Escape stops the task and leaves the inspector open');
      });
      await run('Escape in the bottom terminal closes its panel without stopping the running task',async()=>{
        setBottomPanel(true);await frame();escape();await frame();
        check(document.getElementById('bottom-panel').hidden && stopCalls===0,'Escape stops the task and leaves the bottom terminal open');
      });
      await run('Inspector Close returns keyboard focus to its opening control',async()=>{
        const origin=document.getElementById('thread-more');origin.focus();setInspector(true,'files');
        const close=document.getElementById('inspector-close');close.focus();close.click();await frame();
        check(document.activeElement===origin,'Inspector Close leaves focus inside the hidden panel');
      });
      await run('Bottom terminal Close returns keyboard focus to its opening control',async()=>{
        const origin=document.getElementById('thread-more');origin.focus();setBottomPanel(true);await frame();
        const close=document.getElementById('bottom-panel-close');close.focus();close.click();await frame();
        check(document.activeElement===origin,'Bottom terminal Close loses its opening focus');
      });
      for(const failure of ['start','write','rejection'])await run('Terminal '+failure+' failure retains the original command for retry',async()=>{
        activeProjectRoot='D:/Desktop/Magic Pointer';let writes=0;const message='controlled '+failure;
        Data.startProjectTerminal=async()=>{if(failure==='rejection')throw new Error(message);return failure==='start'?{ok:false,error:message}:{ok:true};};
        Data.writeProjectTerminal=async()=>{writes++;return {ok:false,error:message};};
        setBottomPanel(true);await frame();const input=document.getElementById('bottom-terminal-input');input.value='  Get-ChildItem  ';
        document.getElementById('bottom-terminal-form').requestSubmit();await frame();await frame();
        check(input.value==='  Get-ChildItem  ','failed terminal submission consumed the command');
        check(document.getElementById('bottom-terminal-output').textContent.includes(message),'terminal failure is not visible');
        check(writes===(failure==='write'?1:0),'failed start still wrote a command');
      });
      await run('Submitting without a project retains the command and explains the missing project',async()=>{
        activeProjectRoot='';let starts=0;Data.startProjectTerminal=async()=>{starts++;return {ok:true};};
        setBottomPanel(true);await frame();const input=document.getElementById('bottom-terminal-input');input.value='Get-Location';
        document.getElementById('bottom-terminal-form').requestSubmit();await frame();await frame();
        check(input.value==='Get-Location' && starts===0,'project-less submission lost the command or started a terminal');
        check(document.getElementById('bottom-terminal-output').textContent.includes('Open a project first.'),'missing project has no visible explanation');
      });
      await run('Holding Escape after panel dismissal does not interrupt the task, while a new Escape can stop it',async()=>{
        const origin=document.querySelector('#composer-form textarea');origin.focus();setInspector(true,'files');document.getElementById('inspector-close').focus();escape();await frame();
        origin.focus();origin.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',repeat:true,bubbles:true,cancelable:true}));
        check(stopCalls===0,'repeated Escape interrupts after closing the panel');
        escape();check(stopCalls===1,'a deliberate Escape in the chat no longer stops the task');
      });
      await run('Composition and already-consumed Escape events do not stop the task',async()=>{
        const input=document.querySelector('#composer-form textarea');input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true,cancelable:true}));
        const composingStops=stopCalls;
        const consumed=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});consumed.preventDefault();input.dispatchEvent(consumed);
        check(composingStops===0 && stopCalls===0,'composition or a consumed keyboard event still interrupts');
      });
      await run('A bottom-terminal command keeps the current file inspector visible',async()=>{
        activeProjectRoot='D:/Desktop/Magic Pointer';Data.startProjectTerminal=async()=>({ok:true});Data.writeProjectTerminal=async()=>({ok:true});
        setInspector(true,'files');setBottomPanel(true);await frame();
        const input=document.getElementById('bottom-terminal-input');input.value='Get-Date';document.getElementById('bottom-terminal-form').requestSubmit();await frame();await frame();
        check(inspectorState.open && inspectorState.tab==='files' && !document.getElementById('bottom-panel').hidden,'bottom terminal command replaces the file inspector with a second terminal');
        check(input.value==='','accepted terminal command did not clear');
      });
      await run('Pending terminal submission is single and its acceptance retains a newer command draft',async()=>{
        activeProjectRoot='D:/Desktop/Magic Pointer';let finish;let starts=0;const writes=[];
        const pending=new Promise(resolve=>{finish=resolve;});Data.startProjectTerminal=async()=>{starts++;return pending;};Data.writeProjectTerminal=async command=>{writes.push(command);return {ok:true};};
        setBottomPanel(true);await frame();const form=document.getElementById('bottom-terminal-form');const input=document.getElementById('bottom-terminal-input');const button=form.querySelector('button[type="submit"]');
        input.value='Get-Date';form.requestSubmit();await frame();
        check(input.value==='Get-Date' && button.disabled && form.getAttribute('aria-busy')==='true','pending submission has no accurate busy receipt');
        form.requestSubmit();check(starts===1,'the pending command was submitted twice');
        input.value='Get-Location';finish({ok:true});await frame();await frame();
        check(input.value==='Get-Location' && !button.disabled && !form.hasAttribute('aria-busy') && writes.length===1 && writes[0]==='Get-Date','old acceptance clears or dispatches the new draft');
        form.requestSubmit();await frame();await frame();
        check(input.value==='' && writes.length===2 && writes[1]==='Get-Location','an untouched accepted command is not cleared');
      });
      await run('Project terminal submission still registers its own terminal resource',async()=>{
        activeProjectRoot='D:/Desktop/Magic Pointer';Data.startProjectTerminal=async()=>({ok:true});Data.writeProjectTerminal=async()=>({ok:true});
        setInspector(true,'terminal');const input=document.getElementById('project-terminal-input');input.value='Get-Date';document.getElementById('project-terminal-form').requestSubmit();await frame();await frame();
        check(input.value==='' && workspaceResourceTabs.some(tab=>tab.kind==='terminal' && tab.active),'project terminal submission lost its resource binding');
      });
      await run('A late terminal acceptance cannot clear the same text in another task',async()=>{
        activeProjectRoot='D:/Desktop/Magic Pointer';activeConversationId='terminal-owner';let finish;
        Data.startProjectTerminal=()=>new Promise(resolve=>{finish=resolve;});Data.writeProjectTerminal=async()=>({ok:true});Data.stopProjectTerminal=async()=>({ok:true});
        Data.conversation=async id=>({id,title:'Terminal task',workspaceRoot:'D:/Desktop/Magic Pointer',turns:[]});
        setBottomPanel(true);await frame();const input=document.getElementById('bottom-terminal-input');input.value='Get-Date';document.getElementById('bottom-terminal-form').requestSubmit();await frame();
        await openConversation('terminal-next-owner');input.value='Get-Date';finish({ok:true});await frame();await frame();
        check(activeConversationId==='terminal-next-owner' && input.value==='Get-Date','old terminal acknowledgement clears another task draft');
      });
      return {ok:cases.every(item=>item.ok),usedBackend:'production Studio DOM keyboard routing; controlled stop and terminal APIs, no worker/model/terminal process or external effect',cases};
    })()`);
    const focusedWindow = new BrowserWindow({
      width: 1100,
      height: 820,
      show: true,
      webPreferences: {
        sandbox: false,
        contextIsolation: true,
        preload: path.resolve('scripts/probe_studio_layout_preload.js'),
        additionalArguments: ['--mp-probe-state=landing'],
      },
    });
    try {
      await focusedWindow.loadFile(
        path.resolve('build/electron/renderer/studio.html'),
      );
      focusedWindow.focus();
      await focusedWindow.webContents
        .executeJavaScript(`show('chat');setStudioHomeVisible(false);closeStudioPopovers();window.__panelStops=0;window.__panelKeys=[];
        stopActiveConversation=async()=>{window.__panelStops++;};studioComposerBusy=true;pendingConversation={requestId:'native-panel',body:document.createElement('div')};
        window.addEventListener('keydown',event=>{if(event.key==='Escape')window.__panelKeys.push({repeat:event.repeat,trusted:event.isTrusted});},true);
        window.__panelOrigin=document.querySelector('#composer-form textarea');__panelOrigin.focus();setInspector(true,'files');document.getElementById('inspector-close').focus();`);
      const press = async (modifiers = []) => {
        focusedWindow.webContents.sendInputEvent({
          type: 'keyDown',
          keyCode: 'ESCAPE',
          modifiers,
        });
        focusedWindow.webContents.sendInputEvent({
          type: 'keyUp',
          keyCode: 'ESCAPE',
          modifiers,
        });
        await focusedWindow.webContents.executeJavaScript(
          'new Promise(resolve=>requestAnimationFrame(resolve))',
        );
      };
      await press();
      await press(['isautorepeat']);
      const inspector = await focusedWindow.webContents
        .executeJavaScript(`({closed:!inspectorState.open,focused:document.activeElement===__panelOrigin,
        documentFocus:document.hasFocus(),focusVisible:document.activeElement.matches(':focus-visible'),stops:__panelStops,keys:__panelKeys})`);
      await press();
      const deliberate =
        await focusedWindow.webContents.executeJavaScript('__panelStops');
      result.cases.push({
        name: 'Native Escape and repeated Escape close the inspector, return visible focus and retain a deliberate chat stop',
        ok:
          inspector.closed &&
          inspector.focused &&
          inspector.documentFocus &&
          inspector.focusVisible &&
          inspector.stops === 0 &&
          deliberate === 1 &&
          inspector.keys.some(key => key.repeat && key.trusted),
        details: inspector,
      });
      await focusedWindow.webContents
        .executeJavaScript(`window.__panelStops=0;window.__panelOrigin=document.getElementById('thread-more');__panelOrigin.focus();setBottomPanel(true);
        new Promise(resolve=>requestAnimationFrame(resolve));`);
      await press();
      const bottom = await focusedWindow.webContents
        .executeJavaScript(`({closed:document.getElementById('bottom-panel').hidden,focused:document.activeElement===__panelOrigin,
        documentFocus:document.hasFocus(),stops:__panelStops})`);
      result.cases.push({
        name: 'Native Escape dismisses the bottom terminal and restores its visible opening control',
        ok:
          bottom.closed &&
          bottom.focused &&
          bottom.documentFocus &&
          bottom.stops === 0,
        details: bottom,
      });
      result.ok = result.cases.every(item => item.ok);
    } finally {
      focusedWindow.destroy();
    }
    fs.writeFileSync(
      path.join(output, 'renderer-result.json'),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
    clearTimeout(deadline);
    win.destroy();
    app.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    win.destroy();
    app.exit(1);
  }
});
