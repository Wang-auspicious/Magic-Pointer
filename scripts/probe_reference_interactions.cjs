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
const deadline = setTimeout(() => app.exit(1), 40000);
const buildRoot = path.resolve('build/electron/renderer');

async function open(page, preload) {
  const win = new BrowserWindow({width: 1440, height: 900, show: false,
    webPreferences: {offscreen: true, sandbox: false, contextIsolation: false, backgroundThrottling: false,
      ...(preload ? {preload: path.resolve(preload)} : {})}});
  await win.loadFile(path.join(buildRoot, page + '.html'));
  return win;
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
    console.log('Reference interactions passed: IME isolation and streaming scroll');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    app.exit(process.exitCode || 0);
  }
});
