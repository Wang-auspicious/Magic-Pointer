'use strict';
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve('data/runtime/panel-language');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 30000);
const options = {
  width: 1200,
  height: 900,
  show: true,
  webPreferences: {
    sandbox: false,
    contextIsolation: true,
    preload: path.resolve('scripts/probe_studio_layout_preload.js'),
    additionalArguments: ['--mp-probe-state=landing'],
  },
};
app.whenReady().then(async () => {
  const win = new BrowserWindow(options);
  let second;
  try {
    await win.loadFile(path.resolve('build/electron/renderer/studio.html'));
    win.focus();
    const cases = [];
    const run = async (name, operation) => {
      try {
        await operation();
        cases.push({name, ok: true});
      } catch (error) {
        cases.push({name, ok: false, error: error.message});
      }
    };
    const evaluate = code => win.webContents.executeJavaScript(code);
    const press = async (keyCode, modifiers) => {
      win.webContents.sendInputEvent({type: 'keyDown', keyCode, modifiers});
      win.webContents.sendInputEvent({type: 'keyUp', keyCode, modifiers});
      await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    };
    await evaluate(`show('chat');setStudioHomeVisible(false);closeStudioPopovers();applyStudioLanguage('en');
      window.__panelKeys=[];window.addEventListener('keydown',event=>__panelKeys.push({key:event.key,trusted:event.isTrusted}),true);
      window.__panelOrigin=document.querySelector('#composer-form textarea');__panelOrigin.focus();`);
    await run(
      'Native Ctrl+J restores the composer after closing its terminal',
      async () => {
        await press('J', ['control']);
        await evaluate(
          `if(document.activeElement.id!=='bottom-terminal-input')throw new Error('Shortcut did not enter the terminal');`,
        );
        await press('J', ['control']);
        await evaluate(
          `if(!document.getElementById('bottom-panel').hidden || document.activeElement!==__panelOrigin || !document.hasFocus() || !__panelOrigin.matches(':focus-visible'))throw new Error('Shortcut close lost visible opening focus');`,
        );
      },
    );
    await run(
      'Native Ctrl+Shift+B restores the composer after closing the inspector',
      async () => {
        await evaluate(
          `__panelOrigin.focus();setInspector(true,'files');document.getElementById('file-tree-filter').focus();`,
        );
        await press('B', ['control', 'shift']);
        await evaluate(
          `if(inspectorState.open || document.activeElement!==__panelOrigin || !document.hasFocus())throw new Error('Inspector shortcut close lost its opening focus');`,
        );
      },
    );
    await run(
      'Terminal labels follow Chinese and preserve command selection and output',
      async () => {
        await evaluate(`(async()=>{setBottomPanel(true);await new Promise(resolve=>requestAnimationFrame(resolve));
        activeTerminalRelativeDirectory='src/中文';renderTerminalPrompt();appendTerminalOutput(String.fromCharCode(10)+'MP_OUTPUT_UNCHANGED');
        const input=document.getElementById('bottom-terminal-input');input.value='Get-Location';input.focus();input.setSelectionRange(2,7,'backward');
        const log=document.querySelector('#bottom-terminal-output .mp-terminal-log');const text=log.textContent;applyStudioLanguage('zh-CN');
        if(document.getElementById('bottom-panel-close').getAttribute('aria-label')!=='关闭底部面板' || input.getAttribute('aria-label')!=='终端命令' || document.querySelector('#bottom-terminal-form button').textContent!=='运行' || document.querySelector('[data-terminal-stop]').textContent!=='停止终端')throw new Error('Terminal controls remain in English');
        if(!document.querySelector('#bottom-terminal-output .mp-terminal-label').textContent.includes('当前项目'+String.fromCharCode(92)+'src'+String.fromCharCode(92)+'中文'))throw new Error('Terminal directory label remains in English');
        if(log.textContent!==text || document.activeElement!==input || input.value!=='Get-Location' || input.selectionStart!==2 || input.selectionEnd!==7 || input.selectionDirection!=='backward')throw new Error('Language refresh changed terminal content or selection');
      })()`);
      },
    );
    await run(
      'Browser controls translate without replacing the edited address or navigation state',
      async () => {
        await evaluate(`(async()=>{applyStudioLanguage('en');setInspector(true,'browser');await new Promise(resolve=>requestAnimationFrame(resolve));
        renderBrowserViewState({url:'https://example.test/current',title:'Unchanged page title',loading:true,canGoBack:true,canGoForward:false});
        const input=document.getElementById('project-browser-url');input.value='localhost:3000/中文';input.focus();input.setSelectionRange(2,8,'backward');applyStudioLanguage('zh-CN');
        if(input.getAttribute('aria-label')!=='浏览器地址' || !input.placeholder.includes('localhost') || document.getElementById('project-browser-back').title!=='后退' || document.getElementById('project-browser-reload').title!=='停止加载' || document.getElementById('project-browser-external').title!=='在网页浏览器中打开')throw new Error('Browser toolbar remains in English or lost its loading action');
        if(input.value!=='localhost:3000/中文' || document.activeElement!==input || input.selectionStart!==2 || input.selectionEnd!==8 || input.selectionDirection!=='backward' || document.getElementById('project-browser-back').disabled || !document.getElementById('project-browser-forward').disabled || document.getElementById('inspector-browser').getAttribute('aria-label')!=='Unchanged page title')throw new Error('Browser language refresh changed page state or address selection');
      })()`);
      },
    );
    for (const accepted of [true, false]) {
      await run(
        `Pending terminal ${accepted ? 'acceptance' : 'failure'} uses the current language`,
        async () => {
          await evaluate(`(async()=>{setInspector(false);applyStudioLanguage('en');setBottomPanel(true);await new Promise(resolve=>requestAnimationFrame(resolve));activeProjectRoot='D:/Desktop/Magic Pointer';
          let finish;Data.startProjectTerminal=()=>new Promise(resolve=>{finish=resolve;});Data.writeProjectTerminal=async()=>({ok:true});
          const form=document.getElementById('bottom-terminal-form');const input=document.getElementById('bottom-terminal-input');const button=form.querySelector('button');input.value='Get-Location';form.requestSubmit();
          applyStudioLanguage('zh-CN');const pendingOk=button.textContent==='正在提交…' && button.disabled && form.hasAttribute('aria-busy');
          finish({ok:${accepted},error:'Controlled terminal start failure'});await new Promise(resolve=>requestAnimationFrame(resolve));
          if(!pendingOk || button.textContent!=='运行' || button.disabled || form.hasAttribute('aria-busy'))throw new Error('Pending or settled receipt retained the old language or lost busy state');
          if(input.value!==(${accepted}?'':'Get-Location'))throw new Error('Receipt changed command acceptance semantics');
        })()`);
        },
      );
    }
    await run(
      'Browser empty and pending messages translate without erasing a concrete failure',
      async () => {
        await evaluate(`(async()=>{setInspector(true,'browser');applyStudioLanguage('en');
        const message=document.querySelector('#project-browser-empty p');
        let finish;Data.openBrowserView=()=>new Promise(resolve=>{finish=resolve;});Data.browserViewCommand=async()=>({ok:true});
        const opening=openProjectBrowser('https://example.test/controlled');await new Promise(resolve=>requestAnimationFrame(resolve));applyStudioLanguage('zh-CN');
        const translated=message.textContent==='正在 ego lite 中打开…';finish({ok:false,error:'Controlled original failure'});await opening;applyStudioLanguage('en');
        if(!translated || message.textContent!=='Controlled original failure')throw new Error('Browser opening message did not translate or its original failure was overwritten');
        Data.openBrowserView=async()=>({ok:true});await openProjectBrowser('https://example.test/controlled');
        if(message.textContent!=='Opened in ego lite. Continue in its native browser window.')throw new Error('Successful browser message lost its English state');
        applyStudioLanguage('zh-CN');
        if(message.textContent!=='已在 ego lite 中打开，请在浏览器原生窗口中继续。')throw new Error('Completed browser message did not translate');
      })()`);
      },
    );
    await run(
      'Account language menu updates an open terminal and retains its draft',
      async () => {
        await evaluate(`(async()=>{applyStudioLanguage('en');setInspector(false);setBottomPanel(true);await new Promise(resolve=>requestAnimationFrame(resolve));
        const input=document.getElementById('bottom-terminal-input');input.value='Write-Output retained';input.setSelectionRange(2,8,'backward');
        document.getElementById('account-footer').click();document.querySelector('[data-account-command=language]').click();
        const chinese=[...document.querySelectorAll('#account-submenu button')].find(button=>button.textContent.includes('中文'));if(!chinese)throw new Error('Language submenu did not open');chinese.click();
        await new Promise(resolve=>requestAnimationFrame(resolve));
        if(getStudioLanguage()!=='zh-CN' || document.querySelector('#bottom-terminal-form button').textContent!=='运行' || input.value!=='Write-Output retained' || input.selectionStart!==2 || input.selectionEnd!==8 || input.selectionDirection!=='backward' || document.getElementById('bottom-panel').hidden)throw new Error('Actual language menu changed the terminal draft or left stale controls');
      })()`);
      },
    );
    await run(
      'New Studio window reads the saved language before opening either panel',
      async () => {
        second = new BrowserWindow({...options, show: false});
        await second.loadFile(
          path.resolve('build/electron/renderer/studio.html'),
        );
        await second.webContents.executeJavaScript(
          `if(getStudioLanguage()!=='zh-CN' || document.querySelector('#bottom-terminal-form button').textContent!=='运行' || document.getElementById('project-browser-url').getAttribute('aria-label')!=='浏览器地址' || !document.querySelector('#project-browser-empty p').textContent.includes('本地文档'))throw new Error('Initially saved Chinese was not applied to panel controls');`,
        );
      },
    );
    const keys = await evaluate('__panelKeys');
    const result = {
      ok: cases.every(item => item.ok),
      usedBackend:
        'compiled production Studio, actual focused Chromium shortcut events, account language menu and saved renderer locale; controlled terminal/browser receipts, no shell/model or network',
      cases,
      keys,
    };
    fs.writeFileSync(
      path.join(output, 'renderer-result.json'),
      JSON.stringify(result, null, 2),
    );
    await evaluate(
      `setBottomPanel(false);setInspector(true,'browser');applyTheme('light');new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
    );
    await evaluate(
      `Promise.all(document.getAnimations().filter(animation=>animation instanceof CSSTransition).map(animation=>animation.finished.catch(()=>{})))`,
    );
    fs.writeFileSync(
      path.join(output, 'browser-zh-light.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    await evaluate(
      `applyStudioLanguage('zh-CN');setInspector(false);setBottomPanel(true);applyTheme('light');new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
    );
    await evaluate(
      `Promise.all(document.getAnimations().filter(animation=>animation instanceof CSSTransition).map(animation=>animation.finished.catch(()=>{})))`,
    );
    fs.writeFileSync(
      path.join(output, 'terminal-zh-light.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    win.setContentSize(860, 900);
    await evaluate(
      `applyTheme('dark');new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
    );
    await evaluate(
      `Promise.all(document.getAnimations().filter(animation=>animation instanceof CSSTransition).map(animation=>animation.finished.catch(()=>{})))`,
    );
    fs.writeFileSync(
      path.join(output, 'terminal-zh-dark-narrow.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    console.log(JSON.stringify(result));
    clearTimeout(deadline);
    second?.destroy();
    win.destroy();
    app.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    second?.destroy();
    win.destroy();
    app.exit(1);
  }
});
