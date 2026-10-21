'use strict';
const {app, BrowserWindow, ipcMain} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const output = path.resolve('data/runtime/title-membership');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 60000);
app.whenReady().then(async () => {
  const {
    createConversationStore,
  } = require('../build/electron/conversation_store');
  const baseDir = fs.mkdtempSync(path.join(output, 'history-'));
  const {
    EventSession,
    handleSession,
  } = require('../build/electron/runtime/session');
  const sourceSession = await EventSession.open(baseDir, 'agent-title-parent');
  const runtimeTurn = await sourceSession.startTurn();
  await sourceSession.appendMessage({
    role: 'user',
    content: 'Review the project',
  });
  await sourceSession.appendMessage({
    role: 'assistant',
    content: 'The checked facts are retained.',
  });
  await sourceSession.endTurn('completed');
  let tick = 1000;
  const {createProjectStore} = require('../build/electron/project_store');
  const rootlessProject = createProjectStore({
    baseDir,
    now: () => ++tick,
  }).create({name: 'Knowledge project'}).project;
  const store = createConversationStore({
    baseDir,
    deferPersist: true,
    now: () => ++tick,
  });
  const parent = store.appendTurn({
    newConversation: true,
    question: 'Review the project',
    answer: 'The checked facts are retained.',
    agentSessionId: sourceSession.id,
    runtimeTurn,
  });
  store.flush();
  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    show: false,
    webPreferences: {
      offscreen: true,
      sandbox: false,
      contextIsolation: true,
      preload: path.resolve('scripts/probe_title_membership_preload.cjs'),
      additionalArguments: [
        '--mp-probe-theme=light',
        '--mp-probe-state=landing',
      ],
    },
  });
  let failWrites = false;
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (
      failWrites &&
      String(destination) === path.join(baseDir, 'conversations.json')
    )
      throw new Error('Cannot replace conversation file');
    return rename(source, destination);
  };
  const main = fs.readFileSync('electron/main.ts', 'utf8');
  const ast = ts.createSourceFile(
    'main.ts',
    main,
    ts.ScriptTarget.Latest,
    true,
  );
  const statements = ast.statements.filter(
    node =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(ast) === 'ipcMain.handle' &&
      ["'conversations:rename'", "'conversations:branch'"].includes(
        node.expression.arguments[0].getText(ast),
      ),
  );
  assert.equal(statements.length, 2);
  vm.runInNewContext(
    ts.transpileModule(statements.map(node => node.getText(ast)).join('\n'), {
      compilerOptions: {target: ts.ScriptTarget.ES2022},
    }).outputText,
    {
      ipcMain,
      isDashboardSender: event => event.sender === win.webContents,
      conversations: () => store,
      dashboardWindow: win,
      crypto: require('node:crypto'),
      runRuntimeBridge: (payload, _script, _target, options) => {
        void handleSession(payload, baseDir).then(options.onComplete);
      },
    },
  );
  ipcMain.handle('title-membership:list', () => store.list());
  ipcMain.handle('title-membership:get', (_event, {id}) => store.get(id));
  ipcMain.handle('title-membership:projects', () => store.listProjects());
  const errors = [];
  const cases = [];
  win.webContents.on('console-message', event => {
    if (event.level === 'error') errors.push(event.message);
  });
  const js = code => win.webContents.executeJavaScript(code);
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
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
    await js(
      `setStudioLanguage('en');Data.conversations=()=>titleProbe.invoke('list');Data.conversation=id=>titleProbe.invoke('get',{id});Data.renameConversation=(id,title)=>titleProbe.invoke('rename',{id,title});Data.branchConversation=(id,turnIndex)=>titleProbe.invoke('branch',{id,turnIndex});Data.projects=async()=>[];void 0;`,
    );
    await js(`show('chat');openConversation(${JSON.stringify(parent.id)})`);
    const longTitle =
      'A carefully named project review with decisions and next steps'.slice(
        0,
        60,
      );
    await js(
      `openRenameDialog(${JSON.stringify(parent.id)},'Review the project');document.querySelector('.mpw-rename-input').value=${JSON.stringify(longTitle)};document.querySelector('.mpw-perm-confirm .is-primary').click();void 0;`,
    );
    await pause();
    await run(
      'a 60-character title survives real rename IPC and store reopen',
      async () => {
        assert.equal(
          createConversationStore({baseDir}).get(parent.id).title,
          longTitle,
        );
      },
    );
    await run('the title header shows the accepted saved value', async () => {
      assert.equal(
        await js('document.querySelector("#chat-title").textContent'),
        createConversationStore({baseDir}).get(parent.id).title,
      );
    });
    await run(
      'an explicitly detached project does not inherit its execution folder membership',
      async () => {
        assert.equal(
          await js(
            `buildSessionMenu({id:'detached',title:'Detached',projectId:'',workspaceRoot:'D:/retained-folder'}).querySelector('[data-session-action="remove-project"]')===null`,
          ),
          true,
        );
      },
    );
    await run(
      'a project without a local folder still has change and remove actions',
      async () => {
        assert.equal(
          await js(
            `(()=>{const menu=buildSessionMenu({id:'rootless',title:'Knowledge task',projectId:'project-knowledge',workspaceRoot:''});return !!menu.querySelector('[data-session-action="remove-project"]')&&menu.querySelector('[data-session-action="project"]').textContent.includes('Change project');})()`,
          ),
          true,
        );
      },
    );
    await run(
      'legacy folder membership keeps the existing project actions',
      async () => {
        assert.equal(
          await js(
            `!!buildSessionMenu({id:'legacy',title:'Legacy',workspaceRoot:'D:/legacy'}).querySelector('[data-session-action="remove-project"]')`,
          ),
          true,
        );
      },
    );
    failWrites = true;
    await run(
      'a failed per-message fork stays in the original chat with visible feedback',
      async () => {
        await js(
          `document.dispatchEvent(new CustomEvent('mp:branch-conversation',{detail:{conversationId:${JSON.stringify(parent.id)},turnIndex:0}}));void 0;`,
        );
        await pause();
        assert.equal(store.list().length, 1);
        assert.match(
          await js(
            'document.querySelector("#conversation-branch-error")?.textContent||""',
          ),
          /Could not create/,
        );
        assert.equal(
          await js(
            'document.querySelector("#conversation-branch-error").getBoundingClientRect().height>0',
          ),
          true,
        );
      },
    );
    await run(
      'the header fork uses the same visible failure behavior',
      async () => {
        await js(
          `document.querySelector('#conversation-branch-error')?.remove();openThreadMenu(document.querySelector('#thread-more'));[...document.querySelectorAll('#thread-menu button')].find(button=>button.querySelector('span')?.textContent==='Fork').click();void 0;`,
        );
        await pause();
        assert.match(
          await js(
            'document.querySelector("#conversation-branch-error")?.textContent||""',
          ),
          /Could not create/,
        );
      },
    );
    failWrites = false;
    await run(
      'retrying a fork opens a durable independent branch',
      async () => {
        await js(
          `document.dispatchEvent(new CustomEvent('mp:branch-conversation',{detail:{conversationId:${JSON.stringify(parent.id)},turnIndex:0}}));void 0;`,
        );
        await pause();
        const branch = store.list()[0];
        assert.notEqual(branch.id, parent.id);
        const forked = store.get(branch.id);
        const child = await EventSession.open(
          baseDir,
          forked.agentSessionId,
          false,
        );
        assert.equal(forked.taskContext.taskId, child.id);
        assert.equal(
          child.deriveMessages().at(-1).content,
          'The checked facts are retained.',
        );
        assert.equal(sourceSession.deriveMessages().length, 2);
        assert.equal(
          createConversationStore({baseDir}).get(branch.id)?.turns[0].answer,
          'The checked facts are retained.',
        );
        assert.equal(
          await js(
            'document.querySelector("#conversation-branch-error")===null',
          ),
          true,
        );
        assert.equal(
          await js('document.querySelector("#chat-title").textContent'),
          branch.title,
        );
      },
    );
    await run(
      'a real rootless project has the correct rendered sidebar menu',
      async () => {
        const branch = store.list()[0];
        assert.equal(store.setProject(branch.id, rootlessProject.id).ok, true);
        await js(
          `Data.projects=()=>titleProbe.invoke('projects');renderSidebar()`,
        );
        await js(`openConversation(${JSON.stringify(branch.id)})`);
        await js(
          `document.querySelector('[data-session-menu="${branch.id}"]').click();void 0;`,
        );
        assert.equal(
          await js(
            `(()=>{const menu=document.querySelector('[data-for-session="${branch.id}"]');return !menu.hidden&&!!menu.querySelector('[data-session-action="remove-project"]');})()`,
          ),
          true,
        );
      },
    );
    await pause();
    fs.writeFileSync(
      path.join(output, 'title-menu-light.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    await js(
      `document.documentElement.dataset.theme='dark';document.documentElement.classList.add('dark');void 0;`,
    );
    win.setSize(860, 820);
    await pause();
    fs.writeFileSync(
      path.join(output, 'title-menu-dark-narrow.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    await run(
      'Companion loads the selected summary as a full conversation',
      async () => {
        const companion = new BrowserWindow({
          width: 620,
          height: 720,
          show: false,
          webPreferences: {
            offscreen: true,
            sandbox: false,
            contextIsolation: true,
            preload: path.resolve('scripts/probe_title_membership_preload.cjs'),
          },
        });
        await companion.loadFile(
          path.resolve('build/electron/renderer/companion.html'),
        );
        await companion.webContents.executeJavaScript(
          `window.__listReads=0;Data.conversations=()=>{window.__listReads++;return titleProbe.invoke('list');};Data.conversation=id=>titleProbe.invoke('get',{id});renderConversation(null)`,
        );
        assert.match(
          await companion.webContents.executeJavaScript(
            'document.body.textContent',
          ),
          /The checked facts are retained/,
        );
        await companion.webContents.executeJavaScript(
          `renderConversation(${JSON.stringify(store.list()[0].id)})`,
        );
        assert.equal(
          await companion.webContents.executeJavaScript('window.__listReads'),
          1,
          'an explicit conversation does not require rereading the list',
        );
        companion.destroy();
      },
    );
    const report = {
      ok: cases.every(row => row.ok) && !errors.length,
      usedBackend:
        'production Studio/Companion and main IPC handlers, real conversation store and in-process MP handleSession/EventSession fork; isolated fixture without model or external application effects',
      cases,
      errors,
    };
    fs.writeFileSync(
      path.join(output, 'renderer-result.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.ok ? 0 : 1);
  } catch (error) {
    console.error(error);
    fs.writeFileSync(
      path.join(output, 'probe-error.txt'),
      String(error.stack || error),
    );
    app.exit(1);
  } finally {
    fs.renameSync = rename;
    clearTimeout(deadline);
  }
});
