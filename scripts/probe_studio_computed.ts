
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'data', 'runtime', 'css-parity', 'dump.json');

app.setPath('userData', path.join(ROOT, 'data', 'runtime', 'probe-studio-profile'));
app.disableHardwareAcceleration();

const SELECTORS = [
  'body',
  '.mpw-frame',
  '.mp-window-titlebar',
  '.mpw-sidebar',
  '.mpw-new-session',
  '.mpw-workspace-browser',
  '.mpw-foot',
  '.mp-theme-toggle',
  '.mpw-center-col',
  '#workspace-header',
  '.workspace-eyebrow',
  '.mpw-conversation',
  '.mpw-header',
  '.mpw-title-row',
  '#stream',
  '.mpw-composer-seat',
  '.mpw-input-form',
  '.mpw-card',
  '.mpw-input',
  '.mpw-row',
  '.mpw-tools',
  '.mpw-add',
  '.mpw-primary',
  '.mpw-perm',
  '.mpw-stats',
  '#view-design',
  '.mp-design-intro',
  '.mp-design-bento',
  '.mp-design-card',
  '.mp-design-card-icon',
  '.mp-design-card-copy',
  '.mp-design-card-arrow',
  '#view-stash',
  '.page-toolbar',
  '#view-settings .mpw-settings-panel',
  '.mpw-settings-nav',
  '.mpw-settings-content',
  '#project-inspector',
  '.mp-inspector-tabs',
  '.mp-inspector-filter',
  '#bottom-panel',
  '.mp-terminal-form',
  '#aux',
  '#window-menu-popover',
];

const PROPERTIES = [
  'display', 'position', 'box-sizing', 'flex-direction', 'align-items', 'justify-content',
  'gap', 'row-gap', 'grid-template-columns', 'grid-template-rows',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'color', 'background-color', 'background-image',
  'border-top-width', 'border-top-color', 'border-top-style', 'border-radius',
  'outline-color', 'box-shadow', 'opacity', 'z-index', 'overflow', 'overflow-x', 'overflow-y',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'text-transform', 'white-space', 'text-overflow',
  'width', 'height', 'max-width', 'min-height',
  'transition-property', 'transition-duration', 'animation-name',
  'backdrop-filter', 'pointer-events', 'visibility',
];

function dumpTheme(window: Electron.WebContents, theme: string) {
  return window.executeJavaScript(`(function(){
    const root = document.documentElement;
    const previous = root.dataset.theme;
    root.dataset.theme = ${JSON.stringify(theme)};
    root.style.colorScheme = ${JSON.stringify(theme)};
    const out = {};
    const rootStyle = getComputedStyle(root);
    const customs = {};
    for (const name of rootStyle) { if (name.startsWith('--')) customs[name] = rootStyle.getPropertyValue(name).trim(); }
    out[':root'] = customs;
    const props = ${JSON.stringify(PROPERTIES)};
    for (const selector of ${JSON.stringify(SELECTORS)}) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const style = getComputedStyle(el);
      const picked = {};
      for (const prop of props) picked[prop] = style.getPropertyValue(prop);
      out[selector] = picked;
    }
    if (previous === undefined) delete root.dataset.theme; else root.dataset.theme = previous;
    return out;
  })()`);
}

app.whenReady().then(async () => {
  const builtHtml = path.join(ROOT, 'electron', 'renderer', 'studio.html');
  const errors: string[] = [];
  try {
    const window = new BrowserWindow({
      width: 1500,
      height: 1000,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true },
    });
    window.webContents.on('console-message', (_event: unknown, level: number, message: string) => {
      if (level >= 2) errors.push(String(message).slice(0, 300));
    });
    await window.loadFile(builtHtml);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const light = await dumpTheme(window.webContents, 'light');
    const dark = await dumpTheme(window.webContents, 'dark');
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ viewport: '1500x1000', light, dark }, null, 1));
    process.stdout.write(`dumped=${OUT} selectors=${Object.keys(light).length} console_errors=${errors.length}\n`);
    for (const error of errors.slice(0, 5)) process.stdout.write(`  ${error}\n`);
  } catch (error) {
    process.stderr.write(`probe failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
