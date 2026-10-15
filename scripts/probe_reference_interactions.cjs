'use strict';

const {app, BrowserWindow} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-reference-interactions-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const failures = [];
const output = path.resolve('data/runtime/open-claude-ui-20261014');
fs.mkdirSync(output, {recursive: true});
const deadline = setTimeout(() => app.exit(1), 40000);
const buildRoot = path.resolve('build/electron/renderer');

async function open(page, preload) {
  const win = new BrowserWindow({width: 1440, height: 900, useContentSize: true, show: false,
    webPreferences: {offscreen: true, sandbox: false, contextIsolation: preload !== 'scripts/probe_stage_input_preload.cjs', backgroundThrottling: false,
      ...(preload ? {preload: path.resolve(preload)} : {})}});
  win.webContents.on('console-message', event => {
    if (event.level === 'error') failures.push(page + ' renderer error: ' + event.message);
  });
  win.webContents.on('preload-error', (_event, _path, error) => failures.push(page + ' preload error: ' + error.message));
  await win.loadFile(path.join(buildRoot, page + '.html'));
  return win;
}

async function capture(win, name) {
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await new Promise(resolve => setTimeout(resolve, 250));
  const image = await win.webContents.capturePage(undefined, {stayHidden: true, stayAwake: true});
  fs.writeFileSync(path.join(output, name + '.png'), image.toPNG());
}

