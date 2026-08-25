// Headless screenshot probe for delivery evidence.
//   npx electron build/scripts/probe_studio_shot.js <out-prefix>
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const PREFIX = process.argv[2] || 'studio-sv';
const OUTDIR = path.join(ROOT, 'data', 'runtime');

app.setPath('userData', path.join(ROOT, 'data', 'runtime', 'probe-studio-profile'));
app.disableHardwareAcceleration();

async function settle(window: Electron.BrowserWindow, ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

app.whenReady().then(async () => {
  const errors: string[] = [];
  try {
    const window = new BrowserWindow({
      width: 1500,
      height: 1000,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true },
    });
    window.webContents.on('console-message', (_e: unknown, level: number, message: string) => {
      if (level >= 2) errors.push(String(message).slice(0, 200));
    });
    await window.loadFile(path.join(ROOT, 'electron', 'renderer', 'studio.html'));
    await settle(window, 1400);
    fs.mkdirSync(OUTDIR, { recursive: true });
    const shot1 = await window.webContents.capturePage();
    fs.writeFileSync(path.join(OUTDIR, `${PREFIX}-chat.png`), shot1.toPNG());

    // Design 概览(新 bento)
    await window.webContents.executeJavaScript(
      "(function(){ const b=document.querySelector('[data-goto=\"design\"]'); if(b) b.click(); return 'ok'; })()",
    );
    await settle(window, 500);
    const shot2 = await window.webContents.capturePage();
    fs.writeFileSync(path.join(OUTDIR, `${PREFIX}-design.png`), shot2.toPNG());

    // 深色主题(View Transition 揭幕后的终态)
    await window.webContents.executeJavaScript(
      "(function(){ document.querySelector('#theme-toggle')?.click(); return 'ok'; })()",
    );
    await settle(window, 900);
    const shot3 = await window.webContents.capturePage();
    fs.writeFileSync(path.join(OUTDIR, `${PREFIX}-design-dark.png`), shot3.toPNG());

    process.stdout.write(`shots=${PREFIX}-{chat,design,design-dark}.png console_errors=${errors.length}\n`);
    for (const error of errors.slice(0, 5)) process.stdout.write(`  ${error}\n`);
  } catch (error) {
    process.stderr.write(`shot failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
