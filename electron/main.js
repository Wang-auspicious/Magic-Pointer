const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

let overlayWindow = null;
let panelWindow = null;
let mousePoints = [];
let lastShakeTrigger = 0;
let mousePollTimer = null;
let overlayHideTimer = null;

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, 'data', 'runtime');
const LOG_PATH = path.join(RUNTIME_DIR, 'electron.log');
const PID_PATH = path.join(RUNTIME_DIR, 'electron.pid');
const ACTION_PROPOSAL_TTL_MS = 2 * 60 * 1000;
const ALLOWED_ACTION_TYPES = new Set(['copy_text_to_clipboard', 'office_replace_selection', 'office_undo_last_action']);

const pendingActionProposals = new Map();

function log(message) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch (_) {
    // Logging must never break the overlay.
  }
}

function prunePendingActionProposals(now = Date.now()) {
  for (const [token, entry] of pendingActionProposals.entries()) {
    if (!entry || entry.expiresAt <= now) pendingActionProposals.delete(token);
  }
}

function safeClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function registerActionProposals(parsed) {
  if (!parsed || !Array.isArray(parsed.actionProposals)) return;

  prunePendingActionProposals();
  const now = Date.now();
  const safeProposals = [];
  for (const proposal of parsed.actionProposals.slice(0, 5)) {
    if (!proposal || typeof proposal !== 'object') continue;
    if (!ALLOWED_ACTION_TYPES.has(proposal.action_type)) continue;

    const token = crypto.randomUUID();
    const canonical = safeClone(proposal);
    pendingActionProposals.set(token, {
      proposal: canonical,
      createdAt: now,
      expiresAt: now + ACTION_PROPOSAL_TTL_MS,
    });
    safeProposals.push({ ...canonical, action_token: token });
  }

  parsed.actionProposals = safeProposals;
}

function takePendingActionProposal(token) {
  prunePendingActionProposals();
  if (typeof token !== 'string' || !token) return null;
  const entry = pendingActionProposals.get(token);
  if (!entry) return null;
  pendingActionProposals.delete(token);
  return safeClone(entry.proposal);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    log('second-instance -> showPanel');
    showOverlay('second-instance', 900);
    showPanel('second-instance');
  });
}

