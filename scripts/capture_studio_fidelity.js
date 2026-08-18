'use strict';

// Visual acceptance capture for the DSH Studio transplant. This is intentionally
// a real hidden Electron window: CSS namespace, local-file loading, device scale
// and the compiled browser globals are the same ones the installed app uses.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, nativeImage } = require('electron');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data', 'runtime', 'dsh-fidelity');
const reference = process.env.MAGIC_POINTER_REFERENCE || path.join(
  process.env.APPDATA || '', 'magic-pointer', 'stash', '2026-08', '0817-215058-98a1h.png',
);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function capture(window, name) {
  const image = await window.webContents.capturePage();
  fs.writeFileSync(path.join(output, name), image.toPNG());
}

app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  const window = new BrowserWindow({
    width: 1552,
    height: 874,
    show: false,
    backgroundColor: '#151517',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  window.setContentSize(1552, 874);
  await window.loadFile(path.join(root, 'build', 'electron', 'renderer', 'studio.html'));
  // Let the asynchronous initial conversation load settle before overriding
  // its source thumbnail with the acceptance fixture.
  await wait(1000);
  const previewData = fs.existsSync(reference) ? nativeImage.createFromPath(reference).toDataURL() : '';
  await window.webContents.executeJavaScript(`(() => {
    document.body.setAttribute('data-ds-dark-theme', '');
    const preview = document.getElementById('chat-source-preview');
    const thumb = document.getElementById('chat-source-thumb');
    const peek = document.getElementById('peek-image');
    if (${JSON.stringify(previewData)}) {
      thumb.src = ${JSON.stringify(previewData)};
      peek.src = ${JSON.stringify(previewData)};
      preview.hidden = false;
      document.getElementById('chat-peek').hidden = false;
    }
    document.getElementById('mp-context-tag-label').textContent = 'VS Code';
  })()`);
  await wait(100);
  await capture(window, 'chat-source-parity.png');
  await window.webContents.executeJavaScript(`document.getElementById('chat-origin').focus()`);
  await wait(150);
  await capture(window, 'chat-source-hover.png');
  await window.webContents.executeJavaScript(`(() => {
    document.getElementById('chat-origin').blur();
    document.getElementById('chat-peek').style.display = 'none';
    document.querySelector('[data-conversation-tab="trajectory"]').click();
  })()`);
  await wait(150);
  await capture(window, 'trajectory-source-parity.png');
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