app.whenReady().then(async () => {
  try {
    const studio = await open('studio', 'scripts/probe_studio_layout_preload.js');
    failures.push(...await studio.webContents.executeJavaScript(`(() => {
      const failures = [];
      const check = (ok, message) => { if (!ok) failures.push(message); };
      show('chat');
      const form = document.getElementById('composer-form');
      const input = form.querySelector('textarea');
      let submitted = 0;
      let stopped = 0;
      form.requestSubmit = () => submitted++;
      stopActiveConversation = async () => { stopped++; };
      const key = (name, extra = {}) => {
        const event = new KeyboardEvent('keydown', {key: name, bubbles: true, cancelable: true, ...extra});
        input.dispatchEvent(event);
        return event;
      };
      input.value = '中文草稿';
      key('Enter', {keyCode: 229});
      key('Enter', {isComposing: true});
      check(submitted === 0, 'Studio IME confirmation submitted a draft');
      studioComposerBusy = true;
      externalConversationRun = {requestId: 'ime-running'};
      key('Escape', {isComposing: true});
      key('Escape', {keyCode: 229});
      check(stopped === 0, 'Studio IME cancellation stopped a task');
      const menu = document.getElementById('composer-add-menu');
      const rows = document.getElementById('composer-slash-rows');
      rows.innerHTML = '<button data-slash-name="help" class="is-active">Help</button><button data-slash-name="model">Model</button>';
      menu.hidden = false;
      for (const name of ['ArrowDown', 'Tab', 'Enter', 'Escape']) {
        const event = key(name, {isComposing: true});
        check(!event.defaultPrevented, 'Studio consumed native IME key: ' + name);
      }
      check(!menu.hidden && rows.firstElementChild.classList.contains('is-active'), 'IME keys changed the slash menu');
      check(input.value === '中文草稿', 'IME keys replaced the draft with a command');
      menu.hidden = true;
      studioComposerBusy = false;
      externalConversationRun = null;
      submitted = 0;
      key('Enter', {shiftKey: true});
      check(submitted === 0, 'Shift+Enter submitted a draft');
      key('Enter');
      check(submitted === 1, 'normal Enter no longer submits');
      return failures;
    })()`));
    failures.push(...await studio.webContents.executeJavaScript(`(async () => {
      const failures = [];
      const check = (ok, message) => { if (!ok) failures.push(message); };
      document.getElementById('studio-home').hidden = true;
      const scroller = document.getElementById('stream');
      scroller.hidden = false;
      const content = document.createElement('div');
      content.style.height = '2400px';
      document.getElementById('stream').replaceChildren(content);
      const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const bottom = () => { document.getElementById('scroll-pill').click(); };
      bottom();
      await settle();
      check(scroller.scrollHeight > scroller.clientHeight + 500, 'scroll fixture is not overflowing');
      scroller.dispatchEvent(new WheelEvent('wheel', {deltaY: -20, bubbles: true}));
      scroller.scrollTop -= 20;
      const readingPosition = scroller.scrollTop;
      followIfNearBottom(content, () => { content.style.height = '2600px'; });
      check(Math.abs(scroller.scrollTop - readingPosition) <= 1, 'streaming pulled a small upward scroll back to the bottom');
      scroller.scrollTop = readingPosition;
      await new Promise(resolve => setTimeout(resolve, 180));
      followIfNearBottom(content, () => { content.style.height = '2800px'; });
      check(Math.abs(scroller.scrollTop - readingPosition) <= 1, 'reading position was lost after the input cooldown');
      await settle();
      check(!document.getElementById('scroll-pill').hidden, 'jump to latest is missing while reading history');
      bottom();
      await settle();
      followIfNearBottom(content, () => { content.style.height = '3000px'; });
      check(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1, 'jump to latest did not restore streaming follow');
      scroller.dispatchEvent(new KeyboardEvent('keydown', {key: 'PageUp', bubbles: true}));
      const keyboardPosition = scroller.scrollTop;
      followIfNearBottom(content, () => { content.style.height = '3200px'; });
      check(Math.abs(scroller.scrollTop - keyboardPosition) <= 1, 'streaming raced ahead of a keyboard scroll');
      bottom();
      await settle();
      scroller.scrollTop -= 150;
      await settle();
      check(!document.getElementById('scroll-pill').hidden, 'jump to latest requires scrolling more than 120 pixels');
      return failures;
    })()`));
    await studio.webContents.executeJavaScript(`(() => {
      window.__resizeProbe = {stops: 0};
      stopActiveConversation = async () => { __resizeProbe.stops++; };
      studioComposerBusy = true;
      externalConversationRun = {requestId: 'resize-running'};
      setInspector(true, 'files');
      inspectorState = {...inspectorState, width: 560, previousWidth: 560};
      syncInspectorGeometry();
    })()`);
    const handlePoint = async () => studio.webContents.executeJavaScript(`(async () => {
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
      const rect = document.getElementById('inspector-resize-handle').getBoundingClientRect();
      return {x: Math.round(rect.right - 2), y: Math.round(rect.top + 80)};
    })()`);
    const start = await handlePoint();
    studio.webContents.sendInputEvent({type: 'mouseDown', ...start, button: 'left', clickCount: 1});
    studio.webContents.sendInputEvent({type: 'mouseMove', x: start.x + 2, y: start.y, modifiers: ['leftButtonDown'], movementX: 2, movementY: 0});
    await studio.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
    if (await studio.webContents.executeJavaScript('inspectorState.width !== 560')) failures.push('splitter resizes during a 2px click tremor');
    studio.webContents.sendInputEvent({type: 'mouseMove', x: start.x + 80, y: start.y, modifiers: ['leftButtonDown'], movementX: 78, movementY: 0});
    await studio.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
    const draggedWidth = await studio.webContents.executeJavaScript('inspectorState.width');
    if (Math.abs(draggedWidth - 480) > 1) failures.push('splitter did not follow the captured pointer: ' + draggedWidth);
    studio.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Escape'});
    failures.push(...await studio.webContents.executeJavaScript(`(() => {
      const failures = [];
      if (inspectorState.width !== 560 || localStorage.getItem('mp:inspector-width') !== '560') failures.push('Escape did not restore the split width');
      if (__resizeProbe.stops !== 0) failures.push('Escape during resize stopped the running task');
      const handle = document.getElementById('inspector-resize-handle');
      if (handle.dataset.dragging || shell.dataset.paneDragging) failures.push('cancelled resize kept pointer shields');
      if (handle.tabIndex !== 0 || handle.getAttribute('aria-valuenow') !== '560') failures.push('splitter has no keyboard and accessible value');
      handle.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
      if (inspectorState.width !== 572) failures.push('double click did not balance the two panes');
      handle.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowLeft', bubbles: true}));
      if (inspectorState.width !== 588) failures.push('keyboard cannot resize the right pane');
      handle.dispatchEvent(new KeyboardEvent('keydown', {key: 'Home', bubbles: true}));
      if (inspectorState.width !== 420) failures.push('keyboard resize ignored minimum width');
      handle.dispatchEvent(new KeyboardEvent('keydown', {key: 'End', bubbles: true}));
      if (inspectorState.width !== 724) failures.push('keyboard resize did not preserve the primary pane minimum');
      return failures;
    })()`));
    studio.webContents.sendInputEvent({type: 'mouseUp', x: start.x + 80, y: start.y, button: 'left', clickCount: 1});
    await studio.webContents.executeJavaScript(`(() => {
      inspectorState = {...inspectorState, width: 560, previousWidth: 560};
      latestBrowserViewState = {url: 'https://example.invalid/preview'};
      Data.browserViewCommand = async command => { __resizeProbe.commands = [...(__resizeProbe.commands || []), command]; return {ok: true}; };
      Data.resizeBrowserView = async () => { __resizeProbe.resizeCalls = (__resizeProbe.resizeCalls || 0) + 1; return {ok: true}; };
      setInspector(true, 'browser');
      document.getElementById('inspector-resize-handle').addEventListener('pointerdown', event => { __resizeProbe.pointerId = event.pointerId; }, {once: true});
    })()`);
    const browserStart = await handlePoint();
    await studio.webContents.executeJavaScript('__resizeProbe.resizeCalls = 0');
    studio.webContents.sendInputEvent({type: 'mouseDown', ...browserStart, button: 'left', clickCount: 1});
    studio.webContents.sendInputEvent({type: 'mouseMove', x: browserStart.x - 50, y: browserStart.y, modifiers: ['leftButtonDown']});
    await studio.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    failures.push(...await studio.webContents.executeJavaScript(`(async () => {
      const failures = [];
      const handle = document.getElementById('inspector-resize-handle');
      if (!__resizeProbe.commands?.includes('hide') || __resizeProbe.resizeCalls !== 0) failures.push('native browser was not suspended during resize');
      if (getComputedStyle(shell, '::after').content === 'none') failures.push('preview iframe has no pointer shield');
      handle.dispatchEvent(new PointerEvent('pointercancel', {pointerId: __resizeProbe.pointerId}));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (inspectorState.width !== 560 || shell.dataset.paneDragging || handle.hasPointerCapture(__resizeProbe.pointerId)) failures.push('pointer cancellation did not restore and release the splitter');
      if (!__resizeProbe.resizeCalls) failures.push('browser view was not restored after resize');
      return failures;
    })()`));
    studio.webContents.sendInputEvent({type: 'mouseUp', x: browserStart.x - 50, y: browserStart.y, button: 'left', clickCount: 1});
    for (const opener of [
      "openRenameDialog('modal-fixture', '原会话标题')",
      "void requestStudioText('编辑备注', '保留输入', 500)",
      "openInformationDialog('键盘操作', 'Tab 切换控件，Escape 关闭')",
      'confirmFullAccess()',
    ]) {
      await studio.webContents.executeJavaScript(`setInspector(false); document.querySelector('#composer-form textarea').focus(); ${opener};`);
      const contained = await studio.webContents.executeJavaScript(`(() => {
        const overlay = document.querySelector('.mpw-perm-confirm');
        document.getElementById('sidebar-toggle').focus();
        return overlay.contains(document.activeElement);
      })()`);
      if (!contained) failures.push('modal allows focus behind it: ' + opener);
      await studio.webContents.executeJavaScript("document.querySelector('.mpw-perm-confirm button')?.focus()");
      studio.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Escape'});
      await studio.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
      failures.push(...await studio.webContents.executeJavaScript(`(() => {
        const failures = [];
        if (document.querySelector('.mpw-perm-confirm')) failures.push('Escape left a modal open');
        if (__resizeProbe.stops) failures.push('modal Escape stopped the running task');
        if (document.activeElement !== document.querySelector('#composer-form textarea')) failures.push('modal did not restore the invoking focus');
        document.querySelectorAll('.mpw-perm-confirm').forEach(node => node.remove());
        __resizeProbe.stops = 0;
        return failures;
      })()`));
    }
    await studio.webContents.executeJavaScript(`(async () => {
      studioComposerBusy = false;
      externalConversationRun = null;
      Data.conversation = async () => ({id: 'reference-preview', title: 'UI 验证样例', turns: [{
        at: Date.now(), question: '核对输入、阅读与分栏的交互。',
        answer: '中文候选确认由输入法处理。\\n\\n向上阅读时保留当前位置；点击回到底部后继续跟随新消息。\\n\\n分栏支持 **Escape 撤销**、双击等分和键盘调整。',
      }]});
      Data.recovery = async () => ({ok: true, pendingRecovery: []});
      await openConversation('reference-preview');
      setInspector(true, 'files');
      document.getElementById('inspector-resize-handle').focus();
    })()`);
    await capture(studio, 'split-light');
    for (const theme of ['light', 'dark']) {
      await studio.webContents.executeJavaScript(`document.documentElement.dataset.theme = '${theme}'; document.body.toggleAttribute('data-ds-dark-theme', '${theme}' === 'dark'); openRenameDialog('reference-preview', 'UI 验证样例');`);
      await capture(studio, 'modal-' + theme);
      await studio.webContents.executeJavaScript("document.querySelector('dialog.mpw-perm-confirm').close(); new Promise(resolve => requestAnimationFrame(resolve))");
    }
    studio.setContentSize(760, 600);
    await studio.webContents.executeJavaScript("openInformationDialog('键盘操作', '方向键调整分栏，双击等分；Escape 关闭弹窗，不停止任务。')");
    const overflows = await studio.webContents.executeJavaScript('document.querySelector(".mpw-perm-confirm-card").getBoundingClientRect().right > innerWidth');
    if (overflows) failures.push('narrow modal overflows the viewport');
    await capture(studio, 'modal-narrow');
    studio.destroy();

    const stage = await open('stage', 'scripts/probe_stage_input_preload.cjs');
    failures.push(...await stage.webContents.executeJavaScript(`(() => {
      const failures = [];
      let submitted = 0;
      let dismissed = 0;
      magicPointerStage.submitSelectionCommand = () => { submitted++; return new Promise(() => {}); };
      magicPointerStage.dismiss = () => dismissed++;
      const showInput = () => __stageProbe.show({selectionSessionToken: 'ime-stage', groundingReady: true,
        target: {x: 180, y: 150, width: 120, height: 40},
        eventSequence: [{type: 'FREEZE'}, {type: 'OPEN_CAPSULE', mode: 'text'}]});
      for (const id of ['capsule-input', 'thread-followup']) {
        for (const extra of [{isComposing: true}, {keyCode: 229}]) {
          showInput();
          const input = document.getElementById(id);
          input.value = '尚未完成的中文';
          input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, ...extra}));
          input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, ...extra}));
          if (input.value !== '尚未完成的中文') failures.push('Stage IME confirmation cleared ' + id);
        }
      }
      if (submitted) failures.push('Stage IME confirmation submitted ' + submitted + ' commands');
      if (dismissed) failures.push('Stage IME cancellation dismissed the surface');
      showInput();
      const input = document.getElementById('capsule-input');
      input.value = '已完成输入';
      submitted = 0;
      input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
      if (submitted !== 1) failures.push('Stage normal Enter no longer submits');
      return failures;
    })()`));
    stage.destroy();

    const companion = await open('companion');
    failures.push(...await companion.webContents.executeJavaScript(`(() => {
      const failures = [];
      const form = document.querySelector('.mcomp');
      const input = form.querySelector('textarea');
      let submitted = 0;
      form.requestSubmit = () => submitted++;
      input.value = '随行草稿';
      for (const extra of [{isComposing: true}, {keyCode: 229}]) {
        input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, ...extra}));
      }
      if (submitted) failures.push('Companion IME confirmation submitted a draft');
      submitted = 0;
      input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
      if (submitted !== 1) failures.push('Companion normal Enter no longer submits');
      return failures;
    })()`));
    companion.destroy();
    assert.deepEqual(failures, []);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({failures, backend: 'isolated-electron-renderer', realModel: false}));
    console.log('Reference interactions passed: IME isolation, streaming scroll, pane resize and modal focus');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    app.exit(process.exitCode || 0);
  }
});
