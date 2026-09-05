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
    const effortLabels = await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('#composer-effort-menu [data-effort-value] .dshw-perm-row-text > span')).map((row) => row.textContent.trim())`,
    );
    await captureWitness('effort');
    await realClick(window, '#composer-effort-menu [data-effort-value="max"]');
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
      home,
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
      || home.view !== 'models'
      || home.range !== '30d'
      || home.modelRows < 1
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
