const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'data', 'runtime', 'panel_preview.png');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    x: 40,
    y: 40,
    width: 420,
    height: 160,
    show: true,
    frame: false,
    transparent: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    await window.loadFile(path.join(ROOT, 'electron', 'renderer', 'panel.html'));
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
