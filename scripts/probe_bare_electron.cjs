'use strict';

const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const count = Number(arg('count', '1'));
const transparent = process.argv.includes('--transparent');
const visible = process.argv.includes('--visible');
const hidden = process.argv.includes('--hidden-window');
const out = path.join(__dirname, '..', 'data', 'runtime', 'window-memory');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(os.tmpdir(), `bare-electron-${process.pid}`));

app.whenReady().then(() => {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;
  for (let i = 0; i < count; i += 1) {
    const win = new BrowserWindow({
      x: x + (hidden ? 0 : 0),
      y: y + (hidden ? 0 : 0),
      width: hidden ? 400 : width,
      height: hidden ? 300 : height,
      frame: false,
      transparent,
      backgroundColor: transparent ? '#00000000' : '#ffffff',
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      show: false,
      alwaysOnTop: !hidden,
      webPreferences: { contextIsolation: true, backgroundThrottling: false },
    });
    if (!hidden) win.setAlwaysOnTop(true, 'screen-saver');
    win.loadURL(`data:text/html,<title>bare${i}</title><body style="margin:0"><div style="width:100vw;height:100vh"></div>`);
    if (visible) win.showInactive();
  }

  const samples = [];
  const metrics = setInterval(() => {
    const processes = app.getAppMetrics().map((p) => ({
      type: p.type,
      wsMb: Math.round(p.memory.workingSetSize / 1024),
      privateMb: Math.round(p.memory.privateBytes / 1024),
    }));
    samples.push({ atMs: Math.round(process.uptime() * 1000), processes, total: processes.reduce((s, p) => s + p.wsMb, 0) });
  }, 500);

  setTimeout(() => {
    clearInterval(metrics);
    const peak = samples.reduce((b, s) => (s.total > (b?.total ?? -1) ? s : b), null);
    const result = {
      count, transparent, visible, hidden,
      peakTotalMb: peak?.total ?? null,
      peakProcesses: (peak?.processes ?? []).sort((a, b) => b.wsMb - a.wsMb),
      gpuMb: (peak?.processes ?? []).find((p) => p.type === 'GPU')?.wsMb ?? null,
    };
    const name = `bare-${count}w${transparent ? '-transparent' : ''}${visible ? '-visible' : ''}${hidden ? '-small' : ''}.json`;
    fs.writeFileSync(path.join(out, name), JSON.stringify({ ...result, samples }, null, 2));
    console.log(JSON.stringify(result));
    app.exit(0);
  }, 9000);
});
