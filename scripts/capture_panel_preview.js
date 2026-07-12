const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'data', 'runtime', 'inline_rail_preview_20260712.png');

app.setPath('userData', path.join(ROOT, 'data', 'runtime', 'inline-rail-preview-profile-20260712'));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    x: 40,
    y: 40,
    width: 132,
    height: 44,
    show: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    await window.loadFile(path.join(ROOT, 'electron', 'renderer', 'panel.html'));
    await window.webContents.executeJavaScript(`
      currentSelectionSessionToken = 'preview-session';
      currentPanelLayoutNonce = 'preview-layout';
      renderPrimaryIntent(
        { hasContent: true },
        [{ label: 'Add this', command: 'Add this' }]
      );
    `);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const image = await window.webContents.capturePage();
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, image.toPNG());
    console.log(OUTPUT);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
