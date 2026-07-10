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
    height: 220,
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
    await window.webContents.executeJavaScript(`
      currentSelectionSessionToken = 'preview-session';
      renderCaptureSummary(
        {
          label: 'THIS · Word/WPS 选区',
          detail: '42 字 · 产品说明.docx',
          excerpt: 'Magic Pointer 应该留在用户当前的工作流里，而不是把任务搬进聊天窗口。',
          hasContent: true,
          canRewrite: true
        },
        [
          { label: '解释', command: '解释这段内容' },
          { label: '改写', command: '改写这段内容，让它更清晰简洁' },
          { label: '翻译', command: '把这段内容翻译成中文' }
        ]
      );
    `);
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
