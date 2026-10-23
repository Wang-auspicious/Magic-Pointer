'use strict';
const {app, BrowserWindow, ipcMain} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const output = path.resolve('data/runtime/file-results-11');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const timeout = setTimeout(() => app.exit(1), 60000);
app.whenReady().then(async () => {
  const started = Date.now();
  const {
    createConversationStore,
  } = require('../build/electron/conversation_store');
  const {EventSession} = require('../build/electron/runtime/session');
  const {WorkspaceFiles} = require('../build/electron/runtime/agent_files');
  const {readProjectPreview} = require('../build/electron/project_inspector');
  const baseDir = fs.mkdtempSync(path.join(output, 'fixture-'));
  const workspace = path.join(baseDir, 'project');
  fs.mkdirSync(workspace);
  const session = await EventSession.open(baseDir, 'agent-file-identity');
  const space = new WorkspaceFiles(workspace, session);
  const trajectory = [];
  for (const name of ['client', 'server']) {
    const file = `${name}/index.ts`,
      content = `export const ${name} = 'actual ${name} file';\n`;
    const result = await space.write(space.resolve(file), content);
    trajectory.push({
      kind: 'tool',
      name: 'Write',
      text: JSON.stringify({path: file, content}),
      result: JSON.stringify(result),
    });
  }
  const store = createConversationStore({baseDir});
  const parent = store.appendTurn({
    newConversation: true,
    question: 'Create both entry points',
    answer: 'Saved both files.',
    workspaceRoot: workspace,
    trajectory,
    artifacts: [{artifactId: 'identity-fixture', name: 'index.ts'}],
  });
  const win = new BrowserWindow({
    width: 1320,
    height: 950,
    show: false,
    webPreferences: {
      offscreen: true,
      sandbox: false,
      contextIsolation: true,
      preload: path.resolve('scripts/probe_file_results_preload.cjs'),
      additionalArguments: [
        '--mp-probe-state=landing',
        '--mp-probe-theme=light',
      ],
    },
  });
  const ast = ts.createSourceFile(
    'main.ts',
    fs.readFileSync('electron/main.ts', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const handler = ast.statements.find(
    n =>
      ts.isExpressionStatement(n) &&
      ts.isCallExpression(n.expression) &&
      n.expression.expression.getText(ast) === 'ipcMain.handle' &&
      n.expression.arguments[0].getText(ast) === "'projects:read-file'",
  );
  const opened = [];
  vm.runInNewContext(
    ts.transpileModule(handler.getText(ast), {
      compilerOptions: {target: ts.ScriptTarget.ES2022},
    }).outputText,
    {
      ipcMain,
      isDashboardSender: e => e.sender === win.webContents,
      knownProjectRoot: root => (root === workspace ? root : null),
      readProjectPreview: async (root, file) => {
        opened.push(file);
        return readProjectPreview(root, file);
      },
    },
  );
  ipcMain.handle('file-results:list', () => store.list());
  ipcMain.handle('file-results:get', (_e, id) => store.get(id));
  const js = code => win.webContents.executeJavaScript(code);
  const pause = () => new Promise(r => setTimeout(r, 120));
  const pointer = async selector => {
    const p = await js(
      `(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
    );
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...p,
    });
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      ...p,
    });
    await pause();
  };
  const cases = [],
    errors = [];
  try {
    await win.loadFile(path.resolve('build/electron/renderer/studio.html'));
    await js(
      `(async()=>{setStudioLanguage('en');Data.conversations=()=>fileResultsProbe.invoke('file-results:list');Data.conversation=id=>fileResultsProbe.invoke('file-results:get',id);Data.projects=async()=>[];Data.readProjectFile=(projectRoot,path)=>fileResultsProbe.invoke('projects:read-file',{projectRoot,path});await openConversation(${JSON.stringify(parent.id)});})()`,
    );
    assert.equal(
      await js(
        `document.querySelectorAll('.mp-chat-files [data-mp-chat-act="open-file"]').length`,
      ),
      2,
    );
    assert.equal(
      await js(
        `document.querySelectorAll('.mp-chat-files .mp-chat-file-row[data-mp-chat-act="open-artifact"]').length`,
      ),
      1,
    );
    cases.push(
      'both same-basename files and the separate draft remain visible targets',
    );
    await pointer('.mp-chat-files-more-summary');
    assert.equal(
      await js(`document.querySelector('.mp-chat-files-more').open`),
      true,
    );
    for (const name of ['client', 'server']) {
      await pointer(`.mp-chat-files [data-file-path="${name}/index.ts"]`);
      for (let i = 0; i < 20; i++) {
        if (
          await js(
            `document.getElementById('project-file-content').textContent.includes(${JSON.stringify(`actual ${name} file`)})`,
          )
        )
          break;
        await pause();
      }
      assert.equal(opened.at(-1), `${name}/index.ts`);
      assert.match(
        await js(`document.getElementById('project-file-content').textContent`),
        new RegExp(`actual ${name} file`),
      );
      cases.push(
        `${name}/index.ts pointer click opens its actual persisted content through production main read-file IPC`,
      );
    }
    await js(
      `setInspector(false);document.querySelector('.mp-chat-files').scrollIntoView({block:'center'})`,
    );
    fs.writeFileSync(
      path.join(output, 'identity-after.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
  } catch (e) {
    errors.push(e.stack);
    fs.writeFileSync(
      path.join(output, 'identity-failed.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    fs.writeFileSync(
      path.join(output, 'identity-failed-state.json'),
      JSON.stringify(
        await js(
          `({root:activeProjectRoot,path:selectedProjectFile,text:selectedProjectFileText,preview:selectedProjectPreview,request:projectFileRequest,tab:activeInspectorTab,content:document.getElementById('project-file-content').outerHTML})`,
        ),
        null,
        2,
      ),
    );
  }
  const result = {
    ok: !errors.length,
    cases,
    errors,
    opened,
    timingMs: Date.now() - started,
    usedBackend:
      'Production Studio + main projects:read-file handler, real WorkspaceFiles writes/readback and ConversationStore in isolated fixture; draft metadata fixture, no artifact-editor acceptance or model call',
  };
  fs.writeFileSync(
    path.join(output, 'identity-renderer.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  clearTimeout(timeout);
  win.destroy();
  app.exit(result.ok ? 0 : 1);
});
