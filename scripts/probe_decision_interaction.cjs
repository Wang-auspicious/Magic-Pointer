'use strict';

const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const ts = require('typescript');

const output = path.resolve('data/runtime/decision-interaction');
const useSource = process.env.MP_PROBE_USE_SOURCE === '1';
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 30000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1040,
    height: 800,
    show: false,
    webPreferences: {offscreen: true, contextIsolation: true, sandbox: true},
  });
  try {
    const renderer = path.resolve('build/electron/renderer');
    const styleUrl = pathToFileURL(
      path.join(renderer, 'decision_card.css'),
    ).href;
    const fixture = path.join(output, 'fixture.html');
    fs.writeFileSync(
      fixture,
      `<!doctype html><html><head><meta charset="utf-8">
      <link rel="stylesheet" href="${styleUrl}"><style>
      :root {--mp-text:#282723;--mp-text-muted:#73716b;--mp-panel:#faf9f5;--mp-rule:#dad8d0;--mp-hover:#efeee9;--mp-clay:#c6613f;--mp-r8:8px}
      [data-theme="dark"] {--mp-text:#eeeae2;--mp-text-muted:#aaa79f;--mp-panel:#292824;--mp-rule:#49473f;--mp-hover:#39372f}
      body {background:var(--mp-panel);font:14px/1.5 system-ui;color:var(--mp-text);margin:40px}
      #host {width:min(700px,100%);margin:40px auto} #outside {margin:0 auto;display:block}
      </style></head><body><button id="outside">Outside the question</button><div id="host"></div></body></html>`,
    );
    await win.loadFile(fixture);
    const rendererScripts = [];
    for (const name of ['locale', 'decision_card']) {
      const script = useSource
        ? ts.transpileModule(
            fs.readFileSync(`electron/renderer/${name}.ts`, 'utf8'),
            {
              compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.None,
              },
            },
          ).outputText
        : fs.readFileSync(path.join(renderer, `${name}.js`), 'utf8');
      rendererScripts.push(script);
      await win.webContents.executeJavaScript(script);
    }
    const result = await win.webContents.executeJavaScript(`(async () => {
      const host = document.getElementById('host');
      const cases = [];
      const check = (ok, message) => {if (!ok) throw new Error(message);};
      const run = async (name, test) => {
        DecisionCard.clear(host, true);
        applyStudioLanguage('en');
        document.getElementById('outside').focus();
        try {await test(); cases.push({name, ok:true});}
        catch (error) {cases.push({name, ok:false, error:error.message});}
      };
      const render = (request, submit = () => {}) => DecisionCard.render(host, {presentation:'inline', ...request}, submit);
      await run('English permission card uses the selected interface language', () => {
        render({key:'language-permission', kind:'permission', tool:'Bash', actionPreview:'npm test'});
        check(host.querySelector('.mp-decision-eyebrow').textContent === 'Your permission is needed', 'English permission heading is still Chinese');
        host.querySelector('[data-decision="once"]').click();
        check(host.querySelector('[role="status"]').textContent.includes('Saving'), 'saving status ignores English');
      });
      await run('Other belongs to the single choice group with one Tab entry', () => {
        render({key:'radio-group', questions:[{question:'Format?', options:[{label:'Report'}, {label:'Slides'}]}]});
        const group = host.querySelector('[role="radiogroup"]');
        const radios = [...group.querySelectorAll('[role="radio"]')];
        check(radios.length === 3, 'Other is outside the question radio group');
        check(radios.filter(radio => radio.tabIndex === 0).length === 1, 'every radio requires a separate Tab stop');
        host.querySelector('[data-option-index="1"]').click();
        check([...host.querySelectorAll('[role="radio"]')].filter(radio => radio.tabIndex === 0).length === 1
          && host.querySelector('[data-option-index="1"]').tabIndex === 0, 'selected answer is not the Tab entry');
      });
      await run('Arrow keys and Home/End select a radio and keep focus in its question', () => {
        render({key:'radio-keys', questions:[{question:'Format?', options:[{label:'Report'}, {label:'Slides'}]}]});
        const key = name => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:name, bubbles:true, cancelable:true}));
        host.querySelector('[data-option-index="0"]').focus();
        key('ArrowDown');
        check(document.activeElement.dataset.optionIndex === '1'
          && document.activeElement.getAttribute('aria-checked') === 'true', 'ArrowDown does not select and focus next answer');
        key('End');
        check(document.activeElement.classList.contains('mp-decision-other-choice')
          && document.activeElement.getAttribute('aria-checked') === 'true', 'End does not reach Other');
        key('ArrowRight');
        check(document.activeElement.dataset.optionIndex === '0', 'ArrowRight does not wrap to first answer');
        key('ArrowLeft');
        check(document.activeElement.classList.contains('mp-decision-other-choice'), 'ArrowLeft does not wrap to Other');
        key('Home');
        check(document.activeElement.dataset.optionIndex === '0', 'Home does not reach first answer');
      });
      await run('Question pagination keeps keyboard focus and preserves each page answer', () => {
        render({key:'pages', questions:[
          {question:'Format?', options:[{label:'Report'}, {label:'Slides'}]},
          {question:'Include?', multiSelect:true, options:[{label:'Charts'}, {label:'Sources'}]},
        ]});
        host.querySelector('[data-option-index="1"]').click();
        const next = host.querySelector('[data-question-next]');
        next.focus(); next.click();
        check(host.contains(document.activeElement)
          && document.activeElement.dataset.optionIndex === '0', 'Next removes focus from the card');
        host.querySelector('[aria-label="Previous question"]').click();
        check(document.activeElement.dataset.optionIndex === '1'
          && document.activeElement.getAttribute('aria-checked') === 'true', 'previous page does not restore selected answer focus');
      });
      await run('Saving keeps the action visible and disables duplicate approval', () => {
        let submissions = 0;
        render({key:'saving-context', kind:'permission', tool:'Bash', actionPreview:'npm test && npm run build'}, () => submissions++);
        const once = host.querySelector('[data-decision="once"]');
        once.focus(); once.click();
        check(host.textContent.includes('npm test && npm run build'), 'saving replaces the action with an empty status');
        check([...host.querySelectorAll('button')].every(button => button.disabled), 'a pending approval remains enabled');
        host.querySelector('[data-decision="once"]').click();
        check(submissions === 1, 'approval submitted twice');
        check(document.activeElement.getAttribute('role') === 'status', 'saving loses keyboard focus');
      });
      await run('Failed saving returns focus to the submitted action without stealing outside focus', () => {
        render({key:'retry-focus', kind:'permission', tool:'Bash', actionPreview:'npm test'});
        let once = host.querySelector('[data-decision="once"]');
        once.focus(); once.click();
        DecisionCard.pending(host, false, 'Disk unavailable');
        check(document.activeElement.dataset.decision === 'once'
          && !document.activeElement.disabled && host.querySelector('[role="alert"]').textContent === 'Disk unavailable', 'failed save does not restore the retry action focus');
        once = host.querySelector('[data-decision="once"]');
        once.click();
        const outside = document.getElementById('outside'); outside.focus();
        DecisionCard.pending(host, false, 'Still unavailable');
        check(document.activeElement === outside, 'late failure steals focus from another control');
      });
      await run('Changing language updates a pending question without losing its typed answer or selection', () => {
        const request = {key:'language-live', questions:[{question:'Keep this original question', options:[{label:'Keep this original option'}]}]};
        render(request);
        host.querySelector('.mp-decision-other-choice').click();
        const custom = host.querySelector('textarea');
        custom.value = 'My edited answer'; custom.dispatchEvent(new Event('input', {bubbles:true}));
        custom.setSelectionRange(3, 9, 'backward');
        applyStudioLanguage('zh-CN'); render(request);
        check(host.querySelector('[data-question-submit]').textContent === '提交'
          && host.querySelector('.mp-decision-other-label').textContent === '其他', 'pending question controls stay in the old language');
        const next = host.querySelector('textarea');
        check(next.value === 'My edited answer' && document.activeElement === next
          && next.selectionStart === 3 && next.selectionEnd === 9 && next.selectionDirection === 'backward', 'language change loses answer focus or selection');
        check(host.textContent.includes('Keep this original question') && host.textContent.includes('Keep this original option')
          && host.querySelector('.mp-decision-card').getAttribute('aria-label') === 'Magic Pointer 的提问', 'interface language changed source text or left an obsolete accessible label');
      });
      await run('Chinese history approval explains the selectable time and saved-task scope', () => {
        applyStudioLanguage('zh-CN');
        render({key:'scope-language', kind:'permission', tool:'DailyWrap.read', options:['本次允许', '拒绝'],
          action:{tool:'DailyWrap.read', arguments:{from_ms:1789228800000, to_ms:1789315200000, conversation_ids:['task-a'], limit:12}},
          historySources:[{id:'task-a', title:'Original task title'}]});
        check(host.querySelector('.mp-decision-scope-title').textContent === '选择要读取的时间和已保存任务'
          && host.querySelector('[type="search"]').placeholder === '查找已保存任务', 'history scope controls ignore Chinese');
        check(host.textContent.includes('最多读取 12 条记录。') && host.textContent.includes('已选择 1 项')
          && host.textContent.includes('Original task title'), 'scope count or source title is incorrect');
        render({key:'recall-language', kind:'permission', tool:'Recall', action:{tool:'Recall', arguments:{session_id:'task-a', event_seq:4}}});
        check(host.querySelector('.mp-decision-scope-title').textContent === '本次授权范围'
          && host.querySelector('dt').textContent === '来源', 'read-only recall scope labels ignore Chinese');
      });
      await run('A missing-answer validation message follows a language change', () => {
        const request = {key:'validation-language', questions:[
          {question:'First?', options:[{label:'One'}]}, {question:'Second?', options:[{label:'Two'}]},
        ]};
        render(request);
        host.querySelector('[aria-label="Next question"]').click();
        host.querySelector('[data-option-index="0"]').click();
        host.querySelector('[data-question-submit]').click();
        check(host.querySelector('[role="alert"]').textContent.includes('Choose an answer'), 'missing first answer is not explained');
        applyStudioLanguage('zh-CN'); render(request);
        check(host.querySelector('[role="alert"]').textContent === '请选择一个回答，或明确跳过此题。', 'validation message stays in the old language');
      });
      return {ok:cases.every(item => item.ok), usedBackend:'production DecisionCard and locale in native Chromium; isolated fixture, no IPC, model or external effect', sourceTranspiled:${useSource}, cases};
    })()`);
    const localeWindow = new BrowserWindow({
      show: false,
      webPreferences: {offscreen: true, sandbox: true},
    });
    try {
      await win.webContents.executeJavaScript(
        "localStorage.setItem('mp:language:v1', 'zh-CN')",
      );
      await localeWindow.loadFile(fixture);
      const localeScript = useSource
        ? ts.transpileModule(
            fs.readFileSync('electron/renderer/locale.ts', 'utf8'),
            {
              compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.None,
              },
            },
          ).outputText
        : fs.readFileSync(path.join(renderer, 'locale.js'), 'utf8');
      await localeWindow.webContents.executeJavaScript(localeScript);
      const restored = await localeWindow.webContents.executeJavaScript(
        "getStudioLanguage() === 'zh-CN' && document.documentElement.lang === 'zh-CN'",
      );
      result.cases.push({
        name: 'New renderer restores the saved interface language',
        ok: restored,
      });
      result.ok = result.cases.every(item => item.ok);
    } finally {
      localeWindow.destroy();
    }
    const focusedWindow = new BrowserWindow({
      width: 900,
      height: 720,
      show: true,
      webPreferences: {contextIsolation: true, sandbox: true},
    });
    try {
      await focusedWindow.loadFile(fixture);
      for (const script of rendererScripts) {
        await focusedWindow.webContents.executeJavaScript(script);
      }
      focusedWindow.show();
      focusedWindow.focus();
      await focusedWindow.webContents
        .executeJavaScript(`applyStudioLanguage('en');
        DecisionCard.render(document.getElementById('host'), {key:'native-keyboard', presentation:'inline', questions:[
          {question:'How should the result be delivered?', options:[{label:'Report', description:'One editable document'}, {label:'Slides', description:'A presentation'}]}
        ]}, () => {});
        document.querySelector('[data-option-index="0"]').focus();`);
      const press = async keyCode => {
        focusedWindow.webContents.sendInputEvent({type: 'keyDown', keyCode});
        if (keyCode === 'Enter') {
          focusedWindow.webContents.sendInputEvent({
            type: 'char',
            keyCode: '\r',
          });
        }
        focusedWindow.webContents.sendInputEvent({type: 'keyUp', keyCode});
        await focusedWindow.webContents.executeJavaScript(
          'new Promise(resolve => requestAnimationFrame(resolve))',
        );
      };
      await press('Down');
      const radioFocus = await focusedWindow.webContents.executeJavaScript(`({
        documentFocus:document.hasFocus(), answer:document.activeElement.dataset.optionIndex,
        checked:document.activeElement.getAttribute('aria-checked'),
        focusVisible:document.activeElement.matches(':focus-visible'),
        outline:getComputedStyle(document.activeElement).outlineWidth
      })`);
      await press('Tab');
      const tabLeavesGroup = await focusedWindow.webContents.executeJavaScript(
        "document.activeElement.hasAttribute('data-question-skip')",
      );
      result.nativeKeyboard = {...radioFocus, tabLeavesGroup};
      result.cases.push({
        name: 'Native arrow selection has a visible focus ring and Tab leaves the single-choice group',
        ok:
          radioFocus.documentFocus &&
          radioFocus.answer === '1' &&
          radioFocus.checked === 'true' &&
          radioFocus.focusVisible &&
          radioFocus.outline === '2px' &&
          tabLeavesGroup,
      });
      fs.writeFileSync(
        path.join(output, 'question-light.png'),
        await captureSettled(focusedWindow),
      );
      focusedWindow.setContentSize(600, 700);
      await focusedWindow.webContents
        .executeJavaScript(`document.documentElement.dataset.theme='dark'; applyStudioLanguage('zh-CN');
        DecisionCard.render(document.getElementById('host'), {key:'native-saving',kind:'permission',presentation:'inline',tool:'Bash',
          actionPreview:'npm test && npm run build', question:'允许运行项目检查吗？',options:['仅这一次允许','本次会话允许','拒绝']}, () => {});
        document.querySelector('[data-decision="once"]').focus();`);
      await press('Enter');
      const saving = await focusedWindow.webContents.executeJavaScript(`({
        focused:document.activeElement.getAttribute('role') === 'status',
        command:document.querySelector('.mp-decision-command')?.textContent,
        disabled:[...document.querySelectorAll('#host button')].every(button => button.disabled),
        inside:document.querySelector('.mp-decision-card').getBoundingClientRect().right <= innerWidth
      })`);
      result.nativeSaving = saving;
      result.cases.push({
        name: 'Native Enter approval keeps preview and saving focus in a narrow dark window',
        ok:
          saving.focused &&
          saving.command === 'npm test && npm run build' &&
          saving.disabled &&
          saving.inside,
      });
      fs.writeFileSync(
        path.join(output, 'saving-dark-narrow.png'),
        await captureSettled(focusedWindow),
      );
      result.ok = result.cases.every(item => item.ok);
    } finally {
      focusedWindow.destroy();
    }
    fs.writeFileSync(
      path.join(
        output,
        useSource ? 'source-result.json' : 'renderer-result.json',
      ),
      JSON.stringify(result, null, 2),
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

async function captureSettled(window) {
  await window.webContents
    .executeJavaScript(`Promise.all(document.getAnimations()
    .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {})))`);
  return (await window.webContents.capturePage()).toPNG();
}
