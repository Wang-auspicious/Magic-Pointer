'use strict';
// Isolated Chromium exercises the production library, with controllable IPC replies.
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve('data/runtime/resource-editing');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 60000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {offscreen: true, contextIsolation: false, sandbox: true},
  });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  const js = source => win.webContents.executeJavaScript(source);
  const wait = async expression => {
    for (let i = 0; i < 100; i++) {
      if (await js(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('UI timeout: ' + expression);
  };
  const results = [];
  const check = async (name, exercise) => {
    try {
      await exercise();
      results.push({name, ok: true});
    } catch (error) {
      results.push({name, ok: false, error: error.message});
    }
  };
  const input = (selector, value) =>
    js(
      `(() => {const el=document.querySelector(${JSON.stringify(selector)}); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  const click = selector =>
    js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const submit = selector =>
    js(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);
  try {
    await win.loadURL('about:blank');
    await js(
      `document.documentElement.lang='en'; document.head.innerHTML=${JSON.stringify('<style>' + fs.readFileSync('electron/renderer/resource_library.css', 'utf8') + '</style>')};`,
    );
    await js(
      fs.readFileSync('build/electron/renderer/right_workspace.js', 'utf8') +
        '\n' +
        fs.readFileSync('build/electron/renderer/resource_preview.js', 'utf8') +
        ';void 0;',
    );
    await js(
      fs.readFileSync('build/electron/renderer/resource_library.js', 'utf8') +
        ';void 0;',
    );
    await js(`
      window.studioT=key=>key;
      window.magicPointerDashboard={stash:{onEntry:()=>{}}};
      window.reset=async()=>{
        document.body.innerHTML='<main id="resource-library" style="height:850px;width:1200px"></main>';
        window.rows=[{id:'one',media:'text',capturedAt:Date.now(),relPath:'one.txt',text:'Reference material',collection:{revision:1,title:'First resource',state:'inbox',note:'',summary:'Original summary',intent:'save'}},{id:'two',media:'text',capturedAt:Date.now(),relPath:'two.txt',text:'Second resource',collection:{revision:1,title:'Second resource',state:'ready',note:'',summary:'Second summary',intent:'save'}}];
        window.calls=[];window.block='';window.release=null;window.fail='';
        window.source={accountId:'42',username:'tester',status:'ready',enabled:false,likes:false,bookmarks:true,organize:false,rules:'Saved rule',recentIds:[]};
        window.api={request:async(action,input={})=>{
          calls.push({action,input:structuredClone(input)});
          if(block===action){block='';await new Promise(resolve=>{window.release=resolve;});window.release=null;}
          if(fail===action){fail='';return {ok:false,error:'Fixture source request failed'};}
          if(action==='list')return structuredClone({ok:true,items:rows,projects:[],source});
          if(action==='preview')return structuredClone({ok:true,preview:window.previewResult||{kind:'text',text:'Retained original <script>data only</script>',truncated:false}});
          if(action.startsWith('x-')){if(action==='x-configure')Object.assign(source,input);if(action==='x-sync')rows.push({...structuredClone(rows[0]),id:'synced'});return structuredClone({ok:true,source});}
          const row=rows.find(r=>r.id===input.id);
          if(action==='edit'){
            if(input.revision!==row.collection.revision)return {ok:false,error:'resource_revision_conflict'};
            Object.assign(row.collection,input.patch,{revision:row.collection.revision+1});
          }
          if(action==='process')Object.assign(row.collection,{state:'ready',revision:row.collection.revision+1});
          if(action==='add'){const added={...structuredClone(rows[0]),id:'added',text:input.text,collection:{...rows[0].collection,title:input.text}};rows.push(added);return structuredClone({ok:true,entry:added});}
          return structuredClone({ok:true,entry:row});
        }};
        window.openedTask='';window.previewResult=null;
        window.library=ResourceLibrary.mount(document.querySelector('main'),api,{openTask:id=>{window.openedTask=id;},openCanvas:()=>{}});
        library.show();await library.refresh();
      };void 0;
    `);
    const reset = async () => {
      await js('reset()');
      await click('[data-rl-id="one"]');
    };
    await check(
      'typing while Save is in flight survives the acknowledgement and can be saved',
      async () => {
        await reset();
        await input('[name=note]', 'first draft');
        await js("block='edit'");
        await submit('[data-rl-edit]');
        await wait('!!release');
        await input('[name=note]', 'newer draft');
        await js('release()');
        await wait('!release');
        assert.equal(
          await js("document.querySelector('[name=note]').value"),
          'newer draft',
        );
        await submit('[data-rl-edit]');
        await wait("rows[0].collection.note==='newer draft'");
      },
    );
    await check(
      'Ignore saves the current note before moving the resource',
      async () => {
        await reset();
        await input('[name=note]', 'keep my reasoning');
        await click('[data-rl-action=ignore]');
        await wait("rows[0].collection.state==='ignored'");
        assert.equal(await js('rows[0].collection.note'), 'keep my reasoning');
      },
    );
    await check(
      'refresh does not lend a newer revision to an older dirty editor',
      async () => {
        await reset();
        await input('[name=note]', 'local draft');
        await js(
          "rows[0].collection.summary='New backend analysis';rows[0].collection.revision++;library.refresh()",
        );
        await submit('[data-rl-edit]');
        await wait("calls.some(c=>c.action==='edit')");
        assert.equal(
          await js('rows[0].collection.summary'),
          'New backend analysis',
        );
        assert.equal(
          await js("document.querySelector('[name=note]').value"),
          'local draft',
        );
        assert.match(
          await js(
            "document.querySelector('[data-resource-status]').textContent",
          ),
          /changed|conflict/i,
        );
        await click('[data-rl-action=reload]');
        await wait(
          "document.querySelector('[name=summary]').value==='New backend analysis'",
        );
      },
    );
    await check(
      'a new capture draft survives the previous capture reply',
      async () => {
        await reset();
        await input('[data-rl-capture] textarea', 'first capture');
        await js("block='add'");
        await submit('[data-rl-capture]');
        await wait('!!release');
        await input('[data-rl-capture] textarea', 'next capture');
        await js('release()');
        await wait('!release');
        assert.equal(
          await js(
            "document.querySelector('[data-rl-capture] textarea').value",
          ),
          'next capture',
        );
      },
    );
    await check(
      'empty search explains the filter and offers a working clear action',
      async () => {
        await reset();
        await input('.rl-search', 'no-such-reference');
        assert.match(
          await js("document.querySelector('.rl-empty').textContent"),
          /No resources match/i,
        );
        await click('[data-rl-action=clear-search]');
        assert.equal(
          await js("document.querySelector('.rl-search').value"),
          '',
        );
        assert.equal(
          await js("document.querySelectorAll('.rl-item').length"),
          1,
        );
      },
    );
    await check(
      'details adapt to their container even in a wide application window',
      async () => {
        await reset();
        await js("document.querySelector('main').style.width='540px'");
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.ok(
          await js(
            "document.querySelector('.rl-detail').getBoundingClientRect().right<=document.querySelector('main').getBoundingClientRect().right+1",
          ),
        );
        assert.equal(
          await js(
            "getComputedStyle(document.querySelector('.rl-grid')).display",
          ),
          'none',
        );
      },
    );
    await check(
      'a running resource action prevents a competing delivery',
      async () => {
        await reset();
        await js("block='process'");
        await click('[data-rl-action=process]');
        await wait('!!release');
        await click('[data-rl-action=deliver]');
        assert.equal(
          await js("calls.filter(c=>c.action==='deliver').length"),
          0,
        );
        await js('release()');
        await wait('!release');
      },
    );
    await check('switching view preserves an unsent capture', async () => {
      await reset();
      await input('[data-rl-capture] textarea', 'not collected yet');
      await click('[data-rl-tab=browser]');
      await wait("!!document.querySelector('.rl-browser')");
      await click('[data-rl-tab=library]');
      await wait("!!document.querySelector('[data-rl-capture]')");
      assert.equal(
        await js("document.querySelector('[data-rl-capture] textarea').value"),
        'not collected yet',
      );
    });
    await check(
      'Ignore acknowledgement keeps edits typed while it was pending',
      async () => {
        await reset();
        await js("block='edit'");
        await click('[data-rl-action=ignore]');
        await wait('!!release');
        await input('[name=note]', 'typed while ignoring');
        await js('release()');
        await wait('!release');
        assert.equal(
          await js("document.querySelector('[name=note]').value"),
          'typed while ignoring',
        );
        await submit('[data-rl-edit]');
        await wait("rows[0].collection.note==='typed while ignoring'");
      },
    );
    await check(
      'failed processing refreshes its saved error and task link',
      async () => {
        await reset();
        await js(`const originalRequest=api.request;api.request=async(action,input)=>{
        if(action==='process'){Object.assign(rows[0].collection,{state:'error',error:'Unreadable analysis',taskId:'failed-task',revision:2});return {ok:false,error:'Unreadable analysis'};}
        return originalRequest(action,input);
      };void 0;`);
        await click('[data-rl-action=process]');
        await wait("!!document.querySelector('[data-rl-action=task]')");
        assert.match(
          await js("document.querySelector('.rl-error').textContent"),
          /Unreadable analysis/,
        );
      },
    );
    const sources = async () => {
      await reset();
      await click('[data-rl-tab=sources]');
      await wait("!!document.querySelector('[data-rl-x]')");
    };
    await check(
      'late account connection preserves the current browser view',
      async () => {
        await sources();
        await input('[name=token]', 'test-token');
        await js("block='x-connect'");
        await submit('[data-rl-x]');
        await wait('!!release');
        await click('[data-rl-tab=browser]');
        await wait("!!document.querySelector('.rl-browser')");
        await js('release()');
        await wait('!release');
        assert.ok(await js("!!document.querySelector('.rl-browser')"));
      },
    );
    await check('late source sync preserves the library view', async () => {
      await sources();
      await js("block='x-sync'");
      await click('[data-rl-action=sync]');
      await wait('!!release');
      await click('[data-rl-tab=library]');
      await wait("!!document.querySelector('.rl-grid')");
      await js('release()');
      await wait('!release');
      assert.ok(await js("!!document.querySelector('.rl-grid')"));
      await wait("document.querySelectorAll('.rl-item').length===2");
    });
    await check(
      'unsaved collection rules survive refresh and a view change',
      async () => {
        await sources();
        await input('[name=rules]', 'My unsaved rule');
        await js(
          "document.querySelector('[data-rl-action=sync]').focus();library.refresh()",
        );
        assert.equal(
          await js("document.querySelector('[name=rules]').value"),
          'My unsaved rule',
        );
        await click('[data-rl-tab=browser]');
        await click('[data-rl-tab=sources]');
        assert.equal(
          await js("document.querySelector('[name=rules]').value"),
          'My unsaved rule',
        );
      },
    );
    await check(
      'failed source preference restores the actual saved checkbox value',
      async () => {
        await sources();
        await js(
          "fail='x-configure';document.querySelector('[data-rl-x-option=likes]').click()",
        );
        await wait(
          "document.querySelector('[data-rl-source-feedback]').textContent.includes('Fixture source request failed')",
        );
        assert.equal(
          await js(
            "document.querySelector('[data-rl-x-option=likes]').checked",
          ),
          false,
        );
      },
    );
    await check(
      'source operations cannot be submitted twice while pending',
      async () => {
        await sources();
        await js("block='x-sync'");
        await click('[data-rl-action=sync]');
        await wait('!!release');
        await click('[data-rl-action=sync]');
        assert.equal(
          await js("calls.filter(c=>c.action==='x-sync').length"),
          1,
        );
        await js('release()');
        await wait('!release');
      },
    );
    await check(
      'failed account connection keeps its token for an in-place retry only',
      async () => {
        await sources();
        await input('[name=token]', 'test-token');
        await js("fail='x-connect'");
        await submit('[data-rl-x]');
        await wait(
          "document.querySelector('[data-rl-source-feedback]').textContent.includes('Fixture source request failed')",
        );
        assert.equal(
          await js("document.querySelector('[name=token]').value"),
          'test-token',
        );
        await click('[data-rl-tab=browser]');
        await click('[data-rl-tab=sources]');
        assert.equal(
          await js("document.querySelector('[name=token]').value"),
          '',
        );
      },
    );
    await check(
      'durable queued items remain visible in the inbox with their real state',
      async () => {
        await reset();
        await js("rows[0].collection.state='queued';library.refresh()");
        assert.equal(
          await js("document.querySelectorAll('.rl-item').length"),
          1,
        );
        assert.match(
          await js("document.querySelector('.rl-item').textContent"),
          /Queued/i,
        );
      },
    );
    await check(
      'restored running analysis cannot launch a competing task',
      async () => {
        await reset();
        await js(
          "Object.assign(rows[0].collection,{state:'processing',taskId:'actual-task'});library.refresh()",
        );
        assert.equal(
          await js(
            "document.querySelector('[data-rl-action=process]').disabled",
          ),
          true,
        );
        assert.ok(
          await js("!!document.querySelector('[data-rl-action=task]')"),
        );
      },
    );
    await check(
      'waiting analysis continues its actual task from the primary action',
      async () => {
        await reset();
        await js(
          "Object.assign(rows[0].collection,{state:'waiting',taskId:'waiting-task'});library.refresh()",
        );
        assert.equal(
          await js("document.querySelectorAll('.rl-item').length"),
          1,
        );
        await click('.rl-actions [data-rl-action=task]');
        assert.equal(await js('openedTask'), 'waiting-task');
      },
    );
    await check(
      'read-only original preview preserves an unsaved note and renders text as data',
      async () => {
        await reset();
        await input('[name=note]', 'Unsent thought');
        await click('[data-rl-action=preview]');
        await wait('!!document.querySelector(".rl-preview[open] pre")');
        assert.match(
          await js('document.querySelector(".rl-preview pre").textContent'),
          /<script>data only<\/script>/,
        );
        assert.equal(await js('calls.some(c=>c.action==="edit")'), false);
        await click('[data-preview-close]');
        await wait('!document.querySelector(".rl-preview")');
        assert.equal(
          await js('document.querySelector("[name=note]").value'),
          'Unsent thought',
        );
        assert.equal(
          await js('document.activeElement.dataset.rlAction'),
          'preview',
        );
      },
    );
    await check(
      'a late original preview reply cannot reopen a closed or hidden view',
      async () => {
        await reset();
        await js('block="preview"');
        await click('[data-rl-action=preview]');
        await wait('!!release');
        await click('[data-preview-close]');
        await js('release()');
        await wait('!release');
        assert.equal(
          await js('!!document.querySelector(".rl-preview")'),
          false,
        );
        await js('block="preview"');
        await click('[data-rl-action=preview]');
        await wait('!!release');
        await js('library.hide();release()');
        await wait('!release');
        assert.equal(
          await js('!!document.querySelector(".rl-preview")'),
          false,
        );
      },
    );
    await check(
      'preview failure is visible and retry stays in the same dialog',
      async () => {
        await reset();
        await js('fail="preview"');
        await click('[data-rl-action=preview]');
        await wait(
          '!!document.querySelector("[data-preview-error]")?.textContent',
        );
        await click('[data-preview-retry]');
        await wait('!!document.querySelector(".rl-preview pre")');
        assert.equal(
          await js('document.querySelectorAll(".rl-preview").length'),
          1,
        );
        await click('[data-preview-close]');
      },
    );
    await check(
      'downloaded paper preview and external open address the paper rather than the saved link',
      async () => {
        await reset();
        await js(
          'rows[0].collection.paperPath="retained/paper.pdf";library.refresh()',
        );
        await click('[data-rl-action=paper]');
        await wait('!!document.querySelector(".rl-preview pre")');
        assert.equal(
          await js('calls.find(c=>c.action==="preview").input.material'),
          'paper',
        );
        await click('[data-preview-external]');
        await wait('calls.some(c=>c.action==="open-original")');
        assert.equal(
          await js('calls.find(c=>c.action==="open-original").input.material'),
          'paper',
        );
        await click('[data-preview-close]');
        assert.equal(
          await js('document.activeElement.dataset.rlAction'),
          'paper',
        );
      },
    );
    const imagePreview = async () => {
      await js(
        `previewResult={kind:'image',url:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1200"><rect width="2000" height="1200" fill="#c7c3b7"/><circle cx="1000" cy="600" r="350" fill="#746d59"/></svg>'),name:'Retained image',truncated:false}`,
      );
      await click('[data-rl-action=preview]');
      await wait(
        'document.querySelector(".rl-preview-image")?.naturalWidth===2000 && !document.querySelector(".rl-preview-toolbar").hidden',
      );
      await new Promise(resolve => setTimeout(resolve, 40));
    };
    await check(
      'image zoom follows the cursor and ordinary wheel pans without changing scale',
      async () => {
        await reset();
        await imagePreview();
        const transform = () =>
          js(
            '(()=>{const m=new DOMMatrix(document.querySelector(".rl-preview-image").style.transform);return {scale:m.a,x:m.e,y:m.f}})()',
          );
        await js(
          '(()=>{const b=document.querySelector(".rl-preview-body"),r=b.getBoundingClientRect();b.dispatchEvent(new WheelEvent("wheel",{deltaY:-30,ctrlKey:true,clientX:r.left+r.width*.65,clientY:r.top+r.height*.5,bubbles:true,cancelable:true}))})()',
        );
        const zoomed = await transform();
        assert.ok(zoomed.scale > 1);
        assert.ok(zoomed.x < 0, 'zoom remains anchored to the cursor');
        await js(
          'document.querySelector(".rl-preview-body").dispatchEvent(new WheelEvent("wheel",{deltaX:30,deltaY:10,bubbles:true,cancelable:true}))',
        );
        const panned = await transform();
        assert.equal(panned.scale, zoomed.scale);
        assert.ok(panned.x < zoomed.x);
        await click('[data-preview-fit]');
        assert.equal((await transform()).scale, 1);
        await click('[data-preview-actual]');
        assert.equal(
          await js(
            'document.querySelector(".rl-preview-toolbar output").textContent',
          ),
          '100%',
        );
        await click('[data-preview-close]');
      },
    );
    await check(
      'native pointer drag ignores micro-movement and does not turn a drag into a zoom click',
      async () => {
        await reset();
        await imagePreview();
        await click('[data-preview-actual]');
        const point = await js(
          '(()=>{const r=document.querySelector(".rl-preview-body").getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()',
        );
        const before = await js(
          'document.querySelector(".rl-preview-image").style.transform',
        );
        win.webContents.sendInputEvent({
          type: 'mouseDown',
          button: 'left',
          clickCount: 1,
          ...point,
        });
        win.webContents.sendInputEvent({
          type: 'mouseMove',
          x: point.x + 2,
          y: point.y,
        });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(
          await js(
            'document.querySelector(".rl-preview-image").style.transform',
          ),
          before,
        );
        win.webContents.sendInputEvent({
          type: 'mouseMove',
          x: point.x + 90,
          y: point.y + 30,
        });
        win.webContents.sendInputEvent({
          type: 'mouseUp',
          button: 'left',
          clickCount: 1,
          x: point.x + 90,
          y: point.y + 30,
        });
        await new Promise(resolve => setTimeout(resolve, 30));
        const moved = await js(
          '(()=>{const m=new DOMMatrix(document.querySelector(".rl-preview-image").style.transform);return {scale:m.a,x:m.e}})()',
        );
        assert.ok(moved.scale > 1);
        assert.ok(moved.x > 0);
        await click('[data-preview-close]');
      },
    );
    await check(
      'broken thumbnails and image loads expose readable fallback and retry',
      async () => {
        await reset();
        await js(
          'rows[0].previewUrl="data:image/png;base64,AAAA";library.refresh()',
        );
        await wait('!!document.querySelector(".rl-thumbnail.is-unavailable")');
        await js(
          'previewResult={kind:"image",url:"data:image/png;base64,AAAA",name:"Missing",truncated:false}',
        );
        await click('[data-rl-action=preview]');
        await wait('!document.querySelector("[data-preview-retry]").hidden');
        assert.equal(
          await js('document.querySelector(".rl-preview-toolbar").hidden'),
          true,
        );
        await js(
          'previewResult={kind:"text",text:"Recovered retained source",truncated:false}',
        );
        await click('[data-preview-retry]');
        await wait(
          'document.querySelector(".rl-preview pre")?.textContent.includes("Recovered")',
        );
        await click('[data-preview-close]');
      },
    );
    await check(
      'external-open failures stay visible and duplicate opens are gated',
      async () => {
        await reset();
        await click('[data-rl-action=preview]');
        await wait('!!document.querySelector(".rl-preview pre")');
        await js('fail="open-original"');
        await click('[data-preview-external]');
        await wait(
          'document.querySelector("[data-preview-error]").textContent.includes("Fixture")',
        );
        await js('block="open-original"');
        await click('[data-preview-external]');
        await wait('!!release');
        await click('[data-preview-external]');
        assert.equal(
          await js('calls.filter(c=>c.action==="open-original").length'),
          2,
        );
        await js('release()');
        await wait('!release');
        await click('[data-preview-close]');
      },
    );
    await check(
      'preview returns focus after a background refresh, and Escape closes only the preview',
      async () => {
        await reset();
        await imagePreview();
        await js('library.refresh()');
        win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Escape'});
        win.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Escape'});
        await wait('!document.querySelector(".rl-preview")');
        assert.equal(
          await js('document.activeElement.dataset.rlAction'),
          'preview',
        );
        assert.equal(
          await js('document.querySelector(".rl-detail").hidden'),
          false,
        );
      },
    );
    await check(
      'audio and video use paused native controls and release their source on close',
      async () => {
        for (const kind of ['audio', 'video']) {
          await reset();
          await js(
            `previewResult={kind:${JSON.stringify(kind)},url:'data:video/mp4;base64,AAAA',name:'Local media',truncated:false}`,
          );
          await click('[data-rl-action=preview]');
          await wait(`!!document.querySelector('.rl-preview ${kind}')`);
          assert.equal(
            await js(
              `(()=>{window.testMedia=document.querySelector('.rl-preview ${kind}');return testMedia.controls&&!testMedia.autoplay&&testMedia.paused})()`,
            ),
            true,
          );
          await click('[data-preview-close]');
          assert.equal(await js('testMedia.getAttribute("src")'), null);
        }
      },
    );
    await reset();
    await js("document.querySelector('main').style.width='720px'");
    await new Promise(resolve => setTimeout(resolve, 100));
    const result = {
      ok: results.every(row => row.ok) && errors.length === 0,
      usedBackend:
        'production ResourceLibrary in isolated Chromium; controllable API fixture',
      results,
      errors,
    };
    fs.writeFileSync(
      path.join(output, 'result.json'),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
    app.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(error, errors);
    app.exit(1);
  } finally {
    clearTimeout(deadline);
  }
});
