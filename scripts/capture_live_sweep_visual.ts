'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const fixture = path.join(root, 'tests', 'fixtures', 'live_sweep_visual.html');
const output = path.join(root, 'data', 'runtime', 'live-sweep-20260801');

async function capture() {
  fs.mkdirSync(output, { recursive: true });
  const window = new BrowserWindow({
    width: 1000,
    height: 640,
    show: false,
    backgroundColor: '#f6f5ed',
    webPreferences: {
      backgroundThrottling: false,
      offscreen: true,
    },
  });
  await window.loadFile(fixture);
  await new Promise((resolve) => setTimeout(resolve, 120));
  for (const scenario of ['baseline', 'early', 'active', 'curve', 'released', 'clear']) {
    await window.webContents.executeJavaScript(`window.renderSweepScenario('${scenario}')`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const image = await window.webContents.capturePage();
    fs.writeFileSync(path.join(output, `${scenario}.png`), image.toPNG());
  }
  window.destroy();
}

app.whenReady()
  .then(capture)
  .then(() => app.quit())
  .catch((error: unknown) => {
    console.error(error);
    app.exit(1);
  });
