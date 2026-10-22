'use strict';
const {app, BrowserWindow, ipcMain} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const {ProjectTerminal} = require('../build/electron/project_terminal');
const {projectPath} = require('../build/electron/project_inspector');
const output = path.resolve('data/runtime/panel-terminal');
const workspace = path.join(output, 'shell-workspace');
fs.mkdirSync(workspace, {recursive: true});
app.setPath('userData', path.join(output, 'shell-profile'));
app.disableHardwareAcceleration();
const terminal = new ProjectTerminal();
const started = Date.now();
const deadline = setTimeout(() => {
  terminal.stop();
  app.exit(1);
}, 20000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1240,
    height: 900,
    show: true,
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      preload: path.resolve('scripts/probe_project_terminal_preload.cjs'),
      additionalArguments: [
        '--mp-probe-state=landing',
        '--mp-probe-terminal-root=' + workspace,
      ],
    },
  });
  try {
    const source = fs.readFileSync('electron/main.ts', 'utf8');
    const ast = ts.createSourceFile(
      'main.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const nodes = ast.statements.filter(node => {
      if (ts.isFunctionDeclaration(node))
        return ['knownProjectRoot', 'isDashboardSender'].includes(
          node.name?.text,
        );
      if (
        !ts.isExpressionStatement(node) ||
        !ts.isCallExpression(node.expression)
      )
        return false;
      const call = node.expression;
      return (
        call.expression.getText(ast) === 'ipcMain.handle' &&
        ts.isStringLiteral(call.arguments[0]) &&
        [
          'projects:terminal-start',
          'projects:terminal-write',
          'projects:terminal-stop',
        ].includes(call.arguments[0].text)
      );
    });
    if (nodes.length !== 5)
      throw new Error('Production terminal IPC functions are missing');
    const context = vm.createContext({
      ipcMain,
      path,
      fs,
      projectPath,
      dashboardWindow: win,
      projectTerminal: terminal,
      projectTerminalDirectory: '',
      projectTerminalGeneration: 0,
      conversations: () => ({listProjects: () => [{root: workspace}]}),
      FABRIC_DATA_DIR: output,
      isManagedWorktreePath: () => false,
    });
    vm.runInContext(
      ts.transpileModule(nodes.map(node => node.getText(ast)).join('\n'), {
        compilerOptions: {target: ts.ScriptTarget.ES2022},
      }).outputText,
      context,
    );
    await win.loadFile(path.resolve('build/electron/renderer/studio.html'));
    await win.webContents
      .executeJavaScript(`show('chat');setStudioHomeVisible(false);applyStudioLanguage('en');
      Data.startProjectTerminal=terminalProbe.start;Data.writeProjectTerminal=terminalProbe.write;Data.stopProjectTerminal=terminalProbe.stop;Data.onProjectTerminalEvent=terminalProbe.onEvent;
      activeProjectRoot=terminalProbe.workspace;`);
    const studioSource = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
    const studioAst = ts.createSourceFile(
      'studio.ts',
      studioSource,
      ts.ScriptTarget.Latest,
      true,
    );
    const eventNode = studioAst.statements.find(
      node =>
        ts.isExpressionStatement(node) &&
        ts.isCallExpression(node.expression) &&
        node.expression.expression.getText(studioAst) ===
          'Data.onProjectTerminalEvent',
    );
    if (!eventNode)
      throw new Error('Production terminal event renderer is missing');
    await win.webContents.executeJavaScript(
      ts.transpileModule(eventNode.getText(studioAst), {
        compilerOptions: {target: ts.ScriptTarget.ES2022},
      }).outputText,
    );
    await win.webContents
      .executeJavaScript(`setBottomPanel(true);const input=document.getElementById('bottom-terminal-input');
      input.value="Write-Output ('MP_UI_TERMINAL_OK:终端回执:' + (Get-Location).Path)";document.getElementById('bottom-terminal-form').requestSubmit();`);
    let snapshot;
    const until = Date.now() + 8000;
    do {
      snapshot = await win.webContents
        .executeJavaScript(`({draft:document.getElementById('bottom-terminal-input').value,
        busy:document.getElementById('bottom-terminal-form').hasAttribute('aria-busy'),output:document.getElementById('bottom-terminal-output').textContent})`);
      if (snapshot.output.includes('MP_UI_TERMINAL_OK:终端回执:' + workspace))
        break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < until);
    const accepted =
      snapshot.draft === '' &&
      !snapshot.busy &&
      snapshot.output.includes('MP_UI_TERMINAL_OK:终端回执:' + workspace);
    const stopped = await win.webContents.executeJavaScript(
      'Data.stopProjectTerminal()',
    );
    const result = {
      ok: accepted && stopped.ok && !terminal.running,
      usedBackend:
        'production Studio form and terminal event renderer, actual main terminal IPC handler functions and ProjectTerminal powershell.exe; controlled project registry in an isolated workspace',
      workspace,
      elapsedMs: Date.now() - started,
      accepted,
      stopped: stopped.ok,
      snapshot,
    };
    fs.writeFileSync(
      path.join(output, 'shell-result.json'),
      JSON.stringify(result, null, 2),
    );
    await win.webContents.executeJavaScript(
      `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
    );
    fs.writeFileSync(
      path.join(output, 'terminal-light.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    win.setContentSize(860, 900);
    await win.webContents.executeJavaScript(
      `applyTheme('dark');new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
    );
    await win.webContents.executeJavaScript(
      `Promise.all(document.getAnimations().filter(animation=>animation instanceof CSSTransition && animation.playState==='running').map(animation=>animation.finished.catch(()=>{})))`,
    );
    result.closeStyles = await win.webContents.executeJavaScript(
      `['#bottom-panel-close','#bottom-panel-close svg','#bottom-panel-close use'].map(selector=>{const style=getComputedStyle(document.querySelector(selector));return {selector,color:style.color,stroke:style.stroke,fill:style.fill,opacity:style.opacity};})`,
    );
    result.closeRules = await win.webContents.executeJavaScript(
      `(()=>{const rules=[];const element=document.getElementById('bottom-panel-close');function visit(list){for(const rule of list){if(rule.selectorText && rule.style.color && element.matches(rule.selectorText))rules.push({selector:rule.selectorText,color:rule.style.color});if(rule.cssRules)visit(rule.cssRules);}}for(const sheet of document.styleSheets)visit(sheet.cssRules);return rules;})()`,
    );
    fs.writeFileSync(
      path.join(output, 'shell-result.json'),
      JSON.stringify(result, null, 2),
    );
    fs.writeFileSync(
      path.join(output, 'terminal-dark-narrow.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    console.log(JSON.stringify(result));
    clearTimeout(deadline);
    terminal.stop();
    win.destroy();
    app.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    terminal.stop();
    win.destroy();
    app.exit(1);
  }
});
