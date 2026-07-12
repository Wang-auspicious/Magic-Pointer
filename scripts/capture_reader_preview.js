const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'data', 'runtime', 'secondary_reader_preview_20260712.png');

app.setPath('userData', path.join(ROOT, 'data', 'runtime', 'secondary-reader-preview-profile-20260712'));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    x: 40,
    y: 40,
    width: 420,
    height: 520,
    show: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  try {
    await window.loadFile(path.join(ROOT, 'electron', 'renderer', 'reader.html'));
    await window.webContents.executeJavaScript(`renderPayload({
      ok: true,
      title: '润色结果',
      sourceApp: 'Microsoft Word · 当前选区',
      answer: '已根据当前段落语气完成精简。\\n\\n- 保留原意与专业术语\\n- 删除重复表达\\n- 调整句间节奏',
      selectionSessionToken: 'preview-session',
      actionProposals: [{
        id: 'preview-proposal',
        action_token: 'preview-action-token',
        action_type: 'office_replace_selection',
        parameters: {
          expected_text_excerpt: '这是一段需要进一步优化的原始表达。',
          replacement_text_excerpt: '这是精简后的表达。'
        }
      }]
    })`);
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
