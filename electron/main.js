const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let overlayWindow = null;

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
    // Keep overlay usable while active; Escape hides it explicitly.
    if (overlayWindow && overlayWindow.isVisible()) overlayWindow.focus();
  });
}

function showOverlay() {
  if (!overlayWindow) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  overlayWindow.setBounds(display.bounds);
  overlayWindow.show();
  overlayWindow.focus();
  overlayWindow.webContents.send('overlay:show');
}

function hideOverlay() {
  if (!overlayWindow) return;
  overlayWindow.webContents.send('overlay:hide');
  overlayWindow.hide();
}

app.whenReady().then(() => {
  createOverlayWindow();
  globalShortcut.register('Control+Alt+M', showOverlay);
  // Also show once on launch for immediate visual testing.
  setTimeout(showOverlay, 500);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

ipcMain.on('overlay:hide', hideOverlay);
function runPythonBridge(payload) {
  if (!overlayWindow) return;
  const py = process.env.MAGIC_POINTER_PYTHON || 'python';
  const root = path.resolve(__dirname, '..');
  const child = spawn(py, ['scripts/electron_bridge.py'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (error) => {
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
  console.log('[magic-pointer-overlay]', JSON.stringify(enriched));
  overlayWindow?.webContents.send('overlay:result', { ok: null, status: 'Thinking?' });
  runPythonBridge(enriched);
});
