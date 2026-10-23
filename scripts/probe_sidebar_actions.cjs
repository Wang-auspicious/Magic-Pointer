'use strict';
const {app, BrowserWindow, ipcMain} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const output = path.resolve('data/runtime/sidebar-actions-10');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 60000);
app.whenReady().then(async () => {
  const {
    createConversationStore,
  } = require('../build/electron/conversation_store');
  const {
    EventSession,
    handleSession,
  } = require('../build/electron/runtime/session');
  const baseDir = fs.mkdtempSync(path.join(output, 'history-'));
  const session = await EventSession.open(baseDir, 'agent-sidebar-parent');
  const runtimeTurn = await session.startTurn();
  await session.appendMessage({
    role: 'user',
    content: 'Keep this parent context',
  });
  await session.appendMessage({role: 'assistant', content: 'Original answer'});
  await session.endTurn('completed');
  const store = createConversationStore({baseDir});
  const parent = store.appendTurn({
    newConversation: true,
    question: 'Sidebar action test',
    answer: 'Original answer',
    agentSessionId: session.id,
    runtimeTurn,
  });
  store.flush();
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    webPreferences: {
      offscreen: true,
      sandbox: false,
      contextIsolation: true,
      preload: path.resolve('scripts/probe_title_membership_preload.cjs'),
      additionalArguments: [
        '--mp-probe-state=landing',
        '--mp-probe-theme=light',
      ],
    },
  });
  const main = fs.readFileSync('electron/main.ts', 'utf8');
  const ast = ts.createSourceFile(
    'main.ts',
    main,
    ts.ScriptTarget.Latest,
    true,
  );
  const handler = ast.statements.find(
    n =>
      ts.isExpressionStatement(n) &&
      ts.isCallExpression(n.expression) &&
      n.expression.expression.getText(ast) === 'ipcMain.handle' &&
      n.expression.arguments[0].getText(ast) === "'conversations:branch'",
  );
  let forkRequests = 0;
  let releaseFork;
  let forkGate = Promise.resolve();
  let failFork = false;
  vm.runInNewContext(
    ts.transpileModule(handler.getText(ast), {
      compilerOptions: {target: ts.ScriptTarget.ES2022},
    }).outputText,
    {
      ipcMain,
      isDashboardSender: e => e.sender === win.webContents,
      conversations: () => store,
      dashboardWindow: win,
      crypto: require('node:crypto'),
      runRuntimeBridge: (payload, _script, _target, options) => {
        forkRequests++;
        void forkGate
          .then(() =>
            failFork
              ? {ok: false, error: 'session_busy'}
              : handleSession(payload, baseDir),
          )
          .then(options.onComplete);
      },
    },
  );
  ipcMain.handle('title-membership:list', () => store.list());
  ipcMain.handle('title-membership:get', (_e, {id}) => store.get(id));
  const js = code => win.webContents.executeJavaScript(code);
  const pause = () => new Promise(r => setTimeout(r, 120));
  const pointer = async selector => {
    const point = await js(
      `(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing '+${JSON.stringify(selector)});const r=n.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML}})()`,
    );
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      x: point.x,
      y: point.y,
    });
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      x: point.x,
      y: point.y,
    });
    await pause();
    return point;
  };
  const cases = [];
  const errors = [];
  const run = async (name, fn) => {
    try {
      await fn();
      cases.push({name, ok: true});
    } catch (e) {
      cases.push({name, ok: false, error: e.stack});
    }
  };
  try {
    await win.loadFile(path.resolve('build/electron/renderer/studio.html'));
    await js(
      `(async()=>{setStudioLanguage('en');Data.conversations=()=>titleProbe.invoke('list');Data.conversation=id=>titleProbe.invoke('get',{id});Data.branchConversation=(id,turnIndex)=>titleProbe.invoke('branch',{id,turnIndex});Data.projects=async()=>[];await openConversation(${JSON.stringify(parent.id)});await renderSidebar();})()`,
    );
    const row = `.side-item[data-open="${parent.id}"]`;
    await run(
      'pointer Mark as unread persists and visibly marks the original row',
      async () => {
        await pointer(`${row} [data-session-menu]`);
        assert.match(
          await js(
            `document.querySelector('.side-session-menu:not([hidden]) [data-session-action=read]').textContent`,
          ),
          /Mark as unread/,
        );
        await pointer(
          '.side-session-menu:not([hidden]) [data-session-action=read]',
        );
        assert.equal(
          await js(
            `studioLibraries.sessionPreference(${JSON.stringify(parent.id)}).seenAt`,
          ),
          0,
        );
        assert.equal(
          await js(
            `document.querySelector(${JSON.stringify(row)}).dataset.unread`,
          ),
          'true',
        );
        assert.equal(
          await js(
            `(()=>{const n=document.querySelector(${JSON.stringify(row + ' .side-unread')});return !!n&&n.getBoundingClientRect().width===6&&n.getBoundingClientRect().height===6&&getComputedStyle(n).backgroundColor!=='rgba(0, 0, 0, 0)'})()`,
          ),
          true,
        );
      },
    );
    await run(
      'unread survives a renderer reload and Mark as read and opening clear it',
      async () => {
        const loaded = new Promise(resolve =>
          win.webContents.once('did-finish-load', resolve),
        );
        win.webContents.reload();
        await loaded;
        await js(
          `(async()=>{setStudioLanguage('en');Data.conversations=()=>titleProbe.invoke('list');Data.conversation=id=>titleProbe.invoke('get',{id});Data.branchConversation=(id,turnIndex)=>titleProbe.invoke('branch',{id,turnIndex});Data.projects=async()=>[];await renderSidebar();})()`,
        );
        assert.equal(
          await js(
            `document.querySelector(${JSON.stringify(row)}).dataset.unread`,
          ),
          'true',
        );
        await pointer(`${row} [data-session-menu]`);
        assert.match(
          await js(
            `document.querySelector('.side-session-menu:not([hidden]) [data-session-action=read]').textContent`,
          ),
          /Mark as read/,
        );
        await pointer(
          '.side-session-menu:not([hidden]) [data-session-action=read]',
        );
        assert.equal(
          await js(
            `document.querySelector(${JSON.stringify(row)}).dataset.unread`,
          ),
          'false',
        );
        await pointer(`${row} [data-session-menu]`);
        await pointer(
          '.side-session-menu:not([hidden]) [data-session-action=read]',
        );
        assert.equal(
          await js(
            `document.querySelector(${JSON.stringify(row)}).dataset.unread`,
          ),
          'true',
        );
        await pointer(row);
        assert.equal(
          await js(
            `document.querySelector(${JSON.stringify(row)}).dataset.unread`,
          ),
          'false',
        );
        assert.equal(
          await js(
            `!!document.querySelector(${JSON.stringify(row + ' .side-unread')})`,
          ),
          false,
        );
      },
    );
    await run(
      'pointer Fork invokes the real main handler and creates and opens an independent durable runtime',
      async () => {
        await pointer(`${row} [data-session-menu]`);
        forkGate = new Promise(resolve => {
          releaseFork = resolve;
        });
        await pointer(
          '.side-session-menu:not([hidden]) [data-session-action=fork]',
        );
        let progressError;
        try {
          assert.match(
            await js(
              `document.querySelector('#conversation-branch-progress')?.textContent||''`,
            ),
            /Creating/,
          );
          await js(
            `void branchConversationFromUi(${JSON.stringify(parent.id)},0)`,
          );
          await pause();
          assert.equal(
            forkRequests,
            1,
            'a pending fork must not start a duplicate runtime',
          );
        } catch (e) {
          progressError = e;
        } finally {
          releaseFork();
        }
        for (let i = 0; i < 40 && store.list().length === 1; i++) await pause();
        assert.equal(forkRequests, 1);
        assert.equal(store.list().length, 2);
        const child = store.list().find(c => c.id !== parent.id);
        assert.equal(await js('activeConversationId'), child.id);
        const saved = createConversationStore({baseDir}).get(child.id);
        assert.notEqual(saved.agentSessionId, parent.agentSessionId);
        assert.equal(saved.turns[0].answer, 'Original answer');
        const childSession = await EventSession.open(
          baseDir,
          saved.agentSessionId,
        );
        assert.equal(childSession.deriveMessages().length, 2);
        assert.equal(store.get(parent.id).turns.length, 1);
        if (progressError) throw progressError;
      },
    );
    await run(
      'fork failure remains visible, preserves the current chat, and allows a real retry',
      async () => {
        const before = await js('activeConversationId');
        const count = store.list().length;
        failFork = true;
        await pointer(`${row} [data-session-menu]`);
        await pointer(
          '.side-session-menu:not([hidden]) [data-session-action=fork]',
        );
        assert.equal(store.list().length, count);
        assert.equal(await js('activeConversationId'), before);
        assert.match(
          await js(
            `document.querySelector('#conversation-branch-error')?.textContent||''`,
          ),
          /session_busy/,
        );
        assert.equal(
          await js(`!!document.querySelector('#conversation-branch-progress')`),
          false,
        );
        failFork = false;
        await pointer(`${row} [data-session-menu]`);
        assert.equal(
          await js(
            `document.querySelector('.side-session-menu:not([hidden]) [data-session-action=fork]').disabled`,
          ),
          false,
        );
        await pointer(
          '.side-session-menu:not([hidden]) [data-session-action=fork]',
        );
        for (let i = 0; i < 40 && store.list().length === count; i++)
          await pause();
        assert.equal(store.list().length, count + 1);
        assert.equal(
          await js(`!!document.querySelector('#conversation-branch-error')`),
          false,
        );
      },
    );
    await run(
      'a failed source read is reported rather than becoming an unhandled silent click',
      async () => {
        await js(
          `Data.conversation=async()=>{throw Error('Source unavailable')};void branchConversationFromUi(${JSON.stringify(parent.id)})`,
        );
        await pause();
        assert.match(
          await js(
            `document.querySelector('#conversation-branch-error')?.textContent||''`,
          ),
          /Source unavailable/,
        );
        assert.equal(
          await js(`!!document.querySelector('#conversation-branch-progress')`),
          false,
        );
        await js(
          `Data.conversation=id=>titleProbe.invoke('get',{id});document.querySelector('#conversation-branch-error').remove()`,
        );
      },
    );
    fs.writeFileSync(
      path.join(output, 'result.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
  } catch (e) {
    errors.push(e.stack);
  }
  const result = {
    cases,
    errors,
    forkRequests,
    usedBackend:
      'Compiled Studio pointer events, production main branch handler, real isolated ConversationStore and MP EventSession fork; no model or user data writes',
  };
  fs.writeFileSync(
    path.join(output, process.env.MP_ACTION_PHASE || 'result') + '.json',
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  clearTimeout(deadline);
  win.destroy();
  app.exit(cases.every(c => c.ok) && !errors.length ? 0 : 1);
});
