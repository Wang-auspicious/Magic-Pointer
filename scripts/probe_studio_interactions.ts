// @ts-nocheck
'use strict';

/*
 * Real-input witness for the Studio controls copied from Claude Desktop.
 * The Node entry re-launches this built file through Electron. The Electron
 * entry loads the production renderer with deterministic preload data, sends
 * mouse input at measured element centres, and emits one bounded JSON record.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = process.cwd();

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined
    ? process.argv[index + 1]
    : fallback;
}

function launchElectron() {
  const builtEntry = path.join(ROOT, 'build', 'scripts', 'probe_studio_interactions.js');
  if (!fs.existsSync(builtEntry)) {
    process.stderr.write('interaction probe requires `npm run build:electron` first\n');
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForStudio(webContents) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await webContents.executeJavaScript(`Boolean(
      document.getElementById('studio-home')?.hidden === false
      && document.getElementById('composer-effort')
      && document.querySelector('.mp-home-heatmap-cell')
    )`);
    if (ready) return;
    await wait(25);
  }
  throw new Error('Studio interaction fixture did not finish booting');
}

async function centre(webContents, selector) {
  const result = await webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (element.hidden || style.display === 'none' || style.visibility === 'hidden'
        || rect.width <= 0 || rect.height <= 0) return null;
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  if (!result) throw new Error(`click target is not visible: ${selector}`);
  return result;
}

async function realClick(window, selector, settleMs = 90) {
  const point = await centre(window.webContents, selector);
  window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await wait(settleMs);
}

/* 按横向比例点：滑块的两端不是同一档，取中点只能验到中间那一档。 */
async function realClickAt(window, selector, ratio, settleMs = 90) {
  const box = await window.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  })()`);
  if (!box) throw new Error(`realClickAt: no box for ${selector}`);
  // ratio=1 会落到盒子右边界之外那一像素上，命中不到元素本身。
  const x = Math.min(Math.round(box.left + box.width * ratio), Math.round(box.left + box.width) - 1);
  const y = Math.round(box.top + box.height / 2);
  window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await wait(settleMs);
}

async function visibleBounds(webContents, selector) {
  return webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (element.hidden || style.display === 'none' || style.visibility === 'hidden'
        || rect.width <= 0 || rect.height <= 0) return null;
    const round = (value) => Math.round(value * 100) / 100;
    return {
      left: round(rect.left), top: round(rect.top), right: round(rect.right),
      bottom: round(rect.bottom), width: round(rect.width), height: round(rect.height),
    };
  })()`);
}

