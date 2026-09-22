
const { app, BrowserWindow } = require('electron');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

app.setPath('userData', path.join(ROOT, 'data', 'runtime', 'probe-studio-batch-profile'));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      preload: path.resolve(__dirname, '..', '..', 'scripts', 'probe_studio_batch_preload.js'),
    },
  });
  const errors: string[] = [];
  window.webContents.on('console-message', (_event: unknown, level: number, message: string) => {
    if (level >= 2) errors.push(String(message).slice(0, 300));
  });
  const out: string[] = [];
  try {
    await window.loadFile(path.join(ROOT, 'electron', 'renderer', 'studio.html'));
    await new Promise((r) => setTimeout(r, 1200));

    const modeLabel = await window.webContents.executeJavaScript(
      `document.getElementById('mode-switch-label').textContent`,
    );
    out.push(`modeLabel=${modeLabel}`);

    out.push(`hasTitlebarContext=${await window.webContents.executeJavaScript(
      `!!document.getElementById('window-project-context')`,
    )}`);

    await window.webContents.executeJavaScript(
      `document.getElementById('mode-switch').click()`,
    );
    await new Promise((r) => setTimeout(r, 250));
    out.push(`designHit=${await window.webContents.executeJavaScript(`
      (function () {
        const menu = document.getElementById('mode-menu');
        const design = document.getElementById('mode-design');
        if (!menu || menu.hidden || !design) return 'menu-not-open';
        const rect = design.getBoundingClientRect();
        const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return top && (top === design || design.contains(top)) ? 'design-clickable'
          : 'covered-by:' + (top ? top.className || top.id : 'none');
      })()
    `)}`);

    await window.webContents.executeJavaScript(
      `document.getElementById('inspector-toggle').click(); 'clicked'`,
    );
    await new Promise((r) => setTimeout(r, 700));
    out.push(`tree=${await window.webContents.executeJavaScript(`
      (function () {
        const rows = Array.from(document.querySelectorAll('#project-file-tree .mp-file-tree-row'));
        const chevrons = document.querySelectorAll('#project-file-tree .mp-tree-chevron').length;
        const folder = document.querySelectorAll('#project-file-tree use[href="#ic-tree-folder"]').length;
        const folderOpen = document.querySelectorAll('#project-file-tree use[href="#ic-tree-folder-open"]').length;
        const file = document.querySelectorAll('#project-file-tree use[href="#ic-tree-file"]').length;
        return JSON.stringify({ rows: rows.length, chevrons, folder, folderOpen, file,
          first: rows[0] ? rows[0].textContent.trim() : '' });
      })()
    `)}`);

    out.push(`console_errors=${errors.length}`);
    for (const error of errors.slice(0, 8)) out.push(`  ${error}`);
    process.stdout.write(out.join('\n') + '\n');
  } catch (error) {
    process.stderr.write(`probe failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});