'use strict';
const {app, BrowserWindow, ipcMain} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve('data/runtime/keyboard-focus');
const visibleFocus = process.argv.includes('--visible-focus');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 90000);
app.whenReady().then(async () => {
  const {
    createConversationStore,
  } = require('../build/electron/conversation_store');
  const {createStashRuntime} = require('../build/electron/stash_runtime');
  const {
    ResourceCollectionService,
  } = require('../build/electron/resource_collection_service');
  const folder = fs.mkdtempSync(path.join(output, 'case-'));
  const store = createConversationStore({
    baseDir: path.join(folder, 'history'),
  });
  const project = store.registerProject(folder);
  const stash = createStashRuntime({
    baseDir: path.join(folder, 'stash'),
    clipboard: {
      availableFormats: () => [],
      readText: () => '',
      readImage: () => ({isEmpty: () => true}),
    },
  });
  const service = new ResourceCollectionService({
    stash: () => stash,
    projects: () => store.listProjects(),
    attach: (id, files) =>
      store.updateProject(id, {
        sharedFiles: [...(store.getProject(id).sharedFiles || []), ...files],
      }),
    analyze: async () => {
      throw new Error('No model in keyboard verification');
    },
  });
  const items = [];
  for (let i = 0; i < 3; i++) {
    items.push(
      await service.add({
        text: `Keyboard reference ${i}`,
        title: `Reference ${i}`,
        projectId: project.id,
      }),
    );
  }
  service.update(items[0].id, {summary: 'A saved handoff'}, 1);
  await service.deliver(items[0].id);
  ipcMain.handle('resource-probe', async (_event, {action, input = {}}) => {
    try {
      if (action === 'project-inbox')
        return {
          ok: true,
          handoffs: service.projectInbox(input.projectId),
          handoffReceipts: [],
        };
      if (action === 'handoff-state')
        return {
          ok: true,
          entry: service.setHandoffState(
            input.id,
            input.handoffState,
            input.revision,
            input.snoozedUntil,
          ),
        };
      if (action === 'list')
        return {
          ok: true,
          items: service.list(),
          projects: store.listProjects(),
        };
      if (action === 'edit')
        return {
          ok: true,
          entry: service.update(input.id, input.patch, input.revision),
        };
      if (action === 'project-update')
        return store.updateProject(project.id, input.patch);
      return {ok: true};
    } catch (error) {
      return {ok: false, error: error.message};
    }
  });
  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    show: visibleFocus,
    webPreferences: {
      offscreen: !visibleFocus,
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
  const cases = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  const js = code => win.webContents.executeJavaScript(code);
  const pause = () => new Promise(resolve => setTimeout(resolve, 70));
  const wait = async code => {
    for (let i = 0; i < 60; i++) {
      if (await js(code)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('UI timeout: ' + code);
  };
  const key = async name => {
    win.webContents.sendInputEvent({type: 'keyDown', keyCode: name});
    if (name === 'ENTER') {
      win.webContents.sendInputEvent({type: 'char', keyCode: '\r'});
    }
    win.webContents.sendInputEvent({type: 'keyUp', keyCode: name});
    await pause();
  };
  const run = async (name, check) => {
    try {
      await check();
      cases.push({name, ok: true});
    } catch (error) {
      cases.push({name, ok: false, error: error.message});
    }
  };
  try {
    await win.loadFile(path.resolve('build/electron/renderer/studio.html'));
    win.webContents.focus();
    if (visibleFocus) {
      win.focus();
    }
    await js(
      `window.__project=${JSON.stringify(store.getProject(project.id))};Data.projects=async()=>[window.__project];Data.conversations=async()=>[];Data.updateProject=async(_id,patch)=>{const result=await window.magicPointerDashboard.resources.request('project-update',{patch});window.__project=result.project;return result;};window.__stopCalls=0;stopActiveConversation=async()=>{window.__stopCalls++};void 0;`,
    );
    const projectPage = async () => {
      await js(
        `studioComposerBusy=false;show('projects',${JSON.stringify(project.id)})`,
      );
      await wait('!!document.querySelector(".mp-project-heading")');
    };
    const menu = '.mp-project-heading .mp-project-menu';
    await projectPage();
    await run('outside pointer dismisses project menu', async () => {
      await js(
        `document.querySelector('${menu} summary').click();document.querySelector('.mp-project-heading h1').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));`,
      );
      await pause();
      assert.equal(await js(`document.querySelector('${menu}').open`), false);
    });
    await projectPage();
    await run('only one project menu stays open', async () => {
      await js(
        `document.querySelector('${menu} summary').click();document.querySelector('.mp-project-context .mp-project-menu summary').click()`,
      );
      await pause();
      assert.equal(
        await js('document.querySelectorAll(".mp-project-menu[open]").length'),
        1,
      );
    });
    await projectPage();
    await run(
      'project menu supports keyboard entry and arrow navigation',
      async () => {
        await js(`document.querySelector('${menu} summary').focus()`);
        await key('DOWN');
        assert.equal(
          await js('document.activeElement.dataset.projectAction'),
          'star',
        );
        await key('UP');
        assert.equal(
          await js('document.activeElement.dataset.projectAction'),
          'archive',
        );
        await key('HOME');
        assert.equal(
          await js('document.activeElement.dataset.projectAction'),
          'star',
        );
      },
    );
    await projectPage();
    await run(
      'Escape closes project menu and restores trigger without stopping a task',
      async () => {
        await js(
          `document.querySelector('${menu} summary').click();document.querySelector('[data-project-action=star]').focus();studioComposerBusy=true;pendingConversation={};window.__stopCalls=0`,
        );
        await key('ESCAPE');
        assert.equal(await js(`document.querySelector('${menu}').open`), false);
        assert.equal(await js('document.activeElement.tagName'), 'SUMMARY');
        assert.equal(await js('window.__stopCalls'), 0);
      },
    );
    await projectPage();
    await run('Escape closes only the project dialog', async () => {
      await js(
        'document.querySelector("[data-project-action=details]").click();studioComposerBusy=true;pendingConversation={};window.__stopCalls=0',
      );
      await key('ESCAPE');
      assert.equal(await js('!!document.querySelector("dialog[open]")'), false);
      assert.equal(await js('window.__stopCalls'), 0);
    });
    await projectPage();
    await run(
      'saving project dialog restores the replacement edit button',
      async () => {
        await js(
          'document.querySelector("[data-project-action=details]").focus();document.querySelector("[data-project-action=details]").click();document.querySelector("dialog [name=name]").value="Keyboard acceptance";document.querySelector("dialog form").requestSubmit()',
        );
        await wait('!document.querySelector("dialog[open]")');
        await pause();
        assert.equal(
          await js('document.activeElement.dataset.projectAction'),
          'details',
        );
      },
    );
    await projectPage();
    await run(
      'handoff filtering and state updates preserve keyboard position',
      async () => {
        await wait('!!document.querySelector("[data-handoff-filter=handled]")');
        await js(
          'document.querySelector("[data-handoff-filter=handled]").focus();document.querySelector("[data-handoff-filter=handled]").click()',
        );
        assert.equal(
          await js('document.activeElement.dataset.handoffFilter'),
          'handled',
        );
        await js(
          'document.querySelector("[data-handoff-filter=unread]").click()',
        );
        await wait('!!document.querySelector("[data-project-handoff]")');
        await js(
          'document.querySelector("[data-handoff-state=handled]").focus();document.querySelector("[data-handoff-state=handled]").click()',
        );
        await wait('!document.querySelector("[data-project-handoff]")');
        await pause();
        assert.equal(
          await js('document.activeElement.dataset.handoffFilter'),
          'unread',
        );
      },
    );
    await js(
      'studioComposerBusy=false;pendingConversation=null;show("resources")',
    );
    await wait('document.querySelectorAll("[data-rl-id]").length>=2');
    await run(
      'resource collection is one tab stop with wrapping arrow keys',
      async () => {
        assert.equal(
          await js(
            '[...document.querySelectorAll("[data-rl-id]")].filter(item=>item.tabIndex===0).length',
          ),
          1,
        );
        await js('document.querySelector("[data-rl-id]").focus()');
        await key('UP');
        assert.equal(
          await js('document.activeElement.dataset.rlId'),
          await js(
            '[...document.querySelectorAll("[data-rl-id]")].at(-1).dataset.rlId',
          ),
        );
        await key('HOME');
        assert.equal(
          await js('document.activeElement.dataset.rlId'),
          await js('document.querySelector("[data-rl-id]").dataset.rlId'),
        );
      },
    );
    await run(
      'resource keyboard opening and Escape return to the saved card',
      async () => {
        await js(
          'window.__resourceId=document.querySelector("[data-rl-id]").dataset.rlId;document.querySelector("[data-rl-id]").focus()',
        );
        await key('ENTER');
        await wait('!document.querySelector(".rl-detail").hidden');
        assert.equal(
          await js('!!document.activeElement.closest(".rl-detail")'),
          true,
        );
        await js(
          'const note=document.querySelector("[data-rl-edit] [name=note]");note.focus();note.value="Keyboard saved note";note.dispatchEvent(new Event("input",{bubbles:true}));studioComposerBusy=true;pendingConversation={};window.__stopCalls=0',
        );
        await key('ESCAPE');
        await wait('document.querySelector(".rl-detail").hidden');
        assert.equal(
          await js('document.activeElement.dataset.rlId'),
          await js('window.__resourceId'),
        );
        const id = await js('window.__resourceId');
        assert.equal(stash.get(id).collection.note, 'Keyboard saved note');
        assert.equal(await js('window.__stopCalls'), 0);
      },
    );
    await run('resource refresh preserves focused card', async () => {
      await js(
        'document.querySelectorAll("[data-rl-id]")[1].focus();window.__focusedId=document.activeElement.dataset.rlId;document.querySelector("[data-rl-filter=all]").click()',
      );
      assert.equal(
        await js('document.activeElement.dataset.rlId'),
        await js('window.__focusedId'),
      );
    });
    await js('studioComposerBusy=false;pendingConversation=null');
    await projectPage();
    await run(
      'project menu action restores its trigger after saving',
      async () => {
        await js(
          'document.querySelector(".mp-project-heading .mp-project-menu summary").focus()',
        );
        await key('DOWN');
        await key('ENTER');
        await wait('window.__project.starred === true');
        await pause();
        assert.equal(
          await js(
            'document.activeElement.matches(".mp-project-heading .mp-project-menu summary")',
          ),
          true,
        );
      },
    );
    await js('show("resources")');
    await wait('document.querySelectorAll("[data-rl-id]").length>=2');
    await run(
      'idle resource refresh preserves editor focus and selection',
      async () => {
        await js('document.querySelector("[data-rl-id]").click()');
        await wait('!document.querySelector(".rl-detail").hidden');
        await js(
          'const title=document.querySelector("[data-rl-edit] [name=title]");title.focus();title.setSelectionRange(0,3);void 0',
        );
        await js('resourceLibraryUi.refresh()');
        assert.equal(await js('document.activeElement.name'), 'title');
        assert.equal(await js('document.activeElement.selectionEnd'), 3);
      },
    );
    await projectPage();
    await js(
      'document.documentElement.dataset.theme="light";document.documentElement.classList.remove("dark");document.querySelector(".mp-project-heading .mp-project-menu summary").focus()',
    );
    await key('DOWN');
    fs.writeFileSync(
      path.join(output, 'project-menu-focus-light.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    await js(
      'document.documentElement.dataset.theme="dark";document.documentElement.classList.add("dark");show("resources")',
    );
    win.setSize(860, 820);
    await wait('document.querySelectorAll("[data-rl-id]").length>=2');
    await js('document.querySelector("[data-rl-action=close]")?.click()');
    await wait('document.querySelector(".rl-detail").hidden');
    await js('document.querySelector("[data-rl-id]").focus()');
    await key('RIGHT');
    const focusStyle = await js(
      '({focused:document.activeElement.dataset.rlId,visible:document.activeElement.matches(":focus-visible"),outline:getComputedStyle(document.activeElement).outline,documentFocus:document.hasFocus()})',
    );
    fs.writeFileSync(
      path.join(output, 'resource-focus-dark-narrow.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    const report = {
      ok:
        cases.every(item => item.ok) &&
        !errors.length &&
        (!visibleFocus ||
          (focusStyle.documentFocus &&
            focusStyle.visible &&
            !focusStyle.outline.includes(' none '))),
      usedBackend:
        'production Studio renderer, native Chromium keyboard events, real project store and Stash; controlled task stop counter, no model',
      cases,
      errors,
      focusStyle,
    };
    fs.writeFileSync(
      path.join(output, 'renderer-result.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.ok ? 0 : 1);
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally {
    clearTimeout(deadline);
  }
});
