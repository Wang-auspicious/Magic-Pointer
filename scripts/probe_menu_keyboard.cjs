'use strict';
const {app, BrowserWindow} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve('data/runtime/menu-keyboard');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 30000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    show: true,
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      preload: path.resolve('scripts/probe_studio_layout_preload.js'),
      additionalArguments: ['--mp-probe-state=landing'],
    },
  });
  try {
    await win.loadFile(path.resolve('build/electron/renderer/studio.html'));
    win.focus();
    const evaluate = code => win.webContents.executeJavaScript(code);
    const expect = async (expression, message) =>
      assert.ok(await evaluate(expression), message);
    const press = async (keyCode, modifiers = []) => {
      win.webContents.sendInputEvent({type: 'keyDown', keyCode, modifiers});
      if (keyCode === 'ENTER') {
        win.webContents.sendInputEvent({
          type: 'char',
          keyCode: '\r',
          modifiers,
        });
      }
      win.webContents.sendInputEvent({type: 'keyUp', keyCode, modifiers});
      await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    };
    const cases = [];
    const run = async (name, operation) => {
      await evaluate(
        `closeWindowMenu();closeThreadMenu();closeSidebarMenu();closeAccountMenu();window.__menuStops=0;`,
      );
      try {
        await operation();
        cases.push({name, ok: true});
      } catch (error) {
        cases.push({name, ok: false, error: error.message});
      }
    };
    await evaluate(`show('chat');setStudioHomeVisible(false);applyStudioLanguage('en');closeStudioPopovers();
      window.__menuStops=0;window.__menuKeys=[];stopActiveConversation=async()=>{__menuStops++;};studioComposerBusy=true;pendingConversation={requestId:'menu-probe',body:document.createElement('div')};
      window.addEventListener('keydown',event=>__menuKeys.push({key:event.key,trusted:event.isTrusted,repeat:event.repeat}),true);
      window.__visibleRows=id=>[...document.getElementById(id).querySelectorAll('button:not(:disabled)')].filter(button=>button.getClientRects().length);void 0;`);
    for (const [trigger, menu] of [
      ['app-menu', 'window-menu-popover'],
      ['thread-more', 'thread-menu'],
      ['sidebar-more', 'sidebar-menu'],
    ]) {
      await run(
        `${trigger} enters its visible menu items and supports wrapping, Home and End`,
        async () => {
          await evaluate(`document.getElementById('${trigger}').focus()`);
          await press('ENTER');
          await expect(
            `document.activeElement===__visibleRows('${menu}')[0] && document.hasFocus() && document.activeElement.matches(':focus-visible')`,
            'Opening did not enter the first visible menu action',
          );
          await press('UP');
          await expect(
            `document.activeElement===__visibleRows('${menu}').at(-1)`,
            'ArrowUp did not wrap to the last enabled action',
          );
          await press('DOWN');
          await expect(
            `document.activeElement===__visibleRows('${menu}')[0]`,
            'ArrowDown did not wrap to the first action',
          );
          await press('END');
          await expect(
            `document.activeElement===__visibleRows('${menu}').at(-1)`,
            'End did not enter the last action',
          );
          await press('HOME');
          await expect(
            `document.activeElement===__visibleRows('${menu}')[0]`,
            'Home did not enter the first action',
          );
        },
      );
    }
    for (const [trigger, menu] of [
      ['app-menu', 'window-menu-popover'],
      ['thread-more', 'thread-menu'],
    ]) {
      await run(
        `${menu} Escape restores its trigger without stopping the task`,
        async () => {
          await evaluate(
            `document.getElementById('${trigger}').click();__visibleRows('${menu}')[0].focus()`,
          );
          await press('ESCAPE');
          await expect(
            `(!document.getElementById('${menu}') || document.getElementById('${menu}').hidden) && document.activeElement===document.getElementById('${trigger}') && __menuStops===0`,
            'Dismissal lost trigger focus or entered task Stop',
          );
        },
      );
    }
    await run(
      'Sidebar More Escape dismisses only its menu and retains a deliberate chat Stop',
      async () => {
        await evaluate(
          `document.getElementById('sidebar-more').click();__visibleRows('sidebar-menu')[0].focus()`,
        );
        await press('ESCAPE');
        await expect(
          `!document.getElementById('sidebar-menu') && document.activeElement===document.getElementById('sidebar-more') && __menuStops===0`,
          'More Escape stopped the task or left its menu open',
        );
        await press('ESCAPE', ['isautorepeat']);
        await expect(
          '__menuStops===0',
          'Held Escape stopped the task after dismissing More',
        );
        await evaluate(
          `document.querySelector('#composer-form textarea').focus()`,
        );
        await press('ESCAPE');
        await expect(
          '__menuStops===1',
          'A new Escape no longer stops from the chat',
        );
      },
    );
    const account = async () => {
      await evaluate(
        `document.getElementById('account-footer').click();new Promise(resolve=>requestAnimationFrame(resolve))`,
      );
      await evaluate(
        `document.querySelector('[data-account-command=language]').focus()`,
      );
    };
    await run(
      'Account ArrowRight opens and enters its language submenu',
      async () => {
        await account();
        await press('RIGHT');
        await expect(
          `!document.getElementById('account-submenu').hidden && document.activeElement===document.querySelector('#account-submenu button') && document.querySelector('[data-account-command=language]').getAttribute('aria-expanded')==='true'`,
          'ArrowRight did not open the focused submenu',
        );
      },
    );
    await run(
      'Account ArrowLeft closes the child and returns to its parent item',
      async () => {
        await account();
        await evaluate(
          `document.querySelector('[data-account-command=language]').click()`,
        );
        await press('LEFT');
        await expect(
          `document.getElementById('account-submenu').hidden && !document.getElementById('account-menu').hidden && document.activeElement===document.querySelector('[data-account-command=language]') && document.activeElement.getAttribute('aria-expanded')==='false'`,
          'ArrowLeft did not return to the open parent menu',
        );
      },
    );
    await run(
      'Account Escape closes one layer and repeated Escape does not close the parent',
      async () => {
        await account();
        await evaluate(
          `document.querySelector('[data-account-command=language]').click()`,
        );
        await press('ESCAPE');
        await expect(
          `document.getElementById('account-submenu').hidden && !document.getElementById('account-menu').hidden && document.activeElement===document.querySelector('[data-account-command=language]')`,
          'Child Escape closed its parent or lost its parent item',
        );
        await press('ESCAPE', ['isautorepeat']);
        await expect(
          `!document.getElementById('account-menu').hidden && __menuStops===0`,
          'Repeated Escape dismissed another layer',
        );
        await press('ESCAPE');
        await expect(
          `document.getElementById('account-menu').hidden && document.activeElement===document.getElementById('account-footer') && __menuStops===0`,
          'New Escape did not dismiss the parent safely',
        );
      },
    );
    await run(
      'Tab dismisses the window menu and moves to the next toolbar control',
      async () => {
        await evaluate(
          `document.getElementById('app-menu').click();__visibleRows('window-menu-popover')[0].focus()`,
        );
        await press('TAB');
        await expect(
          `document.getElementById('window-menu-popover').hidden && document.activeElement===document.getElementById('sidebar-toggle') && __menuStops===0`,
          'Tab left the menu open or lost its normal toolbar order',
        );
      },
    );
    for (const [trigger, menu, label] of [
      ['thread-more', 'thread-menu', 'Terminal'],
      ['app-menu', 'window-menu-popover', 'Toggle bottom panel'],
    ]) {
      await run(
        `${menu} command keeps its trigger as the terminal return target`,
        async () => {
          await evaluate(
            `setBottomPanel(false);document.getElementById('${trigger}').click();[...document.querySelectorAll('#${menu} button')].find(button=>button.querySelector('span')?.textContent==='${label}').focus()`,
          );
          await press('ENTER');
          await expect(
            `document.activeElement.id==='bottom-terminal-input' && !document.getElementById('bottom-panel').hidden`,
            'Menu command did not enter its terminal',
          );
          await press('ESCAPE');
          await expect(
            `document.activeElement===document.getElementById('${trigger}') && __menuStops===0`,
            'Panel lost the menu command origin when closing',
          );
        },
      );
    }
    await run(
      'A native language-menu action returns focus to the account footer',
      async () => {
        await account();
        await evaluate(
          `document.querySelector('[data-account-command=language]').click();document.querySelectorAll('#account-submenu button')[1].focus()`,
        );
        await press('ENTER');
        await expect(
          `getStudioLanguage()==='zh-CN' && document.getElementById('account-menu').hidden && document.activeElement===document.getElementById('account-footer')`,
          'Language selection hid the focused menu item without returning focus',
        );
      },
    );
    const result = {
      ok: cases.every(item => item.ok),
      usedBackend:
        'production compiled Studio in a visible focused Chromium window, trusted native Enter/char/arrows/Home/End/Tab/Escape; controlled Stop counter, no model/worker/external actions',
      cases,
      keys: await evaluate('__menuKeys'),
    };
    fs.writeFileSync(
      path.join(output, 'renderer-result.json'),
      JSON.stringify(result, null, 2),
    );
    await evaluate(
      `closeStudioPopovers();document.getElementById('app-menu').click();applyTheme('light');new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
    );
    await evaluate(
      `Promise.all(document.getAnimations().filter(animation=>animation instanceof CSSTransition).map(animation=>animation.finished.catch(()=>{})))`,
    );
    fs.writeFileSync(
      path.join(output, 'window-menu-light.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    win.setContentSize(860, 900);
    await evaluate(
      `closeWindowMenu();openAccountMenu();new Promise(resolve=>requestAnimationFrame(resolve))`,
    );
    await evaluate(
      `openAccountSubmenu('language');applyTheme('dark');new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
    );
    await evaluate(
      `Promise.all(document.getAnimations().filter(animation=>animation instanceof CSSTransition).map(animation=>animation.finished.catch(()=>{})))`,
    );
    fs.writeFileSync(
      path.join(output, 'account-child-dark-narrow.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    console.log(JSON.stringify(result));
    clearTimeout(deadline);
    win.destroy();
    app.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    win.destroy();
    app.exit(1);
  }
});
