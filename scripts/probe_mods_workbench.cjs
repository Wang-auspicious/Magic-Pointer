const {app, BrowserWindow, ipcMain} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const {buildSync} = require('esbuild');
require('tsx/cjs');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'data/runtime/mods-workbench-ui');
const fixture = path.join(out, `fixture-${Date.now()}`);
fs.mkdirSync(fixture, {recursive: true});
app.setPath('userData', path.join(fixture, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => app.exit(2), 180000);
const workerChildren = new Set();
app.on('will-quit', () => {
  for (const child of workerChildren) child.kill();
});
const probePreload = path.join(fixture, 'preload.cjs');
buildSync({
  entryPoints: [path.join(root, 'electron/preload.ts')],
  outfile: probePreload,
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  external: ['electron'],
});

app.whenReady().then(async () => {
  const {EventSession} = require(
    path.join(root, 'electron/runtime/session.ts'),
  );
  const {updateContext} = require(
    path.join(root, 'electron/runtime/context.ts'),
  );
  const {createRuntimeBridgeRunner} = require(
    path.join(root, 'electron/runtime_bridge_runner.ts'),
  );
  const {saveDashboard} = require(
    path.join(root, 'electron/runtime/dashboard.ts'),
  );
  const {RuntimeActivitySink} = require(
    path.join(root, 'electron/runtime/agent_activity.ts'),
  );
  const nodeExecutable = process.env.MP_ACCEPTANCE_NODE;
  assert(
    nodeExecutable && fs.existsSync(nodeExecutable),
    'MP_ACCEPTANCE_NODE must point to the real Node executable',
  );
  const session = await EventSession.open(
    fixture,
    'agent-studio-new-ui-modules',
  );
  const note = path.join(fixture, 'source-note.txt');
  fs.writeFileSync(note, 'The latest evidence is 173 orders.');
  const csv = path.join(fixture, 'sales.csv');
  fs.writeFileSync(csv, 'region,revenue\nNorth,12\nSouth,18\n');
  const dashboard = await saveDashboard(fixture, {
    schemaVersion: 1,
    dashboardId: '',
    title: 'Sales',
    updatedAt: '',
    sources: [{sourceId: 'sales', kind: 'csv', path: csv}],
    charts: [
      {
        chartId: 'revenue',
        title: 'Revenue',
        type: 'kpi',
        select: {source: 'sales', value: 'revenue', agg: 'sum'},
      },
    ],
  });
  const folder = path.join(fixture, 'data/plugins/source-note');
  fs.mkdirSync(folder, {recursive: true});
  fs.writeFileSync(
    path.join(folder, 'plugin.json'),
    JSON.stringify({name: 'source-note', main: 'plugin.cjs'}),
  );
  fs.writeFileSync(
    path.join(folder, 'plugin.cjs'),
    `module.exports={name:'source-note',inject:['modules'],apply(ctx){ctx.get('modules').register({id:'source-note',title:'Source note',commands:[{id:'read',label:'Read source note',tool:{description:'Read the task source note',input_schema:{type:'object',properties:{},required:[]},effect:'read',used_backend:'fixture.local_note',access_for:()=>({action:'read',paths:[${JSON.stringify(note)}]}),execute:async()=>({text:await require('node:fs/promises').readFile(${JSON.stringify(note)},'utf8')})}}],panels:[{id:'note',render:()=>({id:'note',title:'Source note',status:{state:'ready'},sections:[{id:'source',rows:[{id:'name',label:'Source',value:'source-note.txt'}],actions:[{id:'read',label:'Read latest note',primary:true}]}]}),actions:{read:{commandId:'read'}}}]});}};`,
  );
  await updateContext(session, {
    sources: [
      {
        sourceId: 'report',
        taskId: session.id,
        kind: 'file',
        title: 'Quarterly report',
        identity: {path: path.join(fixture, 'report.txt')},
        revision: {},
        capabilities: ['read'],
        origin: 'user-attached',
        parentSourceId: null,
      },
    ],
  });
  await session.append('plan/updated', {
    plan: [{content: 'Reconcile orders against the report', status: 'pending'}],
  });
  const conversation = {
    id: 'mods-conversation',
    title: 'Order reconciliation',
    agentSessionId: session.id,
    workspaceRoot: '',
    projectId: '',
    updatedAt: Date.now(),
    turns: [
      {
        at: Date.now(),
        question: 'Reconcile the order report',
        answer: 'Isolated UI acceptance; no model request.',
      },
    ],
  };
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    useContentSize: true,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      offscreen: true,
      backgroundThrottling: false,
      preload: probePreload,
    },
  });
  const errors = [];
  const requests = [];
  win.webContents.on('preload-error', (_event, _path, error) =>
    errors.push(error.message),
  );
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(String(message));
  });
  const source = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');
  const ast = ts.createSourceFile(
    'main.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const owned = ['modules:list', 'modules:invoke'];
  const registrations = owned.map(channel => {
    const node = ast.statements.find(
      node =>
        ts.isExpressionStatement(node) &&
        ts.isCallExpression(node.expression) &&
        node.expression.arguments.some(
          arg => ts.isStringLiteral(arg) && arg.text === channel,
        ),
    );
    assert(node, `production ${channel} handler`);
    return node.getText(ast);
  });
  const context = vm.createContext({
    ipcMain: {
      handle(channel, handler) {
        ipcMain.handle(channel, (...args) => {
          requests.push({channel, payload: args[1]});
          return handler(...args);
        });
      },
    },
    isDashboardSender: event => event.sender === win.webContents,
    conversations: () => ({
      get: id => (id === conversation.id ? conversation : undefined),
    }),
    runRuntimeBridgePromise: payload => {
      const request = {runtime: payload, workerPid: null, progress: []};
      requests.push(request);
      return new Promise(resolve => {
        let child;
        child = createRuntimeBridgeRunner().run({
          executable: nodeExecutable,
          args: [
            '--require',
            'tsx/cjs',
            path.join(root, 'electron/runtime/worker.ts'),
            'fabric',
          ],
          input: {...payload, root},
          spawnOptions: {
            cwd: root,
            windowsHide: true,
            env: {
              ...process.env,
              MAGIC_POINTER_USER_DATA_DIR: fixture,
              MAGIC_POINTER_PLUGIN_DIR: path.join(fixture, 'data/plugins'),
            },
          },
          timeoutMs: 30000,
          onProgress: record => request.progress.push(record.phase),
          onComplete: result => {
            workerChildren.delete(child);
            resolve(result);
          },
        });
        request.workerPid = child.pid;
        workerChildren.add(child);
      });
    },
  });
  const helpers = ['handleModuleWorkspace'];
  const functions = helpers.flatMap(name => {
    const node = ast.statements.find(
      node => ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    return node ? [node.getText(ast)] : [];
  });
  vm.runInContext(
    ts.transpileModule([...functions, ...registrations].join('\n'), {
      compilerOptions: {target: ts.ScriptTarget.ES2022},
    }).outputText,
    context,
  );
  const fixtures = {
    'conversations:list': () => [conversation],
    'conversations:get': () => conversation,
    'conversations:stats': () => null,
    'conversations:recovery': () => ({ok: true, pending: []}),
    'conversations:subagents': () => ({ok: true, tasks: []}),
    'dashboard:settings:get': () => ({
      ok: true,
      settings: {appearance: {theme: 'light'}},
      modelStatus: {},
    }),
    'models:catalog': () => ({
      ok: true,
      catalog: {current: 'fixture', groups: []},
    }),
    'models:quota': () => ({ok: false, error: 'No model in UI acceptance'}),
    'slash:directory': () => ({items: [], commands: [], skills: []}),
    'updates:status': () => ({state: 'idle'}),
    'projects:environment': () => ({ok: true, isGit: false}),
    'figma:status': () => ({ok: true, connected: false}),
    'desktop-perception:status': () => ({
      paused: false,
      onboardingRequired: false,
      wakeMode: 'hotkey',
      detectWiggle: false,
      detectMouseButton: false,
      polling: false,
      hotkeys: [],
    }),
  };
  const unrelatedInvocations = [];
  for (const match of fs
    .readFileSync(path.join(root, 'electron/preload.ts'), 'utf8')
    .matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)) {
    const channel = match[1];
    if (owned.includes(channel)) continue;
    owned.push(channel);
    ipcMain.handle(channel, () => {
      unrelatedInvocations.push(channel);
      return fixtures[channel]?.() ?? [];
    });
  }
  const js = code => win.webContents.executeJavaScript(code);
  const checks = [];
  const check = (value, message) => {
    assert(value, message);
    checks.push(message);
  };
  async function waitFor(expression) {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (await js(expression).catch(() => false)) return;
      await delay(40);
    }
    throw Error(`Timed out: ${expression}`);
  }
  try {
    await win.loadFile(path.join(root, 'build/electron/renderer/studio.html'));
    await waitFor("typeof openConversation==='function'");
    await js("openConversation('mods-conversation')");
    await js("document.getElementById('thread-more').click()");
    check(
      await js(
        "Array.from(document.querySelectorAll('#thread-menu button')).some(button=>button.textContent.trim()==='Mods'&&!button.disabled)",
      ),
      'real conversation More menu exposes the module workspace',
    );
    await js(
      "Array.from(document.querySelectorAll('#thread-menu button')).find(button=>button.textContent.trim()==='Mods').click()",
    );
    await waitFor(
      "document.querySelector('[data-mod-panel=task-context]')!==null",
    );
    await js("document.querySelector('[data-mod-panel=task-context]').click()");
    check(
      await js(
        "document.querySelector('.mp-mods-header').getBoundingClientRect().left-document.querySelector('.mp-mods-workspace').getBoundingClientRect().left>=12",
      ),
      'workspace content has readable inset inside the production inspector',
    );
    check(
      await js(
        "document.querySelector('.mp-mods-content').textContent.includes('Quarterly report')&&document.querySelector('.mp-mods-content').textContent.includes('Reconcile orders against the report')",
      ),
      'built-in module reads the real durable task source and plan',
    );
    await session.append('plan/updated', {
      plan: [{content: 'Verify the amended invoice', status: 'pending'}],
    });
    const progress = [];
    const sink = new RuntimeActivitySink((phase, fields) =>
      progress.push({phase, fields}),
    );
    const listCount = () =>
      requests.filter(request => request.channel === 'modules:list').length;
    const beforeTokens = listCount();
    for (let index = 0; index < 30; index++)
      win.webContents.send('conversations:progress', {
        conversationId: conversation.id,
        record: {
          phase: 'answer_chunk',
          fields: {b64: Buffer.from('text').toString('base64')},
        },
      });
    await delay(250);
    check(
      listCount() === beforeTokens,
      'token chunks do not reload module panels',
    );
    sink.onEvent({
      kind: 'plan_updated',
      plan: [{content: 'Verify the amended invoice', status: 'pending'}],
    });
    for (let index = 0; index < 3; index++)
      win.webContents.send('conversations:progress', {
        conversationId: conversation.id,
        record: progress.at(-1),
      });
    await waitFor(
      "document.querySelector('.mp-mods-content').textContent.includes('Verify the amended invoice')",
    );
    check(
      listCount() === beforeTokens + 1,
      'actual plan notifications merge into one visible workspace reload',
    );
    const acceptedCount=listCount();
    win.webContents.send('conversations:progress',{conversationId:'another-task',record:progress.at(-1)});
    for(let index=0;index<3;index++)win.webContents.send('conversations:turn',{id:conversation.id,turnIndex:0,liveProgress:{requestId:'external-stream',answer:'More streamed text',trajectory:[],records:[progress.at(-1)]}});
    await delay(250);
    check(listCount()===acceptedCount,'another task and repeated external stream snapshots do not reload current modules');
    await js('setInspector(false)');
    const hiddenCount = listCount();
    sink.onEvent({
      kind: 'plan_updated',
      plan: [{content: 'Hidden update', status: 'pending'}],
    });
    win.webContents.send('conversations:progress', {
      conversationId: conversation.id,
      record: progress.at(-1),
    });
    await delay(250);
    check(
      listCount() === hiddenCount,
      'hidden module workspace does not make background requests',
    );
    await js("setInspector(true,'modules')");
    await waitFor(
      "document.querySelector('[data-mod-action=summary]')&&!document.querySelector('[data-mod-refresh]').disabled",
    );
    await js("document.querySelector('[data-mod-action=summary]').click()");
    await waitFor(
      "document.querySelector('[data-mod-result]')?.textContent.includes('Verify the amended invoice')",
    );
    check(
      await js(
        "document.querySelector('[data-mod-result]').textContent.includes('runtime.task_context')",
      ),
      'action rereads changed disk session and reports actual backend',
    );
    await js(
      "document.querySelector('[data-mod-panel=note]').click();document.querySelector('[data-mod-action=read]').click()",
    );
    await waitFor(
      "document.querySelector('[data-mod-result]')?.classList.contains('is-error')",
    );
    check(
      await js("!document.querySelector('[data-mod-action=read]').disabled"),
      'real source authorization failure remains retryable',
    );
    const sendsBefore = unrelatedInvocations.filter(channel => /submit|send|start-turn/.test(channel)).length;
    check(
      await js(`(()=>{
        const textarea=document.querySelector('.mpw-input');
        textarea.value='Keep my original draft';
        composerAttachments=[${JSON.stringify(note)}];
        textarea.dispatchEvent(new Event('input',{bubbles:true}));
        const attachmentsBefore=JSON.stringify(composerAttachments);
        const button=document.querySelector('[data-mod-continue]');
        if(!button)return false;
        button.click();
        const draft=textarea.value;
        document.querySelector('[data-mod-continue]').click();
        return draft.startsWith('Keep my original draft\\n\\n')&&draft.includes('source-note')&&draft.includes('Read latest note')&&draft.includes('{}')&&textarea.value===draft&&document.querySelector('[data-mod-continue]').disabled&&activeConversationRecord.agentSessionId===${JSON.stringify(session.id)}&&JSON.stringify(composerAttachments)===attachmentsBefore&&document.activeElement===textarea;
      })()`),
      'real denied worker action appends one editable request to the same task draft and preserves original text and attachments',
    );
    check(
      unrelatedInvocations.filter(channel => /submit|send|start-turn/.test(channel)).length === sendsBefore,
      'continuing in task does not send or execute the composed request',
    );
    await updateContext(session, {
      scopeGrants: [
        {
          grantId: 'note',
          taskId: session.id,
          sourceIds: [],
          folderRoots: [fixture],
          windowIds: [],
          recipients: [],
          actions: ['read'],
          expiresAtMs: null,
        },
      ],
    });
    fs.writeFileSync(note, 'Updated local evidence: 181 verified orders.');
    await js("document.querySelector('[data-mod-action=read]').click()");
    await waitFor(
      "document.querySelector('[data-mod-result]')?.textContent.includes('181 verified orders')",
    );
    check(
      await js(
        "document.querySelector('[data-mod-result]').textContent.includes('fixture.local_note')",
      ),
      'registered plugin action reads actual file after real task grant',
    );
    check(
      await js("(()=>{const times=document.querySelector('[data-mod-result]').textContent.match(/Execution ([0-9]+) ms.*Total ([0-9]+) ms/);return !!times&&Number(times[2])>=Number(times[1]);})()"),
      'visible total wait includes the independently started worker and backend execution',
    );
    await session.refresh();
    check(
      session.events.some(
        event =>
          event.type === 'module/command_finished' &&
          event.data.moduleId === 'source-note',
      ),
      'module action completion persists in the same task journal',
    );
    check(
      requests
        .filter(request => request.runtime)
        .every(request => request.runtime.sessionId === session.id),
      'main handler binds all module requests to conversation-owned session',
    );
    check(
      requests
        .filter(request => request.runtime)
        .every(
          request =>
            request.workerPid && request.progress.includes('runtime_ready'),
        ),
      'all module requests crossed an independently started production worker',
    );
    await js("document.querySelector('[data-mod-panel=dashboards]').click()");
    await js(
      `document.querySelector('[data-mod-action="open-${dashboard.dashboardId}"]').click()`,
    );
    const revenue =
      "Array.from(document.querySelectorAll('.mp-mods-rows dt')).find(node=>node.textContent==='Revenue')?.nextElementSibling?.textContent";
    await waitFor(`(${revenue})==='30'`);
    check(
      await js(
        "document.querySelector('.mp-mods-content').textContent.includes('Revenue query')&&/SUM|sum/.test(document.querySelector('.mp-mods-content').textContent)",
      ),
      'real Dashboard module exposes its saved query and computed value',
    );
    fs.writeFileSync(csv, 'region,revenue\nNorth,112\nSouth,18\n');
    const beforeRead = listCount();
    await js("document.querySelector('[data-mod-refresh]').click()");
    await waitFor("!document.querySelector('[data-mod-refresh]').disabled");
    await delay(100);
    check(
      listCount() === beforeRead + 1 && (await js(`(${revenue})==='30'`)),
      'module refresh retains the actual last query snapshot instead of silently requerying data',
    );
    await js(
      "document.querySelector('[data-mod-action=refresh-values]').click()",
    );
    await waitFor(`(${revenue})==='130'`);
    check(
      true,
      'explicit Dashboard refresh recomputes the changed CSV in another worker',
    );
    await js("document.querySelector('[data-mod-action=inspect-0]').click()");
    await waitFor(
      "document.querySelector('.mp-mods-content').textContent.includes('Row 2')",
    );
    check(
      await js(
        "document.querySelector('.mp-mods-content').textContent.includes('revenue: 112')",
      ),
      'source inspection displays the physical row and original cell value',
    );
    await js(`(() => {
      const form = document.querySelector('[data-mod-action-form="inspect-0"]');
      for (const name of ['offset', 'limit']) {
        const input = form.querySelector('input[name="'+name+'"]');
        input.value = '1';
        input.dispatchEvent(new Event('input', {bubbles:true}));
      }
      form.requestSubmit();
    })()`);
    await waitFor("document.querySelector('.mp-mods-content').textContent.includes('2–2 of 2')");
    check(
      await js("document.querySelector('.mp-mods-content').textContent.includes('Row 3')&&!document.querySelector('.mp-mods-content').textContent.includes('Row 2')"),
      'editable source range reaches the real worker and displays only the requested CSV row',
    );
    const pagedRequest = requests.findLast(request => request.runtime?.actionId === 'inspect-0');
    check(
      pagedRequest.runtime.inputs.offset === 1 && pagedRequest.runtime.inputs.limit === 1,
      'native form inputs cross production preload and main as numeric tool parameters',
    );
    for (const [theme, width] of [
      ['light', 1280],
      ['dark', 1280],
      ['dark', 760],
    ]) {
      win.setContentSize(width, 900);
      await js(
        `document.documentElement.dataset.theme='${theme}';document.body.toggleAttribute('data-ds-dark-theme','${theme}'==='dark');new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
      );
      win.webContents.invalidate();
      await delay(250);
      check(
        await js('document.documentElement.scrollWidth<=innerWidth'),
        `module workspace ${theme} ${width} has no horizontal overflow`,
      );
      fs.writeFileSync(
        path.join(out, `${theme}-${width}.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
    }
    check(errors.length === 0, `renderer/preload errors: ${errors.join('; ')}`);
    fs.writeFileSync(
      path.join(out, 'result.json'),
      JSON.stringify(
        {
          checks,
          requests,
          errors,
          fixture,
          sessionFile: session.file,
          backend:
            'production Studio/preload/main handlers/createRuntimeBridgeRunner/independent Node worker/module registry/EventSession/real CSV; unrelated app data isolated',
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({passed: checks.length, errors, out}));
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(
      path.join(out, 'failure.json'),
      JSON.stringify({checks, requests, errors, error: String(error)}, null, 2),
    );
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  }
});