function createOverlayWindow() {
  const display = screen.getPrimaryDisplay();
  const bounds = display.bounds;

  overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    fullscreenable: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function createPanelWindow() {
  if (panelWindow) return panelWindow;
  panelWindow = new BrowserWindow({
    width: 420,
    height: 160,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    fullscreenable: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  panelWindow.setAlwaysOnTop(true, 'screen-saver');
  panelWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panelWindow.loadFile(path.join(__dirname, 'renderer', 'panel.html'));
  panelWindow.on('closed', () => { panelWindow = null; });
  return panelWindow;
}

function positionPanelNearCursor() {
  if (!panelWindow) return;
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const bounds = display.workArea || display.bounds;
  const size = panelWindow.getBounds();
  const x = Math.min(bounds.x + bounds.width - size.width - 18, Math.max(bounds.x + 18, cursor.x + 28));
  const y = Math.min(bounds.y + bounds.height - size.height - 18, Math.max(bounds.y + 18, cursor.y + 30));
  panelWindow.setBounds({ x, y, width: size.width, height: size.height });
}

function resizePanel(height) {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  const desiredHeight = Math.max(160, Math.min(360, Math.round(Number(height) || 160)));
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const workArea = display.workArea || display.bounds;
  const current = panelWindow.getBounds();
  const x = Math.min(workArea.x + workArea.width - current.width - 18, Math.max(workArea.x + 18, current.x));
  const y = Math.min(workArea.y + workArea.height - desiredHeight - 18, Math.max(workArea.y + 18, current.y));
  panelWindow.setBounds({ x, y, width: current.width, height: desiredHeight });
}

function showPanel(reason = 'manual') {
  const win = createPanelWindow();
  const reveal = () => {
    if (!panelWindow || panelWindow.isDestroyed()) return;
    positionPanelNearCursor();
    win.show();
    win.focus();
    win.webContents.send('panel:show', { reason });
    log(`showPanel reason=${reason}`);
  };
  if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', reveal);
  else reveal();
}

function hidePanel({ hideObserver = false } = {}) {
  if (!panelWindow) return;
  panelWindow.webContents.send('panel:hide');
  panelWindow.hide();
  if (hideObserver) hideOverlay();
  log('hidePanel');
}

function sendCursorToOverlay(pos = screen.getCursorScreenPoint()) {
  if (!overlayWindow || !overlayWindow.isVisible()) return;
  const display = screen.getDisplayNearestPoint(pos);
  const desired = display.bounds;
  const current = overlayWindow.getBounds();
  if (
    current.x !== desired.x
    || current.y !== desired.y
    || current.width !== desired.width
    || current.height !== desired.height
  ) {
    overlayWindow.setBounds(desired);
  }
  const bounds = overlayWindow.getBounds();
  overlayWindow.webContents.send('overlay:cursor', {
    x: pos.x - bounds.x,
    y: pos.y - bounds.y,
    globalX: pos.x,
    globalY: pos.y,
  });
}


function showOverlay(reason = 'manual', durationMs = 0) {
  if (!overlayWindow) return;
  if (overlayHideTimer) clearTimeout(overlayHideTimer);
  overlayHideTimer = null;
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  overlayWindow.setBounds(display.bounds);
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.showInactive();
  overlayWindow.webContents.send('overlay:show', { reason, observerMode: true });
  sendCursorToOverlay(cursor);
  log(`showOverlay observer reason=${reason} cursor=${cursor.x},${cursor.y}`);
  if (durationMs > 0) {
    overlayHideTimer = setTimeout(() => hideOverlay(), durationMs);
  }
}

function hideOverlay() {
  if (overlayHideTimer) clearTimeout(overlayHideTimer);
  overlayHideTimer = null;
  if (!overlayWindow) return;
  overlayWindow.webContents.send('overlay:hide');
  overlayWindow.hide();
  log('hideOverlay');
}

function looksLikeMouseShake(now) {
  const recent = mousePoints.filter((p) => now - p.t <= 1150);
  if (recent.length < 8) return false;

  const xs = recent.map((p) => p.x);
  const ys = recent.map((p) => p.y);
  const xRange = Math.max(...xs) - Math.min(...xs);
  const yRange = Math.max(...ys) - Math.min(...ys);
  if (xRange < 58) return false;
  if (yRange > Math.max(92, xRange * 0.75)) return false;

  const chunks = [];
  let currentDir = 0;
  let currentDist = 0;
  let prevX = xs[0];
  for (const x of xs.slice(1)) {
    const dx = x - prevX;
    prevX = x;
    if (Math.abs(dx) < 10) continue;
    const dir = dx > 0 ? 1 : -1;
    if (currentDir === 0) {
      currentDir = dir;
      currentDist = Math.abs(dx);
    } else if (dir === currentDir) {
      currentDist += Math.abs(dx);
    } else {
      chunks.push([currentDir, currentDist]);
      currentDir = dir;
      currentDist = Math.abs(dx);
    }
  }
  if (currentDir) chunks.push([currentDir, currentDist]);

  const meaningful = [];
  for (const [dir, dist] of chunks) {
    if (dist < 24) continue;
    const last = meaningful[meaningful.length - 1];
    if (last && last[0] === dir) last[1] += dist;
    else meaningful.push([dir, dist]);
  }
  if (meaningful.length < 4) return false;
  const turns = meaningful.slice(1).filter((chunk, i) => chunk[0] !== meaningful[i][0]).length;
  if (turns < 3) return false;
  const total = meaningful.reduce((sum, chunk) => sum + chunk[1], 0);
  const net = Math.abs(xs[xs.length - 1] - xs[0]);
  if (total < 145) return false;
  if (net > total * 0.65 && net > 110) return false;
  return true;
}

function startMouseShakePolling() {
  if (mousePollTimer) clearInterval(mousePollTimer);
  mousePollTimer = setInterval(() => {
    const now = Date.now();
    const pos = screen.getCursorScreenPoint();
    if (overlayWindow && overlayWindow.isVisible()) sendCursorToOverlay(pos);
    if (panelWindow && panelWindow.isVisible()) return;
    if (!overlayWindow || overlayWindow.isVisible()) return;
    mousePoints.push({ t: now, x: pos.x, y: pos.y });
    if (mousePoints.length > 28) mousePoints.shift();
    if (now - lastShakeTrigger > 900 && looksLikeMouseShake(now)) {
      lastShakeTrigger = now;
      mousePoints = [];
      showOverlay('mouse-shake', 1600);
    }
  }, 35);
  log('mouse shake polling started');
}

app.whenReady().then(() => {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(PID_PATH, String(process.pid), 'utf8');
  } catch (_) {}
  log(`app ready pid=${process.pid}`);
  createOverlayWindow();
  const ok = globalShortcut.register('Control+Alt+M', () => {
    if (panelWindow && panelWindow.isVisible()) {
      hidePanel({ hideObserver: true });
      return;
    }
    showOverlay('hotkey-observer', 900);
    showPanel('hotkey');
  });
  log(`register hotkey Control+Alt+M observer+panel ok=${ok}`);
  startMouseShakePolling();
  // First launch should show once so the user knows the background process is alive.
  setTimeout(() => showOverlay('startup', 1400), 650);
});

app.on('will-quit', () => {
  try { fs.unlinkSync(PID_PATH); } catch (_) {}
  globalShortcut.unregisterAll();
  if (mousePollTimer) clearInterval(mousePollTimer);
  try { panelWindow?.close(); } catch (_) {}
  log('app will quit');
});

ipcMain.on('overlay:hide', hideOverlay);
ipcMain.on('panel:hide', () => hidePanel({ hideObserver: true }));
ipcMain.on('panel:resize', (_event, payload) => resizePanel(payload?.height));

function resultTargetWindow(target) {
  return target === 'panel' ? panelWindow : overlayWindow;
}

function sendBridgeResult(target, parsed) {
  const win = resultTargetWindow(target);
  const channel = target === 'panel' ? 'panel:result' : 'overlay:result';
  win?.webContents.send(channel, parsed);
}

function runPythonBridge(payload, scriptPath = 'scripts/electron_bridge.py', target = 'overlay') {
  if (!resultTargetWindow(target)) return;
  const py = process.env.MAGIC_POINTER_PYTHON || 'python';
  const child = spawn(py, [scriptPath], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => {
    log(`bridge spawn error ${error.name}: ${error.message}`);
    sendBridgeResult(target, {
      ok: false,
      error: `${error.name}: ${error.message}`,
    });
  });
  child.on('close', (code) => {
    let parsed = null;
    try {
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      parsed = JSON.parse(lines[lines.length - 1] || '{}');
    } catch (error) {
      parsed = { ok: false, error: `Could not parse bridge output: ${error.message}`, raw: stdout };
    }
    if (code !== 0 && parsed && parsed.ok !== true) {
      parsed.code = code;
      parsed.stderr = stderr.slice(0, 2000);
    }
    registerActionProposals(parsed);
    log(`bridge close script=${scriptPath} code=${code} ok=${parsed?.ok}`);
    sendBridgeResult(target, parsed);
  });

  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
}

ipcMain.on('overlay:done', (_event, payload) => {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const enriched = {
    ...payload,
    screenBounds: display.bounds,
    scaleFactor: display.scaleFactor || payload?.viewport?.dpr || 1,
    capturePad: 54,
  };
  log(`overlay:done action=${enriched.action || 'capture'} points=${enriched.points?.length || 0} scale=${enriched.scaleFactor} bounds=${display.bounds.x},${display.bounds.y},${display.bounds.width},${display.bounds.height}`);
  runPythonBridge(enriched);
});




ipcMain.on('panel:submit-selection-command', (_event, payload) => {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const enriched = {
    ...payload,
    screenBounds: display.bounds,
    scaleFactor: display.scaleFactor || 1,
    source: 'observer_selection_panel',
  };
  log(`panel:submit-selection-command command_len=${String(enriched.command || '').length}`);
  runPythonBridge(enriched, 'scripts/selection_bridge.py', 'panel');
});

function executeActionForTarget(payload, target) {
  const token = payload?.actionToken || payload?.action_token;
  const proposal = takePendingActionProposal(token);
  if (!proposal) {
    log(`${target}:execute-action rejected missing-or-expired token`);
    sendBridgeResult(target, {
      ok: false,
      prompt: 'Action result',
      error: 'Action expired or was not proposed by this session.',
    });
    return;
  }

  const enriched = {
    proposal,
    confirmed: payload?.confirmed === true,
  };
  log(`${target}:execute-action type=${proposal.action_type || 'unknown'} confirmed=${enriched.confirmed}`);
  runPythonBridge(enriched, 'scripts/action_bridge.py', target);
}

ipcMain.on('overlay:execute-action', (_event, payload) => executeActionForTarget(payload, 'overlay'));
ipcMain.on('panel:execute-action', (_event, payload) => executeActionForTarget(payload, 'panel'));
