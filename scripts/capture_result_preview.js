const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'data', 'runtime', 'contextual_result_preview_20260712.png');

app.setPath('userData', path.join(ROOT, 'data', 'runtime', 'contextual-result-preview-profile-20260712'));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 420,
    height: 210,
    show: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  try {
    await window.loadFile(path.join(ROOT, 'electron', 'renderer', 'result.html'));
    await window.webContents.executeJavaScript(`renderPayload({
      ok: true,
      prompt: '翻译',
      sourceLabel: 'PDF · 当前选区',
      answer: '持久性并不意味着永恒，而是系统在变化中维持连续性的能力。',
      selectionSessionToken: 'preview-session',
      resultMode: 'inline'
    })`);
    const resultHeight = await window.webContents.executeJavaScript("Math.ceil(document.getElementById('contextual-result').scrollHeight)");
    window.setSize(420, Math.max(92, Math.min(360, resultHeight)));
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
