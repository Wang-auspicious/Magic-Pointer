'use strict';
const {app, BrowserWindow, ipcMain} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve('data/runtime/resource-acceptance');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 60000);
app.whenReady().then(async () => {
  const {ResourceCollectionService} = require('../build/electron/resource_collection_service');
  const {createStashRuntime} = require('../build/electron/stash_runtime');
  const baseDir = fs.mkdtempSync(path.join(output, 'stash-'));
  const root = fs.mkdtempSync(path.join(output, 'project-'));
  const stash = createStashRuntime({baseDir, clipboard: {availableFormats: () => [], readText: () => '', readImage: () => ({isEmpty: () => true})}});
  const attached = [];
  const projects = [{id: 'ui', name: '界面设计', root}];
  const service = new ResourceCollectionService({stash: () => stash, projects: () => projects,
    attach: (_id, files) => attached.push(...files),
    analyze: async () => ({ok: true, usedBackend: 'fixture.runtime', timingMs: 3, answer: JSON.stringify({summary: '侧栏在拖动时保持连续运动。适合作为当前项目导航切换的参考。', nextStep: '对照现有侧栏，试做可中断的弹簧动效。', coverage: '仅阅读用户保存的选文。', decision: 'keep'})}),
  });
  await service.add({text: 'A small detail: preserve velocity when an animation changes direction.', title: '可以随时打断的侧栏动效', url: 'https://example.com/motion', projectId: 'ui'});
  await service.add({text: 'A paper reading note about evidence and retrieval.', title: '给下一篇论文留一条线索'});
  ipcMain.handle('resource-probe', async (_event, {action, input}) => {
    try {
      if (action === 'list') return {ok: true, items: service.list(), projects, source: {status: 'disconnected'}};
      if (action === 'add') return {ok: true, entry: await service.add(input)};
      if (action === 'edit') return {ok: true, entry: service.update(input.id, input.patch, input.revision)};
      if (action === 'process') return {ok: true, entry: await service.process(input.id)};
      if (action === 'deliver') return {ok: true, entry: await service.deliver(input.id)};
      throw new Error('Not exercised: ' + action);
    } catch (error) {return {ok: false, error: error.message};}
  });
  const win = new BrowserWindow({width: 1360, height: 920, show: false, webPreferences: {offscreen: true, sandbox: false, contextIsolation: true, preload: path.resolve('scripts/probe_studio_layout_preload.js'), additionalArguments: ['--mp-probe-theme=light', '--mp-probe-state=landing']}});
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => {if (level >= 3) errors.push(message);});
  const js = script => win.webContents.executeJavaScript(script);
  const wait = async expression => {for (let i = 0; i < 100; i++) {if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 50));} throw new Error('UI timeout: ' + expression);};
  const screenshot = async name => {
    await new Promise(resolve => setTimeout(resolve, 400));
    fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await win.loadFile(path.resolve('build/electron/renderer/studio.html'));
    await js('document.fonts.ready');
    await js("document.documentElement.lang='zh-CN'; setProductMode('design');");
    assert.equal(await js("document.querySelector('.mp-shell').dataset.view"), 'chat');
    assert.equal(await js("document.querySelector('.mp-shell').dataset.productMode"), 'design');
    await screenshot('work-light.png');
    await js("show('resources')");
    await wait("document.querySelectorAll('.rl-item').length === 2");
    await screenshot('library-light.png');
    await js("[...document.querySelectorAll('.rl-item')].find(e => e.textContent.includes('侧栏')).click()");
    await wait("!!document.querySelector('[data-rl-edit]')");
    await js("document.querySelector('[name=note]').value = '只做参考，不直接复刻'; document.querySelector('[name=note]').dispatchEvent(new Event('input',{bubbles:true})); show('chat'); show('resources');");
    assert.equal(await js("document.querySelector('[name=note]').value"), '只做参考，不直接复刻');
    await js("document.querySelector('[data-rl-edit]').requestSubmit()");
    await wait("document.querySelector('[data-resource-status]').textContent.includes('修改已保存')");
    await js("document.querySelector('[data-rl-action=process]').click()");
    await wait("document.querySelector('[name=summary]').value.includes('连续运动')");
    await js("document.querySelector('[data-rl-action=deliver]').click()");
    await wait("document.querySelector('[data-resource-status]').textContent.includes('下次任务')");
    assert.ok(attached.some(file => file.endsWith('handoff.md') && fs.readFileSync(file, 'utf8').includes('连续运动')));
    await screenshot('detail-light.png');
    await js("document.documentElement.dataset.theme='dark'; document.documentElement.classList.add('dark');");
    await screenshot('detail-dark.png');
    win.setSize(860, 820);
    await screenshot('detail-narrow.png');
    await js("document.querySelector('[data-rl-tab=browser]').click()");
    await screenshot('browser.png');
    await js("document.querySelector('[data-rl-tab=sources]').click()");
    await screenshot('sources.png');
    const result = {ok: true, usedBackend: 'electron UI + real local resource service; analysis fixture', resourceCount: service.list().length, projectFiles: attached.length, errors};
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    app.exit(0);
  } catch (error) {console.error(error); console.error(await js("document.querySelector('[data-resource-status]')?.textContent")); console.error(errors); await screenshot('failure.png'); app.exit(1);}
  finally {clearTimeout(deadline);}
});
