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
      fs.readFileSync('build/electron/renderer/resource_library.js', 'utf8') +
        ';void 0;',
    );
    await js(`
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
        window.library=ResourceLibrary.mount(document.querySelector('main'),api,{openTask:()=>{},openCanvas:()=>{}});
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
    await reset();
    await js("document.querySelector('main').style.width='720px'");
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.writeFileSync(
      path.join(output, 'narrow.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
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
