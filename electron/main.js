const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let overlayWindow = null;
let mousePoints = [];
let lastShakeTrigger = 0;
let mousePollTimer = null;

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, 'data', 'runtime');
const LOG_PATH = path.join(RUNTIME_DIR, 'electron.log');

function log(message) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch (_) {
    // Logging must never break the overlay.
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    log('second-instance -> showOverlay');
    showOverlay('second-instance');
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

  overlayWindow.on('blur', () => {
    if (overlayWindow && overlayWindow.isVisible()) overlayWindow.focus();
  });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function showOverlay(reason = 'manual') {
  if (!overlayWindow) return;
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  overlayWindow.setBounds(display.bounds);
  overlayWindow.show();
  overlayWindow.focus();
  overlayWindow.webContents.send('overlay:show', { reason });
  log(`showOverlay reason=${reason} cursor=${cursor.x},${cursor.y}`);
}

function hideOverlay() {
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
    if (!overlayWindow || overlayWindow.isVisible()) return;
    const now = Date.now();
    const pos = screen.getCursorScreenPoint();
    mousePoints.push({ t: now, x: pos.x, y: pos.y });
    if (mousePoints.length > 28) mousePoints.shift();
    if (now - lastShakeTrigger > 900 && looksLikeMouseShake(now)) {
      lastShakeTrigger = now;
      mousePoints = [];
      showOverlay('mouse-shake');
    }
  }, 35);
  log('mouse shake polling started');
}

app.whenReady().then(() => {
  log('app ready');
  createOverlayWindow();
  const ok = globalShortcut.register('Control+Alt+M', () => showOverlay('hotkey'));
  log(`register hotkey Control+Alt+M ok=${ok}`);
  startMouseShakePolling();
  // First launch should show once so the user knows the background process is alive.
  setTimeout(() => showOverlay('startup'), 650);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (mousePollTimer) clearInterval(mousePollTimer);
  log('app will quit');
});

ipcMain.on('overlay:hide', hideOverlay);

function runPythonBridge(payload) {
  if (!overlayWindow) return;
  const py = process.env.MAGIC_POINTER_PYTHON || 'python';
  const child = spawn(py, ['scripts/electron_bridge.py'], {
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
    overlayWindow?.webContents.send('overlay:result', {
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
    log(`bridge close code=${code} ok=${parsed?.ok}`);
    overlayWindow?.webContents.send('overlay:result', parsed);
  });

  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
}

ipcMain.on('overlay:done', (_event, payload) => {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const enriched = {
    ...payload,
    screenBounds: display.bounds,
    capturePad: 54,
  };
  log(`overlay:done action=${enriched.action || 'capture'} points=${enriched.points?.length || 0}`);
  runPythonBridge(enriched);
});
