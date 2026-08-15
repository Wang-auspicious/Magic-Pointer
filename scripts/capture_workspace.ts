// Temporary: capture studio.html in working (chat) state.
//   npx electron build/scripts/capture_workspace.js <out.png> [view] [settings-page]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const outArg = process.argv[2] || path.join(ROOT, 'data', 'runtime', 'workspace.png');
const viewArg = process.argv[3] || 'chat';
const settingsPageArg = process.argv[4] || '';

app.setPath('userData', path.join(ROOT, 'data', 'runtime', 'capture-ws-profile'));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  try {
    await window.loadFile(path.join(ROOT, 'electron', 'renderer', 'studio.html'), {
      query: { view: viewArg },
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (viewArg === 'settings' && settingsPageArg) {
      await window.webContents.executeJavaScript(`(() => {
        const item = document.querySelector('[data-settings-page="${settingsPageArg.replace(/[^a-z-]/g, '')}"]');
        if (item) item.click();
      })()`);
    }
    await window.webContents.executeJavaScript(`(() => {
      const hero = document.getElementById('hero');
      if (hero) { hero.hidden = true; }
      const shell = document.getElementById('shell');
      if (shell) { shell.hidden = false; }
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const image = await window.webContents.capturePage();
    fs.writeFileSync(outArg, image.toPNG());
    process.stdout.write(`${outArg}\n`);
  } catch (error) {
    process.stderr.write(`capture failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
