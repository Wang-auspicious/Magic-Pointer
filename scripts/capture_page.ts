
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv
  .slice(2)
  .filter((a) => !a.startsWith('--') && !/capture_page\.[jt]s$/.test(a));
const pageArg = args[0];
if (!pageArg) {
  process.stderr.write('Usage: electron capture_page.js <html-path> [output.png] [width]\n');
  process.exit(1);
}
const outArg = args[1] || path.join(ROOT, 'data', 'runtime', 'page.png');
const width = Number(args[2]) || 1500;

app.setPath('userData', path.join(ROOT, 'data', 'runtime', 'capture-page-profile'));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width,
    height: 1200,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  const errors: string[] = [];
  window.webContents.on('console-message', (_event: unknown, level: number, message: string) => {
    if (level >= 2) errors.push(message);
  });
  try {
    await window.loadFile(path.isAbsolute(pageArg) ? pageArg : path.join(ROOT, pageArg));
    await new Promise((resolve) => setTimeout(resolve, 700));
    const height = await window.webContents.executeJavaScript(
      'document.documentElement.scrollHeight',
    );
    window.setContentSize(width, Math.min(Math.ceil(height) + 20, 8000));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const image = await window.webContents.capturePage();
    fs.mkdirSync(path.dirname(outArg), { recursive: true });
    fs.writeFileSync(outArg, image.toPNG());
    process.stdout.write(`${outArg}\nconsole_errors=${errors.length}\n`);
    for (const error of errors.slice(0, 10)) process.stdout.write(`  ${error}\n`);
  } catch (error) {
    process.stderr.write(`capture failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
