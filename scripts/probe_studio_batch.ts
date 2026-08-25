// Headless Studio probe for the 8·25 batch: Work label, titlebar context
// removed, mode menu not clipped (design option clickable), file tree
// fidelity (no chevron, source folder/file icons), and zero console errors.
//   npx electron build/scripts/probe_studio_batch.js

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

    // 1) 左上角模式名 = Work（不再是 Walker）。
    const modeLabel = await window.webContents.executeJavaScript(
      `document.getElementById('mode-switch-label').textContent`,
    );
    out.push(`modeLabel=${modeLabel}`);

    // 2) 标题栏右上角不再有项目名上下文占位。
    out.push(`hasTitlebarContext=${await window.webContents.executeJavaScript(
      `!!document.getElementById('window-project-context')`,
    )}`);

    // 3) 打开模式菜单：Design 选项可见且可点（不再被新对话按钮盖住）。
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

    // 4) boot 已通过 projects.list 激活项目；打开 Inspector 文件树：
    //    目录行不再有 chevron，保留源的文件夹/文件图标。
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