async function runElectron() {
  const { app, BrowserWindow } = require('electron');
  const width = 1199;
  const height = 800;
  const output = path.resolve(String(option(
    'output',
    path.join(ROOT, 'data', 'runtime', 'studio-claude-interactions-20260905.png'),
  )));
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  const profile = path.join(ROOT, 'data', 'runtime', 'probe-studio-interactions-profile');
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  await app.whenReady();

  const consoleErrors = [];
  const screenshots = {};
  const window = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    frame: false,
    show: false,
    backgroundColor: '#FCFCFB',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: true,
      preload: path.join(ROOT, 'scripts', 'probe_studio_claude_preload.js'),
      additionalArguments: [
        '--mp-probe-theme=light',
        '--mp-probe-state=landing',
      ],
    },
  });
  window.setContentSize(width, height);
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      consoleErrors.push({
        level,
        message: String(message).slice(0, 400),
        line,
        sourceId: String(sourceId).slice(0, 240),
      });
    }
  });

  const captureWitness = async (name) => {
    const target = output.replace(/\.png$/i, `-${name}.png`);
    const image = await window.webContents.capturePage();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, image.toPNG());
    screenshots[name] = target;
  };

  try {
    const studioHtml = path.join(ROOT, 'build', 'electron', 'renderer', 'studio.html');
    if (!fs.existsSync(studioHtml)) throw new Error('built Studio renderer is missing');
    await window.loadFile(studioHtml, { query: { view: 'chat' } });
    await waitForStudio(window.webContents);
    await window.webContents.executeJavaScript('document.fonts && document.fonts.ready');
    window.webContents.focus();

    await realClick(window, '#account-footer');
    const accountBounds = await visibleBounds(window.webContents, '#account-menu');
    const accountItems = await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('#account-menu [data-account-command]')).map((row) => row.textContent.trim())`,
    );
    await captureWitness('account');
    await realClick(window, '#account-menu [data-account-command="settings"]');
    const settingsOpened = await window.webContents.executeJavaScript(
      `document.getElementById('view-settings')?.hidden === false`,
    );
    await window.webContents.executeJavaScript(`(async () => {
      setProductMode('walker', false);
      show('chat');
      startNewChat();
      await renderStudioHome();
    })()`);
    await wait(140);

    await realClick(window, '#composer-permission');
    const permissionBounds = await visibleBounds(window.webContents, '#composer-permission-menu');
    await captureWitness('permission');
    await realClick(window, '#composer-permission-menu [data-perm-value="read-only"]');
    const selectedPermission = await window.webContents.executeJavaScript(
      `document.getElementById('composer-permission-label')?.textContent.trim()`,
    );

    await realClick(window, '#composer-model', 180);
    const modelBounds = await visibleBounds(window.webContents, '#composer-model-menu');
    await captureWitness('model');
    await realClick(window, '#composer-model-menu [data-model-id="claude-sonnet-4"]', 180);
    const selectedModel = await window.webContents.executeJavaScript(
      `document.getElementById('composer-model-label')?.textContent.trim()`,
    );

    await realClick(window, '#composer-effort');
    const effortBounds = await visibleBounds(window.webContents, '#composer-effort-menu');
    /* effort 从一列选项变成了一根滑块：能读的是两端的方向标签、当前档名和
       刻度数，选档靠点在轨道上的位置。 */
    const effortLabels = await window.webContents.executeJavaScript(`({
      scale: Array.from(document.querySelectorAll('#composer-effort-menu .mp-effort-scale > span')).map((node) => node.textContent.trim()),
      current: document.querySelector('#composer-effort-menu .mp-effort-head-value')?.textContent.trim() || '',
      ticks: document.querySelectorAll('#composer-effort-menu .mp-effort-tick').length,
    })`);
    await captureWitness('effort');
    await realClickAt(window, '#composer-effort-menu .mp-effort-track', 1);

    /* 上下文卡：参考里是「标题行 + 彩色分段条 + 分组 + 行 + 页脚」，不是竖排
       的标签/值。截一张图，标题行那个百分比和分段条的宽度都能直接看。
       这个流程跑在空会话上，卡片的「什么都没有」那一态本来就不该有段——真正
       要看的是有数的时候。所以先塞一轮真用量：没有缓存字段，正是 provider
       不报缓存时的默认路径，条上应当只有新输入和输出两段、两个颜色。 */
    const usageEmptySegments = await window.webContents.executeJavaScript(`(() => {
      renderUsageMeter([]);
      const empty = document.querySelectorAll('#composer-usage-popover .mp-usage-seg').length;
      renderUsageMeter([{
        modelUsage: { inputTokens: 61234, outputTokens: 417, totalTokens: 61651,
          contextTokens: 61234, contextEstimated: 0, lastOutputTokens: 417,
          systemTokensEstimate: 1000, toolSchemaTokensEstimate: 2000,
          messageTokensEstimate: 3000, toolResultTokensEstimate: 55234 },
      }]);
      return empty;
    })()`);
    await realClick(window, '#composer-effort');
    await realClick(window, '#composer-context');
    const usageBounds = await visibleBounds(window.webContents, '#composer-usage-popover');
    const usageHead = await window.webContents.executeJavaScript(
      `document.querySelector('#composer-usage-popover .mp-usage-head-value')?.textContent.trim() || ''`,
    );
    const usageSegments = await window.webContents.executeJavaScript(
      `document.querySelectorAll('#composer-usage-popover .mp-usage-seg').length`,
    );
    const usageSegmentKinds = await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('#composer-usage-popover .mp-usage-seg')).map((node) => node.dataset.kind || '')`,
    );
    /* 只数带类别的填充：配额那几行也会画 .mp-usage-row-fill，但它们不属于
       上下文的类别，混进来会让这条断言在接上配额适配器之后莫名其妙地红。 */
    const usageRowKinds = await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('#composer-usage-breakdown .mp-usage-context-row')).map((node) => node.dataset.kind || '')`,
    );
    await captureWitness('usage');
    await realClick(window, '#composer-usage-popover .mp-usage-foot');
    const usageDetailBounds = await visibleBounds(window.webContents, '#composer-usage-breakdown');
    const usageAfterClick = await visibleBounds(window.webContents, '#composer-usage-popover');
    if (!usageAfterClick) throw new Error('one click on details closed the main usage card');
    if (!usageDetailBounds || usageDetailBounds.right > usageAfterClick.left - 4) {
      throw new Error('usage details must open outside the main card on its left');
    }
    const colorsMatch = await window.webContents.executeJavaScript(`Array.from(
      document.querySelectorAll('#composer-usage-popover .mp-usage-seg')).every(segment => {
        const fill = document.querySelector('#composer-usage-breakdown .mp-usage-row-fill[data-kind="' + segment.dataset.kind + '"]');
        const swatch = document.querySelector('#composer-usage-breakdown .mp-usage-swatch[data-kind="' + segment.dataset.kind + '"]');
        return fill && swatch && getComputedStyle(segment).backgroundColor === getComputedStyle(fill).backgroundColor
          && getComputedStyle(segment).backgroundColor === getComputedStyle(swatch).backgroundColor;
      })`);
    if (!colorsMatch) throw new Error('context segment, detail bar and legend colors differ');
    await captureWitness('usage-breakdown');
    await realClick(window, '#composer-usage-popover .mp-usage-head');
    if (await visibleBounds(window.webContents, '#composer-usage-breakdown')) throw new Error('context arrow must close the left detail only');
    if (!await visibleBounds(window.webContents, '#composer-usage-popover')) throw new Error('context arrow closed the main card');
    await realClick(window, '#composer-context');

    /* 工作目录小卡：参考里点文件夹先出「No folder / Recent / <项目> ✓ /
       Open folder…」，不是直接弹系统对话框。 */
    await realClick(window, '#composer-workspace');
    const workspaceBounds = await visibleBounds(window.webContents, '#composer-workspace-menu');
    const workspaceItems = await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('#composer-workspace-menu .mp-workspace-menu-row')).map((node) => node.textContent.trim())`,
    );
    await captureWitness('workspace');
    await realClick(window, '#composer-workspace');
    const selectedEffort = await window.webContents.executeJavaScript(
      `document.getElementById('composer-effort-label')?.textContent.trim()`,
    );

    await realClick(window, '[data-home-view="models"]');
    await realClick(window, '[data-home-range="30d"]');
    const home = await window.webContents.executeJavaScript(`({
      view: document.querySelector('[data-home-view][aria-selected="true"]')?.dataset.homeView || '',
      range: document.querySelector('[data-home-range][aria-selected="true"]')?.dataset.homeRange || '',
      modelRows: document.querySelectorAll('#studio-home-models:not([hidden]) .mp-home-model-row').length,
    })`);

    await realClick(window, '[data-home-view="overview"]');
    const activeHeatCell = '#studio-home-heatmap .mp-home-heatmap-cell:not([data-level="0"])';
    await realClick(window, activeHeatCell, 160);
    const tooltipBounds = await visibleBounds(window.webContents, '#studio-home-tooltip');
    const tooltipText = await window.webContents.executeJavaScript(
      `document.getElementById('studio-home-tooltip')?.textContent.trim() || ''`,
    );

    // Leave the five-level menu open in the screenshot witness so row density,
    // alignment, selected state, and viewport containment can be inspected.
    await realClick(window, '#composer-effort');
    await wait(80);
    const finalEffortBounds = await visibleBounds(window.webContents, '#composer-effort-menu');
    const image = await window.webContents.capturePage();
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, image.toPNG());

    await realClick(window, '#composer-effort');
    await window.webContents.executeJavaScript(`show('stash')`);
    await realClick(window, '#stash-add-note');
    const noteDialogBounds = await visibleBounds(window.webContents, '.dshw-perm-confirm');
    const noteInput = await window.webContents.executeJavaScript(
      `Boolean(document.querySelector('.dshw-perm-confirm textarea'))`,
    );
    if (noteDialogBounds) await realClick(window, '.dshw-perm-confirm-actions button');

    const witness = {
      viewport: { width, height },
      account: {
        open: Boolean(accountBounds),
        bounds: accountBounds,
        items: accountItems,
        settingsOpened: Boolean(settingsOpened),
      },
      permission: { bounds: permissionBounds, selected: selectedPermission },
      model: { bounds: modelBounds, selected: selectedModel },
      effort: {
        bounds: finalEffortBounds || effortBounds,
        initialBounds: effortBounds,
        selected: selectedEffort,
        labels: effortLabels,
      },
      usage: {
        bounds: usageBounds,
        head: usageHead,
        segments: usageSegments,
        segmentKinds: usageSegmentKinds,
        rowKinds: usageRowKinds,
        emptySegments: usageEmptySegments,
      },
      workspace: { bounds: workspaceBounds, items: workspaceItems },
      home,
      stash: { noteDialogOpen: Boolean(noteDialogBounds), noteInput },
      tooltip: { open: Boolean(tooltipBounds), bounds: tooltipBounds, text: tooltipText },
      screenshot: output,
      screenshots,
      consoleErrors,
    };
    process.stdout.write(`INTERACTION_PROBE=${JSON.stringify(witness)}\n`);
    if (
      !accountBounds
      || !settingsOpened
      || !permissionBounds
      || selectedPermission !== 'Manual'
      || !modelBounds
      || selectedModel !== 'claude-sonnet-4'
      || !effortBounds
      || selectedEffort !== 'Max'
      || !usageBounds
      || !usageHead
      /* 有数的时候一条一段：这一轮的输入总量（唯一到过的类别）加上输出。
         空会话那一条相反，一段都不该有——零宽的彩色段看着像「这里有东西」。 */
      || usageSegments !== 4
      || usageSegmentKinds.join(',') !== 'system,tools,messages,results'
      || usageRowKinds.join(',') !== 'system,tools,messages,results,available'
      || usageEmptySegments !== 0
      || !workspaceBounds
      || !workspaceItems.includes('No folder')
      || !workspaceItems.some((item) => item.startsWith('Open folder'))
      || home.view !== 'models'
      || home.range !== '30d'
      || home.modelRows < 1
      || !noteDialogBounds || !noteInput
      || !tooltipBounds
      || consoleErrors.length > 0
    ) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Studio interaction probe failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
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
