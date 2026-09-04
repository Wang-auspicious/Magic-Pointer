// @ts-nocheck
'use strict';

/*
 * Deterministic Claude-fidelity Studio renderer probe.
 *
 * Source invocation is intentionally supported:
 *   npx --no-install tsx scripts/probe_studio_claude.ts --width 1199 ...
 * The tiny Node wrapper re-enters the already-built script through Electron so
 * the renderer, device scale, preload isolation and PNG path match production.
 * Required CLI surface: --width --height --scale-factor --theme --state --output.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const STATES = [
  'landing',
  'conversation',
  'conversation-inspector',
  'running',
  'permission',
  'error',
  'inspector-maximized',
  'thinking-expanded',
  'subagent',
  'browser',
  'customize',
  'design',
  'minimum',
];

const ROOT = process.cwd();

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

function numberOption(name, fallback) {
  const value = Number(option(name, fallback));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid --${name}: ${value}`);
  return value;
}

function parseOptions() {
  const state = String(option('state', 'landing'));
  const theme = String(option('theme', 'light'));
  if (!STATES.includes(state)) throw new Error(`invalid --state: ${state}`);
  if (!['light', 'dark'].includes(theme)) throw new Error(`invalid --theme: ${theme}`);
  const output = path.resolve(String(option('output', path.join('data', 'runtime', `claude-studio-${theme}-${state}.png`))));
  return {
    width: Math.round(numberOption('width', state === 'minimum' ? 1020 : 1199)),
    height: Math.round(numberOption('height', state === 'minimum' ? 700 : 800)),
    scaleFactor: numberOption('scale-factor', 2),
    theme,
    state,
    output,
  };
}

function launchElectron() {
  const builtEntry = path.join(ROOT, 'build', 'scripts', 'probe_studio_claude.js');
  if (!fs.existsSync(builtEntry)) {
    process.stderr.write('probe requires a fresh `npm run build:electron` first\n');
    process.exitCode = 1;
    return;
  }
  const electronBinary = require('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(electronBinary, [builtEntry, ...process.argv.slice(2)], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
  });
  process.exitCode = child.status === null ? 1 : child.status;
}

function statePreparationScript(state, theme) {
  return `(async () => {
    const state = ${JSON.stringify(state)};
    const theme = ${JSON.stringify(theme)};
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark');
    try { localStorage.setItem('mp:theme', theme); } catch (_) {}

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const openReference = async (conversationId = 'studio-reference') => {
      setProductMode('walker', false);
      await openConversation(conversationId);
      await wait(30);
    };
    const openFiles = async (maximized) => {
      await openReference();
      inspectorState = { ...inspectorState, width: 747, previousWidth: 747, maximized: false };
      setInspector(true, 'files');
      await refreshProjectInspector();
      expandedProjectDirectories.add('electron');
      await loadProjectDirectory('electron');
      await selectProjectFile('VisLexicon-完整方案.md');
      if (maximized) document.getElementById('inspector-maximize')?.click();
      await wait(40);
    };

    if (state === 'landing' || state === 'minimum') {
      setProductMode('walker', false);
      show('chat');
      startNewChat();
      await renderStudioHome();
    } else if (state === 'conversation') {
      await openReference('magic-pointer-review');
      const flow = document.querySelector('#stream .dsh-flow');
      if (flow) {
        const host = document.createElement('div');
        host.className = 'dsh-flow-item mp-reference-working';
        host.appendChild(DshChat.turnStatusNode('Thinking'));
        flow.appendChild(host);
        const stream = document.getElementById('stream');
        if (stream) stream.scrollTop = stream.scrollHeight;
      }
    } else if (state === 'conversation-inspector') {
      await openFiles(false);
    } else if (state === 'inspector-maximized') {
      await openFiles(true);
    } else if (state === 'running') {
      await openReference();
      studioComposerBusy = true;
      setComposerRunningState(true);
      composerPlan = { steps: [
        { content: '清退旧 Studio 视觉栈', status: 'completed' },
        { content: '逐像素核对两张参考图', status: 'in_progress' },
        { content: '同步安装版并核对版本', status: 'pending' },
      ] };
      renderPlanCard();
      const flow = document.querySelector('#stream .dsh-flow');
      if (flow) {
        const host = document.createElement('div');
        host.className = 'dsh-flow-item';
        host.appendChild(DshChat.liveActivityNode({
          phase: 'tool_call',
          fields: { id: 'probe-running', name: 'Bash', command: 'npm run typecheck' },
          ms: 6840,
        }));
        flow.appendChild(host);
      }
    } else if (state === 'permission') {
      await openReference();
      pendingPermissionAsk = { tool: 'Bash', prefix: 'npm run sync' };
      pendingAskInput = null;
      renderPermissionAsk();
    } else if (state === 'error') {
      await openReference();
      const flow = document.querySelector('#stream .dsh-flow');
      if (flow) {
        const host = document.createElement('div');
        host.className = 'dsh-flow-item';
        host.appendChild(DshChat.turnErrorNode(
          '模型端点暂时不可用；provider_unavailable · usedBackend=magic_pointer.messages_multiturn_streaming',
          'provider_unavailable',
        ));
        flow.appendChild(host);
      }
      setComposerSettledState('error');
      const stream = document.getElementById('stream');
      if (stream) stream.scrollTop = stream.scrollHeight;
    } else if (state === 'thinking-expanded') {
      await openReference();
      const reasoning = document.querySelector('.dsh-think > .dsh-row');
      if (reasoning) reasoning.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const more = document.querySelector('.dsh-think-more');
      if (more) more.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    } else if (state === 'subagent') {
      await openReference();
      activeConversationTurns = [{ trajectory: [{
        kind: 'tool', callId: 'parent-agent-probe', name: 'Agent', state: 'running',
        text: JSON.stringify({ task: 'Audit Claude Settings and Inspector', readonly: true }),
        result: '', usedBackend: 'subagent_loop', startedAt: 100,
      }] }];
      liveSubagentTasks.set('child-probe', {
        id: 'child-probe', parentCallId: 'parent-agent-probe',
        description: 'Audit Claude Settings and Inspector', readonly: true,
        status: 'running', stepCount: 3, currentTool: 'Read',
        steps: [
          { index: 1, tool: 'Grep', status: 'completed', usedBackend: 'ripgrep', latencyMs: 42 },
          { index: 2, tool: 'Read', status: 'completed', usedBackend: 'filesystem', latencyMs: 18 },
          { index: 3, tool: 'Read', status: 'running', usedBackend: 'filesystem' },
        ],
      });
      focusedSubagentId = 'child-probe';
      setInspector(true, 'tasks');
      renderProjectTasks();
    } else if (state === 'browser') {
      await openReference();
      inspectorState = { ...inspectorState, width: 747, previousWidth: 747, maximized: false };
      setInspector(true, 'browser');
      const browserInput = document.getElementById('project-browser-url');
      if (browserInput) browserInput.value = 'https://example.test';
      await openProjectBrowser('https://example.test');
      await wait(40);
    } else if (state === 'customize') {
      setProductMode('walker', false);
      show('settings');
      activeSettingsPage = 'models-agents';
      renderSettings();
    } else if (state === 'design') {
      setProductMode('design', false);
      show('design');
    }

    document.getElementById('global-search-overlay')?.setAttribute('hidden', '');
    await wait(40);
    return { state, theme };
  })()`;
}

async function settleTwoFrames(webContents) {
  await webContents.executeJavaScript(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
}

async function waitForStudio(webContents) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await webContents.executeJavaScript(
      "Boolean(document.getElementById('studio-home') && document.getElementById('composer-form') && document.querySelector('#side-convos > *'))",
    );
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const diagnostic = await webContents.executeJavaScript(`(() => ({
    readyState: document.readyState,
    href: location.href,
    bridge: Boolean(window.magicPointerDashboard),
    conversations: Boolean(window.magicPointerDashboard?.conversations),
    shell: Boolean(document.getElementById('shell')),
    home: Boolean(document.getElementById('studio-home')),
    composer: Boolean(document.getElementById('composer-form')),
    projectRows: document.querySelectorAll('#side-convos .dshw-project').length,
    sideText: String(document.getElementById('side-convos')?.textContent || '').slice(0, 300),
  }))()`);
  throw new Error(`Studio fixture did not finish booting: ${JSON.stringify(diagnostic)}`);
}

async function collectMetrics(webContents) {
  return webContents.executeJavaScript(`(() => {
    const round = (value) => Math.round(value * 100) / 100;
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element || element.hidden || getComputedStyle(element).display === 'none') return null;
      const value = element.getBoundingClientRect();
      return { x: round(value.x), y: round(value.y), width: round(value.width), height: round(value.height), right: round(value.right), bottom: round(value.bottom) };
    };
    const style = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const value = getComputedStyle(element);
      return {
        display: value.display,
        position: value.position,
        width: value.width,
        height: value.height,
        minHeight: value.minHeight,
        padding: value.padding,
        gridTemplateRows: value.gridTemplateRows,
        alignContent: value.alignContent,
        alignSelf: value.alignSelf,
        flex: value.flex,
        backgroundColor: value.backgroundColor,
        color: value.color,
        borderColor: value.borderColor,
        borderRadius: value.borderRadius,
        boxShadow: value.boxShadow,
        fontFamily: value.fontFamily,
        fontSize: value.fontSize,
        fontWeight: value.fontWeight,
        lineHeight: value.lineHeight,
      };
    };
    const horizontalOverflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth;
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      geometry: {
        shell: rect('#shell'),
        titlebar: rect('#window-titlebar'),
        sidebar: rect('.dshw-sidebar-col'),
        primary: rect('.dshw-conversation:not([hidden])'),
        home: rect('#studio-home'),
        stats: rect('#studio-home-stats'),
        composer: rect('#composer-form'),
        composerInput: rect('.dshw-scroll'),
        composerSend: rect('.dshw-primary'),
        inspector: rect('#project-inspector'),
        sidebarFooter: rect('.dshw-foot'),
        updateCard: rect('#update-card'),
        accountFooter: rect('#account-footer'),
        settings: rect('.dshw-settings-panel'),
        design: rect('#design-actions'),
        flow: rect('.dsh-flow'),
        user: rect('.dsh-user'),
        bubble: rect('.dsh-bubble'),
        assistantBody: rect('.dsh-assistant-body'),
        stream: rect('#stream'),
        composerSeat: rect('.dshw-composer-seat'),
        repositoryContext: rect('#composer-repository-context'),
        browserHost: rect('#project-browser-host'),
        sidebarProjects: document.querySelectorAll('#side-convos .dshw-project').length,
        sidebarSessions: document.querySelectorAll('#side-convos .side-item').length,
        planRows: document.querySelectorAll('#composer-plan:not([hidden]) .dshw-plan-step').length,
        permissionActions: document.querySelectorAll('#composer-permission-ask:not([hidden]) .dshw-perm-ask-btn').length,
        turnErrors: document.querySelectorAll('#stream .dsh-turn-error').length,
        thinkingRows: document.querySelectorAll('#stream .dsh-think').length,
        expandedThinkingRows: document.querySelectorAll('#stream .dsh-think[data-open="true"]').length,
        subagentRows: document.querySelectorAll('#project-inspector:not([hidden]) .mp-subagent-task').length,
        settingsRows: document.querySelectorAll('#view-settings:not([hidden]) .claude-settings-row').length,
        designRows: document.querySelectorAll('#view-design:not([hidden]) .mp-design-action-row').length,
        composerBusy: document.getElementById('composer-form')?.getAttribute('aria-busy') === 'true',
        inspectorMaximized: document.getElementById('shell')?.dataset.inspectorMaximized === 'true',
        flowChildren: Array.from(document.querySelectorAll('.dsh-flow > *')).map((element) => {
          const value = element.getBoundingClientRect();
          return {
            className: element.className,
            x: round(value.x), y: round(value.y), width: round(value.width), height: round(value.height),
            text: String(element.textContent || '').replace(/\\s+/g, ' ').slice(0, 100),
          };
        }),
        assistantChildren: Array.from(document.querySelectorAll('.dsh-flow-item:last-child .dsh-assistant-body > *')).map((element) => {
          const value = element.getBoundingClientRect();
          return {
            className: element.className,
            tagName: element.tagName,
            x: round(value.x), y: round(value.y), width: round(value.width), height: round(value.height),
            text: String(element.textContent || '').replace(/\\s+/g, ' ').slice(0, 120),
          };
        }),
        activityRows: Array.from(document.querySelectorAll('.dsh-flow-item:last-child .dsh-tool-group-header, .dsh-flow-item:last-child .dsh-tool-group-body, .dsh-flow-item:last-child .dsh-tool .dsh-row')).map((element) => {
          const value = element.getBoundingClientRect();
          return { className: element.className, x: round(value.x), y: round(value.y), width: round(value.width), height: round(value.height), text: String(element.textContent || '').replace(/\\s+/g, ' ').slice(0, 80) };
        }),
        filePreviewContent: rect('#project-file-content'),
        filePreviewBlocks: Array.from(document.querySelectorAll('#project-file-content .dsh-markdown > *')).slice(0, 20).map((element) => {
          const value = element.getBoundingClientRect();
          return { tagName: element.tagName, className: element.className, x: round(value.x), y: round(value.y), width: round(value.width), height: round(value.height), text: String(element.textContent || '').replace(/\\s+/g, ' ').slice(0, 140) };
        }),
      },
      styles: {
        body: style('body'),
        sidebar: style('.dshw-sidebar'),
        panel: style('#project-inspector'),
        composer: style('#composer-form .dshw-card'),
        homeTitle: style('#studio-home-title'),
        sidebarFooter: style('.dshw-foot'),
        updateCard: style('#update-card'),
        accountFooter: style('#account-footer'),
        toolGroupBody: style('.dsh-tool-group-body'),
      },
      horizontalOverflow: round(horizontalOverflow),
      consoleState: document.readyState,
      scroll: (() => { const element = document.getElementById('stream'); return element ? {
        scrollTop: round(element.scrollTop), scrollHeight: round(element.scrollHeight), clientHeight: round(element.clientHeight),
      } : null; })(),
    };
  })()`);
}

function pixelHex(image, cssX, cssY, cssWidth, cssHeight) {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const scaleX = size.width / cssWidth;
  const scaleY = size.height / cssHeight;
  const x = Math.max(0, Math.min(size.width - 1, Math.round(cssX * scaleX)));
  const y = Math.max(0, Math.min(size.height - 1, Math.round(cssY * scaleY)));
  const offset = (y * size.width + x) * 4;
  const b = bitmap[offset] || 0;
  const g = bitmap[offset + 1] || 0;
  const r = bitmap[offset + 2] || 0;
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

async function runElectron() {
  let options;
  try {
    options = parseOptions();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }

  const { app, BrowserWindow } = require('electron');
  app.commandLine.appendSwitch('force-device-scale-factor', String(options.scaleFactor));
  const profile = path.join(ROOT, 'data', 'runtime', 'probe-studio-claude-profile');
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);

  await app.whenReady();
  const consoleErrors = [];
  const window = new BrowserWindow({
    width: options.width,
    height: options.height,
    useContentSize: true,
    frame: false,
    show: false,
    backgroundColor: options.theme === 'dark' ? '#151515' : '#FCFCFB',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: true,
      preload: path.join(ROOT, 'scripts', 'probe_studio_claude_preload.js'),
      additionalArguments: [
        `--mp-probe-theme=${options.theme}`,
        `--mp-probe-state=${options.state}`,
      ],
    },
  });
  window.setContentSize(options.width, options.height);
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) consoleErrors.push({ level, message: String(message).slice(0, 500), line, sourceId });
  });

  try {
    const studioHtml = path.join(ROOT, 'build', 'electron', 'renderer', 'studio.html');
    if (!fs.existsSync(studioHtml)) throw new Error('built Studio renderer is missing');
    await window.loadFile(studioHtml, { query: { view: 'chat' } });
    await waitForStudio(window.webContents);
    await window.webContents.executeJavaScript(statePreparationScript(options.state, options.theme));
    await window.webContents.executeJavaScript('document.fonts && document.fonts.ready');
    await settleTwoFrames(window.webContents);
    const metrics = await collectMetrics(window.webContents);
    const geometry = metrics.geometry;
    const stateFailures = [];
    const requireVisible = (name, value) => {
      if (!value || value.width <= 0 || value.height <= 0) stateFailures.push(`${name} missing`);
    };
    if (options.state === 'landing') {
      requireVisible('home', geometry.home);
      if (stateFailures.length) throw new Error(`invalid landing probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'conversation') {
      requireVisible('repository context', geometry.repositoryContext);
      if (geometry.sidebarProjects < 2) stateFailures.push('fewer than two project groups');
      if (geometry.sidebarSessions < 3) stateFailures.push('fewer than three session rows');
      if (geometry.flowChildren.length < 4) stateFailures.push('conversation fixture did not render');
      if (stateFailures.length) throw new Error(`invalid Claude work-state probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'conversation-inspector') {
      requireVisible('inspector', geometry.inspector);
      requireVisible('file preview', geometry.filePreviewContent);
      if (geometry.filePreviewBlocks.length < 2) stateFailures.push('file preview content missing');
      if (stateFailures.length) throw new Error(`invalid conversation-inspector probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'running') {
      if (geometry.planRows < 3) stateFailures.push('plan steps missing');
      if (!geometry.composerBusy) stateFailures.push('composer is not busy');
      if (stateFailures.length) throw new Error(`invalid running probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'permission') {
      if (geometry.permissionActions < 3) stateFailures.push('permission actions missing');
      if (stateFailures.length) throw new Error(`invalid permission probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'error') {
      if (geometry.turnErrors < 1) stateFailures.push('turn error missing');
      if (stateFailures.length) throw new Error(`invalid error probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'inspector-maximized') {
      requireVisible('inspector', geometry.inspector);
      if (!geometry.inspectorMaximized) stateFailures.push('inspector is not maximized');
      if (stateFailures.length) throw new Error(`invalid inspector-maximized probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'thinking-expanded') {
      if (geometry.thinkingRows < 1) stateFailures.push('thinking row missing');
      if (geometry.expandedThinkingRows < 1) stateFailures.push('thinking row is not expanded');
      if (stateFailures.length) throw new Error(`invalid thinking-expanded probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'subagent') {
      if (geometry.subagentRows < 1) stateFailures.push('subagent row missing');
      if (stateFailures.length) throw new Error(`invalid subagent probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'browser') {
      requireVisible('browser host', geometry.browserHost);
      if (stateFailures.length) throw new Error(`invalid browser probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'customize') {
      if (geometry.settingsRows < 1) stateFailures.push('settings rows missing');
      if (stateFailures.length) throw new Error(`invalid customize probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'design') {
      if (geometry.designRows < 4) stateFailures.push('design rows missing');
      if (stateFailures.length) throw new Error(`invalid design probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'minimum') {
      requireVisible('home', geometry.home);
      if (!geometry.sidebar || geometry.sidebar.width > 44) stateFailures.push('sidebar is not collapsed');
      if (stateFailures.length) throw new Error(`invalid minimum probe: ${stateFailures.join('; ')}`);
    }
    const image = await window.webContents.capturePage();
    const imageSize = image.getSize();
    const points = {
      titlebar: [Math.min(options.width - 1, 420), 18],
      sidebar: [Math.min(options.width - 1, 120), Math.min(options.height - 1, 90)],
      page: [Math.min(options.width - 1, 320), Math.min(options.height - 1, 90)],
      stats: metrics.geometry.stats
        ? [metrics.geometry.stats.x + metrics.geometry.stats.width / 2, metrics.geometry.stats.y + metrics.geometry.stats.height / 2]
        : null,
      inspector: metrics.geometry.inspector
        ? [metrics.geometry.inspector.x + metrics.geometry.inspector.width / 2, metrics.geometry.inspector.y + 20]
        : null,
    };
    const pixelSamples = {};
    for (const [name, point] of Object.entries(points)) {
      if (point) pixelSamples[name] = pixelHex(image, point[0], point[1], options.width, options.height);
    }

    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, image.toPNG());
    const metadataPath = options.output.replace(/\.png$/i, '') + '.json';
    fs.writeFileSync(metadataPath, JSON.stringify({
      options,
      imageSize,
      geometry: metrics.geometry,
      styles: metrics.styles,
      scroll: metrics.scroll,
      horizontalOverflow: metrics.horizontalOverflow,
      pixelSamples,
      consoleErrors,
    }, null, 2));

    process.stdout.write(
      `state=${options.state} theme=${options.theme} viewport=${options.width}x${options.height} dpr=${options.scaleFactor}\n`
      + `png=${options.output}\nmetadata=${metadataPath}\n`
      + `image=${imageSize.width}x${imageSize.height} horizontal_overflow=${metrics.horizontalOverflow} console_errors=${consoleErrors.length}\n`,
    );
    if (metrics.horizontalOverflow > 0 || consoleErrors.length > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Studio probe failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    for (const entry of consoleErrors.slice(0, 12)) {
      process.stderr.write(`console[${entry.level}] ${entry.message} (${entry.sourceId}:${entry.line})\n`);
    }
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.exit(process.exitCode || 0);
  }
}

if (process.versions.electron) {
  void runElectron();
} else {
  launchElectron();
}
