'use strict';
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const output = path.resolve('data/runtime/decision-sync');
const useSource = process.env.MP_PROBE_USE_SOURCE === '1';
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 20000);
app.whenReady().then(async () => {
  const windows = [];
  try {
    const fixture = path.join(output, 'fixture.html');
    fs.writeFileSync(
      fixture,
      '<!doctype html><html><head><meta charset="utf-8"></head><body><button id="outside">Outside</button><div id="host"></div></body></html>',
    );
    for (let i = 0; i < 2; i++) {
      const win = new BrowserWindow({
        show: false,
        webPreferences: {offscreen: true, sandbox: true},
      });
      windows.push(win);
      await win.loadFile(fixture);
      for (const name of ['locale', 'decision_card']) {
        const script = useSource
          ? ts.transpileModule(
              fs.readFileSync(`electron/renderer/${name}.ts`, 'utf8'),
              {
                compilerOptions: {
                  target: ts.ScriptTarget.ES2022,
                  module: ts.ModuleKind.None,
                },
              },
            ).outputText
          : fs.readFileSync(`build/electron/renderer/${name}.js`, 'utf8');
        await win.webContents.executeJavaScript(script);
      }
      await win.webContents.executeJavaScript("applyStudioLanguage('en')");
    }
    const [first, second] = windows;
    const cases = [];
    const observed = second.webContents
      .executeJavaScript(`new Promise(resolve => {
      window.addEventListener('storage', event => {if(event.key==='mp:language:v1')resolve(true);}, {once:true});
      setTimeout(() => resolve(false), 1000);
    })`);
    await first.webContents.executeJavaScript("applyStudioLanguage('zh-CN')");
    const eventReceived = await observed;
    const language = await second.webContents.executeJavaScript(
      `({saved:localStorage.getItem('mp:language:v1'),current:getStudioLanguage(),documentLanguage:document.documentElement.lang})`,
    );
    cases.push({
      name: 'An already-open renderer follows the saved language event',
      ok:
        eventReceived &&
        language.saved === 'zh-CN' &&
        language.current === 'zh-CN' &&
        language.documentLanguage === 'zh-CN',
      details: language,
    });
    await first.webContents.executeJavaScript("applyStudioLanguage('en')");
    await second.webContents.executeJavaScript(`applyStudioLanguage('en');
      DecisionCard.render(document.getElementById('host'),{key:'live-card',presentation:'inline',questions:[{question:'Original question',options:[{label:'Original option'}]}]},()=>{});
      document.querySelector('.mp-decision-other-choice').click();
      const answer=document.querySelector('textarea');answer.value='Edited answer';answer.dispatchEvent(new Event('input',{bubbles:true}));answer.setSelectionRange(2,7,'backward');`);
    const updated = second.webContents
      .executeJavaScript(`new Promise(resolve => {
      window.addEventListener('storage', event => {if(event.key==='mp:language:v1')requestAnimationFrame(()=>resolve(true));},{once:true});setTimeout(()=>resolve(false),1000);
    })`);
    await first.webContents.executeJavaScript("applyStudioLanguage('zh-CN')");
    await updated;
    const card = await second.webContents.executeJavaScript(`({
      label:document.querySelector('[data-question-submit]').textContent,
      answer:document.querySelector('textarea').value,
      focused:document.activeElement===document.querySelector('textarea'),
      start:document.querySelector('textarea').selectionStart,end:document.querySelector('textarea').selectionEnd,
      direction:document.querySelector('textarea').selectionDirection
    })`);
    cases.push({
      name: 'Mounted card follows the other window without reopening or losing its answer selection',
      ok:
        card.label === '提交' &&
        card.answer === 'Edited answer' &&
        card.focused &&
        card.start === 2 &&
        card.end === 7 &&
        card.direction === 'backward',
      details: card,
    });
    const history = await second.webContents.executeJavaScript(`(() => {
      const host=document.getElementById('host');
      const request={key:'history-focus',kind:'permission',tool:'DailyWrap.read',action:{tool:'DailyWrap.read',arguments:{from_ms:1789228800000,to_ms:1789315200000}}};
      DecisionCard.render(host,request,()=>{});
      const from=host.querySelector('[data-dailywrap-from]');from.focus();from.value='2026-09-12T14:30';from.dispatchEvent(new Event('input',{bubbles:true}));
      DecisionCard.render(host,{...request,historySources:[{id:'one',title:'Saved task'}]},()=>{});
      return {focused:document.activeElement.hasAttribute('data-dailywrap-from'),value:host.querySelector('[data-dailywrap-from]').value};
    })()`);
    cases.push({
      name: 'Loaded saved-task sources preserve the edited time and its focus',
      ok: history.focused && history.value === '2026-09-12T14:30',
      details: history,
    });
    const validation = await second.webContents.executeJavaScript(`(() => {
      applyStudioLanguage('en');const host=document.getElementById('host');
      DecisionCard.render(host,{key:'validation-clear',presentation:'inline',questions:[
        {question:'First?',options:[{label:'One'}]},{question:'Second?',options:[{label:'Two'}]}
      ]},()=>{});
      host.querySelector('[aria-label="Next question"]').click();host.querySelector('[data-option-index="0"]').click();host.querySelector('[data-question-submit]').click();
      const before=!!host.querySelector('[role="alert"]');
      host.querySelector('.mp-decision-other-choice').click();const input=host.querySelector('textarea');
      input.value='Now answered';input.dispatchEvent(new Event('input',{bubbles:true}));
      return {before,error:host.querySelector('[role="alert"]')?.textContent,focused:document.activeElement===input,value:input.value};
    })()`);
    cases.push({
      name: 'Typing a valid custom answer clears the obsolete missing-answer message in place',
      ok:
        validation.before &&
        !validation.error &&
        validation.focused &&
        validation.value === 'Now answered',
      details: validation,
    });
    const filtering = await second.webContents.executeJavaScript(`(() => {
      const host=document.getElementById('host');
      DecisionCard.render(host,{key:'source-filter',kind:'permission',tool:'DailyWrap.read',action:{tool:'DailyWrap.read',arguments:{from_ms:1789228800000,to_ms:1789315200000,conversation_ids:['one']}},historySources:[{id:'one',title:'Saved task'}]},()=>{});
      const search=host.querySelector('[type="search"]');search.value='no matching task';search.dispatchEvent(new Event('input',{bubbles:true}));
      const empty=[...host.querySelectorAll('[role="status"]')].some(node=>!node.hidden && node.textContent==='No saved tasks match this search.');
      const retained=host.querySelector('[data-dailywrap-source-id="one"]').checked;
      search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));
      return {empty,retained,restored:!host.querySelector('[data-dailywrap-source-id="one"]').closest('label').hidden};
    })()`);
    cases.push({
      name: 'A source search with no matches explains the empty list and retains its selection',
      ok: filtering.empty && filtering.retained && filtering.restored,
      details: filtering,
    });
    if (!useSource) {
      const studio = new BrowserWindow({
        width: 1240,
        height: 900,
        show: false,
        webPreferences: {
          offscreen: true,
          contextIsolation: true,
          sandbox: false,
          preload: path.resolve('scripts/probe_studio_layout_preload.js'),
          additionalArguments: ['--mp-probe-state=landing'],
        },
      });
      const stage = new BrowserWindow({
        width: 1280,
        height: 1000,
        show: false,
        webPreferences: {
          offscreen: true,
          contextIsolation: false,
          sandbox: false,
          preload: path.resolve('scripts/probe_stage_input_preload.cjs'),
        },
      });
      windows.push(studio, stage);
      await studio.loadFile(
        path.resolve('build/electron/renderer/studio.html'),
      );
      await stage.loadFile(path.resolve('build/electron/renderer/stage.html'));
      await studio.webContents.executeJavaScript("applyStudioLanguage('en')");
      await stage.webContents
        .executeJavaScript(`applyStudioLanguage('en');__stageProbe.show({selectionSessionToken:'language-task',groundingReady:true,target:{x:180,y:150,width:120,height:40},
        eventSequence:[{type:'FREEZE'},{type:'OPEN_CAPSULE',mode:'text'},{type:'SUBMIT',command:'Original task'},
          {type:'RESULT',result:{ok:true,awaitingUserInput:true,pendingInput:{requestId:'surface-ask',questions:[{question:'Original stage question',options:[{label:'Original choice'}]}]}}}]});
        const field=document.querySelector('#stage-decision textarea');field.focus();field.value='Stage draft';field.dispatchEvent(new Event('input',{bubbles:true}));field.setSelectionRange(2,6,'backward');`);
      const changed = stage.webContents.executeJavaScript(
        `new Promise(resolve=>{window.addEventListener('storage',event=>{if(event.key==='mp:language:v1')requestAnimationFrame(()=>resolve(true));},{once:true});setTimeout(()=>resolve(false),1000);})`,
      );
      await studio.webContents.executeJavaScript("setStudioLanguage('zh-CN')");
      const event = await changed;
      const surfaces = await stage.webContents
        .executeJavaScript(`({language:getStudioLanguage(),label:document.querySelector('#stage-decision [data-question-submit]').textContent,
        value:document.querySelector('#stage-decision textarea').value,start:document.querySelector('#stage-decision textarea').selectionStart,end:document.querySelector('#stage-decision textarea').selectionEnd,
        direction:document.querySelector('#stage-decision textarea').selectionDirection,focused:document.activeElement===document.querySelector('#stage-decision textarea'),calls:__stageProbe.calls.length})`);
      cases.push({
        name: 'Actual Studio language selection updates an already-open Stage and retains its original answer binding',
        ok:
          event &&
          surfaces.language === 'zh-CN' &&
          surfaces.label === '提交' &&
          surfaces.value === 'Stage draft' &&
          surfaces.start === 2 &&
          surfaces.end === 6 &&
          surfaces.direction === 'backward' &&
          surfaces.focused &&
          surfaces.calls === 0,
        details: surfaces,
      });
    }
    const result = {
      ok: cases.every(item => item.ok),
      usedBackend:
        'two actual Chromium windows with production locale and DecisionCard; isolated file profile, no IPC/model/external effect',
      sourceTranspiled: useSource,
      cases,
    };
    fs.writeFileSync(
      path.join(
        output,
        useSource ? 'source-result.json' : 'renderer-result.json',
      ),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
    clearTimeout(deadline);
    windows.forEach(win => win.destroy());
    app.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    windows.forEach(win => win.destroy());
    app.exit(1);
  }
});
