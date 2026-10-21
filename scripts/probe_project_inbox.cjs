'use strict';
const {app, BrowserWindow, ipcMain} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve('data/runtime/project-inbox');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 60000);
app.whenReady().then(async () => {
  const {
    createConversationStore,
  } = require('../build/electron/conversation_store');
  const {createStashRuntime} = require('../build/electron/stash_runtime');
  const {
    ResourceCollectionService,
  } = require('../build/electron/resource_collection_service');
  const baseDir = fs.mkdtempSync(path.join(output, 'case-'));
  const store = createConversationStore({
    baseDir: path.join(baseDir, 'history'),
  });
  const project = store.registerProject(baseDir);
  const stash = createStashRuntime({
    baseDir: path.join(baseDir, 'stash'),
    clipboard: {
      availableFormats: () => [],
      readText: () => '',
      readImage: () => ({isEmpty: () => true}),
    },
  });
  const service = new ResourceCollectionService({
    stash: () => stash,
    projects: () => store.listProjects(),
    attach: (id, files) => {
      const p = store.getProject(id);
      store.updateProject(id, {
        sharedFiles: [...(p.sharedFiles || []), ...files],
      });
    },
    analyze: async () => {
      throw new Error('Not used');
    },
  });
  const item = await service.add({
    text: 'Original research note',
    title: 'A reference for the next task',
    projectId: project.id,
  });
  service.update(item.id, {summary: 'A concrete handoff for the next task'}, 1);
  await service.deliver(item.id);
  const delivered =
    require('../build/electron/resource_handoff').handoffsForTurn(
      service.projectInbox(project.id),
    );
  const task = store.appendTurn({
    newConversation: true,
    projectId: project.id,
    question: 'Read project references',
    request: {projectHandoffs: delivered},
    outcome: '已完成',
  });
  store.updateTurn({
    conversationId: task.id,
    turnIndex: 0,
    handoffsAcceptedAt: Date.now(),
  });
  store.flush();
  ipcMain.handle('resource-probe', async (_event, {action, input = {}}) => {
    try {
      if (action === 'project-inbox')
        return {
          ok: true,
          handoffs: service.projectInbox(input.projectId),
          handoffReceipts: store.handoffReceipts(input.projectId),
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
      if (action === 'preview')
        return {
          ok: true,
          preview: await service.preview(input.id, input.material),
        };
      return {ok: true, items: [], projects: []};
    } catch (error) {
      return {ok: false, error: error.message};
    }
  });
  const win = new BrowserWindow({
    width: 1320,
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
  const js = code => win.webContents.executeJavaScript(code);
  const wait = async code => {
    for (let i = 0; i < 100; i++) {
      if (await js(code)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('UI timeout: ' + code);
  };
  try {
    await win.loadFile(path.resolve('build/electron/renderer/studio.html'));
    await js(
      `Data.projects=async()=>[${JSON.stringify(store.getProject(project.id))}];Data.conversations=async()=>[];show('projects',${JSON.stringify(project.id)})`,
    );
    await wait('!!document.querySelector("[data-project-handoff]")');
    assert.equal(
      await js(
        'document.querySelector(".mp-project-handoff-receipt")?.dataset.open',
      ),
      task.id,
    );
    await js(
      'document.querySelector(".mp-project-compose textarea").value="Keep this unsent project idea";document.querySelector(".mp-project-compose textarea").dispatchEvent(new Event("input",{bubbles:true}))',
    );
    await js('document.querySelector("[data-handoff-read]").click()');
    await wait(
      'document.querySelector(".rl-preview pre")?.textContent.includes("A concrete handoff")',
    );
    await js('document.querySelector("[data-preview-close]").click()');
    await js('document.querySelector("[data-handoff-state=handled]").click()');
    await wait('!document.querySelector("[data-project-handoff]")');
    assert.equal(service.projectInbox(project.id)[0].state, 'handled');
    assert.equal(
      await js('document.querySelector(".mp-project-compose textarea").value'),
      'Keep this unsent project idea',
    );
    await js('document.querySelector("[data-handoff-filter=handled]").click()');
    await wait('!!document.querySelector("[data-project-handoff]")');
    await js('document.querySelector("[data-handoff-state=unread]").click()');
    await wait('!document.querySelector("[data-project-handoff]")');
    await js('document.querySelector("[data-handoff-filter=unread]").click()');
    await wait('!!document.querySelector("[data-project-handoff]")');
    await js('document.querySelector("[data-handoff-state=snoozed]").click()');
    await wait('!document.querySelector("[data-project-handoff]")');
    assert.equal(service.projectInbox(project.id)[0].state, 'snoozed');
    await js('document.querySelector("[data-handoff-filter=snoozed]").click()');
    await wait('!!document.querySelector("[data-project-handoff]")');
    await new Promise(resolve => setTimeout(resolve, 120));
    fs.writeFileSync(
      path.join(output, 'project-inbox-light.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    await js(
      'document.documentElement.dataset.theme="dark";document.documentElement.classList.add("dark")',
    );
    win.setSize(860, 820);
    await new Promise(resolve => setTimeout(resolve, 150));
    fs.writeFileSync(
      path.join(output, 'project-inbox-dark-narrow.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    const report = {
      ok: errors.length === 0,
      usedBackend:
        'production project workspace and resource service, real Stash and project files; no model',
      readback: true,
      handledPersisted: true,
      snoozePersisted: true,
      draftPreserved: true,
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
