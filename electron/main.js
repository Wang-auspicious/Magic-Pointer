const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');

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
ipcMain.on('overlay:done', (_event, payload) => {
  console.log('[magic-pointer-overlay]', JSON.stringify(payload));
});
