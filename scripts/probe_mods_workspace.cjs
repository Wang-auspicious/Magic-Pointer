const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {transformSync} = require('esbuild');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'data/runtime/mods-workspace-ui');
fs.mkdirSync(out, {recursive: true});
app.setPath('userData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const timeout = setTimeout(() => app.exit(2), 30000);
app.whenReady().then(async () => {
  const baseline = process.argv.includes('--baseline');
  const win = new BrowserWindow({
    width: 760,
    height: 820,
    useContentSize: true,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      offscreen: true,
      backgroundThrottling: false,
      preload: baseline
        ? path.join(root, 'scripts/probe_studio_layout_preload.js')
        : undefined,
    },
  });
  try {
    if (baseline) {
      await win.loadFile(
        path.join(root, 'build/electron/renderer/studio.html'),
      );
      const result = await win.webContents.executeJavaScript(
        "({title:document.title,modules:!!document.querySelector('[data-inspector-tab=modules]')})",
      );
      fs.writeFileSync(
        path.join(out, 'baseline.json'),
        JSON.stringify(result, null, 2),
      );
      assert(
        result.modules,
        'Studio has no registered module workspace surface',
      );
    } else {
      const code = transformSync(
        fs.readFileSync(
          path.join(root, 'electron/renderer/mods_workspace.ts'),
          'utf8',
        ),
        {loader: 'ts', format: 'iife'},
      ).code;
      const css = ['theme_tokens.css', 'mods_workspace.css']
        .map(file =>
          fs.readFileSync(path.join(root, 'electron/renderer', file), 'utf8'),
        )
        .join('\n');
      await win.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            `<html><head><style>${css}body{margin:0;background:var(--mp-panel);color:var(--mp-text);font-family:system-ui}#host{max-width:720px;margin:auto;padding:16px}</style></head><body><div id="host"></div></body></html>`,
          ),
      );
      await win.webContents.executeJavaScript(code);
      const checks = await win.webContents.executeJavaScript(`(async()=>{
        const checks=[]; const check=(value,message)=>{if(!value)throw Error(message);checks.push(message)};
        let language='en';let calls=0;let fail=false;let resolveAction;let asynchronous=false;let composed=0;
        const snapshot={ok:true,modules:[{id:'task-context',title:'Task context',status:'active',commands:[],panels:[{id:'sources',moduleId:'task-context',title:'Task materials',description:'From the current task event log',status:{state:'ready',label:'Ready'},sections:[{id:'materials',title:'Sources',rows:[{id:'file',label:'Quarterly report <b>draft</b>',value:'User attached · Readable'}],actions:[{id:'refresh',label:'Read latest evidence',primary:true}]}]},{id:'receipt',moduleId:'task-context',title:'Latest receipt',status:{state:'ready',label:'Ready'},sections:[{id:'receipt',rows:[{id:'outcome',label:'Outcome',value:'Partial'}]}]}]}],errors:[]};
        let currentSnapshot=snapshot;let listCalls=0;
        snapshot.sessionId='task-one';
        snapshot.modules[0].panels[1].sections.push({id:'empty',title:'Outstanding work',rows:[]});
        const controller=ModsWorkspace.create(document.getElementById('host'),{language:()=>language,sessionId:()=>currentSnapshot.sessionId||'task-one',list:async()=>{listCalls++;return currentSnapshot},composeAgentRequest:(sessionId,request)=>{check(sessionId==='task-one'&&request.toolName==='Module.task-context.read','continuation preserves backend session and tool');composed++;return true;},invoke:async request=>{calls++;check(request.moduleId==='task-context'&&request.panelId==='sources'&&request.actionId==='refresh','action is bound to module/panel/action identity');if(asynchronous)return new Promise(resolve=>resolveAction=resolve);return fail?{ok:false,sessionId:'task-one',error:'source_read_failed',agentRequest:{moduleId:'task-context',moduleTitle:'Task context',actionLabel:'Read source',toolName:'Module.task-context.read',arguments:{}}}:{...snapshot,result:{text:'Read the current source record'},usedBackend:'event-session',timingMs:12};}});
        await controller.refresh();
        check(document.querySelector('.mp-mods-header').getBoundingClientRect().left-document.querySelector('.mp-mods-workspace').getBoundingClientRect().left>=12,'module content has its own inset');
        check(document.querySelectorAll('[data-mod-panel]').length===2,'registered panels appear');
        check(!document.querySelector('.mp-mods-section b')&&document.querySelector('.mp-mods-section').textContent.includes('<b>draft</b>'),'module content stays plain text');
        document.querySelector('[data-mod-action=refresh]').click(); await new Promise(r=>setTimeout(r,20));
        check(document.querySelector('[data-mod-result]').textContent.includes('Read the current source record'),'successful action displays actual result');
        check(document.querySelector('[data-mod-result]').textContent.includes('event-session'),'actual backend remains visible');
        check(document.querySelector('[data-mod-result]').textContent.includes('Execution 12 ms') && /Total [0-9]+ ms/.test(document.querySelector('[data-mod-result]').textContent),'backend execution time is labelled separately from the complete action wait');
        fail=true;document.querySelector('[data-mod-action=refresh]').click();await new Promise(r=>setTimeout(r,20));
        check(document.querySelector('[data-mod-result]').textContent.includes('source_read_failed'),'failed action reports failure');
        check(!document.querySelector('[data-mod-action=refresh]').disabled,'failed action allows retry');
        document.querySelector('[data-mod-continue]').click();document.querySelector('[data-mod-continue]').click();
        check(composed===1&&document.querySelector('[data-mod-continue]').disabled&&document.querySelector('[data-mod-result]').classList.contains('is-error'),'continuation adds once to draft without relabelling the failed action as executed');
        fail=false;asynchronous=true;document.querySelector('[data-mod-action=refresh]').click();document.querySelector('[data-mod-action=refresh]').click();await Promise.resolve();
        check(calls===3,'pending action cannot be submitted twice');
        const beforePendingRefresh=listCalls;controller.invalidate();controller.invalidate();await new Promise(r=>setTimeout(r,20));
        check(listCalls===beforePendingRefresh&&document.querySelector('[data-mod-action=refresh]').disabled,'invalidation waits without interrupting the running module action');
        await controller.refresh();document.querySelector('[data-mod-action=refresh]').click();
        check(calls===3&&listCalls===beforePendingRefresh&&document.querySelector('[data-mod-action=refresh]').disabled,'reopening the same task preserves its running command and cannot execute it twice');
        document.querySelector('[data-mod-panel=receipt]').click();resolveAction({...snapshot,result:{text:'Finished previous panel'},usedBackend:'event-session',timingMs:15});await new Promise(r=>setTimeout(r,20));
        check(document.querySelector('[data-mod-panel=receipt]').getAttribute('aria-selected')==='true','late action result does not navigate away from selected panel');
        check(listCalls===beforePendingRefresh+1,'pending invalidations become one reload after action completion');
        check(document.querySelector('.mp-mods-section-empty')?.textContent==='Nothing recorded.','empty durable sections are explicit');
        await controller.refresh();
        check(document.querySelector('[data-mod-panel=receipt]').getAttribute('aria-selected')==='true','refresh preserves the selected registered panel');
        language='zh-CN';controller.updateLanguage();check(document.querySelector('[data-mod-refresh]').textContent.includes('刷新'),'workspace controls localize');
        document.querySelector('[data-mod-panel=sources]').click();
        document.querySelector('[data-mod-action=refresh]').click();await Promise.resolve();
        currentSnapshot={ok:true,modules:[],errors:[],sessionId:'next-task'};await controller.refresh();
        resolveAction({...snapshot,result:{text:'Old task result'},usedBackend:'event-session',timingMs:20});await new Promise(r=>setTimeout(r,20));
        check(document.querySelectorAll('[data-mod-panel]').length===0&&!document.querySelector('[data-mod-result]'),'old action completion cannot restore the previous task panels');
        currentSnapshot=snapshot;await controller.refresh();
        snapshot.modules[0].status='error';snapshot.errors=[{moduleId:'task-context',message:'Secondary panel unavailable'}];await controller.refresh();
        check(!document.querySelector('[data-mod-action=refresh]').disabled&&document.querySelector('.mp-mods-notice').textContent.includes('Secondary panel unavailable'),'one failed contribution does not disable a healthy panel action');
        snapshot.modules[0].status='active';snapshot.errors=[];await controller.refresh();
        asynchronous=true;document.querySelector('[data-mod-action=refresh]').click();await Promise.resolve();
        resolveAction({ok:false,error:'runtime_snapshot_probe_timeout'});await new Promise(r=>setTimeout(r,20));
        check(document.querySelector('[data-mod-result]').textContent.includes('模块请求超时')&&document.querySelector('[data-mod-result]').textContent.includes('runtime_snapshot_probe_timeout')&&!document.querySelector('[data-mod-action=refresh]').disabled&&!document.querySelector('[data-mod-refresh]').disabled,'timed out action explains recovery and releases both retry and refresh controls');
        currentSnapshot={ok:false,error:'bridge_timeout'};await controller.refresh();
        check(document.querySelector('.mp-mods-notice').textContent.includes('请刷新面板')&&!document.querySelector('[data-mod-refresh]').disabled,'timed out panel read offers refresh without remaining busy');
        currentSnapshot=snapshot;await controller.refresh();
        window.modController=controller;
        return checks;
      })()`);
      for (const [theme, width] of [
        ['light', 760],
        ['dark', 760],
        ['dark', 420],
      ]) {
        win.setContentSize(width, 820);
        await win.webContents.executeJavaScript(
          `document.documentElement.dataset.theme='${theme}';new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
        );
        win.webContents.invalidate();
        await new Promise(resolve => setTimeout(resolve, 200));
        assert(
          await win.webContents.executeJavaScript(
            'document.documentElement.scrollWidth<=innerWidth',
          ),
          'no horizontal overflow',
        );
        fs.writeFileSync(
          path.join(out, `${theme}-${width}.png`),
          (await win.webContents.capturePage()).toPNG(),
        );
      }
      fs.writeFileSync(
        path.join(out, 'result.json'),
        JSON.stringify(
          {
            checks,
            backend: 'actual Chromium component with isolated module callbacks',
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify({passed: checks.length, screenshots: 3}));
    }
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
});
