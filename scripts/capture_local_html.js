'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 520, webPreferences: { offscreen: true } });
  await win.loadFile(path.resolve('data/runtime/icon-candidates.html'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = await win.webContents.capturePage();
  require('node:fs').writeFileSync(path.resolve('data/runtime/icon-candidates.png'), image.toPNG());
  win.destroy(); app.quit();
});
