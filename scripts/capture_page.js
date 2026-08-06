// 用 Electron 自己把一个渲染层页面整页截下来。
// 和产品跑在同一个 Chromium 里——所以看到的就是用户会看到的，
// 不是另一个浏览器渲染出来的近似值。
//
//   npx electron scripts/capture_page.js <page.html> <out.png> [width]

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--') && !a.endsWith('capture_page.js'));
const pageArg = args[0] || 'electron/renderer/gallery.html';
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
  const errors = [];
  window.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  try {
    await window.loadFile(path.isAbsolute(pageArg) ? pageArg : path.join(ROOT, pageArg));
    await new Promise((resolve) => setTimeout(resolve, 700));
    // 整页：把窗口撑到内容高度再截，省得只拿到第一屏
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
    process.stderr.write(`capture failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
