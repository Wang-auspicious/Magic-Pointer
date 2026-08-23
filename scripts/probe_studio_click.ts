// Headless interaction probe: load studio.html, click a selector, report
// console errors + a JS-evaluated result. Used to verify "dead button" bugs
// in the packaged renderer without launching the full app.
//
//   npx electron build/scripts/probe_studio_click.js <clickSelector> <evalExpr>

const { app, BrowserWindow } = require('electron');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const clickSel = process.argv[2] || '#workspace-add';
const evalExpr = process.argv[3] || 'document.getElementById("chat-title").textContent';

app.setPath('userData', path.join(ROOT, 'data', 'runtime', 'probe-studio-profile'));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1500,
    height: 1000,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  const errors: string[] = [];
  window.webContents.on('console-message', (_event: unknown, level: number, message: string) => {
    if (level >= 2) errors.push(String(message).slice(0, 400));
  });
  try {
    await window.loadFile(path.join(ROOT, 'electron', 'renderer', 'studio.html'));
    await new Promise((resolve) => setTimeout(resolve, 900));
    const clicked = await window.webContents.executeJavaScript(
      `(function(){ const el = document.querySelector(${JSON.stringify(clickSel)}); if (!el) return 'MISSING'; el.click(); return 'CLICKED'; })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await window.webContents.executeJavaScript(evalExpr);
    process.stdout.write(`clicked=${clicked}\nafter=${after}\nconsole_errors=${errors.length}\n`);
    for (const error of errors.slice(0, 8)) process.stdout.write(`  ${error}\n`);
  } catch (error) {
    process.stderr.write(`probe failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
