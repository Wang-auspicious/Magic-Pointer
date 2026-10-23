'use strict';
const {app, BrowserWindow, ipcMain} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const output = path.resolve('data/runtime/permission-receipt');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 60000);
app.whenReady().then(async () => {
  const {
    createConversationStore,
  } = require('../build/electron/conversation_store');
  const {
    handleSession,
    handleSessionRead,
  } = require('../build/electron/runtime/session');
  const {
    studioConversationSessionId,
  } = require('../build/electron/agent_session_id');
  const permissions = require('../build/electron/permission_mode');
  const baseDir = fs.mkdtempSync(path.join(output, 'history-'));
  let tick = Date.now();
  let store = createConversationStore({baseDir, now: () => ++tick});
  const conversation = store.appendTurn({
    newConversation: true,
    question: 'Keep the selected mode',
    answer: 'The task history remains intact.',
    outcome: '已完成',
  });
  const waiting = store.appendTurn({
    newConversation: true,
    question: 'Choose the report format',
    outcome: '等待输入',
    pendingInput: {
      kind: 'ask',
      requestId: 'locale-question',
      question: 'Which format?',
    },
  });
  const sessionId = studioConversationSessionId({
    conversationId: conversation.id,
  });
  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    show: false,
    webPreferences: {
      offscreen: true,
      sandbox: false,
      contextIsolation: true,
      preload: path.resolve('scripts/probe_permission_receipt_preload.cjs'),
      additionalArguments: [
        '--mp-probe-theme=light',
        '--mp-probe-state=landing',
      ],
    },
  });
  const source = fs.readFileSync('electron/main.ts', 'utf8');
  const ast = ts.createSourceFile(
    'main.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const selected = ast.statements.filter(
    node =>
      (ts.isFunctionDeclaration(node) &&
        ['setConversationPermission', 'restoreConversationContext'].includes(
          node.name?.text || '',
        )) ||
      (ts.isExpressionStatement(node) &&
        ts.isCallExpression(node.expression) &&
        node.expression.expression.getText(ast) === 'ipcMain.handle' &&
        node.expression.arguments[0].getText(ast) ===
          "'conversations:set-permission'"),
  );
  const context = {
    ...permissions,
    fs,
    path,
    FABRIC_DATA_DIR: baseDir,
    studioConversationSessionId,
    handleSession,
    handleSessionRead,
    restoredContextUsage: new Map(),
    ipcMain,
    isDashboardSender: event => event.sender === win.webContents,
    conversations: () => store,
    notifyConversationChanged() {},
  };
  vm.runInNewContext(
    ts.transpileModule(selected.map(node => node.getText(ast)).join('\n'), {
      compilerOptions: {target: ts.ScriptTarget.ES2022},
    }).outputText,
    context,
  );
  ipcMain.handle('permission-probe:list', () => store.list());
  ipcMain.handle('permission-probe:get', (_event, {id}) =>
    context.restoreConversationContext(store.get(id)),
  );
  let blockIndex = false;
  let blockJournal = false;
  let failSync = false;
  const rename = fs.renameSync;
  const open = fs.promises.open;
  fs.renameSync = (from, to) => {
    if (blockIndex && String(to) === path.join(baseDir, 'conversations.json'))
      throw new Error('Conversation file is locked');
    return rename(from, to);
  };
  fs.promises.open = async (file, flags, ...args) => {
    if (
      blockJournal &&
      String(file) ===
        path.join(baseDir, 'agent-sessions', `${sessionId}.jsonl`) &&
      flags === 'a'
    )
      throw new Error('Session journal unavailable');
    const handle = await open(file, flags, ...args);
    if (
      failSync &&
      String(file) ===
        path.join(baseDir, 'agent-sessions', `${sessionId}.jsonl`) &&
      flags === 'a'
    ) {
      handle.sync = async () => {
        throw new Error('Journal sync failed');
      };
    }
    return handle;
  };
  const errors = [];
  const cases = [];
  win.webContents.on('console-message', event => {
    if (event.level === 'error') errors.push(event.message);
  });
  const js = code => win.webContents.executeJavaScript(code);
  const pause = () => new Promise(resolve => setTimeout(resolve, 120));
  const run = async (name, check) => {
    try {
      await check();
      cases.push({name, ok: true});
    } catch (error) {
      cases.push({name, ok: false, error: error.message});
    }
  };
  const choose = async preset => {
    await js(
      `openPermissionMenu();document.querySelector('[data-perm-value="${preset}"]').click();void 0;`,
    );
    await pause();
  };
  const status = () =>
    handleSessionRead({action: 'status', sessionId}, baseDir);
  try {
    await win.loadFile(path.resolve('build/electron/renderer/studio.html'));
    await js(
      `setStudioLanguage('en');Data.conversations=()=>permissionProbe.call('list');Data.conversation=id=>permissionProbe.call('get',{id});Data.projects=async()=>[];Data.setConversationPermission=(id,preset)=>permissionProbe.call('select',{id,preset});show('chat');openConversation(${JSON.stringify(conversation.id)})`,
    );
    blockIndex = true;
    await choose('plan');
    await run(
      'a committed mode remains selected when the conversation file cannot be saved',
      async () => {
        assert.equal((await status()).permissionMode, 'plan');
        assert.equal(
          await js(
            'document.querySelector("#composer-permission-label").textContent',
          ),
          'Plan',
        );
        assert.equal(
          await js('document.querySelector("#composer-permission").disabled'),
          false,
        );
        assert.match(
          await js(
            'document.querySelector("#composer-permission-menu").textContent',
          ),
          /Selected mode is active.*could not be saved/,
        );
        assert.equal(
          await js('!!document.querySelector("[data-permission-retry]")'),
          true,
          'the applied mode can retry saving without changing modes',
        );
        assert.equal(
          await js(
            'document.activeElement===document.querySelector("[data-permission-retry]")',
          ),
          true,
          'the recovery action is ready for keyboard use',
        );
        assert.equal(
          await js(
            'document.querySelector("#composer-permission-menu [role=status]").getBoundingClientRect().height>0',
          ),
          true,
        );
      },
    );
    await pause();
    fs.writeFileSync(
      path.join(output, 'permission-warning-light.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    blockIndex = false;
    store = createConversationStore({baseDir});
    await run(
      'reopening repairs a missing conversation-to-Session link from the committed journal',
      async () => {
        assert.equal(store.get(conversation.id).agentSessionId, undefined);
        await js(
          `closePermissionMenu();openConversation(${JSON.stringify(conversation.id)})`,
        );
        assert.equal(store.get(conversation.id).agentSessionId, sessionId);
        assert.equal(
          createConversationStore({baseDir}).get(conversation.id).taskContext
            .permissionMode,
          'plan',
        );
        assert.equal(
          await js(
            'document.querySelector("#composer-permission-label").textContent',
          ),
          'Plan',
        );
      },
    );
    await choose('read-only');
    await run(
      'retrying another mode confirms the saved projection and journal agree',
      async () => {
        assert.equal((await status()).permissionMode, 'safe');
        assert.equal(
          createConversationStore({baseDir}).get(conversation.id).taskContext
            .permissionMode,
          'safe',
        );
        assert.equal(
          await js(
            'document.querySelector("#composer-permission").getAttribute("aria-busy")',
          ),
          'false',
        );
      },
    );
    blockJournal = true;
    await choose('plan');
    await run(
      'a failed journal append leaves the actual and visible previous mode unchanged',
      async () => {
        assert.equal((await status()).permissionMode, 'safe');
        assert.notEqual(
          await js(
            'document.querySelector("#composer-permission-label").textContent',
          ),
          'Plan',
        );
        assert.match(
          await js(
            'document.querySelector("#composer-permission-menu").textContent',
          ),
          /Session journal unavailable/,
        );
      },
    );
    blockJournal = false;
    failSync = true;
    await choose('plan');
    await run(
      'a failed journal sync reports the mode visible in the completed journal line',
      async () => {
        assert.equal((await status()).permissionMode, 'plan');
        assert.equal(
          await js(
            'document.querySelector("#composer-permission-label").textContent',
          ),
          'Plan',
        );
        assert.match(
          await js(
            'document.querySelector("#composer-permission-menu").textContent',
          ),
          /permission record could not be confirmed/,
        );
      },
    );
    failSync = false;
    await run(
      'the retry action confirms the same active mode without requiring a different selection',
      async () => {
        await js(
          'document.querySelector("[data-permission-retry]").click();void 0;',
        );
        await pause();
        assert.equal((await status()).permissionMode, 'plan');
        assert.equal(
          await js(
            'document.querySelector("#composer-permission-menu").hidden',
          ),
          true,
        );
      },
    );
    await js(
      `closePermissionMenu();setStudioLanguage('zh-CN');renderSidebar()`,
    );
    await run(
      'the real pending sidebar row follows the Chinese locale',
      async () => {
        assert.equal(
          await js(
            `document.querySelector('[data-open="${waiting.id}"] .side-state-label').textContent`,
          ),
          '需要输入',
        );
      },
    );
    blockIndex = true;
    await choose('read-only');
    await run(
      'the applied-but-unsaved receipt is localized without reverting the new mode',
      async () => {
        assert.equal((await status()).permissionMode, 'safe');
        assert.match(
          await js(
            'document.querySelector("#composer-permission-menu").textContent',
          ),
          /所选权限模式已生效.*未能保存/,
        );
      },
    );
    await js(
      `document.documentElement.dataset.theme='dark';document.documentElement.classList.add('dark');void 0;`,
    );
    win.setSize(860, 820);
    await pause();
    await run(
      'an open mode receipt stays inside the resized viewport',
      async () => {
        assert.equal(
          await js(
            '(()=>{const box=document.querySelector("#composer-permission-menu").getBoundingClientRect();return box.top>=0&&box.bottom<=innerHeight;})()',
          ),
          true,
        );
      },
    );
    fs.writeFileSync(
      path.join(output, 'permission-warning-dark-narrow.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    blockIndex = false;
    await run(
      'retrying the localized save repairs the index and clears the warning',
      async () => {
        await js(
          'document.querySelector("[data-permission-retry]").click();void 0;',
        );
        await pause();
        assert.equal(
          createConversationStore({baseDir}).get(conversation.id).taskContext
            .permissionMode,
          'safe',
        );
        assert.equal(
          await js(
            'document.querySelector("#composer-permission-menu").hidden',
          ),
          true,
        );
      },
    );
    const report = {
      ok: cases.every(row => row.ok) && !errors.length,
      usedBackend:
        'production Studio, permission IPC functions, real conversation store and in-process MP Session journal; controlled filesystem failures, no model or external application effect',
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
    fs.writeFileSync(
      path.join(output, 'probe-error.json'),
      JSON.stringify({error: error.message, cases, errors}, null, 2),
    );
    console.error(error);
    app.exit(1);
  } finally {
    fs.renameSync = rename;
    fs.promises.open = open;
    clearTimeout(deadline);
  }
});
