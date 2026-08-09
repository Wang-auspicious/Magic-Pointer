// Temporary: capture studio.html in hero (first-screen) state.
//   npx electron build/scripts/capture_hero.js <out.png>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const outArg = process.argv[2] || path.join(ROOT, 'data', 'runtime', 'hero.png');

app.setPath('userData', path.join(ROOT, 'data', 'runtime', 'capture-hero-profile'));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  try {
    await window.loadFile(path.join(ROOT, 'electron', 'renderer', 'studio.html'));
    await new Promise((resolve) => setTimeout(resolve, 700));
    await window.webContents.executeJavaScript(`(() => {
      const hero = document.getElementById('hero');
      if (hero) { hero.hidden = false; }
      const shell = document.getElementById('shell');
      if (shell) { shell.hidden = true; }
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
