// Headless Studio interaction probe WITH a mocked bridge: verifies the full
// renderer chain (chip click -> pick -> submit payload) without Electron IPC.
//   npx electron build/scripts/probe_studio_flow.js

const { app, BrowserWindow } = require('electron');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

app.setPath('userData', path.join(ROOT, 'data', 'runtime', 'probe-studio-flow-profile'));
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
    if (level >= 2) errors.push(String(message).slice(0, 300));
  });
  try {
    await window.loadFile(path.join(ROOT, 'electron', 'renderer', 'studio.html'));
    await new Promise((r) => setTimeout(r, 900));
    // Inject the fake bridge AFTER load: data.ts reads window.magicPointerDashboard
    // lazily at call time, so post-load injection exercises the real send path.
    await window.webContents.executeJavaScript(`
      window.__sent = [];
      window.magicPointerDashboard = {
        conversations: {
          list: async () => [],
          get: async () => undefined,
          send: async (p) => { window.__sent.push(p); return { ok: true, conversationId: 'c1' }; },
          pickWorkspace: async () => ({ ok: true, path: 'C:/some/other/workspace' }),
          timeline: async () => [], memories: async () => [], artifacts: async () => [],
          stash: async () => [], models: async () => null, slashDirectory: async () => null,
          selectModel: async () => ({ ok: true }),
          onProgress: () => {}, onTurn: () => {}, onChange: () => {},
          export: async () => ({ ok: false }),
        },
      };
      'bridged';
    `);

    // 1) Click the workspace chip -> mock picker returns another folder.
    await window.webContents.executeJavaScript(
      `document.getElementById('composer-workspace').click()`,
    );
    await new Promise((r) => setTimeout(r, 400));
    const chipLabel = await window.webContents.executeJavaScript(
      `document.getElementById('composer-workspace-label').textContent`,
    );

    // 2) Type a question and submit the composer form.
    await window.webContents.executeJavaScript(`
      (function(){
        const ta = document.querySelector('.dshw-input');
        ta.value = '列出工作区文件';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const form = ta.closest('form');
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return 'submitted';
      })()
    `);
    await new Promise((r) => setTimeout(r, 600));
    const sent = await window.webContents.executeJavaScript(`window.__sent`);
    process.stdout.write(
      `chipLabel=${chipLabel}\nsentCount=${sent.length}\n` +
      (sent[0] ? `workspaceRoot=${JSON.stringify(sent[0].workspaceRoot)}\nquestion=${JSON.stringify(sent[0].question)}\n` : ''),
    );
    process.stdout.write(`console_errors=${errors.length}\n`);
    for (const error of errors.slice(0, 8)) process.stdout.write(`  ${error}\n`);
  } catch (error) {
    process.stderr.write(`probe failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
