const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {transformSync} = require('esbuild');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'data/runtime/desktop-perception-ui');
fs.mkdirSync(out, {recursive: true});
app.setPath('userData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const deadline = setTimeout(() => app.exit(2), 30000);
app.whenReady().then(async () => {
  const baseline = process.argv.includes('--baseline');
  const win = new BrowserWindow({
    width: 1000,
    height: 760,
    useContentSize: true,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      preload: baseline
        ? path.join(root, 'scripts/probe_studio_layout_preload.js')
        : undefined,
    },
  });
  const errors = [];
  win.webContents.on('render-process-gone', (_event, details) =>
    errors.push(details.reason),
  );
  try {
    if (baseline) {
      await win.loadFile(
        path.join(root, 'build/electron/renderer/studio.html'),
      );
      const result = await win.webContents.executeJavaScript(
        `({entry: !!document.querySelector('.mp-desktop-perception'), title: document.title})`,
      );
      fs.writeFileSync(
        path.join(out, 'baseline.json'),
        JSON.stringify(result, null, 2),
      );
      assert(
        result.entry,
        'Studio has no discoverable desktop perception / start pointing control',
      );
    } else {
      const source = fs.readFileSync(
        path.join(root, 'electron/renderer/desktop_perception.ts'),
        'utf8',
      );
      const javascript = transformSync(source, {
        loader: 'ts',
        format: 'iife',
      }).code;
      const css = ['theme_tokens.css', 'desktop_perception.css']
        .map(file =>
          fs.readFileSync(path.join(root, 'electron/renderer', file), 'utf8'),
        )
        .join('\n');
      await win.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            '<html><head><style>' +
              css +
              'body{margin:0;background:var(--mp-page);font-family:system-ui}main{max-width:720px;padding:36px;margin:auto}h1{font-size:24px;color:var(--mp-text);margin-bottom:24px}</style></head><body><main><h1>Magic Pointer</h1><div id="host"></div></main></body></html>',
          ),
      );
      await win.webContents.executeJavaScript(javascript);
      const result = await win.webContents.executeJavaScript(`(async () => {
        const checks = [];
        const check = (value, message) => { if (!value) throw Error(message); checks.push(message); };
        let language = 'en';
        let activations = 0;
        let opened = '';
        let settings = '';
        let failStatus = false;
        let failPause = false;
        const status = {paused:false,onboardingRequired:false,wakeMode:'wiggle_hotkey',detectWiggle:true,detectMouseButton:false,polling:true,pointerStateFresh:true,hotkeys:[{name:'wake',accelerator:'Ctrl+Alt+M',registered:true}]};
        const controller = DesktopPerception.create(document.getElementById('host'), {
          readStatus: async () => { if(failStatus) throw Error('native bridge unavailable'); return status; },
          setPaused: async paused => {if(failPause) return {ok:false,error:'pause unavailable'};status.paused=paused;return {ok:true};},
          activate: async () => {activations++; return {ok:false,error:'target unavailable'};},
          openSettings: page => settings = page,
          openMaterials: source => opened = source,
          language: () => language,
        });
        await controller.refresh();
        const detail = document.querySelector('details');
        detail.open = true;
        await new Promise(resolve => setTimeout(resolve, 50));
        check(document.querySelector('.mp-perception-state').textContent === 'Ready to point', 'actual listener and registered shortcut appear');
        controller.updateStatus({...status,activity:{token:'gesture',state:'reading',providers:[{provider:'uia',state:'fulfilled',latencyMs:125},{provider:'office',state:'slow',latencyMs:301}]}});
        check(document.querySelector('[data-perception-live]')?.textContent.includes('125 ms') && document.querySelector('[data-perception-live]').textContent.includes('Still reading'), 'live provider progress distinguishes completed and slow concurrent reads');
        controller.updateStatus({...status,activity:{token:'gesture',state:'ready',providers:[{provider:'office',state:'timeout',latencyMs:8000,error:'com_timeout'}]}});
        check(document.querySelector('[data-perception-live]').textContent.includes('com_timeout') && document.querySelector('[data-perception-live]').textContent.includes('Timed out'), 'completed capture preserves actual reader timeout');
        await document.querySelector('.mp-perception-action').click();
        await Promise.resolve();
        check(activations === 1 && document.querySelector('.mp-perception-notice').textContent === 'target unavailable', 'failed activation displays actual error and permits retry');
        check(!document.querySelector('.mp-perception-action').disabled, 'failed action releases pending state');
        document.querySelector('[data-perception-settings]').click();
        check(settings === 'interaction', 'wake settings opens interaction page');
        controller.updateContext({taskId:'task',referenceRevision:1,sources:[{sourceId:'source',title:'Quarterly report <b>real</b>',kind:'capture',origin:'user-pointed',identity:{},revision:{},capabilities:['read'],parentSourceId:null,taskId:'task'}],references:[{referenceId:'ref',sourceId:'source',label:'A',role:'target',capturedAtMs:Date.UTC(2026,9,17),active:true,ordinal:0,locator:{}}]});
        const row = document.querySelector('.mp-perception-source');
        check(document.querySelector('.mp-perception-count').textContent === '1 source', 'single source count uses singular');
        check(row.textContent.includes('Pointed on screen') && row.textContent.includes('A (target)') && !row.querySelector('b'), 'real source title and target binding render without HTML interpretation');
        row.click();
        check(opened === 'source', 'material opens exact current source');
        controller.updateEvidence({frameLeaseId:'frame-1',capturedAt:'2026-10-17T12:00:00Z',source:{perceptionTrace:{selectedAdapter:'uia',attempts:[{adapter:'uia',status:'ok',coversMark:true,usedBackend:'windows.uia'},{adapter:'pixel-ocr',status:'error',reason:'ocr_worker_unavailable'}]}}});
        check(document.querySelector('.mp-perception-evidence').textContent.includes('windows.uia') && document.querySelector('.mp-perception-evidence').textContent.includes('ocr_worker_unavailable'), 'saved capture displays actual provider backend and failure');
        controller.updateEvidence({frameLeaseId:'wgc-frame',source:{captureAttestation:{source:'wgc-display',pixelsFrozen:true,frameAgeMs:23.4},perceptionTrace:{attempts:[]}}});
        check(document.querySelector('.mp-perception-evidence').textContent.includes('Windows Graphics Capture') && document.querySelector('.mp-perception-evidence').textContent.includes('23 ms'), 'historical capture shows the actual WGC backend and frame age');
        controller.updateEvidence({frameLeaseId:'fallback-frame',source:{captureAttestation:{source:'gdi-fallback',pixelsFrozen:true,fallbackReason:'wgc_access_denied'},perceptionTrace:{attempts:[]}}});
        check(document.querySelector('.mp-perception-evidence').textContent.includes('GDI') && document.querySelector('.mp-perception-evidence').textContent.includes('wgc_access_denied'), 'fallback capture exposes its original WGC failure');
        controller.updateStatus({...status,paused:true});
        check(document.querySelector('.mp-perception-action').disabled && document.querySelector('.mp-perception-state').textContent === 'Paused', 'pause visibly disables activation');
        document.querySelector('[data-perception-pause]').click();
        await new Promise(resolve => setTimeout(resolve, 20));
        check(!document.querySelector('.mp-perception-action').disabled, 'resume button restores pointing through acknowledged status');
        failPause = true;
        document.querySelector('[data-perception-pause]').click();
        await new Promise(resolve => setTimeout(resolve, 20));
        check(document.querySelector('.mp-perception-state').textContent === 'Ready to point' && document.querySelector('.mp-perception-notice').textContent === 'pause unavailable', 'failed pause preserves acknowledged state and reports error');
        controller.updateStatus({...status,pointerStateFresh:false,hotkeys:[]});
        check(document.querySelector('.mp-perception-state').textContent === 'Wake unavailable', 'timer alone does not claim native input health');
        failStatus = true;
        await controller.refresh();
        check(document.querySelector('.mp-perception-state').textContent === 'Status unknown' && document.querySelector('.mp-perception-notice').textContent === 'native bridge unavailable', 'status failure clears stale ready claim');
        failStatus = false;
        await controller.refresh();
        language = 'zh-CN'; controller.updateLanguage();
        check(document.querySelector('.mp-perception-title').textContent === '指向屏幕' && row.isConnected === false, 'language updates both entry and material detail');
        detail.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
        check(!detail.open && document.activeElement === detail.querySelector('summary'), 'Escape closes panel and restores focus');
        detail.open = true;
        window.probeController = controller;
        return checks;
      })()`);
      for (const [theme, width] of [
        ['light', 1000],
        ['dark', 1000],
        ['dark', 420],
      ]) {
        win.setContentSize(width, 760);
        await win.webContents.executeJavaScript(
          `document.documentElement.dataset.theme='${theme}';document.body.dataset.theme='${theme}';`,
        );
        await new Promise(resolve => setTimeout(resolve, 120));
        const overflow = await win.webContents.executeJavaScript(
          'document.documentElement.scrollWidth > window.innerWidth',
        );
        assert(!overflow, `${theme} ${width}px should not overflow`);
        fs.writeFileSync(
          path.join(out, `${theme}-${width}.png`),
          (await win.webContents.capturePage()).toPNG(),
        );
      }
      assert.equal(errors.length, 0);
      fs.writeFileSync(
        path.join(out, 'result.json'),
        JSON.stringify(
          {
            checks: result,
            errors,
            backend: 'isolated Chromium renderer, fixture IPC callbacks',
          },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({passed: result.length, screenshots: 3, errors}),
      );
    }
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  }
});
